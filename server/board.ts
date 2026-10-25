import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type CardStatus = "ready" | "running" | "review" | "failed" | "interrupted" | "done";
export type RepoBoard = { id: string; repo: string };
export type BakerySettings = { confirmRunStart: boolean };
export type Card = { id: string; title: string; body: string; repo: string; status: CardStatus; source: "manual"; createdAt: string; updatedAt: string; turns: number; turnsIncomplete: number };
export type Run = { id: string; cardId: string; attempt: number; status: "running" | "review" | "failed" | "interrupted"; pid: number | null; worktree: string | null; sessionId: string; output: string; error: string | null; startedAt: string; finishedAt: string | null; turns: number; turnsIncomplete: number };
export type Approval = { cardId: string; runId: string; candidate: string; preparedHead: string | null; merged: number };
export type MergeFailure = { cardId: string; files: string[]; details: string };
const now = () => new Date().toISOString();
const cardQuery = `SELECT cards.*, COALESCE(SUM(runs.turns), 0) AS turns, COALESCE(MAX(runs.turnsIncomplete), 0) AS turnsIncomplete
  FROM cards LEFT JOIN runs ON runs.cardId=cards.id`;

export class Board {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, repo TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, cardId TEXT NOT NULL REFERENCES cards(id), attempt INTEGER NOT NULL, status TEXT NOT NULL, pid INTEGER, worktree TEXT, sessionId TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', error TEXT, startedAt TEXT, finishedAt TEXT, turns INTEGER NOT NULL DEFAULT 0, turnsIncomplete INTEGER NOT NULL DEFAULT 0, UNIQUE(cardId, attempt));
      CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, repo TEXT NOT NULL UNIQUE, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS approvals (cardId TEXT PRIMARY KEY, runId TEXT NOT NULL, candidate TEXT NOT NULL, preparedHead TEXT, merged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS merge_failures (cardId TEXT PRIMARY KEY, files TEXT NOT NULL, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), confirmRunStart INTEGER NOT NULL CHECK(confirmRunStart IN (0, 1)));
      INSERT OR IGNORE INTO settings(id, confirmRunStart) VALUES (1, 0);`);
    if (!(this.db.prepare("PRAGMA table_info(boards)").all() as { name: string }[]).some(column => column.name === "archived")) {
      this.db.exec("ALTER TABLE boards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    }
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
    const approvalColumns = new Set((this.db.prepare("PRAGMA table_info(approvals)").all() as { name: string }[]).map(column => column.name));
    if (!approvalColumns.has("preparedHead")) this.db.exec("ALTER TABLE approvals ADD COLUMN preparedHead TEXT");
    if (!approvalColumns.has("merged")) this.db.exec("ALTER TABLE approvals ADD COLUMN merged INTEGER NOT NULL DEFAULT 0");
    // Preserve old cards and runs. A stored repository path is never reinterpreted against today's cwd.
    for (const row of this.db.prepare("SELECT DISTINCT repo FROM cards WHERE repo NOT IN (SELECT repo FROM boards)").all() as { repo: string }[]) this.addRepo(row.repo);
    // After a process restart, never infer success or schedule a second worker.
    this.db.exec(`UPDATE runs SET status='interrupted', error='Server restarted while this run was active', finishedAt=datetime('now') WHERE status='running';
      UPDATE cards SET status='interrupted' WHERE status='running';`);
  }
  close() { this.db.close(); }
  getSettings(): BakerySettings {
    const row = this.db.prepare("SELECT confirmRunStart FROM settings WHERE id=1").get() as { confirmRunStart: number };
    return { confirmRunStart: row.confirmRunStart === 1 };
  }
  updateSettings(settings: BakerySettings): BakerySettings {
    this.db.prepare("UPDATE settings SET confirmRunStart=? WHERE id=1").run(settings.confirmRunStart ? 1 : 0);
    return this.getSettings();
  }
  listRepos(): string[] { return this.listBoards().map(board => board.repo); }
  listBoards(): RepoBoard[] { return this.db.prepare("SELECT id, repo FROM boards WHERE archived=0 ORDER BY repo").all() as RepoBoard[]; }
  getBoard(id: string): RepoBoard | undefined { return this.db.prepare("SELECT id, repo FROM boards WHERE id=? AND archived=0").get(id) as RepoBoard | undefined; }
  addRepo(repo: string): RepoBoard {
    const existing = this.db.prepare("SELECT id, repo FROM boards WHERE repo=?").get(repo) as RepoBoard | undefined;
    if (existing) {
      this.db.prepare("UPDATE boards SET archived=0 WHERE id=?").run(existing.id);
      return existing;
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO boards(id, repo) VALUES (?, ?)").run(id, repo);
    return this.getBoard(id)!;
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
    this.db.prepare("INSERT INTO cards VALUES (?, ?, ?, ?, 'ready', 'manual', ?, ?)").run(id, input.title, input.body, input.repo, time, time);
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
  setStatus(id: string, status: "ready" | "done"): Card {
    const card = this.getCard(id);
    if (!card) throw new Error("Card not found");
    if (card.status === "running" || card.status === "interrupted") throw new Error("Resolve the active or interrupted run first");
    if (this.getApproval(id)) throw new Error("Approval is in progress; retry Approve and merge");
    if (status === "done" && this.listRuns(id).length) throw new Error("Cards with run work cannot be marked Done without approval and integration");
    // Recover cards closed by the old status-only action without launching another Pi run.
    if (status === "ready" && card.status === "done" && this.listRuns(id)[0]?.status === "review" && !this.wasIntegrated(id)) {
      this.db.prepare("UPDATE cards SET status='review', updatedAt=? WHERE id=?").run(now(), id);
      return this.getCard(id)!;
    }
    this.db.prepare("UPDATE cards SET status=?, updatedAt=? WHERE id=?").run(status, now(), id);
    return this.getCard(id)!;
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
  claim(cardId: string): Run {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId);
      if (!card) throw new Error("Card not found");
      if (card.status === "running") throw new Error("Card already has an active run");
      if (card.status === "interrupted") throw new Error("Resolve the interrupted process before retrying");
      if (card.status === "done") throw new Error("Reopen this card before starting a run");
      if (this.getApproval(cardId)) throw new Error("Approval is in progress; retry Approve and merge");
      const attempt = Number((this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE cardId=?").get(cardId) as { n: number }).n) + 1;
      const id = randomUUID(), sessionId = `bakery-${cardId}`;
      this.db.prepare("INSERT INTO runs(id, cardId, attempt, status, sessionId, startedAt) VALUES (?, ?, ?, 'running', ?, ?)").run(id, cardId, attempt, sessionId, now());
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
