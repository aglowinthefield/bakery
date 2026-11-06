import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PrLock } from "./pr-lock.js";

/**
 * What a sentinel watches. `pr-health`: the owner's open PRs that conflict or fail CI, on a timer. `pr-requests`:
 * `/bakery` comments on any open PR. A github-pr board has one of each.
 */
export type SentinelKind = "pr-health" | "pr-requests";
export const sentinelKinds: SentinelKind[] = ["pr-health", "pr-requests"];
export const sentinelNames: Record<SentinelKind, string> = { "pr-health": "Broken pull requests", "pr-requests": "/bakery requests" };
export const defaultSentinelIntervals: Record<SentinelKind, number> = { "pr-health": 5 * 60_000, "pr-requests": 60_000 };
/**
 * A persistent monitor, not a card: it has no lane or status and is never reviewed or merged. `enabled` false is
 * paused: no runs start and its unstarted jobs wait. `instructions` are the operator's, added to every job's brief.
 * `scope` is the GitHub repository it watches.
 */
export type SentinelRecord = { id: string; boardId: string; kind: SentinelKind; instructions: string; scope: string; intervalMs: number; enabled: boolean; nextRunAt: string; lastRunAt: string | null; createdAt: string; updatedAt: string };
/**
 * What one run did about one finding. `created`: it made the job card. `open`: a card for the finding was still open,
 * so none was made (deduplication). `withdrawn`: the finding went away before its card started.
 */
export type SentinelFinding = { key: string; cardId: string; outcome: "created" | "open" | "withdrawn" };
/** One execution of a sentinel. `interrupted` means Bakery stopped while it ran. */
export type SentinelRun = { id: string; sentinelId: string; status: "running" | "succeeded" | "failed" | "interrupted"; startedAt: string; finishedAt: string | null; findings: SentinelFinding[]; summary: string; error: string | null };
type SentinelRow = Omit<SentinelRecord, "enabled"> & { enabled: number };
type RunRow = Omit<SentinelRun, "findings"> & { findings: string };
/** The run that owns job cards made before sentinels had records of their own. Its id is fixed so the migration can re-run. */
export const legacyRunId = (sentinelId: string) => `legacy-${sentinelId}`;
/** A finding is one PR: while its card is open the sentinel makes no other card for it. */
export const prFindingKey = (prNumber: number) => `pr:${prNumber}`;

/** A lock row. `pending` means the comment may not exist yet: the row is written first, then the comment, then the row is confirmed. */
export type LockRow = PrLock & { repo: string; prNumber: number; commentId: string | null; state: "pending" | "held" | "released" };
type Row = { repo: string; prNumber: number; holder: string; startedAt: string; releasedAt: string | null; commentId: string | null; state: LockRow["state"] };

export class SentinelStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pr_locks (repo TEXT NOT NULL, prNumber INTEGER NOT NULL, holder TEXT NOT NULL, startedAt TEXT NOT NULL, releasedAt TEXT, commentId TEXT, state TEXT NOT NULL CHECK(state IN ('pending','held','released')), PRIMARY KEY (repo, prNumber));
      CREATE TABLE IF NOT EXISTS sentinel_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, prNumber INTEGER NOT NULL, branch TEXT NOT NULL, head TEXT NOT NULL, mainTip TEXT NOT NULL, cardId TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(repo, prNumber, head, mainTip));
      CREATE TABLE IF NOT EXISTS pr_request_cursor (repo TEXT PRIMARY KEY, since TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_request_cards (cardId TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS sentinel_given_up (repo TEXT NOT NULL, prNumber INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (repo, prNumber));
      CREATE TABLE IF NOT EXISTS sentinels (id TEXT PRIMARY KEY, boardId TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('pr-health','pr-requests')), instructions TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '',
        intervalMs INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)), nextRunAt TEXT NOT NULL, lastRunAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(boardId, kind));
      CREATE TABLE IF NOT EXISTS sentinel_runs (id TEXT PRIMARY KEY, sentinelId TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
        startedAt TEXT NOT NULL, finishedAt TEXT, findings TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', error TEXT);
      -- At most one run of a sentinel at a time, whatever starts it.
      CREATE UNIQUE INDEX IF NOT EXISTS sentinel_runs_one_running ON sentinel_runs(sentinelId) WHERE status='running';
      CREATE INDEX IF NOT EXISTS sentinel_runs_by_sentinel ON sentinel_runs(sentinelId, startedAt);
    `);
    // One store is made per process, so a run still marked running was cut off by a restart.
    db.prepare("UPDATE sentinel_runs SET status='interrupted', finishedAt=?, error='Bakery stopped during this run' WHERE status='running'").run(new Date().toISOString());
  }

  private toSentinel(row: SentinelRow | undefined): SentinelRecord | undefined { return row && { ...row, enabled: !!row.enabled }; }
  getSentinel(id: string): SentinelRecord | undefined { return this.toSentinel(this.db.prepare("SELECT * FROM sentinels WHERE id=?").get(id) as SentinelRow | undefined); }
  listSentinels(boardId?: string): SentinelRecord[] {
    const rows = (boardId === undefined ? this.db.prepare("SELECT * FROM sentinels ORDER BY createdAt, kind").all() : this.db.prepare("SELECT * FROM sentinels WHERE boardId=? ORDER BY kind").all(boardId)) as SentinelRow[];
    return rows.map(row => this.toSentinel(row)!);
  }
  /** The board's sentinel of this kind, made on first use: enabled, due now. An existing one keeps its settings, paused or not. */
  ensureSentinel(boardId: string, kind: SentinelKind, intervalMs = defaultSentinelIntervals[kind], scope = ""): SentinelRecord {
    const at = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO sentinels(id, boardId, kind, scope, intervalMs, enabled, nextRunAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)")
      .run(randomUUID(), boardId, kind, scope, intervalMs, at, at, at);
    if (scope) this.db.prepare("UPDATE sentinels SET scope=? WHERE boardId=? AND kind=? AND scope<>?").run(scope, boardId, kind, scope);
    return this.toSentinel(this.db.prepare("SELECT * FROM sentinels WHERE boardId=? AND kind=?").get(boardId, kind) as SentinelRow)!;
  }
  /** Pause (`enabled` false), resume (due at once), reschedule or reword a sentinel. */
  updateSentinel(id: string, change: { enabled?: boolean; intervalMs?: number; instructions?: string }): SentinelRecord {
    const current = this.getSentinel(id);
    if (!current) throw new Error("Sentinel not found");
    if (change.intervalMs !== undefined && (!Number.isInteger(change.intervalMs) || change.intervalMs < 15_000 || change.intervalMs > 7 * 24 * 3_600_000)) throw new Error("Interval must be a whole number of milliseconds from 15 seconds to 7 days");
    if (change.instructions !== undefined && change.instructions.length > 4000) throw new Error("Instructions must be at most 4,000 characters");
    const at = new Date().toISOString(), resumed = change.enabled === true && !current.enabled;
    // Scheduling rule: resuming makes it due now. Changing the interval moves the next run to one new interval after the
    // last run (or after now, if it never ran), so shortening takes effect at once and lengthening is honoured. A past
    // result means it is due now.
    const rescheduled = change.intervalMs !== undefined && change.intervalMs !== current.intervalMs;
    const next = resumed ? at : rescheduled ? new Date(Math.max(Date.parse(current.lastRunAt ?? at) + change.intervalMs!, Date.now())).toISOString() : current.nextRunAt;
    this.db.prepare("UPDATE sentinels SET enabled=?, intervalMs=?, instructions=?, nextRunAt=?, updatedAt=? WHERE id=?").run(
      (change.enabled ?? current.enabled) ? 1 : 0, change.intervalMs ?? current.intervalMs, change.instructions ?? current.instructions, next, at, id);
    return this.getSentinel(id)!;
  }
  /** Makes an enabled sentinel due now. */
  runSoon(id: string): SentinelRecord {
    const current = this.getSentinel(id);
    if (!current) throw new Error("Sentinel not found");
    if (!current.enabled) throw new Error("This sentinel is paused; resume it to run it");
    this.db.prepare("UPDATE sentinels SET nextRunAt=? WHERE id=?").run(new Date().toISOString(), id);
    return this.getSentinel(id)!;
  }
  /** Enabled sentinels whose next run is due. */
  dueSentinels(at: string): SentinelRecord[] {
    return (this.db.prepare("SELECT * FROM sentinels WHERE enabled=1 AND nextRunAt<=? ORDER BY nextRunAt").all(at) as SentinelRow[]).map(row => this.toSentinel(row)!);
  }
  /**
   * Starts a run and schedules the next one, in one transaction. Returns undefined while another run of the sentinel is
   * still going, so two timers, a run-now and a restart cannot dispatch it twice.
   */
  beginRun(sentinelId: string, at = new Date()): string | undefined {
    const sentinel = this.getSentinel(sentinelId);
    if (!sentinel) throw new Error("Sentinel not found");
    const id = randomUUID(), started = at.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM sentinel_runs WHERE sentinelId=? AND status='running'").get(sentinelId)) { this.db.exec("ROLLBACK"); return undefined; }
      this.db.prepare("INSERT INTO sentinel_runs(id, sentinelId, status, startedAt) VALUES (?, ?, 'running', ?)").run(id, sentinelId, started);
      this.db.prepare("UPDATE sentinels SET lastRunAt=?, nextRunAt=? WHERE id=?").run(started, new Date(at.getTime() + sentinel.intervalMs).toISOString(), sentinelId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return id;
  }
  finishRun(id: string, result: { status: "succeeded" | "failed"; findings: SentinelFinding[]; summary: string; error?: string }): void {
    this.db.prepare("UPDATE sentinel_runs SET status=?, finishedAt=?, findings=?, summary=?, error=? WHERE id=? AND status='running'")
      .run(result.status, new Date().toISOString(), JSON.stringify(result.findings), result.summary.slice(0, 2000), result.error?.slice(0, 2000) ?? null, id);
  }
  private toRun(row: RunRow | undefined): SentinelRun | undefined { return row && { ...row, findings: JSON.parse(row.findings) as SentinelFinding[] }; }
  getRun(id: string): SentinelRun | undefined { return this.toRun(this.db.prepare("SELECT * FROM sentinel_runs WHERE id=?").get(id) as RunRow | undefined); }
  /** Newest first. */
  listRuns(sentinelId: string, limit = 20): SentinelRun[] {
    return (this.db.prepare("SELECT * FROM sentinel_runs WHERE sentinelId=? ORDER BY startedAt DESC, rowid DESC LIMIT ?").all(sentinelId, limit) as RunRow[]).map(row => this.toRun(row)!);
  }
  /** The open (not Done or archived) card for this finding, if any. */
  openFindingCard(sentinelId: string, findingKey: string): string | undefined {
    return (this.db.prepare("SELECT id FROM cards WHERE sentinelId=? AND findingKey=? AND status NOT IN ('done', 'archived') ORDER BY createdAt DESC LIMIT 1").get(sentinelId, findingKey) as { id: string } | undefined)?.id;
  }

  /**
   * Before sentinel records, a job card was recognised by its idempotency key (`sentinel:` for a broken PR, `request:`
   * for a `/bakery` comment). This gives each such card its board's sentinel, a fixed legacy run and a finding key, and
   * changes nothing else: ids, status, attempts, PR locks and any running agent stay as they are, so nothing is started
   * twice. It only touches cards without a sentinel, in one transaction, so re-running it after a crash is harmless.
   */
  adoptLegacyJobs(intervals: Record<SentinelKind, number> = defaultSentinelIntervals): number {
    const rows = this.db.prepare(`SELECT cards.id, cards.idempotencyKey AS "key", cards.createdAt, boards.id AS boardId, a.prNumber FROM cards JOIN boards ON boards.repo=cards.repo
      LEFT JOIN sentinel_attempts a ON a.cardId=cards.id
      WHERE cards.sentinelId IS NULL AND (cards.idempotencyKey LIKE 'sentinel:%' OR cards.idempotencyKey LIKE 'request:%') ORDER BY cards.createdAt`).all() as { id: string; key: string; createdAt: string; boardId: string; prNumber: number | null }[];
    if (!rows.length) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const findings = new Map<string, SentinelFinding[]>();
      for (const row of rows) {
        const kind: SentinelKind = row.key.startsWith("request:") ? "pr-requests" : "pr-health";
        const sentinel = this.ensureSentinel(row.boardId, kind, intervals[kind]);
        const runId = legacyRunId(sentinel.id);
        this.db.prepare("INSERT OR IGNORE INTO sentinel_runs(id, sentinelId, status, startedAt, finishedAt, summary) VALUES (?, ?, 'succeeded', ?, ?, 'Jobs made before sentinels kept their own runs')")
          .run(runId, sentinel.id, row.createdAt, row.createdAt);
        const prNumber = row.prNumber ?? Number(row.key.match(/^sentinel:(\d+):/)?.[1] ?? NaN);
        const key = Number.isInteger(prNumber) ? prFindingKey(prNumber) : `legacy:${row.key}`;
        this.db.prepare("UPDATE cards SET sentinelId=?, sentinelRunId=?, findingKey=? WHERE id=? AND sentinelId IS NULL").run(sentinel.id, runId, key, row.id);
        findings.set(runId, [...findings.get(runId) ?? [], { key, cardId: row.id, outcome: "created" }]);
      }
      for (const [runId, items] of findings) {
        const run = this.getRun(runId)!;
        this.db.prepare("UPDATE sentinel_runs SET findings=? WHERE id=?").run(JSON.stringify([...run.findings.filter(old => !items.some(item => item.cardId === old.cardId)), ...items]), runId);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return rows.length;
  }
  private toLock(row: Row | undefined): LockRow | undefined {
    return row && { repo: row.repo, prNumber: row.prNumber, holder: row.holder, startedAt: row.startedAt, ...(row.releasedAt ? { releasedAt: row.releasedAt } : {}), commentId: row.commentId, state: row.state };
  }
  getLock(repo: string, prNumber: number): LockRow | undefined {
    return this.toLock(this.db.prepare("SELECT * FROM pr_locks WHERE repo=? AND prNumber=?").get(repo, prNumber) as Row | undefined);
  }
  listPendingLocks(): LockRow[] {
    return (this.db.prepare("SELECT * FROM pr_locks WHERE state='pending'").all() as Row[]).map(row => this.toLock(row)!);
  }
  /** Step 1 of taking a lock: record the intent, keeping any comment id from an earlier lock so it is edited, not duplicated. */
  beginLock(repo: string, prNumber: number, holder: string, startedAt: string): void {
    this.db.prepare(`INSERT INTO pr_locks(repo, prNumber, holder, startedAt, releasedAt, commentId, state) VALUES (?, ?, ?, ?, NULL, NULL, 'pending')
      ON CONFLICT(repo, prNumber) DO UPDATE SET holder=excluded.holder, startedAt=excluded.startedAt, releasedAt=NULL, state='pending'`).run(repo, prNumber, holder, startedAt);
  }
  /** Step 2: the comment exists. */
  confirmLock(repo: string, prNumber: number, commentId: string): void {
    this.db.prepare("UPDATE pr_locks SET commentId=?, state='held' WHERE repo=? AND prNumber=? AND state='pending'").run(commentId, repo, prNumber);
  }
  dropPendingLock(repo: string, prNumber: number): void {
    this.db.prepare("DELETE FROM pr_locks WHERE repo=? AND prNumber=? AND state='pending' AND commentId IS NULL").run(repo, prNumber);
  }
  markReleased(repo: string, prNumber: number, releasedAt: string): void {
    this.db.prepare("UPDATE pr_locks SET releasedAt=?, state='released' WHERE repo=? AND prNumber=?").run(releasedAt, repo, prNumber);
  }
  /** Comments up to this time have been read for `/bakery` requests; undefined until the repository is first looked at. */
  requestCursor(repo: string): string | undefined {
    return (this.db.prepare("SELECT since FROM pr_request_cursor WHERE repo=?").get(repo) as { since: string } | undefined)?.since;
  }
  setRequestCursor(repo: string, since: string): void {
    this.db.prepare("INSERT INTO pr_request_cursor(repo, since) VALUES (?, ?) ON CONFLICT(repo) DO UPDATE SET since=excluded.since").run(repo, since);
  }
  /** Marks an attempt's card as made for a `/bakery` request, not to fix a broken PR: the sentinel's limits and withdrawal leave it alone. */
  markRequestCard(cardId: string): void { this.db.prepare("INSERT OR IGNORE INTO pr_request_cards(cardId) VALUES (?)").run(cardId); }
  isRequestCard(cardId: string): boolean { return !!this.db.prepare("SELECT 1 FROM pr_request_cards WHERE cardId=?").get(cardId); }
  /** Request cards of this repo with the PR each is for. */
  listRequestCards(repo: string): { cardId: string; prNumber: number }[] {
    return this.db.prepare("SELECT a.cardId, a.prNumber FROM sentinel_attempts a JOIN pr_request_cards r ON r.cardId=a.cardId WHERE a.repo=?").all(repo) as { cardId: string; prNumber: number }[];
  }
  attemptCount(repo: string, prNumber: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM sentinel_attempts WHERE repo=? AND prNumber=? AND cardId NOT IN (SELECT cardId FROM pr_request_cards)").get(repo, prNumber) as { n: number }).n;
  }
  hasAttempt(repo: string, prNumber: number, head: string, mainTip: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sentinel_attempts WHERE repo=? AND prNumber=? AND head=? AND mainTip=? AND cardId NOT IN (SELECT cardId FROM pr_request_cards)").get(repo, prNumber, head, mainTip);
  }
  recordAttempt(repo: string, prNumber: number, branch: string, head: string, mainTip: string, cardId: string, at: string): void {
    this.db.prepare("INSERT INTO sentinel_attempts(repo, prNumber, branch, head, mainTip, cardId, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(repo, prNumber, branch, head, mainTip, cardId, at);
  }
  /** Card ids of this PR's sentinel attempts, newest first. */
  attemptCards(repo: string, prNumber: number): string[] {
    return (this.db.prepare("SELECT cardId FROM sentinel_attempts WHERE repo=? AND prNumber=? ORDER BY id DESC").all(repo, prNumber) as { cardId: string }[]).map(row => row.cardId);
  }
  /** Returns true the first time it is called for a PR, so the "needs a person" comment is posted once. */
  markGivenUp(repo: string, prNumber: number, at: string): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO sentinel_given_up(repo, prNumber, at) VALUES (?, ?, ?)").run(repo, prNumber, at).changes) > 0;
  }
  /** Card ids of every sentinel attempt on a repo. */
  listAttemptCards(repo: string): string[] {
    return (this.db.prepare("SELECT cardId FROM sentinel_attempts WHERE repo=? AND cardId NOT IN (SELECT cardId FROM pr_request_cards)").all(repo) as { cardId: string }[]).map(row => row.cardId);
  }
  attemptPr(cardId: string): number | undefined {
    return (this.db.prepare("SELECT prNumber FROM sentinel_attempts WHERE cardId=?").get(cardId) as { prNumber: number } | undefined)?.prNumber;
  }
  attemptFor(cardId: string): { repo: string; prNumber: number; branch: string; head: string } | undefined {
    return this.db.prepare("SELECT repo, prNumber, branch, head FROM sentinel_attempts WHERE cardId=?").get(cardId) as { repo: string; prNumber: number; branch: string; head: string } | undefined;
  }
}
