import type { GitHub } from "./github.js";
import { lockBody, lockStatus, parseLock, type LockStatus, type PrLock } from "./pr-lock.js";
import type { SentinelStore } from "./sentinel-store.js";

/**
 * Lock comments on PRs, kept in step with the `pr_locks` table. GitHub and SQLite cannot share a transaction, so
 * the order is what makes the pair safe: the row is written first as `pending`, then the comment is posted or
 * edited, then the row is confirmed. A crash in between leaves a `pending` row, and `reconcile` settles it from
 * what is actually on the PR.
 */
export class PrLocks {
  constructor(private readonly store: SentinelStore, private readonly github: GitHub, private readonly now: () => number = Date.now) {}

  /** Takes the lock for `holder`, or returns the live lock somebody else holds. */
  async acquire(repo: string, number: number, holder: string): Promise<{ acquired: true } | { acquired: false; lock: PrLock }> {
    const current = await this.current(repo, number);
    if (current && current.status === "active" && current.lock.holder !== holder) { console.log(`[lock ${repo}#${number}] ${holder} refused: held by ${current.lock.holder} since ${current.lock.startedAt}`); return { acquired: false, lock: current.lock }; }
    const lock: PrLock = { holder, startedAt: new Date(this.now()).toISOString() };
    this.store.beginLock(repo, number, holder, lock.startedAt);
    try {
      const existing = this.store.getLock(repo, number)?.commentId ?? current?.commentId;
      let id: string;
      if (existing) { await this.github.editComment(repo, existing, lockBody(lock)); id = existing; }
      else id = await this.github.createComment(repo, number, lockBody(lock));
      this.store.confirmLock(repo, number, id);
      console.log(`[lock ${repo}#${number}] ${holder} ${existing ? "refreshed" : "took"} the lock (comment ${id})`);
    } catch (error) { this.store.dropPendingLock(repo, number); throw error; }
    return { acquired: true };
  }

  /** Marks the lock released if `holder` holds it. Anyone else's lock is left alone. */
  async release(repo: string, number: number, holder: string): Promise<void> {
    const row = this.store.getLock(repo, number);
    if (!row?.commentId || row.holder !== holder || row.state === "released") return;
    const releasedAt = new Date(this.now()).toISOString();
    await this.github.editComment(repo, row.commentId, lockBody({ holder, startedAt: row.startedAt, releasedAt }));
    this.store.markReleased(repo, number, releasedAt);
    console.log(`[lock ${repo}#${number}] ${holder} released the lock`);
  }

  /** The lock on the PR as GitHub shows it (the comment is the source of truth), with its status. */
  async current(repo: string, number: number): Promise<{ lock: PrLock; status: LockStatus; commentId: string } | undefined> {
    const comments = await this.github.listComments(repo, number);
    for (const comment of comments.reverse()) {
      const lock = parseLock(comment.body);
      if (lock) return { lock, status: lockStatus(lock, this.now()), commentId: comment.id };
    }
    return undefined;
  }

  /** Settles rows left `pending` by a crash: confirm them when their comment exists, drop them when it never got posted. */
  async reconcile(): Promise<void> {
    for (const row of this.store.listPendingLocks()) {
      try {
        const found = await this.current(row.repo, row.prNumber);
        if (found && found.lock.holder === row.holder && found.lock.startedAt === row.startedAt) this.store.confirmLock(row.repo, row.prNumber, found.commentId);
        else if (row.commentId) {
          await this.github.editComment(row.repo, row.commentId, lockBody({ holder: row.holder, startedAt: row.startedAt }));
          this.store.confirmLock(row.repo, row.prNumber, row.commentId);
        }
        else this.store.dropPendingLock(row.repo, row.prNumber);
      } catch (error) { console.error(`Could not reconcile the lock on ${row.repo}#${row.prNumber}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
}
