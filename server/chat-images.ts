import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";

/** Only recognized raster bytes are published, never arbitrary local files or SVG. */
export function rasterType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return "image/gif";
  if (bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP") return "image/webp";
}

export function chatImagePath(sessionDir: string, chatId: string, id: string): string {
  return join(sessionDir, "images", chatId, id);
}

/** Import explicit local raster links into opaque, chat-scoped storage. */
export function publishChatImages(text: string, sessionDir: string, chatId: string, boardId: string, repo: string): string {
  return text.replace(/!?\[([^\]\n]*)\]\(\s*(\/[^)\n]+?)\s*\)/g, (original, label: string, path: string) => {
    try {
      if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) return original;
      const file = realpathSync(path);
      const allowed = [repo, tmpdir()].some(root => {
        const part = relative(realpathSync(root), file);
        return part !== "" && !part.startsWith("..") && !isAbsolute(part);
      });
      if (!allowed || !statSync(file).isFile() || statSync(file).size > 10 * 1024 * 1024) return original;
      const bytes = readFileSync(file);
      if (!rasterType(bytes)) return original;
      const id = createHash("sha256").update(bytes).digest("hex");
      const destination = chatImagePath(sessionDir, chatId, id);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, bytes, { mode: 0o600 });
      return `![${label}](/api/boards/${boardId}/chats/${chatId}/images/${id})`;
    } catch { return original; }
  });
}
