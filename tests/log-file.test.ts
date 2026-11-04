import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LogBuffer } from "../server/logs.js";

test("a persisted log keeps every line, indents multi-line messages, and rotates at the size limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-log-"));
  try {
    const file = join(dir, "logs", "bakery.log");
    const logs = new LogBuffer();
    logs.persist(file, 200);
    logs.add("info", "first\nsecond line");
    assert.match(readFileSync(file, "utf8"), /INFO\s+first\n {4}second line\n/);
    for (let i = 0; i < 10; i++) logs.add("warn", `line ${i} ${"x".repeat(40)}`);
    assert.ok(existsSync(`${file}.1`), "the full file moved aside");
    assert.ok(!existsSync(`${file}.4`), "only three old files are kept");
    assert.match(readFileSync(file, "utf8"), /line 9/);
    assert.equal(logs.since().length, 11, "the in-memory copy is unaffected");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
