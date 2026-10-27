import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { emptyAgentModels, validateAgentModels } from "../server/agent-models.js";
import { DatabaseSync } from "node:sqlite";

test("manual cards persist and only one active attempt may be claimed", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const board = new Board(join(dir, "board.sqlite"));
    const card = board.createCard({ title: "Fix the feed", body: "Reproduce first", repo: dir });
    assert.equal(board.listCards()[0]?.title, "Fix the feed");
    assert.equal(card.status, "triage");
    assert.throws(() => board.claim(card.id), /Move.*Ready/);
    assert.equal(board.listRuns(card.id).length, 0);
    assert.equal(board.setStatus(card.id, "ready").status, "ready");
    const run = board.claim(card.id);
    assert.equal(run.attempt, 1);
    assert.throws(() => board.claim(card.id), /active run/);
    board.finish(run.id, "failed", "Worker exited");
    assert.equal(board.claim(card.id).attempt, 2);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only Done cards on the same board archive, atomically, and restore to Done", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const board = new Board(join(dir, "board.sqlite"));
    const [a, b, open] = ["A", "B", "Open"].map(title => board.createCard({ title, body: "", repo: dir }));
    const other = board.createCard({ title: "Other", body: "", repo: join(dir, "other") });
    for (const card of [a, b, other]) board.setStatus(card.id, "done");
    assert.throws(() => board.setArchived(dir, [a.id, open.id], true), /Only Done/);
    assert.throws(() => board.setArchived(dir, [a.id, other.id], true), /not found on this board/);
    assert.throws(() => board.setArchived(dir, [], true), /between 1 and 500/);
    assert.equal(board.getCard(a.id)?.status, "done", "a rejected batch changes nothing");
    assert.deepEqual(board.setArchived(dir, [a.id, b.id, a.id], true).map(card => card.status), ["archived", "archived"]);
    assert.throws(() => board.setStatus(a.id, "ready"), /Restore this archived card/);
    assert.throws(() => board.claim(a.id), /Restore this archived card/);
    assert.throws(() => board.setArchived(dir, [a.id], true), /Only Done/);
    assert.equal(board.setArchived(dir, [a.id], false)[0].status, "done");
    assert.throws(() => board.setArchived(dir, [a.id], false), /Only archived/);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("existing Ready cards stay Ready when the database opens", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const path = join(dir, "board.sqlite"), first = new Board(path);
    const card = first.createCard({ title: "Already approved", body: "", repo: dir });
    first.close();
    const legacy = new DatabaseSync(path);
    legacy.prepare("UPDATE cards SET status='ready' WHERE id=?").run(card.id);
    legacy.close();
    const upgraded = new Board(path);
    assert.equal(upgraded.getCard(card.id)?.status, "ready");
    assert.equal(upgraded.claim(card.id).attempt, 1);
    upgraded.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an idempotency key returns the board's existing card, in any status", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const board = new Board(join(dir, "board.sqlite")), other = join(dir, "other");
    const first = board.createCard({ title: "Nightly", body: "", repo: dir, idempotencyKey: "nightly-1" });
    assert.equal(first.idempotencyKey, "nightly-1");
    const again = board.createCard({ title: "Changed title", body: "x", repo: dir, idempotencyKey: "nightly-1" });
    assert.equal(again.id, first.id);
    assert.equal(again.title, "Nightly");
    board.setStatus(first.id, "done");
    board.setArchived(dir, [first.id], true);
    assert.equal(board.createCard({ title: "Nightly", body: "", repo: dir, idempotencyKey: "nightly-1" }).id, first.id, "archived cards still match");
    const elsewhere = board.createCard({ title: "Nightly", body: "", repo: other, idempotencyKey: "nightly-1" });
    assert.notEqual(elsewhere.id, first.id, "another board can reuse the key");
    const plain = [board.createCard({ title: "Plain", body: "", repo: dir }), board.createCard({ title: "Plain", body: "", repo: dir })];
    assert.notEqual(plain[0].id, plain[1].id);
    assert.equal(plain[0].idempotencyKey, null);
    assert.equal(board.listCards(dir).length, 3);
    assert.throws(() => board.createCard({ title: "Long", body: "", repo: dir, idempotencyKey: "k".repeat(201) }), /1 to 200/);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("older card tables gain a nullable idempotency key with a per-board unique index", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const path = join(dir, "board.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, repo TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)");
    legacy.prepare("INSERT INTO cards VALUES ('old', 'Old', '', ?, 'triage', 'manual', '2025-01-01', '2025-01-01')").run(dir);
    legacy.close();
    const board = new Board(path);
    assert.equal(board.getCard("old")?.idempotencyKey, null);
    const keyed = board.createCard({ title: "New", body: "", repo: dir, idempotencyKey: "k" });
    board.close();
    const raw = new DatabaseSync(path);
    assert.throws(() => raw.prepare("INSERT INTO cards(id, title, body, repo, status, source, idempotencyKey, createdAt, updatedAt) VALUES ('dup', 'Dup', '', ?, 'triage', 'manual', 'k', '', '')").run(dir), /UNIQUE/);
    raw.close();
    assert.ok(keyed.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("settings default to notifications off and persist across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const path = join(dir, "board.sqlite"), first = new Board(path);
    assert.deepEqual(first.getSettings(), { confirmRunStart: false, notifyOnReview: false, cardDetailsLayout: "dialog", theme: "default", density: "default", agentModels: emptyAgentModels() });
    assert.deepEqual(first.updateSettings({ confirmRunStart: true }), { confirmRunStart: true, notifyOnReview: false, cardDetailsLayout: "dialog", theme: "default", density: "default", agentModels: emptyAgentModels() });
    assert.equal(first.updateSettings({ density: "cozy" }).density, "cozy");
    assert.equal(first.updateSettings({ density: "default" }).density, "default");
    assert.deepEqual(first.updateSettings({ cardDetailsLayout: "side" }), { confirmRunStart: true, notifyOnReview: false, cardDetailsLayout: "side", theme: "default", density: "default", agentModels: emptyAgentModels() });
    assert.deepEqual(first.updateSettings({ theme: "compline", notifyOnReview: true }), { confirmRunStart: true, notifyOnReview: true, cardDetailsLayout: "side", theme: "compline", density: "default", agentModels: emptyAgentModels() });
    first.close();
    const second = new Board(path);
    assert.deepEqual(second.getSettings(), { confirmRunStart: true, notifyOnReview: true, cardDetailsLayout: "side", theme: "compline", density: "default", agentModels: emptyAgentModels() });
    assert.deepEqual(second.updateSettings({ theme: "light" }), { confirmRunStart: true, notifyOnReview: true, cardDetailsLayout: "side", theme: "light", density: "default", agentModels: emptyAgentModels() });
    assert.deepEqual(second.updateSettings({ theme: "default" }), { confirmRunStart: true, notifyOnReview: true, cardDetailsLayout: "side", theme: "default", density: "default", agentModels: emptyAgentModels() });
    second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("existing settings databases gain the Default theme without losing preferences", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-theme-migration-"));
  try {
    const path = join(dir, "board.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE settings (id INTEGER PRIMARY KEY, confirmRunStart INTEGER NOT NULL, cardDetailsLayout TEXT NOT NULL)");
    legacy.exec("INSERT INTO settings VALUES (1, 1, 'side')");
    legacy.close();
    const board = new Board(path);
    assert.deepEqual(board.getSettings(), { confirmRunStart: true, notifyOnReview: false, cardDetailsLayout: "side", theme: "default", density: "default", agentModels: emptyAgentModels() });
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a Compline database can save Light without losing its preferences", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-theme-upgrade-"));
  try {
    const path = join(dir, "board.sqlite");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), confirmRunStart INTEGER NOT NULL, cardDetailsLayout TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'default' CHECK(theme IN ('default', 'compline'))); INSERT INTO settings VALUES (1, 1, 'side', 'compline')");
    old.close();
    const board = new Board(path);
    assert.deepEqual(board.getSettings(), { confirmRunStart: true, notifyOnReview: false, cardDetailsLayout: "side", theme: "compline", density: "default", agentModels: emptyAgentModels() });
    assert.deepEqual(board.updateSettings({ theme: "light" }), { confirmRunStart: true, notifyOnReview: false, cardDetailsLayout: "side", theme: "light", density: "default", agentModels: emptyAgentModels() });
    board.close();
    const reopened = new Board(path);
    assert.equal(reopened.getSettings().theme, "light");
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a database from before Hearth can save it without losing density or models", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-hearth-upgrade-"));
  try {
    const path = join(dir, "board.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), confirmRunStart INTEGER NOT NULL, cardDetailsLayout TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'default' CHECK(theme IN ('default', 'compline', 'light')), notifyOnReview INTEGER NOT NULL DEFAULT 0, agentModels TEXT NOT NULL DEFAULT '{}', density TEXT NOT NULL DEFAULT 'default');
      INSERT INTO settings VALUES (1, 1, 'side', 'light', 1, '{}', 'cozy');`);
    old.close();
    const board = new Board(path);
    assert.deepEqual(board.updateSettings({ theme: "hearth" }), { confirmRunStart: true, notifyOnReview: true, cardDetailsLayout: "side", theme: "hearth", density: "cozy", agentModels: emptyAgentModels() });
    board.close();
    const reopened = new Board(path);
    assert.equal(reopened.getSettings().theme, "hearth");
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an older Dark preference maps to the unchanged Default palette", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-dark-upgrade-"));
  try {
    const path = join(dir, "board.sqlite");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), confirmRunStart INTEGER NOT NULL, cardDetailsLayout TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'dark' CHECK(theme IN ('dark', 'light'))); INSERT INTO settings VALUES (1, 1, 'side', 'dark')");
    old.close();
    const board = new Board(path);
    assert.deepEqual(board.getSettings(), { confirmRunStart: true, notifyOnReview: false, cardDetailsLayout: "side", theme: "default", density: "default", agentModels: emptyAgentModels() });
    assert.equal(board.updateSettings({ theme: "compline" }).theme, "compline");
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review comments remain on their original snapshot and feedback persists until a new reviewed run", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-feedback-"));
  try {
    const path = join(dir, "board.sqlite"), board = new Board(path);
    const card = board.createCard({ title: "Review", body: "", repo: dir });
    board.setStatus(card.id, "ready");
    const first = board.claim(card.id);
    board.finish(first.id, "review");
    const fingerprint = "a".repeat(64);
    const comment = board.addReviewComment(card.id, first.id, fingerprint, "src/app.ts", 12, "add", "const next = 1;", "Please handle null", 42);
    assert.equal(board.listReviewComments(card.id)[0]?.id, comment.id);
    assert.equal(board.listReviewComments(card.id)[0]?.fileLine, 42);
    const stale = board.addReviewComment(card.id, first.id, "b".repeat(64), "src/app.ts", 8, "remove", "old", "Old draft");
    assert.throws(() => board.requestChanges(card.id, first.id, fingerprint), /Remove draft comments on older diffs/);
    assert.equal(board.hasDraftReviewComments(card.id, first.id), true);
    board.deleteReviewComment(card.id, stale.id);
    assert.throws(() => board.requestChanges(card.id, first.id, "b".repeat(64)), /current diff|comments/i);
    assert.deepEqual([board.getCard(card.id)?.attempts, board.getCard(card.id)?.reviewRounds], [1, 0]);
    board.requestChanges(card.id, first.id, fingerprint);
    assert.equal(board.getCard(card.id)?.reviewRounds, 1);
    assert.equal(board.hasDraftReviewComments(card.id, first.id), false);
    assert.equal(board.hasRequestedChanges(card.id, first.id), true);
    assert.deepEqual(board.getFeedbackForRun(card.id).map(item => item.body), ["Please handle null"]);
    assert.throws(() => board.addReviewComment(card.id, first.id, fingerprint, "src/app.ts", 14, "add", "x", "More"), /already requested/i);
    const retry = board.claim(card.id);
    assert.deepEqual(board.getFeedbackForRun(card.id).map(item => item.id), [comment.id]);
    board.finish(retry.id, "failed");
    assert.deepEqual(board.getFeedbackForRun(card.id).map(item => item.id), [comment.id]);
    const next = board.claim(card.id);
    board.finish(next.id, "review");
    assert.deepEqual(board.getFeedbackForRun(card.id), []);
    assert.deepEqual([board.listCards(dir)[0]?.attempts, board.listCards(dir)[0]?.reviewRounds], [3, 1]);
    assert.equal(board.listReviewComments(card.id)[0]?.runId, first.id);
    board.close();
    const reopened = new Board(path);
    assert.equal(reopened.listReviewComments(card.id)[0]?.body, "Please handle null");
    reopened.close();
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
    first.setStatus(card.id, "ready");
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

test("existing boards gain default appearance without losing settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-appearance-upgrade-"));
  const path = join(dir, "board.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE boards (id TEXT PRIMARY KEY, repo TEXT NOT NULL UNIQUE, archived INTEGER NOT NULL DEFAULT 0, autoCollapseEmptySwimlanes INTEGER NOT NULL DEFAULT 0)");
    legacy.prepare("INSERT INTO boards(id, repo, autoCollapseEmptySwimlanes) VALUES (?, ?, 1)").run("old", dir);
    legacy.close();
    const board = new Board(path);
    assert.deepEqual([board.getBoard("old")?.icon, board.getBoard("old")?.color, board.getBoard("old")?.autoCollapseEmptySwimlanes, board.getBoard("old")?.remoteUrl], ["layout-grid", "violet", true, ""]);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("repository appearance is independent, survives restart, and stays with an archived board", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-appearance-"));
  const path = join(dir, "board.sqlite");
  try {
    const board = new Board(path);
    const first = board.addRepo(join(dir, "first"));
    const second = board.addRepo(join(dir, "second"));
    assert.equal(first.icon, "layout-grid");
    assert.equal(first.color, "violet");
    assert.deepEqual([second.icon, second.color], ["layout-grid", "violet"]);
    assert.deepEqual([board.setAppearance(first.id, "rocket", "coral").icon, board.getBoard(first.id)?.color], ["rocket", "coral"]);
    assert.deepEqual([board.getBoard(second.id)?.icon, board.getBoard(second.id)?.color], ["layout-grid", "violet"]);
    assert.equal(board.setRemoteUrl(first.id, "https://github.com/o/first").remoteUrl, "https://github.com/o/first");
    assert.throws(() => board.setRemoteUrl(first.id, "file:///etc/passwd"), /http/);
    assert.equal(board.getBoard(second.id)?.remoteUrl, "");
    board.archiveBoard(first.id);
    board.close();
    const reopened = new Board(path);
    assert.deepEqual([reopened.addRepo(join(dir, "first")).icon, reopened.getBoard(first.id)?.color], ["rocket", "coral"]);
    assert.equal(reopened.getBoard(first.id)?.remoteUrl, "https://github.com/o/first");
    reopened.close();
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
    reopened.setStatus(card.id, "ready");
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
    board.setStatus(card.id, "ready");
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
    legacy.prepare("INSERT INTO runs(id, cardId, attempt, status, sessionId, output, startedAt) VALUES ('old-run', 'old-card', 1, 'review', 'old-session', ?, '2026-01-01')").run("\nTurn 1: read ×1\nTurn 3: bash ×1\n");
    legacy.close();
    const board = new Board(path);
    assert.deepEqual(board.listRepos(), [repo]);
    assert.equal(board.listCards(repo)[0]?.id, "old-card");
    assert.equal(board.listCards(repo)[0]?.priority, 0, "cards from before priorities migrate to Normal");
    assert.equal(board.listRuns("old-card")[0]?.sessionId, "old-session");
    assert.equal(board.listCards(repo)[0]?.turns, 3);
    assert.equal(board.listCards(repo)[0]?.turnsIncomplete, 1);
    assert.equal(board.listRuns("old-card")[0]?.cost, null, "pre-usage attempts show no recorded cost");
    assert.equal(board.listRuns("old-card")[0]?.inputTokens, null);
    assert.equal(board.listCards(repo)[0]?.cost, null);
    const next = board.claim("old-card");
    assert.equal(board.getRun(next.id)?.cost, 0, "new attempts start recording at zero");
    board.recordUsage(next.id, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.5 });
    assert.equal(board.listCards(repo)[0]?.cost, 0.5);
    assert.equal(board.listCards(repo)[0]?.usageIncomplete, 1);
    board.completeTurn(next.id);
    board.completeTurn(next.id);
    assert.equal(board.listCards(repo)[0]?.turns, 5);
    board.finish(next.id, "review");
    board.close();
    const reopened = new Board(path);
    assert.deepEqual(reopened.listRepos(), [repo]);
    assert.equal(reopened.listCards(repo)[0]?.turns, 5);
    assert.equal(reopened.listCards(repo)[0]?.turnsIncomplete, 1);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("older approval tables gain prepared merge columns without losing pending approvals", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const path = join(dir, "board.sqlite"), first = new Board(path);
    const closed = first.createCard({ title: "Collapse", body: "", repo: dir });
    first.setStatus(closed.id, "ready");
    const closedRun = first.claim(closed.id);
    first.finish(closedRun.id, "review");
    const pending = first.createCard({ title: "Pending", body: "", repo: dir });
    first.setStatus(pending.id, "ready");
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
    assert.equal(reopened.getBoard(item.id)?.autoCollapseEmptySwimlanes, false);
    assert.equal(reopened.getBoard(item.id)?.pickupDailyLimit, 6);
    assert.equal(reopened.getBoard(item.id)?.autoPickupStarts, 0);
    assert.equal(reopened.getBoard(item.id)?.autoPickupNextAt, null);
    assert.equal(reopened.setAutoCollapseEmptySwimlanes(item.id, true).autoCollapseEmptySwimlanes, true);
    reopened.close();
    const persisted = new Board(path);
    assert.equal(persisted.listBoards()[0]?.autoCollapseEmptySwimlanes, true);
    persisted.archiveBoard(item.id);
    assert.deepEqual(persisted.listBoards(), []);
    persisted.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restart preserves interrupted work as blocked rather than dispatching it again", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const path = join(dir, "board.sqlite");
    const first = new Board(path);
    const card = first.createCard({ title: "A ticket", body: "", repo: dir });
    first.setStatus(card.id, "ready");
    first.claim(card.id);
    first.close();
    const second = new Board(path);
    second.recoverInterruptedRuns();
    assert.equal(second.listCards()[0]?.status, "interrupted");
    assert.throws(() => second.claim(card.id), /interrupted/);
    assert.equal(second.resolveInterrupted(card.id).status, "failed");
    assert.equal(second.claim(card.id).attempt, 2);
    second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("card counts are grouped by repository and status", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-test-"));
  try {
    const board = new Board(join(dir, "board.sqlite"));
    const other = join(dir, "other");
    const [a] = ["A", "B"].map(title => board.createCard({ title, body: "", repo: dir }));
    board.setStatus(a!.id, "ready");
    board.createCard({ title: "C", body: "", repo: other });
    assert.deepEqual(board.cardCounts(), { [dir]: { triage: 1, ready: 1 }, [other]: { triage: 1 } });
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("older databases gain inheriting Pi model settings; repository overrides resolve before global defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-models-"));
  const path = join(dir, "board.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE boards (id TEXT PRIMARY KEY, repo TEXT NOT NULL UNIQUE, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), confirmRunStart INTEGER NOT NULL, cardDetailsLayout TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'default' CHECK(theme IN ('default', 'compline', 'light')), notifyOnReview INTEGER NOT NULL DEFAULT 0);
      INSERT INTO settings VALUES (1, 1, 'side', 'light', 1);`);
    legacy.prepare("INSERT INTO boards(id, repo) VALUES (?, ?)").run("old", dir);
    legacy.close();
    const board = new Board(path);
    assert.deepEqual(board.getSettings(), { confirmRunStart: true, notifyOnReview: true, cardDetailsLayout: "side", theme: "light", density: "default", agentModels: emptyAgentModels() });
    assert.deepEqual(board.getBoard("old")?.agentModels, emptyAgentModels());
    assert.deepEqual(board.agentModelFor(dir, "work"), { model: "", thinking: "" });
    assert.throws(() => board.updateSettings({ agentModels: { work: { model: "--version", thinking: "" } } as never }), /model must be/);
    assert.throws(() => board.setAgentModels("old", { work: { thinking: "maximal" } }), /thinking must be/);
    assert.throws(() => board.setAgentModels("old", { merge: {} }), /Unknown agent phase/);
    assert.throws(() => board.setAgentModels("missing", {}), /Board not found/);
    board.updateSettings({ agentModels: validateAgentModels({ work: { model: "anthropic/claude-sonnet-4-5", thinking: "medium" }, review: { model: "openai-codex/gpt-5.5" } }) });
    board.setAgentModels("old", { work: { model: "openai-codex/gpt-5.5" }, review: { thinking: "high" }, draft: { model: "anthropic/claude-haiku-4-5", thinking: "off" } });
    const other = board.addRepo(join(dir, "other"));
    board.close();
    const reopened = new Board(path);
    assert.deepEqual(reopened.agentModelFor(dir, "work"), { model: "openai-codex/gpt-5.5", thinking: "medium" });
    assert.deepEqual(reopened.agentModelFor(dir, "conflict"), { model: "", thinking: "" });
    assert.deepEqual(reopened.agentModelFor(dir, "review"), { model: "openai-codex/gpt-5.5", thinking: "high" });
    assert.deepEqual(reopened.agentModelFor(dir, "draft"), { model: "anthropic/claude-haiku-4-5", thinking: "off" });
    assert.deepEqual(reopened.agentModelFor(other.repo, "draft"), { model: "", thinking: "" });
    assert.deepEqual(reopened.agentModelFor(other.repo, "work"), { model: "anthropic/claude-sonnet-4-5", thinking: "medium" });
    assert.equal(reopened.getSettings().theme, "light");
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
