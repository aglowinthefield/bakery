import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Board } from "../server/board.js";
import { cardHistory } from "../server/card-history.js";

const withBoard = (fn: (board: Board, dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try { const board = new Board(join(dir, "board.sqlite")); try { fn(board, dir); } finally { board.close(); } }
  finally { rmSync(dir, { recursive: true, force: true }); }
};
const reasons = (board: Board, id: string) => board.listCardEvents(id).map(e => `${e.fromStatus ?? "-"}>${e.toStatus ?? "-"}: ${e.reason}`);

test("every status change is recorded with a reason, including a Done card reopened to Review", () => {
  withBoard((board, dir) => {
    const card = board.createCard({ title: "T", body: "", repo: dir });
    board.setStatus(card.id, "ready");
    const run = board.claim(card.id, "manual", "to apply the agent reviewer's requested changes");
    board.finish(run.id, "review");
    board.closeReview(card.id);
    board.setStatus(card.id, "ready");
    assert.deepEqual(reasons(board, card.id), [
      "triage>ready: Moved to Ready",
      "ready>running: Attempt 1 started to apply the agent reviewer's requested changes",
      "running>review: Attempt 1 finished; waiting for review",
      "review>done: Closed without merging; the worktree and branch stay, and Reopen brings it back to Review",
      "done>review: Reopened; its work was never merged, so it is back for review",
    ]);
  });
});

test("a failed run records its error, and a status change made outside a named path still gets a line", () => {
  withBoard((board, dir) => {
    const card = board.createCard({ title: "T", body: "", repo: dir });
    board.setStatus(card.id, "ready");
    const run = board.claim(card.id);
    board.finish(run.id, "failed", "Pi exited (1)");
    board.noteCard(card.id, "The agent reviewer sent this back, but Bakery could not start the new attempt: limit");
    const events = board.listCardEvents(card.id);
    assert.equal(events.at(-2)?.reason, "Attempt 1 failed: Pi exited (1)");
    assert.deepEqual([events.at(-1)?.toStatus, events.at(-1)?.reason.slice(0, 20)], [null, "The agent reviewer s"]);
    new DatabaseSync(join(dir, "board.sqlite")).exec(`UPDATE cards SET status='archived' WHERE id='${card.id}'`);
    assert.deepEqual([board.listCardEvents(card.id).at(-1)?.toStatus, board.listCardEvents(card.id).at(-1)?.reason], ["archived", ""]);
  });
});

test("history rebuilds runs from before events were recorded and labels agent reviews", () => {
  withBoard((board, dir) => {
    const card = board.createCard({ title: "T", body: "", repo: dir });
    board.setStatus(card.id, "ready");
    const run = board.claim(card.id);
    board.finish(run.id, "review");
    new DatabaseSync(join(dir, "board.sqlite")).exec("DELETE FROM card_events");
    const old = { ...board.getCard(card.id)!, createdAt: "2026-01-01T00:00:00.000Z" };
    const job = { cardId: card.id, runId: run.id, state: "needs_human" as const, details: "Sent back to the implementer: fix the budget check", fingerprint: "", startedAt: "2026-01-01T00:00:01.000Z", finishedAt: "2026-01-01T00:00:02.000Z", agent: "", interruptions: 0, requeued: 0, changes: "[]", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
    const history = cardHistory(old, board.listCardEvents(card.id), board.listRuns(card.id), [job]);
    assert.deepEqual(history.map(h => h.text), ["Card created", "Agent reviewer requested changes of attempt 1", "Attempt 1 started", "Attempt 1 finished; waiting for review"]);
    assert.equal(history[1].detail, "fix the budget check");
  });
});
