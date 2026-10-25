import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Card } from "../server/board.js";
import { Integration, IntegrationConflictError } from "../server/integration.js";

function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakery-integrate-"));
  const repo = join(dir, "repo"), data = join(dir, "data");
  mkdirSync(repo); mkdirSync(join(data, "worktrees"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "original\n");
  git(repo, "add", "README.md");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  const board = new Board(join(dir, "board.sqlite"));
  const card = board.createCard({ title: "Review work", body: "", repo });
  const run = board.claim(card.id), worktree = join(data, "worktrees", card.id);
  git(repo, "worktree", "add", "-qb", `bakery/${card.id}`, worktree, "HEAD");
  board.attach(run.id, process.pid, worktree);
  board.finish(run.id, "review");
  const integration = new Integration(board, data);
  return { dir, repo, data, board, card: board.getCard(card.id)!, worktree, integration, close: () => { board.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("approval commits reviewed work, reconciles with newer main, and only then marks Done", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.worktree, "README.md"), "original\nreviewed\n");
    writeFileSync(join(item.worktree, "new.txt"), "new file\n");
    writeFileSync(join(item.repo, "main.txt"), "new main change\n");
    git(item.repo, "add", "main.txt");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "other work");
    const mainBefore = git(item.repo, "rev-parse", "HEAD");
    assert.throws(() => item.board.setStatus(item.card.id, "done"), /without approval/);
    const done = item.integration.approve(item.card);
    assert.equal(done.status, "done");
    assert.equal(item.board.wasIntegrated(item.card.id), true);
    assert.notEqual(git(item.repo, "rev-parse", "HEAD"), mainBefore);
    assert.equal(readFileSync(join(item.repo, "main.txt"), "utf8"), "new main change\n");
    assert.equal(readFileSync(join(item.repo, "README.md"), "utf8"), "original\nreviewed\n");
    assert.equal(readFileSync(join(item.repo, "new.txt"), "utf8"), "new file\n");
    assert.equal(git(item.repo, "status", "--porcelain"), "");
    assert.equal(git(item.worktree, "status", "--porcelain"), "");
    assert.deepEqual(item.board.listMergeFailures(item.repo), []);
    assert.equal(item.board.setStatus(item.card.id, "ready").status, "ready");
  } finally { item.close(); }
});

test("a conflict preserves the reviewed branch and keeps the card in Review", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.worktree, "README.md"), "card change\n");
    writeFileSync(join(item.repo, "README.md"), "main change\n");
    git(item.repo, "add", "README.md");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "other work");
    const mainBefore = git(item.repo, "rev-parse", "HEAD");
    assert.throws(() => item.integration.approve(item.card), error => {
      assert.ok(error instanceof IntegrationConflictError);
      assert.deepEqual(error.files, ["README.md"]);
      assert.equal(error.cardId, item.card.id);
      assert.match(error.details, /CONFLICT/);
      return true;
    });
    assert.equal(item.board.getCard(item.card.id)?.status, "review");
    assert.equal(git(item.repo, "rev-parse", "HEAD"), mainBefore);
    assert.equal(readFileSync(join(item.repo, "README.md"), "utf8"), "main change\n");
    assert.equal(readFileSync(join(item.worktree, "README.md"), "utf8"), "card change\n");
    assert.equal(item.board.getApproval(item.card.id), undefined);
    assert.deepEqual(item.board.listMergeFailures(item.repo).map(failure => failure.files), [["README.md"]]);
    const reopened = new Board(join(item.dir, "board.sqlite"));
    assert.deepEqual(reopened.listMergeFailures(item.repo).map(failure => failure.files), [["README.md"]]);
    assert.deepEqual(reopened.listMergeFailures(item.worktree), []);
    reopened.close();
    assert.throws(() => item.integration.approve(item.card), IntegrationConflictError);
    item.board.clearMergeFailure(item.card.id);
    assert.deepEqual(item.board.listMergeFailures(item.repo), []);
    assert.equal(git(item.repo, "status", "--porcelain"), "");
  } finally { item.close(); }
});

test("reviewed conflict resolution on the card branch can be approved without changing main first", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.worktree, "README.md"), "card change\n");
    writeFileSync(join(item.repo, "README.md"), "main change\n");
    git(item.repo, "add", "README.md");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "main change");
    const main = git(item.repo, "rev-parse", "main");
    assert.throws(() => item.integration.approve(item.card), IntegrationConflictError);
    assert.throws(() => git(item.worktree, "merge", "main"));
    writeFileSync(join(item.worktree, "README.md"), "main change\ncard change\n");
    git(item.worktree, "add", "README.md");
    git(item.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "resolve conflict on card branch");
    assert.equal(git(item.repo, "rev-parse", "main"), main);
    assert.equal(item.integration.approve(item.board.getCard(item.card.id)!).status, "done");
    assert.equal(readFileSync(join(item.repo, "README.md"), "utf8"), "main change\ncard change\n");
  } finally { item.close(); }
});

test("failed repair keeps merge diagnostics until a reviewed attempt completes", () => {
  const item = fixture();
  try {
    item.board.recordMergeFailure(item.card.id, ["README.md"], "old conflict");
    assert.equal(item.board.listMergeFailures(item.repo).length, 1);
    const failed = item.board.claim(item.card.id);
    assert.deepEqual(item.board.listMergeFailures(item.repo), []);
    item.board.finish(failed.id, "failed", "Pi failed");
    assert.equal(item.board.listMergeFailures(item.repo).length, 1);
    const repaired = item.board.claim(item.card.id);
    item.board.finish(repaired.id, "review");
    assert.deepEqual(item.board.listMergeFailures(item.repo), []);
  } finally { item.close(); }
});

test("ignored files in main cannot be overwritten by an approved card", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.worktree, "local.txt"), "reviewed file\n");
    git(item.worktree, "add", "local.txt");
    writeFileSync(join(item.repo, ".gitignore"), "local.txt\n");
    git(item.repo, "add", ".gitignore");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "ignore local file");
    writeFileSync(join(item.repo, "local.txt"), "important ignored data\n");
    assert.throws(() => item.integration.approve(item.card), /merge failed/);
    assert.equal(readFileSync(join(item.repo, "local.txt"), "utf8"), "important ignored data\n");
    assert.equal(item.board.getCard(item.card.id)?.status, "review");
  } finally { item.close(); }
});

test("approval resumes after main moved but before the Done status was saved", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.worktree, "README.md"), "reviewed\n");
    git(item.worktree, "add", "-A");
    git(item.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "reviewed work");
    const candidate = git(item.worktree, "rev-parse", "HEAD");
    const run = item.board.listRuns(item.card.id)[0];
    item.board.recordApproval(item.card.id, run.id, candidate);
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", candidate);
    const preparedHead = git(item.repo, "rev-parse", "HEAD");
    item.board.recordPreparedMerge(item.card.id, run.id, candidate, preparedHead);
    assert.equal(item.board.getCard(item.card.id)?.status, "review");
    assert.equal(item.integration.approve(item.board.getCard(item.card.id)!).status, "done");
    assert.equal(git(item.repo, "rev-parse", "HEAD"), preparedHead);
  } finally { item.close(); }
});

test("a changed main tip cannot silently complete an interrupted approval", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.worktree, "README.md"), "reviewed\n");
    git(item.worktree, "add", "-A");
    git(item.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "reviewed work");
    const candidate = git(item.worktree, "rev-parse", "HEAD"), run = item.board.listRuns(item.card.id)[0];
    item.board.recordApproval(item.card.id, run.id, candidate);
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", candidate);
    item.board.recordPreparedMerge(item.card.id, run.id, candidate, git(item.repo, "rev-parse", "HEAD"));
    writeFileSync(join(item.repo, "README.md"), "original\n");
    git(item.repo, "add", "README.md");
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "revert work");
    assert.throws(() => item.integration.approve(item.board.getCard(item.card.id)!), /Main changed after Bakery merged/);
    assert.equal(item.board.getCard(item.card.id)?.status, "review");
  } finally { item.close(); }
});

test("outside merges do not count as Bakery's prepared integration", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.worktree, "README.md"), "reviewed\n");
    git(item.worktree, "add", "-A");
    git(item.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "reviewed work");
    const candidate = git(item.worktree, "rev-parse", "HEAD");
    const run = item.board.listRuns(item.card.id)[0];
    item.board.recordApproval(item.card.id, run.id, candidate);
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "-s", "ours", "--no-ff", "--no-edit", candidate);
    assert.throws(() => item.integration.approve(item.board.getCard(item.card.id)!), /merged outside Bakery/);
    assert.equal(item.board.getCard(item.card.id)?.status, "review");
    assert.equal(readFileSync(join(item.repo, "README.md"), "utf8"), "original\n");
  } finally { item.close(); }
});

test("withdrawal unlocks revision but cannot hide an integration already on main", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.worktree, "README.md"), "reviewed\n");
    git(item.worktree, "add", "-A");
    git(item.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "reviewed work");
    const candidate = git(item.worktree, "rev-parse", "HEAD"), run = item.board.listRuns(item.card.id)[0];
    item.board.recordApproval(item.card.id, run.id, candidate);
    assert.throws(() => item.board.claim(item.card.id), /Approval is in progress/);
    item.integration.withdraw(item.card);
    assert.equal(item.board.getApproval(item.card.id), undefined);
    assert.equal(git(item.worktree, "rev-parse", "HEAD"), candidate);
    item.board.recordApproval(item.card.id, run.id, candidate);
    git(item.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", candidate);
    item.board.recordPreparedMerge(item.card.id, run.id, candidate, git(item.repo, "rev-parse", "HEAD"));
    assert.throws(() => item.integration.withdraw(item.card), /reached main/);
    assert.equal(item.board.getApproval(item.card.id)?.candidate, candidate);
  } finally { item.close(); }
});

test("dirty main blocks approval before staging or committing the card", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.worktree, "README.md"), "card change\n");
    writeFileSync(join(item.repo, "README.md"), "uncommitted main change\n");
    const cardBefore = git(item.worktree, "rev-parse", "HEAD");
    assert.throws(() => item.integration.approve(item.card), /Main worktree has changes/);
    assert.equal(git(item.worktree, "rev-parse", "HEAD"), cardBefore);
    assert.equal(item.board.getCard(item.card.id)?.status, "review");
    assert.equal(item.board.getApproval(item.card.id), undefined);
  } finally { item.close(); }
});

test("a legacy Done card with a reviewed run returns to Review for approval", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.worktree, "README.md"), "card change\n");
    // Simulate the old Mark done action on the real database, not a new public shortcut.
    const db = new DatabaseSync(join(item.dir, "board.sqlite"));
    db.prepare("UPDATE cards SET status='done' WHERE id=?").run(item.card.id); db.close();
    assert.equal(item.board.setStatus(item.card.id, "ready").status, "review");
    assert.equal(item.integration.approve(item.board.getCard(item.card.id)!).status, "done");
    assert.equal(readFileSync(join(item.repo, "README.md"), "utf8"), "card change\n");
    assert.ok(existsSync(item.worktree));
  } finally { item.close(); }
});
