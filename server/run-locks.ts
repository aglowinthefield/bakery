import type { Board, Run } from "./board.js";
import { boardGithubRepo } from "./github.js";
import type { PrLocks } from "./pr-locks.js";
import type { SentinelStore } from "./sentinel-store.js";

/** Lock refresh interval. Well inside the 30-minute lifetime, so a long run keeps its lock. */
const refreshMs = 10 * 60_000;

/**
 * Locks a card's open PR for as long as one of its runs is active: taken when the run starts, refreshed while it
 * runs, released when it finishes. A run that dies without finishing leaves the lock to expire, which is the
 * signal the sentinel waits for. Cards without a PR yet (a first feature run) take no lock.
 */
export class RunLocks {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private taking = new Map<string, Promise<void>>();
  constructor(private readonly board: Board, private readonly locks: PrLocks, private readonly store: SentinelStore, private readonly enabled = true) {
    if (enabled) board.runListener = (event, run) => void this.handle(event, run);
  }
  shutdown(): void { for (const timer of this.timers.values()) clearInterval(timer); this.timers.clear(); }

  /** Where the run's lock goes: the PR, and who holds it. A sentinel card's PR comes from its attempt record. */
  private target(run: Run): { repo: string; number: number; holder: string } | undefined {
    const card = this.board.getCard(run.cardId);
    const repoBoard = card && this.board.listBoards().find(item => item.repo === card.repo);
    if (!card || repoBoard?.integration !== "github-pr") return undefined;
    const repo = boardGithubRepo(repoBoard);
    const sentinelPr = this.store.attemptPr(card.id);
    if (sentinelPr !== undefined) return { repo, number: sentinelPr, holder: `sentinel:${card.id}` };
    if (card.prNumber && card.prState !== "MERGED" && card.prState !== "CLOSED") return { repo, number: card.prNumber, holder: card.id };
    return undefined;
  }

  private async handle(event: "started" | "finished", run: Run): Promise<void> {
    try {
      const target = this.target(run);
      if (!target) return;
      if (event === "started") {
        const taking = this.locks.acquire(target.repo, target.number, target.holder).then(() => undefined);
        this.taking.set(run.id, taking);
        await taking;
        this.timers.set(run.id, setInterval(() => void this.locks.acquire(target.repo, target.number, target.holder).catch(() => undefined), refreshMs));
      } else {
        // A run can finish while its lock is still being taken. Wait, so the release comes after it.
        await this.taking.get(run.id)?.catch(() => undefined);
        this.taking.delete(run.id);
        if (this.timers.has(run.id)) { clearInterval(this.timers.get(run.id)); this.timers.delete(run.id); }
        await this.locks.release(target.repo, target.number, target.holder);
      }
    } catch (error) { console.error(`PR lock for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
