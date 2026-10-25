import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { DatabaseSync } from "node:sqlite";

test("manual cards persist and only one active attempt may be claimed", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const board = new Board(join(dir, "board.sqlite"));
    const card = board.createCard({ title: "Fix the feed", body: "Reproduce first", repo: dir });
    assert.equal(board.listCards()[0]?.title, "Fix the feed");
    const run = board.claim(card.id);
    assert.equal(run.attempt, 1);
    assert.throws(() => board.claim(card.id), /active run/);
    board.finish(run.id, "failed", "Worker exited");
    assert.equal(board.claim(card.id).attempt, 2);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run confirmation preference defaults off and persists across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const path = join(dir, "board.sqlite"), first = new Board(path);
    assert.deepEqual(first.getSettings(), { confirmRunStart: false });
    assert.deepEqual(first.updateSettings({ confirmRunStart: true }), { confirmRunStart: true });
    first.close();
    const second = new Board(path);
    assert.deepEqual(second.getSettings(), { confirmRunStart: true });
    second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("repository boards retain cards and keep attempted work in its original repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const path = join(dir, "board.sqlite"), first = new Board(path);
    const alpha = join(dir, "alpha"), beta = join(dir, "beta");
    first.addRepo(alpha);
    first.addRepo(beta);
    const card = first.createCard({ title: "Alpha work", body: "", repo: alpha });
    first.createCard({ title: "Beta work", body: "", repo: beta });
    assert.deepEqual(first.listRepos(), [alpha, beta]);
    assert.deepEqual(first.listCards(alpha).map(item => item.title), ["Alpha work"]);
    assert.deepEqual(first.listCards(beta).map(item => item.title), ["Beta work"]);
    const run = first.claim(card.id);
    first.finish(run.id, "failed");
    assert.throws(() => first.updateCard(card.id, { title: "Moved", body: "", repo: beta }), /repository/i);
    first.close();
    const second = new Board(path);
    assert.deepEqual(second.listRepos(), [alpha, beta]);
    assert.deepEqual(second.listCards(alpha).map(item => item.title), ["Alpha work"]);
    second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edit a board before attempts and remove it without deleting cards", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const path = join(dir, "board.sqlite"), oldRoot = join(dir, "wrong"), root = join(dir, "repo");
    const board = new Board(path);
    const old = board.addRepo(oldRoot);
    const card = board.createCard({ title: "Keep this card", body: "", repo: oldRoot });
    assert.equal(board.renameBoard(old.id, root).repo, root);
    assert.equal(board.getCard(card.id)?.repo, root);
    assert.deepEqual(board.listCards(oldRoot), []);
    board.archiveBoard(old.id);
    assert.deepEqual(board.listBoards(), []);
    assert.equal(board.getCard(card.id)?.title, "Keep this card");
    board.close();
    const reopened = new Board(path);
    assert.deepEqual(reopened.listBoards(), []);
    assert.equal(reopened.addRepo(root).id, old.id);
    assert.equal(reopened.listCards(root)[0]?.id, card.id);
    const run = reopened.claim(card.id);
    reopened.finish(run.id, "review");
    assert.throws(() => reopened.renameBoard(old.id, oldRoot), /attempt/);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cannot remove a board while a run is active or interrupted", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const path = join(dir, "board.sqlite"), repo = join(dir, "repo");
    const board = new Board(path), item = board.addRepo(repo);
    const card = board.createCard({ title: "In progress", body: "", repo });
    board.claim(card.id);
    assert.throws(() => board.archiveBoard(item.id), /running or interrupted/);
    board.close();
    const restarted = new Board(path);
    assert.throws(() => restarted.archiveBoard(item.id), /running or interrupted/);
    restarted.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("existing cards become repository boards without losing runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const path = join(dir, "board.sqlite"), repo = join(dir, "repo");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, repo TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY, cardId TEXT NOT NULL REFERENCES cards(id), attempt INTEGER NOT NULL, status TEXT NOT NULL, pid INTEGER, worktree TEXT, sessionId TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', error TEXT, startedAt TEXT NOT NULL, finishedAt TEXT, UNIQUE(cardId, attempt));`);
    legacy.prepare("INSERT INTO cards VALUES (?, 'Before migration', '', ?, 'review', 'manual', '2026-01-01', '2026-01-01')").run("old-card", repo);
    legacy.prepare("INSERT INTO runs(id, cardId, attempt, status, sessionId, startedAt) VALUES ('old-run', 'old-card', 1, 'review', 'old-session', '2026-01-01')").run();
    legacy.close();
    const board = new Board(path);
    assert.deepEqual(board.listRepos(), [repo]);
    assert.equal(board.listCards(repo)[0]?.id, "old-card");
    assert.equal(board.listRuns("old-card")[0]?.sessionId, "old-session");
    board.close();
    const reopened = new Board(path);
    assert.deepEqual(reopened.listRepos(), [repo]);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("older approval tables gain prepared merge columns without losing pending approvals", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const path = join(dir, "board.sqlite"), first = new Board(path);
    const closed = first.createCard({ title: "Collapse", body: "", repo: dir });
    const closedRun = first.claim(closed.id);
    first.finish(closedRun.id, "review");
    const pending = first.createCard({ title: "Pending", body: "", repo: dir });
    const pendingRun = first.claim(pending.id);
    first.finish(pendingRun.id, "review");
    first.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE approvals; CREATE TABLE approvals (cardId TEXT PRIMARY KEY, runId TEXT NOT NULL, candidate TEXT NOT NULL)");
    legacy.prepare("INSERT INTO approvals VALUES (?, ?, ?)").run(pending.id, pendingRun.id, "old-commit");
    legacy.prepare("UPDATE cards SET status='done' WHERE id=?").run(closed.id);
    legacy.close();

    const upgraded = new Board(path);
    assert.equal(upgraded.setStatus(closed.id, "ready").status, "review");
    assert.deepEqual({ ...upgraded.getApproval(pending.id) }, { cardId: pending.id, runId: pendingRun.id, candidate: "old-commit", preparedHead: null, merged: 0 });
    upgraded.close();
    const reopened = new Board(path);
    assert.equal(reopened.getApproval(pending.id)?.candidate, "old-commit");
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("existing repository boards gain removal support on upgrade", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const path = join(dir, "board.sqlite"), repo = join(dir, "repo");
    const first = new Board(path);
    const item = first.addRepo(repo);
    first.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("ALTER TABLE boards RENAME TO boards_new");
    legacy.exec("CREATE TABLE boards (id TEXT PRIMARY KEY, repo TEXT NOT NULL UNIQUE)");
    legacy.exec("INSERT INTO boards(id, repo) SELECT id, repo FROM boards_new");
    legacy.exec("DROP TABLE boards_new");
    legacy.close();
    const reopened = new Board(path);
    assert.equal(reopened.getBoard(item.id)?.repo, repo);
    reopened.archiveBoard(item.id);
    assert.deepEqual(reopened.listBoards(), []);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restart preserves interrupted work as blocked rather than dispatching it again", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const path = join(dir, "board.sqlite");
    const first = new Board(path);
    const card = first.createCard({ title: "A ticket", body: "", repo: dir });
    first.claim(card.id);
    first.close();
    const second = new Board(path);
    assert.equal(second.listCards()[0]?.status, "interrupted");
    assert.throws(() => second.claim(card.id), /interrupted/);
    assert.equal(second.resolveInterrupted(card.id).status, "failed");
    assert.equal(second.claim(card.id).attempt, 2);
    second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
