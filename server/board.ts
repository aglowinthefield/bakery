import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type CardStatus = "triage" | "ready" | "running" | "review" | "failed" | "interrupted" | "done";
export type RepoBoard = { id: string; repo: string; autoCollapseEmptySwimlanes: boolean; autoReviewEnabled: boolean; verificationCommand: string; autoReviewEnabledAt: string | null; autoPickupEnabled: boolean; pickupConcurrency: number; pickupDailyLimit: number; autoPickupStarts: number; autoPickupNextAt: string | null; autoPickupEnabledAt: string | null; autoPickupError: string };
export type BakerySettings = { confirmRunStart: boolean; cardDetailsLayout: "dialog" | "side"; theme: "default" | "compline" };
type BoardRow = { id: string; repo: string; autoCollapseEmptySwimlanes: number; autoReviewEnabled: number; verificationCommand: string; autoReviewEnabledAt: string | null; autoPickupEnabled: number; pickupConcurrency: number; pickupDailyLimit: number; autoPickupResetRunRowid: number; autoPickupEnabledAt: string | null; autoPickupError: string };
const toRepoBoard = (row: BoardRow, starts: string[]): RepoBoard => ({
  id: row.id, repo: row.repo, verificationCommand: row.verificationCommand,
  autoReviewEnabledAt: row.autoReviewEnabledAt, pickupConcurrency: row.pickupConcurrency,
  pickupDailyLimit: row.pickupDailyLimit, autoPickupEnabledAt: row.autoPickupEnabledAt, autoPickupError: row.autoPickupError,
  autoCollapseEmptySwimlanes: row.autoCollapseEmptySwimlanes !== 0,
  autoReviewEnabled: row.autoReviewEnabled !== 0, autoPickupEnabled: row.autoPickupEnabled !== 0,
  autoPickupStarts: starts.length,
  autoPickupNextAt: starts.length >= row.pickupDailyLimit
    ? new Date(Date.parse(starts[starts.length - row.pickupDailyLimit]) + 86_400_000).toISOString() : null,
});
export type Card = { id: string; title: string; body: string; repo: string; status: CardStatus; source: "manual"; createdAt: string; updatedAt: string; turns: number; turnsIncomplete: number };
export type Run = { id: string; cardId: string; attempt: number; status: "running" | "review" | "failed" | "interrupted"; pid: number | null; worktree: string | null; sessionId: string; output: string; error: string | null; startedAt: string; finishedAt: string | null; turns: number; turnsIncomplete: number; startedBy: "manual" | "auto" };
export type Approval = { cardId: string; runId: string; candidate: string; preparedHead: string | null; merged: number };
export type AutoReviewJob = { cardId: string; runId: string; state: "running" | "needs_human" | "merged"; details: string; fingerprint: string; startedAt: string; finishedAt: string | null };
export type MergeFailure = { cardId: string; files: string[]; details: string };
export type ReviewComment = { id: string; cardId: string; runId: string; fingerprint: string; path: string; line: number; fileLine: number | null; kind: "add" | "remove" | "context"; code: string; body: string; state: "draft" | "requested"; createdAt: string };
const boardFields = "id, repo, autoCollapseEmptySwimlanes, autoReviewEnabled, verificationCommand, autoReviewEnabledAt, autoPickupEnabled, pickupConcurrency, pickupDailyLimit, autoPickupResetRunRowid, autoPickupEnabledAt, autoPickupError";
const now = () => new Date().toISOString();
const cardQuery = `SELECT cards.*, COALESCE(SUM(runs.turns), 0) AS turns, COALESCE(MAX(runs.turnsIncomplete), 0) AS turnsIncomplete
  FROM cards LEFT JOIN runs ON runs.cardId=cards.id`;

export class Board {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, repo TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, cardId TEXT NOT NULL REFERENCES cards(id), attempt INTEGER NOT NULL, status TEXT NOT NULL, pid INTEGER, worktree TEXT, sessionId TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', error TEXT, startedAt TEXT, finishedAt TEXT, turns INTEGER NOT NULL DEFAULT 0, turnsIncomplete INTEGER NOT NULL DEFAULT 0, startedBy TEXT NOT NULL DEFAULT 'manual', UNIQUE(cardId, attempt));
      CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, repo TEXT NOT NULL UNIQUE, archived INTEGER NOT NULL DEFAULT 0, autoCollapseEmptySwimlanes INTEGER NOT NULL DEFAULT 0, autoReviewEnabled INTEGER NOT NULL DEFAULT 0, verificationCommand TEXT NOT NULL DEFAULT '', autoReviewEnabledAt TEXT, autoPickupEnabled INTEGER NOT NULL DEFAULT 0, pickupConcurrency INTEGER NOT NULL DEFAULT 2, pickupDailyLimit INTEGER NOT NULL DEFAULT 6, autoPickupResetRunRowid INTEGER NOT NULL DEFAULT 0, autoPickupEnabledAt TEXT, autoPickupError TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS approvals (cardId TEXT PRIMARY KEY, runId TEXT NOT NULL, candidate TEXT NOT NULL, preparedHead TEXT, merged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS merge_failures (cardId TEXT PRIMARY KEY, files TEXT NOT NULL, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auto_review_jobs (cardId TEXT NOT NULL, runId TEXT NOT NULL PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('running','needs_human','merged')), details TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '', startedAt TEXT NOT NULL, finishedAt TEXT);
      CREATE TABLE IF NOT EXISTS review_comments (id TEXT PRIMARY KEY, cardId TEXT NOT NULL REFERENCES cards(id), runId TEXT NOT NULL REFERENCES runs(id), fingerprint TEXT NOT NULL, path TEXT NOT NULL, line INTEGER NOT NULL, fileLine INTEGER, kind TEXT NOT NULL CHECK(kind IN ('add','remove','context')), code TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','requested')), createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS review_comments_card ON review_comments(cardId, runId, state);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), confirmRunStart INTEGER NOT NULL CHECK(confirmRunStart IN (0, 1)), cardDetailsLayout TEXT NOT NULL DEFAULT 'dialog' CHECK(cardDetailsLayout IN ('dialog', 'side')));
      INSERT OR IGNORE INTO settings(id, confirmRunStart) VALUES (1, 0);`);
    const commentColumns = new Set((this.db.prepare("PRAGMA table_info(review_comments)").all() as { name: string }[]).map(column => column.name));
    if (!commentColumns.has("fileLine")) this.db.exec("ALTER TABLE review_comments ADD COLUMN fileLine INTEGER");
    const settingsColumns = new Set((this.db.prepare("PRAGMA table_info(settings)").all() as { name: string }[]).map(column => column.name));
    if (!settingsColumns.has("cardDetailsLayout")) this.db.exec("ALTER TABLE settings ADD COLUMN cardDetailsLayout TEXT NOT NULL DEFAULT 'dialog' CHECK(cardDetailsLayout IN ('dialog', 'side'))");
    if (!settingsColumns.has("theme")) this.db.exec("ALTER TABLE settings ADD COLUMN theme TEXT NOT NULL DEFAULT 'default' CHECK(theme IN ('default', 'compline'))");
    const boardColumns = new Set((this.db.prepare("PRAGMA table_info(boards)").all() as { name: string }[]).map(column => column.name));
    if (!boardColumns.has("archived")) this.db.exec("ALTER TABLE boards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    if (!boardColumns.has("autoCollapseEmptySwimlanes")) this.db.exec("ALTER TABLE boards ADD COLUMN autoCollapseEmptySwimlanes INTEGER NOT NULL DEFAULT 0");
    if (!boardColumns.has("autoReviewEnabled")) this.db.exec("ALTER TABLE boards ADD COLUMN autoReviewEnabled INTEGER NOT NULL DEFAULT 0");
    if (!boardColumns.has("verificationCommand")) this.db.exec("ALTER TABLE boards ADD COLUMN verificationCommand TEXT NOT NULL DEFAULT ''");
    if (!boardColumns.has("autoReviewEnabledAt")) this.db.exec("ALTER TABLE boards ADD COLUMN autoReviewEnabledAt TEXT");
    if (!boardColumns.has("autoPickupEnabled")) this.db.exec("ALTER TABLE boards ADD COLUMN autoPickupEnabled INTEGER NOT NULL DEFAULT 0");
    if (!boardColumns.has("pickupConcurrency")) this.db.exec("ALTER TABLE boards ADD COLUMN pickupConcurrency INTEGER NOT NULL DEFAULT 2");
    if (!boardColumns.has("pickupDailyLimit")) this.db.exec("ALTER TABLE boards ADD COLUMN pickupDailyLimit INTEGER NOT NULL DEFAULT 6");
    if (!boardColumns.has("autoPickupResetRunRowid")) this.db.exec("ALTER TABLE boards ADD COLUMN autoPickupResetRunRowid INTEGER NOT NULL DEFAULT 0");
    if (!boardColumns.has("autoPickupEnabledAt")) this.db.exec("ALTER TABLE boards ADD COLUMN autoPickupEnabledAt TEXT");
    if (!boardColumns.has("autoPickupError")) this.db.exec("ALTER TABLE boards ADD COLUMN autoPickupError TEXT NOT NULL DEFAULT ''");

    const runColumns = new Set((this.db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map(column => column.name));
    if (!runColumns.has("turns")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN turns INTEGER NOT NULL DEFAULT 0");
      // Older transcripts lack event counts. Their highest visible activity marker is only an estimate.
      const update = this.db.prepare("UPDATE runs SET turns=? WHERE id=?");
      for (const row of this.db.prepare("SELECT id, output FROM runs").all() as { id: string; output: string }[]) {
        let count = 0;
        for (const match of row.output.matchAll(/(?:^|\n)Turn (\d+):/g)) count = Math.max(count, Number(match[1]));
        update.run(count, row.id);
      }
    }
    if (!runColumns.has("turnsIncomplete")) this.db.exec("ALTER TABLE runs ADD COLUMN turnsIncomplete INTEGER NOT NULL DEFAULT 1");
    if (!runColumns.has("startedBy")) this.db.exec("ALTER TABLE runs ADD COLUMN startedBy TEXT NOT NULL DEFAULT 'manual'");
    const approvalColumns = new Set((this.db.prepare("PRAGMA table_info(approvals)").all() as { name: string }[]).map(column => column.name));
    if (!approvalColumns.has("preparedHead")) this.db.exec("ALTER TABLE approvals ADD COLUMN preparedHead TEXT");
    if (!approvalColumns.has("merged")) this.db.exec("ALTER TABLE approvals ADD COLUMN merged INTEGER NOT NULL DEFAULT 0");
    // Preserve old cards and runs. A stored repository path is never reinterpreted against today's cwd.
    for (const row of this.db.prepare("SELECT DISTINCT repo FROM cards WHERE repo NOT IN (SELECT repo FROM boards)").all() as { repo: string }[]) this.addRepo(row.repo);
  }
  recoverInterruptedRuns(): void {
    // Only the server calls this under the exclusive data-directory lock.
    this.db.exec(`UPDATE runs SET status='interrupted', error='Server restarted while this run was active', finishedAt=datetime('now') WHERE status='running';
      UPDATE cards SET status='interrupted' WHERE status='running';`);
  }
  recoverAutoReviews(): void {
    // Only the server may call this, after obtaining its exclusive data-directory lock.
    this.db.prepare("UPDATE auto_review_jobs SET state='needs_human', details='Server restarted during agent review; inspect manually', finishedAt=? WHERE state='running'").run(now());
  }
  close() { this.db.close(); }
  getSettings(): BakerySettings {
    const row = this.db.prepare("SELECT confirmRunStart, cardDetailsLayout, theme FROM settings WHERE id=1").get() as { confirmRunStart: number; cardDetailsLayout: BakerySettings["cardDetailsLayout"]; theme: BakerySettings["theme"] };
    return { confirmRunStart: row.confirmRunStart === 1, cardDetailsLayout: row.cardDetailsLayout, theme: row.theme };
  }
  updateSettings(settings: Partial<BakerySettings>): BakerySettings {
    const current = this.getSettings();
    this.db.prepare("UPDATE settings SET confirmRunStart=?, cardDetailsLayout=?, theme=? WHERE id=1").run((settings.confirmRunStart ?? current.confirmRunStart) ? 1 : 0, settings.cardDetailsLayout ?? current.cardDetailsLayout, settings.theme ?? current.theme);
    return this.getSettings();
  }
  listRepos(): string[] { return this.listBoards().map(board => board.repo); }
  private toBoard(row: BoardRow): RepoBoard {
    const starts = (this.db.prepare(`SELECT runs.startedAt FROM runs JOIN cards ON cards.id=runs.cardId
      WHERE cards.repo=? AND runs.startedBy='auto' AND runs.rowid>?
        AND julianday(runs.startedAt)>=julianday('now','-1 day') ORDER BY runs.startedAt`).all(row.repo, row.autoPickupResetRunRowid) as { startedAt: string }[]).map(run => run.startedAt);
    return toRepoBoard(row, starts);
  }
  listBoards(): RepoBoard[] { return (this.db.prepare(`SELECT ${boardFields} FROM boards WHERE archived=0 ORDER BY repo`).all() as BoardRow[]).map(row => this.toBoard(row)); }
  getBoard(id: string): RepoBoard | undefined {
    const row = this.db.prepare(`SELECT ${boardFields} FROM boards WHERE id=? AND archived=0`).get(id) as BoardRow | undefined;
    return row && this.toBoard(row);
  }
  addRepo(repo: string): RepoBoard {
    const existing = this.db.prepare("SELECT id FROM boards WHERE repo=?").get(repo) as { id: string } | undefined;
    if (existing) {
      this.db.prepare("UPDATE boards SET archived=0 WHERE id=?").run(existing.id);
      return this.getBoard(existing.id)!;
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO boards(id, repo) VALUES (?, ?)").run(id, repo);
    return this.getBoard(id)!;
  }
  setAutoCollapseEmptySwimlanes(id: string, enabled: boolean): RepoBoard {
    if (!this.getBoard(id)) throw new Error("Board not found");
    this.db.prepare("UPDATE boards SET autoCollapseEmptySwimlanes=? WHERE id=?").run(enabled ? 1 : 0, id);
    return this.getBoard(id)!;
  }
  setAutoReview(id: string, enabled: boolean, verificationCommand: string): RepoBoard {
    const board = this.getBoard(id);
    if (!board) throw new Error("Board not found");
    const command = verificationCommand.trim();
    if (command.length > 500 || (enabled && !command)) throw new Error("Auto-review requires a verification command (maximum 500 characters)");
    this.db.prepare("UPDATE boards SET autoReviewEnabled=?, verificationCommand=?, autoReviewEnabledAt=? WHERE id=?")
      .run(enabled ? 1 : 0, command, enabled ? (board.autoReviewEnabled && board.verificationCommand === command ? board.autoReviewEnabledAt : now()) : null, id);
    return this.getBoard(id)!;
  }
  setAutoPickup(id: string, enabled: boolean, concurrency: number, dailyLimit?: number): RepoBoard {
    const current = this.getBoard(id);
    if (!current) throw new Error("Board not found");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Auto-pickup concurrency must be between 1 and 4");
    const limit = dailyLimit ?? current.pickupDailyLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24) throw new Error("Auto-pickup daily start limit must be between 1 and 24");
    this.db.prepare("UPDATE boards SET autoPickupEnabled=?, pickupConcurrency=?, pickupDailyLimit=?, autoPickupEnabledAt=?, autoPickupError='' WHERE id=?")
      .run(enabled ? 1 : 0, concurrency, limit, enabled ? (current.autoPickupEnabled ? current.autoPickupEnabledAt : now()) : null, id);
    return this.getBoard(id)!;
  }
  resetAutoPickupLimit(id: string): RepoBoard {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const board = this.getBoard(id);
      if (!board) throw new Error("Board not found");
      if (!board.autoPickupEnabled || board.autoPickupStarts < board.pickupDailyLimit) throw new Error("Auto-pickup start limit is not currently reached on this enabled board");
      // A rowid boundary counts a claim even when it shares the reset's millisecond.
      const last = (this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS id FROM runs").get() as { id: number }).id;
      this.db.prepare("UPDATE boards SET autoPickupResetRunRowid=? WHERE id=?").run(last, id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getBoard(id)!;
  }
  pauseAutoPickup(id: string, reason: string): void {
    this.db.prepare("UPDATE boards SET autoPickupEnabled=0, autoPickupEnabledAt=NULL, autoPickupError=? WHERE id=?")
      .run(reason.slice(0, 500), id);
  }
  runningCount(repo: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM cards WHERE repo=? AND status='running'").get(repo) as { n: number }).n;
  }
  autoStartsToday(repo: string): number {
    const row = this.db.prepare(`SELECT ${boardFields} FROM boards WHERE repo=? AND archived=0`).get(repo) as BoardRow | undefined;
    return row ? this.toBoard(row).autoPickupStarts : 0;
  }
  listAutoPickupCandidates(): { card: Card; board: RepoBoard }[] {
    const result: { card: Card; board: RepoBoard }[] = [];
    for (const repoBoard of this.listBoards().filter(item => item.autoPickupEnabled)) {
      if (this.runningCount(repoBoard.repo) >= repoBoard.pickupConcurrency || repoBoard.autoPickupStarts >= repoBoard.pickupDailyLimit) continue;
      const ids = this.db.prepare("SELECT id FROM cards WHERE repo=? AND status='ready' ORDER BY createdAt, rowid").all(repoBoard.repo) as { id: string }[];
      result.push(...ids.map(({ id }) => ({ card: this.getCard(id)!, board: repoBoard })));
    }
    return result;
  }
  autoPickupBlocker(repoBoard: RepoBoard): string | undefined {
    if (this.db.prepare("SELECT 1 FROM cards WHERE repo=? AND status='interrupted' LIMIT 1").get(repoBoard.repo)) return "An interrupted run needs inspection before automatic pickup";
    if (this.db.prepare(`SELECT 1 FROM runs JOIN cards ON cards.id=runs.cardId
      WHERE cards.repo=? AND runs.startedBy='auto' AND runs.status='failed' AND runs.startedAt>=? LIMIT 1`).get(repoBoard.repo, repoBoard.autoPickupEnabledAt))
      return "An automatic run failed; inspect it before re-enabling pickup";
    return undefined;
  }
  listAutoReviewCandidates(): { card: Card; run: Run; board: RepoBoard }[] {
    const result: { card: Card; run: Run; board: RepoBoard }[] = [];
    for (const repoBoard of this.listBoards().filter(item => item.autoReviewEnabled)) {
      if (this.autoReviewMergesToday(repoBoard.repo) >= 3) continue;
      for (const card of this.listCards(repoBoard.repo).filter(item => item.status === "review")) {
        const run = this.listRuns(card.id)[0];
        if (run?.status === "review" && run.finishedAt && repoBoard.autoReviewEnabledAt && run.finishedAt > repoBoard.autoReviewEnabledAt &&
          !this.getAutoReviewJob(run.id) && !this.getApproval(card.id) && !this.getMergeFailure(card.id) &&
          !this.hasRequestedChanges(card.id, run.id) && !this.hasDraftReviewComments(card.id, run.id)) result.push({ card, run, board: repoBoard });
      }
    }
    return result.sort((a, b) => a.run.finishedAt!.localeCompare(b.run.finishedAt!));
  }
  autoReviewMergesToday(repo: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM auto_review_jobs JOIN cards ON cards.id=auto_review_jobs.cardId WHERE cards.repo=? AND state='merged' AND julianday(finishedAt)>=julianday('now','-1 day')")
      .get(repo) as { n: number }).n;
  }
  getAutoReviewJob(runId: string): AutoReviewJob | undefined {
    return this.db.prepare("SELECT * FROM auto_review_jobs WHERE runId=?").get(runId) as AutoReviewJob | undefined;
  }
  listAutoReviewJobs(cardId: string): AutoReviewJob[] {
    return this.db.prepare("SELECT * FROM auto_review_jobs WHERE cardId=? ORDER BY startedAt DESC").all(cardId) as AutoReviewJob[];
  }
  beginAutoReview(cardId: string, runId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.listAutoReviewCandidates().find(item => item.card.id === cardId && item.run.id === runId);
      if (!candidate) throw new Error("Auto-review is not eligible for this card");
      this.db.prepare("INSERT INTO auto_review_jobs(cardId,runId,state,startedAt) VALUES (?,?,'running',?)").run(cardId, runId, now());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  finishAutoReview(runId: string, state: "needs_human" | "merged", details: string, fingerprint = ""): void {
    this.db.prepare("UPDATE auto_review_jobs SET state=?, details=?, fingerprint=?, finishedAt=? WHERE runId=? AND state='running'")
      .run(state, details.slice(0, 4000), fingerprint, now(), runId);
  }
  renameBoard(id: string, repo: string): RepoBoard {
    const board = this.getBoard(id);
    if (!board) throw new Error("Board not found");
    if (board.repo === repo) return board;
    if (this.db.prepare("SELECT id FROM boards WHERE repo=?").get(repo)) throw new Error("Repository already has a board");
    if (this.db.prepare("SELECT 1 FROM runs JOIN cards ON cards.id=runs.cardId WHERE cards.repo=? LIMIT 1").get(board.repo)) throw new Error("Cannot change repository after a card has an attempt");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE cards SET repo=?, updatedAt=? WHERE repo=?").run(repo, now(), board.repo);
      this.db.prepare("UPDATE boards SET repo=? WHERE id=?").run(repo, id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getBoard(id)!;
  }
  archiveBoard(id: string) {
    const board = this.getBoard(id);
    if (!board) throw new Error("Board not found");
    if (this.db.prepare("SELECT 1 FROM cards WHERE repo=? AND status IN ('running', 'interrupted') LIMIT 1").get(board.repo)) throw new Error("Resolve running or interrupted cards before removing this board");
    this.db.prepare("UPDATE boards SET archived=1 WHERE id=?").run(id);
  }
  listCards(repo?: string): Card[] { return (repo === undefined
    ? this.db.prepare(`${cardQuery} GROUP BY cards.id ORDER BY cards.createdAt DESC`).all()
    : this.db.prepare(`${cardQuery} WHERE cards.repo=? GROUP BY cards.id ORDER BY cards.createdAt DESC`).all(repo)) as Card[]; }
  getCard(id: string): Card | undefined { return this.db.prepare(`${cardQuery} WHERE cards.id=? GROUP BY cards.id`).get(id) as Card | undefined; }
  createCard(input: { title: string; body: string; repo: string }): Card {
    const id = randomUUID(), time = now();
    this.addRepo(input.repo);
    this.db.prepare("INSERT INTO cards VALUES (?, ?, ?, ?, 'triage', 'manual', ?, ?)").run(id, input.title, input.body, input.repo, time, time);
    return this.getCard(id)!;
  }
  updateCard(id: string, input: { title: string; body: string; repo: string }): Card {
    const card = this.getCard(id);
    if (!card) throw new Error("Card not found");
    if (card.status === "running") throw new Error("Cannot edit a running card");
    if (input.repo !== card.repo) throw new Error("Cannot change a card's repository; create a card on the other board");
    this.db.prepare("UPDATE cards SET title=?, body=?, updatedAt=? WHERE id=?").run(input.title, input.body, now(), id);
    return this.getCard(id)!;
  }
  setStatus(id: string, status: "triage" | "ready" | "done"): Card {
    const card = this.getCard(id);
    if (!card) throw new Error("Card not found");
    if (card.status === "running" || card.status === "interrupted") throw new Error("Resolve the active or interrupted run first");
    if (this.getApproval(id)) throw new Error("Approval is in progress; retry Approve and merge");
    if (status === "triage" && (card.status !== "ready" || this.listRuns(id).length)) throw new Error("Only unstarted Ready cards can move to Triage");
    if (status === "done" && this.listRuns(id).length) throw new Error("Cards with run work cannot be marked Done without approval and integration");
    // Recover cards closed by the old status-only action without launching another Pi run.
    if (status === "ready" && card.status === "done" && this.listRuns(id)[0]?.status === "review" && !this.wasIntegrated(id)) {
      this.db.prepare("UPDATE cards SET status='review', updatedAt=? WHERE id=?").run(now(), id);
      return this.getCard(id)!;
    }
    this.db.prepare("UPDATE cards SET status=?, updatedAt=? WHERE id=?").run(status, now(), id);
    return this.getCard(id)!;
  }
  listReviewComments(cardId: string): ReviewComment[] {
    return this.db.prepare("SELECT * FROM review_comments WHERE cardId=? ORDER BY createdAt, id").all(cardId) as ReviewComment[];
  }
  addReviewComment(cardId: string, runId: string, fingerprint: string, path: string, line: number, kind: ReviewComment["kind"], code: string, body: string, fileLine: number | null = null): ReviewComment {
    if (!body.trim() || body.length > 1000 || path.length > 1000 || code.length > 10000 || !Number.isSafeInteger(line) || line < 1 || (fileLine !== null && (!Number.isSafeInteger(fileLine) || fileLine < 1))) throw new Error("Invalid review comment");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId), run = this.listRuns(cardId)[0];
      if (card?.status !== "review" || run?.id !== runId || run.status !== "review" || this.getApproval(cardId)) throw new Error("Only the latest unapproved review accepts comments");
      if (this.hasRequestedChanges(cardId, runId)) throw new Error("Changes already requested for this review; run Pi again to revise it");
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM review_comments WHERE cardId=? AND runId=? AND state='draft'").get(cardId, runId) as { n: number };
      if (count.n >= 25) throw new Error("Limit of 25 draft comments per review");
      const id = randomUUID();
      this.db.prepare("INSERT INTO review_comments(id,cardId,runId,fingerprint,path,line,fileLine,kind,code,body,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, cardId, runId, fingerprint, path, line, fileLine, kind, code, body.trim(), now());
      this.db.exec("COMMIT");
      return this.db.prepare("SELECT * FROM review_comments WHERE id=?").get(id) as ReviewComment;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  deleteReviewComment(cardId: string, id: string): void {
    const result = this.db.prepare("DELETE FROM review_comments WHERE id=? AND cardId=? AND state='draft'").run(id, cardId);
    if (!result.changes) throw new Error("Only draft comments can be removed");
  }
  hasRequestedChanges(cardId: string, runId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM review_comments WHERE cardId=? AND runId=? AND state='requested' LIMIT 1").get(cardId, runId);
  }
  hasDraftReviewComments(cardId: string, runId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM review_comments WHERE cardId=? AND runId=? AND state='draft' LIMIT 1").get(cardId, runId);
  }
  requestChanges(cardId: string, runId: string, fingerprint: string): ReviewComment[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId), run = this.listRuns(cardId)[0];
      if (card?.status !== "review" || run?.id !== runId || run.status !== "review" || this.getApproval(cardId)) throw new Error("Only the latest unapproved review can request changes");
      if (this.hasRequestedChanges(cardId, runId)) throw new Error("Changes already requested for this review");
      if (this.db.prepare("SELECT 1 FROM review_comments WHERE cardId=? AND runId=? AND fingerprint<>? AND state='draft'").get(cardId, runId, fingerprint)) throw new Error("Remove draft comments on older diffs before requesting changes");
      const result = this.db.prepare("UPDATE review_comments SET state='requested' WHERE cardId=? AND runId=? AND fingerprint=? AND state='draft'").run(cardId, runId, fingerprint);
      if (!result.changes) throw new Error("Add comments on the current diff before requesting changes");
      this.db.exec("COMMIT");
      return this.listReviewComments(cardId);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  getFeedbackForRun(cardId: string): ReviewComment[] {
    return this.db.prepare(`SELECT review_comments.* FROM review_comments JOIN runs ON runs.id=review_comments.runId
      WHERE review_comments.cardId=? AND review_comments.state='requested' AND runs.status='review'
      AND runs.attempt=(SELECT MAX(attempt) FROM runs WHERE cardId=? AND status='review') ORDER BY review_comments.createdAt, review_comments.id`).all(cardId, cardId) as ReviewComment[];
  }
  getMergeFailure(cardId: string): MergeFailure | undefined {
    const row = this.db.prepare("SELECT * FROM merge_failures WHERE cardId=?").get(cardId) as { cardId: string; files: string; details: string } | undefined;
    return row && { cardId: row.cardId, files: JSON.parse(row.files) as string[], details: row.details };
  }
  listMergeFailures(repo: string): MergeFailure[] {
    return (this.db.prepare("SELECT merge_failures.* FROM merge_failures JOIN cards ON cards.id=merge_failures.cardId WHERE cards.repo=? AND cards.status IN ('review', 'failed')").all(repo) as { cardId: string; files: string; details: string }[])
      .map(row => ({ cardId: row.cardId, files: JSON.parse(row.files) as string[], details: row.details }));
  }
  recordMergeFailure(cardId: string, files: string[], details: string): void {
    this.db.prepare("INSERT INTO merge_failures(cardId, files, details) VALUES (?, ?, ?) ON CONFLICT(cardId) DO UPDATE SET files=excluded.files, details=excluded.details")
      .run(cardId, JSON.stringify(files), details);
  }
  clearMergeFailure(cardId: string): void { this.db.prepare("DELETE FROM merge_failures WHERE cardId=?").run(cardId); }
  getApproval(cardId: string): Approval | undefined {
    return this.db.prepare("SELECT * FROM approvals WHERE cardId=? AND merged=0").get(cardId) as Approval | undefined;
  }
  wasIntegrated(cardId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM approvals WHERE cardId=? AND merged=1").get(cardId);
  }
  recordApproval(cardId: string, runId: string, candidate: string): Approval {
    const card = this.getCard(cardId), run = this.listRuns(cardId)[0];
    if (card?.status !== "review" || run?.id !== runId || run.status !== "review") throw new Error("Only the latest reviewed run can be approved");
    if (this.getApproval(cardId)) throw new Error("Approval already in progress");
    if (this.hasRequestedChanges(cardId, runId)) throw new Error("Changes requested; review a new attempt before approving");
    this.db.prepare("INSERT INTO approvals(cardId, runId, candidate, merged) VALUES (?, ?, ?, 0) ON CONFLICT(cardId) DO UPDATE SET runId=excluded.runId, candidate=excluded.candidate, preparedHead=NULL, merged=0").run(cardId, runId, candidate);
    this.clearMergeFailure(cardId);
    return this.getApproval(cardId)!;
  }
  cancelApproval(cardId: string, runId: string, includePrepared = false): void {
    this.db.prepare(`DELETE FROM approvals WHERE cardId=? AND runId=? AND merged=0 ${includePrepared ? "" : "AND preparedHead IS NULL"}`).run(cardId, runId);
  }
  recordPreparedMerge(cardId: string, runId: string, candidate: string, preparedHead: string): void {
    const approval = this.getApproval(cardId);
    if (approval?.runId !== runId || approval.candidate !== candidate || this.getCard(cardId)?.status !== "review") throw new Error("Approval state changed");
    this.db.prepare("UPDATE approvals SET preparedHead=? WHERE cardId=? AND merged=0").run(preparedHead, cardId);
  }
  completeApproval(cardId: string, runId: string, candidate: string): Card {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId), run = this.listRuns(cardId)[0], approval = this.getApproval(cardId);
      if (card?.status !== "review" || run?.id !== runId || run.status !== "review" || approval?.candidate !== candidate || approval.runId !== runId) throw new Error("Approval state changed");
      this.db.prepare("UPDATE cards SET status='done', updatedAt=? WHERE id=?").run(now(), cardId);
      this.db.prepare("UPDATE approvals SET merged=1 WHERE cardId=?").run(cardId);
      this.clearMergeFailure(cardId);
      this.db.exec("COMMIT");
      return this.getCard(cardId)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  resolveInterrupted(id: string): Card {
    const card = this.getCard(id);
    if (!card || card.status !== "interrupted") throw new Error("Card is not interrupted");
    const run = this.listRuns(id)[0];
    if (run?.pid) {
      try { process.kill(run.pid, 0); throw new Error(`Process ${run.pid} may still be running; stop and inspect it first`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    this.db.prepare("UPDATE cards SET status='failed', updatedAt=? WHERE id=?").run(now(), id);
    return this.getCard(id)!;
  }
  claim(cardId: string, startedBy: "manual" | "auto" = "manual"): Run {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId);
      if (!card) throw new Error("Card not found");
      if (card.status === "running") throw new Error("Card already has an active run");
      if (card.status === "interrupted") throw new Error("Resolve the interrupted process before retrying");
      if (card.status === "done") throw new Error("Reopen this card before starting a run");
      if (card.status === "triage") throw new Error("Move this card to Ready before starting a run");
      if (this.getApproval(cardId)) throw new Error("Approval is in progress; retry Approve and merge");
      const repoBoard = this.listBoards().find(item => item.repo === card.repo);
      if (repoBoard?.autoPickupEnabled && this.runningCount(card.repo) >= repoBoard.pickupConcurrency)
        throw new Error(`Repository is at its ${repoBoard.pickupConcurrency}-run concurrency limit`);
      if (startedBy === "auto" && (card.status !== "ready" || !repoBoard?.autoPickupEnabled ||
        this.autoStartsToday(card.repo) >= repoBoard.pickupDailyLimit || this.autoPickupBlocker(repoBoard)))
        throw new Error("Automatic pickup is not eligible for this card");
      const attempt = Number((this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE cardId=?").get(cardId) as { n: number }).n) + 1;
      const id = randomUUID(), sessionId = `bakery-${cardId}`;
      this.db.prepare("INSERT INTO runs(id, cardId, attempt, status, sessionId, startedAt, startedBy) VALUES (?, ?, ?, 'running', ?, ?, ?)").run(id, cardId, attempt, sessionId, now(), startedBy);
      this.db.prepare("UPDATE cards SET status='running', updatedAt=? WHERE id=?").run(now(), cardId);
      this.db.exec("COMMIT");
      return this.getRun(id)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  getRun(id: string): Run | undefined { return this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Run | undefined; }
  listRuns(cardId: string): Run[] { return this.db.prepare("SELECT * FROM runs WHERE cardId=? ORDER BY attempt DESC").all(cardId) as Run[]; }
  attach(id: string, pid: number, worktree: string) { this.db.prepare("UPDATE runs SET pid=?, worktree=? WHERE id=? AND status='running'").run(pid, worktree, id); }
  completeTurn(id: string) { this.db.prepare("UPDATE runs SET turns=turns+1 WHERE id=? AND status='running'").run(id); }
  append(id: string, chunk: string) {
    // Keep a bounded tail. Store only human-readable text; never raw tool arguments or credentials.
    const run = this.getRun(id);
    if (run?.status !== "running") return;
    this.db.prepare("UPDATE runs SET output=? WHERE id=?").run((run.output + chunk).slice(-60000), id);
  }
  finish(id: string, status: "review" | "failed", error: string | null = null) {
    const run = this.getRun(id);
    if (!run || run.status !== "running") return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE runs SET status=?, error=?, finishedAt=? WHERE id=? AND status='running'").run(status, error, now(), id);
      this.db.prepare("UPDATE cards SET status=?, updatedAt=? WHERE id=?").run(status, now(), run.cardId);
      if (status === "review") this.clearMergeFailure(run.cardId);
      this.db.exec("COMMIT");
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }
}
