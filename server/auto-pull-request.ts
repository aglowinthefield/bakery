import type { Board, Card } from "./board.js";

/**
 * Opens the pull request for Review cards on github-pr boards that turned on automatic pull requests (see
 * `Board.listAutoPullRequestCandidates`), without waiting for Approve. `draft` writes the title and body, which can take
 * minutes; afterwards the card and board are reloaded and the push only happens if the card is still eligible. `push`
 * pushes like Approve does and returns the card. With auto-review on, the agent reviewer goes first; a run it handed to a
 * person gets a draft pull request, and `push` receives the reviewer's findings to post on it. A failure stays on the card's pull request error and History for a person.
 */
export type PullRequestDraft = { title: string; body: string };
export class AutoPullRequest {
  private active = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;
  constructor(private board: Board, private fingerprint: (card: Card) => string, private draft: (card: Card, fingerprint: string) => Promise<PullRequestDraft>,
    private push: (card: Card, fingerprint: string, draft: PullRequestDraft, handoff?: string) => Promise<Card>) {}
  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, 5000);
    void this.tick();
  }
  /** Stops claiming new cards and resolves once the pushes in progress have finished. */
  async drain(): Promise<void> {
    this.draining = true;
    if (this.timer) clearInterval(this.timer);
    while (this.active.size) await new Promise(resolve => setTimeout(resolve, 50));
  }
  get activeCount(): number { return this.active.size; }
  /** Starts every waiting card not already being opened, and resolves once those it started have finished. */
  async tick(): Promise<void> {
    if (this.draining) return;
    const started: Promise<void>[] = [];
    for (const { card, run } of this.board.listAutoPullRequestCandidates()) {
      if (this.active.has(card.id) || !this.board.claimAutoPullRequest(card.id, run.id)) continue;
      this.active.add(card.id);
      started.push(this.process(card, run.id).finally(() => this.active.delete(card.id)));
    }
    await Promise.all(started);
  }
  /** The card as it is now, or an error saying why Bakery must not push what it drafted. */
  private refreshed(card: Card, runId: string, optedInAt: string | null | undefined): Card {
    const fresh = this.board.getCard(card.id), run = this.board.listRuns(card.id)[0];
    const current = this.board.boardForRepo(card.repo);
    if (!fresh || fresh.status !== "review" || run?.id !== runId || run.status !== "review") throw new Error("The card changed while the pull request was drafted");
    if (fresh.prOverrideUrl) throw new Error(`The card was linked to ${fresh.prOverrideUrl} while the pull request was drafted`);
    if (fresh.prPushedRunId === run.id) throw new Error("This run was pushed while the pull request was drafted");
    if (!current || current.integration !== "github-pr" || !current.autoPullRequestEnabled || current.autoPullRequestEnabledAt !== optedInAt) throw new Error("Automatic pull requests were turned off or changed while the pull request was drafted");
    if (this.board.agentReviewPending(current, card.id, run)) throw new Error("The agent reviewer took over this run while the pull request was drafted");
    return fresh;
  }
  private async process(card: Card, runId: string): Promise<void> {
    try {
      const fingerprint = this.fingerprint(card), optedInAt = this.board.boardForRepo(card.repo)?.autoPullRequestEnabledAt;
      const drafted = await this.draft(card, fingerprint);
      const fresh = this.refreshed(card, runId, optedInAt);
      // A run the agent reviewer handed to a person opens as a draft, with its findings on the pull request.
      const handoff = this.board.boardForRepo(card.repo)?.autoReviewEnabled ? this.board.autoReviewHandoff(runId) ?? undefined : undefined;
      const opened = await this.push(fresh, fingerprint, drafted, handoff);
      if (opened.prUrl && opened.prState === "OPEN") {
        this.board.noteCard(card.id, handoff ? `Opened ${opened.prUrl} as a draft after the agent reviewer left the card for a person` : `Opened ${opened.prUrl} automatically when the run reached Review`);
        console.log(`Opened ${opened.prUrl} automatically for card ${card.id} in ${card.repo}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.board.recordPullRequestError(card.id, `Bakery could not open the pull request automatically: ${message}. Review it and Approve to open it yourself.`);
      this.board.noteCard(card.id, `Bakery could not open the pull request automatically: ${message}`);
      console.error(`Could not open a pull request automatically for card ${card.id}: ${message}`);
    }
  }
}
