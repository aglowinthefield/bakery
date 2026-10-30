import type { Board } from "./board.js";
import type { Worker } from "./worker.js";

// The database claim is the final concurrency/cap guard. This timer only chooses eligible Ready cards, and Review
// cards whose refused push waits for a slot; it never resumes interrupted runs or retries failed ones. Like the start
// limit, a reached cost budget only makes pickup wait; spend already running is never stopped.
export class AutoPickup {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly board: Board, private readonly worker: Worker) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 2000);
    this.tick();
  }
  shutdown(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  tick(): void {
    this.board.resumeResolvedAutoPickup();
    // A refused push that hit the run limit goes first: the operator already asked for it by approving.
    for (const card of this.board.listWaitingHookFixes()) {
      try {
        this.worker.startHookFix(card);
      } catch (error) {
        this.board.noteCard(card.id, `Could not send the refused push's hook output to the agent: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const repoBoard of this.board.listBoards().filter(item => item.autoPickupEnabled)) {
      const blocker = this.board.autoPickupBlocker(repoBoard);
      if (blocker) {
        this.board.pauseAutoPickup(repoBoard.id, blocker.reason, blocker.kind === "failed_run");
        continue;
      }
      const candidates = this.board.listAutoPickupCandidates().filter(item => item.board.id === repoBoard.id);
      for (const { card } of candidates) {
        if (this.board.runningCount(repoBoard.repo) >= repoBoard.pickupConcurrency || (repoBoard.pickupDailyLimit > 0 && this.board.autoStartsToday(repoBoard.repo) >= repoBoard.pickupDailyLimit) ||
          this.board.autoPickupBudgetReached(repoBoard.repo)) break;
        try {
          this.worker.start(card, "auto");
        } catch (error) {
          this.board.pauseAutoPickup(repoBoard.id, `Could not start ${card.title}: ${String(error)}`);
          break;
        }
      }
    }
  }
}
