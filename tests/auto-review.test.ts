import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { Integration } from "../server/integration.js";
import { AutoReview, reviewerVerdict } from "../server/auto-review.js";

function git(repo: string, ...args: string[]) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim(); }
const settle = (verdict: string) => [
  JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.5", stopReason: "stop", content: [{ type: "text", text: verdict }],
    usage: { input: 4000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 4050, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 } } } }),
  JSON.stringify({ type: "agent_settled", aborted: false }), "",
].join("\n");
function fixture(verdict = '{"verdict":"approve","reason":"Diff is small and correct"}') {
  const dir = mkdtempSync(join(tmpdir(), "bakery-auto-review-")), repo = join(dir, "repo"), data = join(dir, "data");
  mkdirSync(repo); mkdirSync(join(data, "worktrees"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "original\n"); git(repo, "add", "README.md");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  const board = new Board(join(dir, "board.sqlite")), repoBoard = board.addRepo(repo);
  const piBin = join(dir, "fake-pi");
  // The fake emits the same JSON events as --mode json; it never calls a model.
  writeFileSync(piBin, `#!/bin/sh\ncat <<'EVENTS'\n${settle(verdict)}EVENTS\n`); chmodSync(piBin, 0o755);
  const integration = new Integration(board, data), auto = new AutoReview(board, integration, piBin);
  function reviewedCard() {
    const card = board.createCard({ repo, title: "Add a new line", body: "Include a regression test" });
    board.setStatus(card.id, "ready");
    const run = board.claim(card.id), worktree = join(data, "worktrees", card.id);
    git(repo, "worktree", "add", "-qb", `bakery/${card.id}`, worktree, "HEAD");
    board.attach(run.id, process.pid, worktree);
    writeFileSync(join(worktree, "README.md"), `original\nnew ${card.id}\n`);
    board.finish(run.id, "review");
    return { card: board.getCard(card.id)!, run: board.getRun(run.id)!, worktree };
  }
  return { dir, repo, data, board, repoBoard, auto, reviewedCard, close: () => { board.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a Review card is the agent's turn until its auto-review finishes, then yours if it was not merged", async () => {
  const item = fixture('{"verdict":"needs_human","reason":"No regression test"}');
  try {
    item.board.setAutoReview(item.repoBoard.id, true, "true");
    await new Promise(resolve => setTimeout(resolve, 5));
    const { card } = item.reviewedCard();
    assert.equal(card.reviewWait, "agent_review", "queued for the agent before the tick claims it");
    assert.deepEqual(item.board.cardCounts()[item.repo], { reviewWaiting: 1 });
    await item.auto.tick();
    assert.equal(item.board.getCard(card.id)!.reviewWait, null);
    assert.deepEqual(item.board.cardCounts()[item.repo], { review: 1 });
    item.board.setAutoReview(item.repoBoard.id, false, "");
    const manual = item.reviewedCard().card;
    assert.equal(manual.reviewWait, null, "without auto-review every Review card is yours");
  } finally { item.close(); }
});

test("strict agent verdict rejects missing settlement, invalid JSON, and ambiguous formats", () => {
  assert.deepEqual(reviewerVerdict(settle('{"verdict":"approve","reason":"Looks correct"}')), { verdict: "approve", reason: "Looks correct" });
  assert.throws(() => reviewerVerdict(settle('```json\n{"verdict":"approve","reason":"fine"}\n```')), /not a JSON object: "```json/);
  assert.throws(() => reviewerVerdict(settle('{"verdict":"approve","reason":"fine","extra":true}')), /invalid or ambiguous: .*extra/);
  assert.throws(() => reviewerVerdict(settle('{"verdict":"approve","reason":"fine"}').replace('"aborted":false', '"aborted":true')), /did not settle.*aborted/);
  assert.throws(() => reviewerVerdict(settle('{"verdict":"approve","reason":"fine"}').replace('"stopReason":"stop"', '"stopReason":"length"')), /did not settle.*stop reason was "length"/);
  assert.throws(() => reviewerVerdict(settle('{"verdict":"approve","reason":"fine"}').replace('"agent_settled"', '"message_end"')), /did not settle.*never reported agent_settled/);
  // A reviewer that used tools sends earlier assistant messages; only the final one is the verdict.
  const toolCall = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] } });
  assert.deepEqual(reviewerVerdict(`${toolCall}\n${settle('{"verdict":"approve","reason":"Imports checked"}')}`), { verdict: "approve", reason: "Imports checked" });
  assert.throws(() => reviewerVerdict(settle('{"verdict":"approve","reason":"fine"}').replace('"stopReason":"stop"', '"stopReason":"toolUse"')), /did not settle.*stop reason was "toolUse"/);
});

test("new opt-in reviews run a separate reviewer and verify before local merge", async () => {
  const item = fixture();
  try {
    const old = item.reviewedCard();
    assert.equal(item.board.listAutoReviewCandidates().length, 0);
    item.board.setAutoReview(item.repoBoard.id, true, "test -f README.md && printf verified");
    assert.equal(item.board.listAutoReviewCandidates().length, 0, "old review must not auto-merge");
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    assert.deepEqual(item.board.listAutoReviewCandidates().map(entry => entry.card.id), [current.card.id]);
    await item.auto.tick();
    assert.equal(item.board.getCard(current.card.id)?.status, "done");
    assert.equal(item.board.getAutoReviewJob(current.run.id)?.state, "merged");
    assert.equal(item.board.getAutoReviewJob(current.run.id)?.agent, "openai-codex/gpt-5.5");
    assert.equal(item.board.getCard(current.card.id)?.reviewAgent, "openai-codex/gpt-5.5");
    assert.equal(item.board.getAutoReviewJob(current.run.id)?.cost, 0.03, "agent review spend is recorded");
    assert.equal(item.board.getAutoReviewJob(current.run.id)?.inputTokens, 4000);
    assert.equal(item.board.getCard(current.card.id)?.cost, 0.03, "card total includes its agent review");
    assert.equal(item.board.autoReviewMergesToday(item.repo), 1);
    assert.match(readFileSync(join(item.repo, "README.md"), "utf8"), new RegExp(current.card.id));
    assert.equal(item.board.getCard(old.card.id)?.status, "review");
    await item.auto.tick();
    assert.equal(item.board.autoReviewMergesToday(item.repo), 1);
  } finally { item.close(); }
});

test("the global tick reconciles a failed card merged outside Bakery without enabling auto-review", async () => {
  const item = fixture();
  try {
    const { card, run, worktree } = item.reviewedCard();
    const failed = item.board.claim(card.id);
    item.board.attach(failed.id, process.pid, worktree);
    item.board.finish(failed.id, "failed", "Pi exited (143)");
    git(worktree, "add", "README.md");
    git(worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "external card fix");
    const candidate = git(worktree, "rev-parse", "HEAD");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", candidate);
    const mergeCommit = git(item.repo, "rev-parse", "HEAD");
    await item.auto.tick();
    assert.equal(item.board.getCard(card.id)?.status, "done");
    assert.equal(item.board.wasIntegrated(card.id), true);
    assert.equal(item.board.autoReviewMergesToday(item.repo), 0);
    const db = new DatabaseSync(join(item.dir, "board.sqlite"));
    try {
      assert.deepEqual({ ...db.prepare("SELECT runId, candidate, mergeCommit FROM external_integrations WHERE cardId=?").get(card.id) as object },
        { runId: failed.id, candidate, mergeCommit });
      assert.equal(db.prepare("SELECT COUNT(*) AS total FROM approvals WHERE cardId=?").get(card.id)!.total, 0);
    } finally { db.close(); }
    assert.equal(item.board.setStatus(card.id, "ready").status, "ready");
    await item.auto.tick();
    assert.equal(item.board.getCard(card.id)?.status, "ready");
    assert.equal(run.status, "review");
  } finally { item.close(); }
});

test("the global tick ignores ancestry without integration, discarded merges, pending approval, and dirty branches", async () => {
  const item = fixture();
  try {
    const untouched = item.reviewedCard();
    // This branch is an ancestor only because main advanced; it contributed nothing.
    writeFileSync(join(item.repo, "main.txt"), "main only\n");
    git(item.repo, "add", "main.txt");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "new main work");
    await item.auto.tick();
    assert.equal(item.board.getCard(untouched.card.id)?.status, "review");
    const discarded = item.reviewedCard();
    git(discarded.worktree, "add", "README.md");
    git(discarded.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "discarded change");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "-s", "ours", "--no-ff", "--no-edit", git(discarded.worktree, "rev-parse", "HEAD"));
    await item.auto.tick();
    assert.equal(item.board.getCard(discarded.card.id)?.status, "review");
    const pending = item.reviewedCard();
    git(pending.worktree, "add", "README.md");
    git(pending.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "pending change");
    const candidate = git(pending.worktree, "rev-parse", "HEAD");
    item.board.recordApproval(pending.card.id, pending.run.id, candidate);
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", candidate);
    await item.auto.tick();
    assert.equal(item.board.getCard(pending.card.id)?.status, "review");
    const dirty = item.reviewedCard();
    git(dirty.worktree, "add", "README.md");
    git(dirty.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "dirty branch work");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", git(dirty.worktree, "rev-parse", "HEAD"));
    writeFileSync(join(dirty.worktree, "untracked.txt"), "unfinished\n");
    await item.auto.tick();
    assert.equal(item.board.getCard(dirty.card.id)?.status, "review");
    rmSync(join(dirty.worktree, "untracked.txt"));
    await item.auto.tick();
    assert.equal(item.board.getCard(dirty.card.id)?.status, "done");
  } finally { item.close(); }
});

test("a run cannot be claimed while agent review is active, but can start after it finishes", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true, "true");
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    item.board.beginAutoReview(current.card.id, current.run.id);
    assert.throws(() => item.board.claim(current.card.id), /Agent review is in progress/);
    assert.equal(item.board.getCard(current.card.id)?.status, "review");
    assert.equal(item.board.listRuns(current.card.id).length, 1);
    item.board.finishAutoReview(current.run.id, "needs_human", "Needs human review");
    assert.equal(item.board.claim(current.card.id).attempt, 2);
  } finally { item.close(); }
});

test("card text edits during review leave the candidate for a human", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true, "true");
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    const script = join(item.dir, "fake-pi");
    writeFileSync(script, `#!/bin/sh\nnode -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(join(item.dir, "board.sqlite"))}); db.prepare("UPDATE cards SET body = ? WHERE id = ?").run("Changed acceptance criteria", ${JSON.stringify(current.card.id)}); db.close()'\ncat <<'EVENTS'\n${settle('{"verdict":"approve","reason":"Looks fine"}')}EVENTS\n`);
    await item.auto.tick();
    assert.equal(item.board.getCard(current.card.id)?.status, "review");
    assert.match(item.board.getAutoReviewJob(current.run.id)!.details, /Card changed during agent review/);
  } finally { item.close(); }
});

test("binary changes are never auto-approved without inspectable bytes", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true, "true");
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    writeFileSync(join(current.worktree, "image.png"), Buffer.from([0, 1, 2, 3]));
    await item.auto.tick();
    assert.equal(item.board.getCard(current.card.id)?.status, "review");
    assert.match(item.board.getAutoReviewJob(current.run.id)!.details, /Binary.*human review/);
  } finally { item.close(); }
});

test("opening another Board cannot invalidate an active review; explicit restart recovery can", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true, "true");
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    item.board.beginAutoReview(current.card.id, current.run.id);
    const second = new Board(join(item.dir, "board.sqlite"));
    assert.equal(second.getAutoReviewJob(current.run.id)?.state, "running");
    second.recoverAutoReviews(); // This method is only called by the exclusive-lock server at startup.
    assert.equal(item.board.getAutoReviewJob(current.run.id)?.state, "needs_human");
    assert.throws(() => new Integration(item.board, item.data).approve(current.card, new Integration(item.board, item.data).review(current.card).fingerprint, "auto", () => {}), /no longer active/);
    second.close();
  } finally { item.close(); }
});

test("a review interrupted by a restart is queued again once, then left for a person", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true, "true");
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    item.board.beginAutoReview(current.card.id, current.run.id);
    item.board.recordAutoReviewUsage(current.run.id, { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.5 });
    item.board.recoverAutoReviews();
    let job = item.board.getAutoReviewJob(current.run.id)!;
    assert.equal(job.requeued, 1);
    assert.match(job.details, /reviewed again/);
    assert.equal(item.board.getCard(current.card.id)!.reviewWait, "agent_review");
    item.board.beginAutoReview(current.card.id, current.run.id);
    job = item.board.getAutoReviewJob(current.run.id)!;
    assert.equal(job.state, "running");
    assert.equal(job.cost, 0.5, "the interrupted attempt's spend still counts");
    item.board.recoverAutoReviews();
    job = item.board.getAutoReviewJob(current.run.id)!;
    assert.equal(job.state, "needs_human");
    assert.equal(job.requeued, 0);
    assert.match(job.details, /twice; inspect manually/);
    assert.equal(item.board.listAutoReviewCandidates().length, 0);
    assert.throws(() => item.board.beginAutoReview(current.card.id, current.run.id), /not eligible/);
  } finally { item.close(); }
});

test("draining waits for the review in progress and claims no new ones", async () => {
  const item = fixture();
  try {
    // The fake reviewer takes a moment, so the drain starts while it is still running.
    const fake = join(item.dir, "fake-pi");
    writeFileSync(fake, `#!/bin/sh\nsleep 0.5\ncat <<'EVENTS'\n${settle('{"verdict":"needs_human","reason":"Check manually"}')}EVENTS\n`);
    item.board.setAutoReview(item.repoBoard.id, true, "true");
    await new Promise(resolve => setTimeout(resolve, 5));
    const first = item.reviewedCard(), second = item.reviewedCard();
    const ticking = item.auto.tick();
    while (!item.auto.active) await new Promise(resolve => setTimeout(resolve, 10));
    await item.auto.drain();
    assert.equal(item.auto.active, false);
    assert.equal(item.board.getAutoReviewJob(first.run.id)?.state, "needs_human", "the active review finished instead of being killed");
    await ticking;
    await item.auto.tick();
    assert.equal(item.board.getAutoReviewJob(second.run.id), undefined, "no new review starts while draining");
  } finally { item.close(); }
});

test("unattended merges have no daily cap, and disabling stops new reviews", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true, "true");
    await new Promise(resolve => setTimeout(resolve, 5));
    const first = item.reviewedCard();
    await item.auto.tick();
    assert.equal(item.board.getCard(first.card.id)?.status, "done");
    // A busy day of earlier merges must not hold a card that passed every check in Review.
    const db = new DatabaseSync(join(item.dir, "board.sqlite"));
    for (let i = 0; i < 50; i++)
      db.prepare("INSERT INTO auto_review_jobs(cardId,runId,state,startedAt,finishedAt) VALUES (?,?,'merged',datetime('now'),datetime('now'))").run(first.card.id, `seeded-${i}`);
    db.close();
    const next = item.reviewedCard();
    await item.auto.tick();
    assert.equal(item.board.getCard(next.card.id)?.status, "done");
    item.board.setAutoReview(item.repoBoard.id, false, "true");
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoReviewEnabled, false);
    item.reviewedCard();
    assert.equal(item.board.listAutoReviewCandidates().length, 0);
  } finally { item.close(); }
});

test("failing verification leaves the card in Review without calling a model or retrying", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true, "exit 2");
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard(), before = git(item.repo, "rev-parse", "main");
    await item.auto.tick();
    assert.equal(item.board.getCard(current.card.id)?.status, "review");
    assert.equal(git(item.repo, "rev-parse", "main"), before);
    assert.equal(item.board.getAutoReviewJob(current.run.id)?.state, "needs_human");
    assert.match(item.board.getAutoReviewJob(current.run.id)!.details, /failed/);
    assert.equal(item.board.listAutoReviewCandidates().length, 0);
  } finally { item.close(); }
});

test("uncommitted overlapping edits on main stop auto-review before verification or a model call", async () => {
  const item = fixture();
  try {
    const marker = join(item.dir, "verified");
    item.board.setAutoReview(item.repoBoard.id, true, `touch ${marker}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard(), before = git(item.repo, "rev-parse", "main");
    writeFileSync(join(item.repo, "README.md"), "uncommitted main change\n");
    await item.auto.tick();
    assert.equal(item.board.getCard(current.card.id)?.status, "review");
    assert.equal(git(item.repo, "rev-parse", "main"), before);
    assert.equal(readFileSync(join(item.repo, "README.md"), "utf8"), "uncommitted main change\n");
    assert.match(item.board.getAutoReviewJob(current.run.id)!.details, /Uncommitted changes on main overlap this card \(README\.md\)/);
    assert.equal(item.board.getAutoReviewJob(current.run.id)?.inputTokens ?? 0, 0, "no reviewer tokens spent");
    assert.throws(() => readFileSync(marker), "verification never ran");
  } finally { item.close(); }
});

test("verification must pass on the merged result, not just the card branch", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true, "test ! -e blocked.txt");
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    writeFileSync(join(item.repo, "blocked.txt"), "new main content\n");
    git(item.repo, "add", "blocked.txt");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "new main file");
    const before = git(item.repo, "rev-parse", "main");
    await item.auto.tick();
    assert.equal(item.board.getCard(current.card.id)?.status, "review");
    assert.equal(git(item.repo, "rev-parse", "main"), before);
    assert.match(item.board.getAutoReviewJob(current.run.id)!.details, /merged result/);
  } finally { item.close(); }
});

test("agent findings or an ambiguous response fail closed", async () => {
  for (const verdict of ['{"verdict":"needs_human","reason":"Missing test"}', 'I approve']) {
    const item = fixture(verdict);
    try {
      item.board.setAutoReview(item.repoBoard.id, true, "true");
      await new Promise(resolve => setTimeout(resolve, 5));
      const current = item.reviewedCard(), before = git(item.repo, "rev-parse", "main");
      await item.auto.tick();
      assert.equal(item.board.getAutoReviewJob(current.run.id)?.state, "needs_human");
      assert.equal(item.board.getCard(current.card.id)?.status, "review");
      assert.equal(git(item.repo, "rev-parse", "main"), before);
    } finally { item.close(); }
  }
});

test("changing the work during verification blocks auto-merge and restarting does not re-run a reviewer", async () => {
  const item = fixture();
  try {
    item.board.setAutoReview(item.repoBoard.id, true, "printf changed >> README.md");
    await new Promise(resolve => setTimeout(resolve, 5));
    const current = item.reviewedCard();
    await item.auto.tick();
    assert.match(item.board.getAutoReviewJob(current.run.id)!.details, /changed during verification/);
    assert.equal(item.board.getCard(current.card.id)?.status, "review");
    const reopened = new Board(join(item.dir, "board.sqlite"));
    assert.equal(reopened.getAutoReviewJob(current.run.id)?.state, "needs_human");
    assert.equal(reopened.listAutoReviewCandidates().length, 0);
    reopened.close();
  } finally { item.close(); }
});

test("the agent reviewer uses the repository's review model before the prompt", async () => {
  const item = fixture();
  try {
    const argsFile = join(item.dir, "args.txt");
    writeFileSync(join(item.dir, "fake-pi"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat <<'EVENTS'\n${settle('{"verdict":"needs_human","reason":"Check manually"}')}EVENTS\n`);
    item.board.updateSettings({ agentModels: { work: { model: "anthropic/claude-sonnet-4-5", thinking: "" }, conflict: { model: "", thinking: "" }, review: { model: "anthropic/claude-haiku-4-5", thinking: "low" } } });
    item.board.setAgentModels(item.repoBoard.id, { review: { model: "openai-codex/gpt-5.5" } });
    item.board.setAutoReview(item.repoBoard.id, true, "true");
    await new Promise(resolve => setTimeout(resolve, 5));
    const { run } = item.reviewedCard();
    await item.auto.tick();
    assert.equal(item.board.getAutoReviewJob(run.id)?.state, "needs_human");
    const args = readFileSync(argsFile, "utf8").split("\n");
    const separator = args.indexOf("--");
    assert.deepEqual(args.slice(separator - 4, separator), ["--model", "openai-codex/gpt-5.5", "--thinking", "low"]);
    // The reviewer is fully capable: it keeps tools, extensions, MCP, skills, and context files like card runs do.
    for (const flag of ["--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files"]) assert.ok(!args.includes(flag), flag);
    assert.match(args[separator + 1], /independent reviewer/);
    assert.match(args[separator + 1], /verification command .*passed: "true"/);
  } finally { item.close(); }
});
