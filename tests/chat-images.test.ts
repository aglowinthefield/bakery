import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishChatImages, chatImagePath } from "../server/chat-images.js";
import { parseMarkdown } from "../src/markdown.js";

test("local raster links become managed inline images; arbitrary bytes and symlinks outside roots stay private", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-images-"));
  try {
    const file = join(dir, "preview.png");
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    writeFileSync(file, bytes);
    const result = publishChatImages(`[Preview](${file})`, dir, "chat", "board", dir);
    const url = result.match(/\((.*)\)/)![1];
    const id = url.split("/").at(-1)!;
    assert.deepEqual(readFileSync(chatImagePath(dir, "chat", id)), bytes);
    assert.match(JSON.stringify(parseMarkdown(result)), /"type":"image"/);
    assert.equal(publishChatImages(result, dir, "chat", "board", dir), result);
    writeFileSync(join(dir,"fake.png"), "secret text");
    const fake = `[fake](${join(dir,"fake.png")})`;
    assert.equal(publishChatImages(fake, dir, "chat", "board", dir), fake);
    symlinkSync("/etc/passwd", join(dir,"escape.png"));
    const escape = `[escape](${join(dir,"escape.png")})`;
    assert.equal(publishChatImages(escape, dir, "chat", "board", dir), escape);
    assert.doesNotMatch(JSON.stringify(parseMarkdown("![bad](https://example.com/tracker.png)")), /"type":"image"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
