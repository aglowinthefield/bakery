import type { DatabaseSync } from "node:sqlite";
import type { PrLock } from "./pr-lock.js";

/** A lock row. `pending` means the comment may not exist yet: the row is written first, then the comment, then the row is confirmed. */
export type LockRow = PrLock & { repo: string; prNumber: number; commentId: string | null; state: "pending" | "held" | "released" };
type Row = { repo: string; prNumber: number; holder: string; startedAt: string; releasedAt: string | null; commentId: string | null; state: LockRow["state"] };

export class SentinelStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pr_locks (repo TEXT NOT NULL, prNumber INTEGER NOT NULL, holder TEXT NOT NULL, startedAt TEXT NOT NULL, releasedAt TEXT, commentId TEXT, state TEXT NOT NULL CHECK(state IN ('pending','held','released')), PRIMARY KEY (repo, prNumber));
      CREATE TABLE IF NOT EXISTS sentinel_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, prNumber INTEGER NOT NULL, branch TEXT NOT NULL, head TEXT NOT NULL, mainTip TEXT NOT NULL, cardId TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(repo, prNumber, head, mainTip));
      CREATE TABLE IF NOT EXISTS sentinel_given_up (repo TEXT NOT NULL, prNumber INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (repo, prNumber));
    `);
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
  attemptCount(repo: string, prNumber: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM sentinel_attempts WHERE repo=? AND prNumber=?").get(repo, prNumber) as { n: number }).n;
  }
  hasAttempt(repo: string, prNumber: number, head: string, mainTip: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sentinel_attempts WHERE repo=? AND prNumber=? AND head=? AND mainTip=?").get(repo, prNumber, head, mainTip);
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
    return (this.db.prepare("SELECT cardId FROM sentinel_attempts WHERE repo=?").all(repo) as { cardId: string }[]).map(row => row.cardId);
  }
  attemptPr(cardId: string): number | undefined {
    return (this.db.prepare("SELECT prNumber FROM sentinel_attempts WHERE cardId=?").get(cardId) as { prNumber: number } | undefined)?.prNumber;
  }
  attemptFor(cardId: string): { repo: string; prNumber: number; branch: string; head: string } | undefined {
    return this.db.prepare("SELECT repo, prNumber, branch, head FROM sentinel_attempts WHERE cardId=?").get(cardId) as { repo: string; prNumber: number; branch: string; head: string } | undefined;
  }
}
