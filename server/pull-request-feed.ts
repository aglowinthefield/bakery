import { boardGithubRepo, checksState, type GitHub, type RepoPullRequest } from "./github.js";
import type { Board } from "./board.js";
import { githubRepo } from "./github-url.js";

type Entry = { pulls: RepoPullRequest[]; at: number };

/**
 * Open pull requests per GitHub repository, kept fresh in the background so the Pull requests page opens
 * from memory. Each refresh fetches the quick list first and publishes it, then adds the slow fields
 * (line counts, review decision, CI) when GitHub returns them.
 */
export class PullRequestFeed {
  private entries = new Map<string, Entry>();
  private inFlight = new Map<string, Promise<void>>();
  private lastRun = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly board: Board, private readonly github: GitHub, private readonly intervalMs = 60_000) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5000);
    void this.tick();
  }
  shutdown(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private async tick(): Promise<void> {
    for (const item of this.board.listBoards())
      if (githubRepo(item.remoteUrl) && Date.now() - (this.lastRun.get(item.id) ?? 0) >= this.intervalMs) void this.refresh(item.id).catch(() => {});
  }
  /** What is known now: the pulls and when they were fetched, or undefined before the first fetch lands. */
  get(boardId: string): Entry | undefined { return this.entries.get(boardId); }
  /** Refreshes one board, sharing an in-flight pass. Resolves once the quick list is published. */
  refresh(boardId: string): Promise<void> {
    const existing = this.inFlight.get(boardId);
    if (existing) return existing;
    const repoBoard = this.board.getBoard(boardId);
    if (!repoBoard) return Promise.resolve();
    this.lastRun.set(boardId, Date.now());
    const repo = boardGithubRepo(repoBoard);
    const quick = this.github.listOpenPullRequests(repo).then(list => {
      const before = new Map((this.entries.get(boardId)?.pulls ?? []).map(pr => [pr.number, pr]));
      // Keep the slow fields from the last pass until the new ones arrive.
      this.entries.set(boardId, { at: Date.now(), pulls: list.map(pr => ({ ...pr, additions: before.get(pr.number)?.additions, deletions: before.get(pr.number)?.deletions, reviewDecision: before.get(pr.number)?.reviewDecision, mergeable: before.get(pr.number)?.mergeable, checks: before.get(pr.number)?.checks })) });
    });
    const whole = quick
      .then(() => this.github.listOpenPullRequestExtras(repo).catch(() => this.github.listOpenPullRequestExtras(repo)))
      .then(extras => {
        const entry = this.entries.get(boardId);
        if (!entry) return;
        const byNumber = new Map(extras.map(extra => [extra.number, extra]));
        entry.pulls = entry.pulls.map(pr => {
          const extra = byNumber.get(pr.number);
          return extra ? { ...pr, additions: extra.additions, deletions: extra.deletions, reviewDecision: extra.reviewDecision, mergeable: extra.mergeable as RepoPullRequest["mergeable"], checks: checksState({ statusCheckRollup: extra.statusCheckRollup }) } : pr;
        });
      })
      .catch(error => { if (!this.entries.has(boardId)) throw error; console.error(`Pull request details for ${repo}: ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => this.inFlight.delete(boardId));
    this.inFlight.set(boardId, whole);
    // Callers wait for the quick list only; a failed quick list rejects for them and for the shared pass.
    return quick.catch(error => { this.inFlight.delete(boardId); throw error; });
  }
}
