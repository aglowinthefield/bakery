import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../server/lock.js";

function withDir(fn: (lock: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "bakery-lock-"));
  try { fn(join(dir, "server.lock")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a fresh lock records this PID", () => withDir(lock => {
  closeSync(acquireLock(lock));
  assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`);
}));

test("a lock from a dead PID is taken over and logged", () => withDir(lock => {
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  writeFileSync(lock, `${dead}\n`);
  const logs: string[] = [];
  closeSync(acquireLock(lock, message => logs.push(message)));
  assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`);
  assert.match(logs[0] ?? "", new RegExp(`stale Bakery lock .* PID ${dead}`));
}));

test("a lock held by a live PID or without a PID still refuses", () => withDir(lock => {
  writeFileSync(lock, `${process.ppid}\n`);
  assert.throws(() => acquireLock(lock), new RegExp(`already owns this data directory \\(PID ${process.ppid}`));
  writeFileSync(lock, "");
  assert.throws(() => acquireLock(lock), /without a PID/);
  assert.equal(readFileSync(lock, "utf8"), "");
}));
