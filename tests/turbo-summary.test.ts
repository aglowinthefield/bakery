import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turboCacheUsage } from "../server/turbo-summary.js";

const summary = (...statuses: ("HIT" | "MISS")[]) => JSON.stringify({ tasks: statuses.map(status => ({ cache: { status, timeSaved: status === "HIT" ? 1500 : 0 } })) });

test("turbo summaries written since the run started give its hit count and time saved", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-turbo-"));
  try {
    assert.equal(turboCacheUsage(dir, 0), null);
    mkdirSync(join(dir, ".turbo", "runs"), { recursive: true });
    const write = (name: string, body: string, at: number) => { const file = join(dir, ".turbo", "runs", name); writeFileSync(file, body); utimesSync(file, at / 1000, at / 1000); };
    write("old.json", summary("HIT", "HIT"), 1_000);
    write("a.json", summary("HIT", "MISS", "MISS"), 10_000);
    write("b.json", summary("HIT"), 11_000);
    write("broken.json", "{", 12_000);
    assert.deepEqual(turboCacheUsage(dir, 5_000), { tasks: 4, hits: 2, savedMs: 3000 });
    assert.equal(turboCacheUsage(dir, 20_000), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
