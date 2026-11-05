import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Board } from "../server/board.js";

test("sentinel in-progress counts include running and queued jobs, not done or plain cards", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-sentinel-badge-"));
  const file = join(dir, "board.sqlite");
  const board = new Board(file);
  try {
    const job = (key: string) => board.createCard({ title: key, body: "", repo: dir, idempotencyKey: key });
    const a = job("sentinel:1:a:b");
    const b = job("request:issues/comments:2");
    board.createCard({ title: "plain", body: "", repo: dir });
    const set = (id: string, status: string) => {
      const db = new DatabaseSync(file);
      db.prepare("UPDATE cards SET status=? WHERE id=?").run(status, id);
      db.close();
    };
    set(a.id, "running");
    set(b.id, "done");
    assert.equal(board.sentinelInProgressCounts()[dir], 1);
    set(a.id, "done");
    assert.equal(board.sentinelInProgressCounts()[dir] ?? 0, 0);
    set(b.id, "ready");
    assert.equal(board.sentinelInProgressCounts()[dir], 1);
  } finally {
    board.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
