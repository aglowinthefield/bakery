import { createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";
import type { Attachment } from "./board.js";

/** The most one file may hold. Large on purpose: screenshots, logs and recordings are the use. */
export const MAX_ATTACHMENT_BYTES = 1024 ** 3;

/** A file name safe to use on disk and in a prompt: no directories, no control characters, never empty or hidden. */
export function safeFileName(name: string): string {
  const clean = basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim().replace(/^\.+/, "_").slice(0, 150);
  return clean || "file";
}

/** Where an attachment's bytes live: `<data dir>/attachments/<card id>/<attachment id>/<name>`. The name keeps its extension for the agent. */
export const attachmentPath = (dataDir: string, item: Pick<Attachment, "cardId" | "id" | "name">) =>
  join(dataDir, "attachments", item.cardId, item.id, safeFileName(item.name));

/**
 * Streams a request body to the attachment's path without holding it in memory, and returns the byte count.
 * A body over `limit` or a dropped connection removes the partial file and rejects.
 */
export async function storeUpload(req: IncomingMessage, target: string, limit = MAX_ATTACHMENT_BYTES): Promise<number> {
  mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
  const partial = `${target}.part`;
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(size > limit ? new Error(`File is larger than the ${Math.round(limit / 1024 ** 2)} MB limit`) : null, chunk);
    },
  });
  try {
    await pipeline(req, counter, createWriteStream(partial, { mode: 0o600 }));
    if (req.aborted || !req.complete) throw new Error("Upload was interrupted");
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return size;
}

export function removeAttachmentFiles(dataDir: string, item: Pick<Attachment, "cardId" | "id">) {
  rmSync(join(dataDir, "attachments", item.cardId, item.id), { recursive: true, force: true });
}

/** The prompt lines that tell an agent where a card's files are. Empty when there are none. */
export function attachmentsPrompt(dataDir: string, items: Attachment[]): string {
  if (!items.length) return "";
  const lines = items.map(item => `- ${attachmentPath(dataDir, item)} (${item.name}, ${item.type}, ${item.size} bytes)`);
  return `The operator attached these files to the card. Read them from these paths when they matter to the task:\n${lines.join("\n")}`;
}
