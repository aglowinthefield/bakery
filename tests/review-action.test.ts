import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { Integration } from "../server/integration.js";
import { reviewActionText, type Card } from "../src/model.js";

function git(repo: string, ...args: string[]) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim(); }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakery-review-action-")), repo = join(dir, "repo"), data = join(dir, "data");
  mkdirSync(repo); mkdirSync(join(data, "worktrees"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "original\n"); git(repo, "add", "README.md");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  const board = new Board(join(dir, "board.sqlite")), integration = new Integration(board, data);
  board.addRepo(repo);
  /** A card whose run reached Review, with or without a file change. */
  function reviewed(change: boolean) {
    const card = board.createCard({ repo, title: change ? "Implement" : "Investigate", body: "" });
    board.setStatus(card.id, "ready");
    const run = board.claim(card.id), worktree = join(data, "worktrees", card.id);
    git(repo, "worktree", "add", "-qb", `bakery/${card.id}`, worktree, "HEAD");
    board.attach(run.id, process.pid, worktree);
    if (change) writeFileSync(join(worktree, "README.md"), `original\n${card.id}\n`);
    board.finish(run.id, "review");
    return { id: card.id, run };
  }
  return { board, integration, reviewed, close: () => { board.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a Review card you can act on is labeled PR ready when the run changed files and Accept findings when it changed none", () => {
  const f = fixture();
  try {
    const code = f.reviewed(true), findings = f.reviewed(false);
    assert.equal(f.board.getCard(code.id)!.reviewAction, null, "the next step is unknown until the changed files are counted");
    for (const id of [code.id, findings.id]) f.integration.recordChangedFiles(f.board.getCard(id)!);
    const a = f.board.getCard(code.id)!, b = f.board.getCard(findings.id)!;
    assert.equal(a.reviewAction, "pr_ready");
    assert.equal(reviewActionText(a as unknown as Card), "PR ready");
    assert.equal(b.reviewAction, "accept_findings");
    assert.equal(reviewActionText(b as unknown as Card), "Accept findings");
  } finally { f.close(); }
});

test("a Review card that is not your turn, or has an approval in progress, gets no next-step label", () => {
  const f = fixture();
  try {
    const code = f.reviewed(true);
    f.integration.recordChangedFiles(f.board.getCard(code.id)!);
    assert.equal(f.board.getCard(code.id)!.reviewAction, "pr_ready");
    f.board.recordApproval(code.id, code.run.id, "candidate");
    assert.equal(f.board.getCard(code.id)!.reviewAction, null, "an approval is already underway");
    // Waiting states stay unlabeled on the client even if the server sent an action.
    const waiting = { status: "review", reviewWait: "agent_review", reviewAction: "pr_ready" } as Card;
    assert.equal(reviewActionText(waiting), "");
    assert.equal(reviewActionText({ ...waiting, reviewWait: "github" }), "");
    assert.equal(reviewActionText({ ...waiting, reviewWait: "ci_fix" }), "");
  } finally { f.close(); }
});
