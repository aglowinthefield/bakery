import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Board } from "../server/board.js";
import { Worker } from "../server/worker.js";

test("an uncommitted repository cannot start a worktree or consume an attempt", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "uncommitted\n");
    const board = new Board(join(dir, "board.sqlite"));
    const worker = new Worker(board, join(dir, "data"), join(dir, "missing-pi"));
    const card = board.createCard({ title: "Start", body: "", repo });
    assert.throws(() => worker.start(card), /initial commit/);
    assert.equal(board.getCard(card.id)?.status, "ready");
    assert.deepEqual(board.listRuns(card.id), []);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a Pi settlement requests review; retry uses the same card worktree and session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), data = join(dir, "data"), fakePi = join(dir, "pi-fake");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    writeFileSync(fakePi, "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"Worked offline.\"}}' '{\"type\":\"agent_settled\",\"aborted\":false}'\n");
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, data, fakePi);
    const card = board.createCard({ title: "Test", body: "No network", repo });
    const first = worker.start(card);
    await waitFor(() => board.getRun(first.id)?.status === "review");
    assert.match(board.getRun(first.id)!.output, /Worked offline/);
    const next = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(next.id)?.status === "review");
    assert.equal(next.attempt, 2);
    assert.equal(next.sessionId, first.sessionId);
    assert.equal(next.worktree, first.worktree);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Worker did not finish");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
