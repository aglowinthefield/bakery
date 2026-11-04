import { existsSync } from "node:fs";
import { join } from "node:path";
import { reportFromOutput, type Board, type Card, type RepoBoard, type Run } from "./board.js";
import { boardGithubRepo, type Check, commentOnPullRequest, fetchOrigin, fixableFailures, git, type GitHub } from "./github.js";
import type { PrLocks } from "./pr-locks.js";
import type { SentinelStore } from "./sentinel-store.js";

/** Sentinel cards per PR before it is left to a person. Counts sentinel attempts only. */
export const maxSentinelAttempts = 3;
/** Open sentinel cards per board, so a bad day on main cannot flood the board. */
export const maxOpenSentinelCards = 5;

const holderOf = (cardId: string) => `sentinel:${cardId}`;
const isOpen = (card: Card) => card.status !== "done" && card.status !== "archived";

/** The brief on a sentinel card. Rebasing onto the latest main comes first, before anything is investigated. */
export function sentinelBrief(input: { repo: string; number: number; url: string; branch: string; head: string; mainTip: string; problems: string[] }): string {
  return [
    `Pull request ${input.url} (branch \`${input.branch}\`) is not mergeable and no Bakery agent is working on it. Make it mergeable.`,
    `Found at head ${input.head.slice(0, 12)} with origin/main at ${input.mainTip.slice(0, 12)}:`,
    ...input.problems.map(problem => `- ${problem}`),
    "",
    "Do these in order:",
    `1. Fetch, then put the PR branch in this worktree: \`git fetch origin && git switch -C ${input.branch} origin/${input.branch}\`.`,
    "2. Before investigating anything, rebase it onto the latest origin/main: `git fetch origin main && git rebase origin/main`. Resolve conflicts that are mechanical. If one needs a human decision, run `git rebase --abort`, change nothing, and say exactly what the decision is.",
    "3. Only now look at CI. A failure may already be gone after the rebase; judge it against the rebased code, not the old head. Fix real failures and run the repository's local verification.",
    `4. Leave the fixed result committed on \`${input.branch}\` in this worktree, with a clean working tree. Do not push: Bakery force-pushes it to the PR when you finish, and only if origin/${input.branch} still has the head named above.`,
    "Do not open a new PR, and change nothing outside this PR's scope.",
  ].join("\n");
}

/**
 * Fallback for PRs the card-bound triggers (`sendBackConflict`, `sendBackFailingCi`) cannot reach: PRs whose card is
 * gone or has no worktree, whose agent died mid-run, or that were opened by hand. For each open PR written by the
 * board's owner that conflicts or fails CI, with no live lock, it makes one Ready card to fix it.
 */
export class Sentinel {
  private timer?: ReturnType<typeof setInterval>;
  private owner?: string;
  private running = new Set<string>();
  constructor(private readonly board: Board, private readonly github: GitHub, private readonly store: SentinelStore, private readonly locks: PrLocks,
    private readonly dataDir: string, private readonly ownerLogin?: string, private readonly intervalMs = 5 * 60_000) {
    board.onRun((event, run) => event === "finished" ? this.afterRun(run) : undefined);
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.locks.reconcile().then(() => this.tick());
  }
  shutdown(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async tick(): Promise<void> {
    await Promise.all(this.board.listBoards().filter(item => item.integration === "github-pr").map(item => this.pass(item.id)));
  }
  /** One board. Passes never overlap on a board; errors are logged and the next pass retries. */
  async pass(boardId: string): Promise<void> {
    if (this.running.has(boardId)) return;
    this.running.add(boardId);
    const started = Date.now();
    try {
      const repoBoard = this.board.getBoard(boardId);
      if (repoBoard?.integration === "github-pr") await this.passOnce(repoBoard);
    } catch (error) { console.error(`[sentinel ${boardId.slice(0, 8)}] pass failed after ${Date.now() - started}ms: ${error instanceof Error ? error.message : String(error)}`); }
    finally { this.running.delete(boardId); }
  }

  private async passOnce(repoBoard: RepoBoard): Promise<void> {
    const repo = boardGithubRepo(repoBoard);
    this.owner ??= this.ownerLogin || await this.github.viewer();
    // The latest main is what every judgment below is made against.
    await fetchOrigin(repoBoard.repo);
    const mainTip = await git(repoBoard.repo, "rev-parse", "origin/main");
    // Only the owner's open PRs matter, so the listing is limited to them, and each non-draft one is checked on its own.
    const prs = await this.github.listOpenPullRequests(repo, this.owner);
    const extra = new Map<number, { mergeable?: string; statusCheckRollup?: Check[] } | undefined>();
    const checkable = prs.filter(pr => !pr.isDraft && pr.author?.login?.toLowerCase() === this.owner!.toLowerCase());
    for (let i = 0; i < checkable.length; i += 4) {
      await Promise.all(checkable.slice(i, i + 4).map(async pr => {
        try { extra.set(pr.number, await this.github.health(repo, pr.number)); }
        catch (error) { extra.set(pr.number, undefined); console.error(`[sentinel ${repo}] #${pr.number}: could not read its state: ${error instanceof Error ? error.message : String(error)}`); }
      }));
    }
    const cards = this.board.listCards(repoBoard.repo).filter(isOpen);
    const sentinelCards = new Set(this.store.listAttemptCards(repo));
    const open = new Set(prs.map(pr => pr.number));
    const tag = `[sentinel ${repo}]`, tally = new Map<string, number>();
    const skip = (pr: { number: number }, why: string) => { tally.set(why, (tally.get(why) ?? 0) + 1); console.debug(`${tag} #${pr.number}: skipped, ${why}`); };
    console.log(`${tag} pass: ${prs.length} open PR(s), origin/main ${mainTip.slice(0, 12)}, owner ${this.owner}, ${cards.filter(card => sentinelCards.has(card.id)).length} open sentinel card(s)`);

    await this.withdrawResolved(repoBoard, repo, cards, sentinelCards, prs.filter(pr => {
      const item = extra.get(pr.number);
      // A PR whose state could not be read counts as broken, so its unstarted card is not withdrawn on a guess.
      return !extra.has(pr.number) || !item || item.mergeable === "CONFLICTING" || fixableFailures({ statusCheckRollup: item?.statusCheckRollup }).length > 0;
    }).map(pr => pr.number), open);

    let openSentinel = cards.filter(card => sentinelCards.has(card.id)).length;
    for (const pr of prs) {
      if (pr.author?.login?.toLowerCase() !== this.owner.toLowerCase()) { skip(pr, "not written by the owner"); continue; }
      if (pr.isDraft) { skip(pr, "draft"); continue; }
      const item = extra.get(pr.number);
      if (!item) { skip(pr, "its state could not be read"); continue; }
      const problems: string[] = [];
      if (item?.mergeable === "CONFLICTING") problems.push("It conflicts with main.");
      const failing = fixableFailures({ statusCheckRollup: item?.statusCheckRollup });
      if (failing.length) problems.push(`CI is failing: ${failing.map(check => check.name || check.context || check.workflowName || "a check").join(", ")}.`);
      if (!problems.length) { skip(pr, `healthy (mergeable=${item?.mergeable ?? "unknown"}, no fixable failures)`); continue; }
      // A card the existing triggers still work on, or a sentinel card already open for it.
      if (cards.some(card => card.prNumber === pr.number && !(card.ciReworks >= 3 && card.conflictRepairs >= 3) && !sentinelCards.has(card.id))) { skip(pr, `broken (${problems.join(" ")}) but its own card still handles it`); continue; }
      if (cards.some(card => card.prNumber === pr.number && sentinelCards.has(card.id))) { skip(pr, "a sentinel card is already open for it"); continue; }
      if (this.store.attemptCount(repo, pr.number) >= maxSentinelAttempts) {
        console.log(`${tag} #${pr.number}: ${maxSentinelAttempts} attempts used; giving up`);
        if (this.store.markGivenUp(repo, pr.number, new Date().toISOString()))
          await commentOnPullRequest(this.github, repo, pr.number, `Bakery's sentinel tried ${maxSentinelAttempts} times to get this pull request mergeable and stopped. A person needs to take it from here.`);
        continue;
      }
      if (openSentinel >= maxOpenSentinelCards) { console.log(`${tag} #${pr.number}: stopping, ${maxOpenSentinelCards} open sentinel cards is the cap`); break; }
      const lock = await this.locks.current(repo, pr.number);
      if (lock?.status === "active") { skip(pr, `broken but locked by ${lock.lock.holder} since ${lock.lock.startedAt}`); continue; }
      // Re-read the PR so the card is built from its current head, not the one in the listing.
      const fresh = await this.github.view(repo, pr.number);
      if (fresh.state !== "OPEN" || !fresh.headRefOid) { skip(pr, `no longer open (${fresh.state})`); continue; }
      if (this.store.hasAttempt(repo, pr.number, fresh.headRefOid, mainTip)) { skip(pr, `already tried at head ${fresh.headRefOid.slice(0, 12)} with main ${mainTip.slice(0, 12)}`); continue; }
      console.log(`${tag} #${pr.number}: broken (${problems.join(" ")}) head ${fresh.headRefOid.slice(0, 12)}, no live lock; making a card`);
      const created = await this.createCard(repoBoard, repo, pr, fresh.headRefOid, fresh.headRefName, mainTip, problems);
      if (created) openSentinel += 1;
    }
    console.log(`${tag} pass done: ${[...tally].map(([why, n]) => `${n}× ${why.replace(/ \(.*$/, "")}`).join("; ") || "nothing skipped"}`);
  }

  private async createCard(repoBoard: RepoBoard, repo: string, pr: { number: number; title: string; url: string }, head: string, branch: string, mainTip: string, problems: string[]): Promise<boolean> {
    const card = this.board.createCard({ title: `Fix PR #${pr.number}: ${pr.title}`, repo: repoBoard.repo, idempotencyKey: `sentinel:${pr.number}:${head}:${mainTip}`, priority: 0,
      body: sentinelBrief({ repo, number: pr.number, url: pr.url, branch, head, mainTip, problems }) });
    // The attempt is recorded before the lock so a failed comment cannot lead to a second card for the same state.
    this.store.recordAttempt(repo, pr.number, branch, head, mainTip, card.id, new Date().toISOString());
    console.log(`[sentinel ${repo}] #${pr.number}: created card ${card.id.slice(0, 8)} for branch ${branch}`);
    this.board.setStatus(card.id, "ready", "Created by Bakery's sentinel: the pull request is not mergeable and nothing is working on it");
    try { await this.locks.acquire(repo, pr.number, holderOf(card.id)); }
    catch (error) { console.error(`Sentinel could not lock ${repo}#${pr.number}: ${error instanceof Error ? error.message : String(error)}`); }
    return true;
  }

  /** Sentinel cards that have not started and whose PR is merged, closed or fine again no longer have a job. */
  private async withdrawResolved(repoBoard: RepoBoard, repo: string, cards: Card[], sentinelCards: Set<string>, broken: number[], open: Set<number>): Promise<void> {
    for (const card of cards) {
      if (!sentinelCards.has(card.id) || (card.status !== "ready" && card.status !== "triage")) continue;
      const number = this.store.attemptPr(card.id);
      if (number === undefined || (open.has(number) && broken.includes(number))) continue;
      const why = open.has(number) ? "is mergeable again" : "was merged or closed";
      console.log(`[sentinel ${repo}] #${number}: withdrawing unstarted card ${card.id.slice(0, 8)}, the pull request ${why}`);
      try {
        this.board.setStatus(card.id, "done", `Withdrawn by Bakery's sentinel: the pull request ${why}`);
        await this.locks.release(repo, number, holderOf(card.id));
      } catch (error) { console.error(`Sentinel could not withdraw card ${card.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /**
   * A finished sentinel run leaves the fixed branch committed in its worktree. Bakery pushes it, because agents do not
   * push. The push is leased to the head the card was made from, so it fails rather than overwrite a newer push by a
   * person. With nothing to push, the agent's report goes on the PR for a person to read.
   */
  async afterRun(run: Run): Promise<void> {
    const attempt = this.store.attemptFor(run.cardId);
    if (!attempt || run.status !== "review") return;
    const worktree = join(this.dataDir, "worktrees", run.cardId);
    const tag = `[sentinel ${attempt.repo}#${attempt.prNumber}]`;
    console.log(`${tag} run ${run.id.slice(0, 8)} finished; checking ${worktree}`);
    const say = (text: string) => commentOnPullRequest(this.github, attempt.repo, attempt.prNumber, text);
    const report = (reportFromOutput(this.board.getRun(run.id)?.output ?? "") ?? "").trim();
    const quoted = report ? `\n\nThe agent's report:\n\n${report.slice(0, 3000).split("\n").map(line => `> ${line}`).join("\n")}` : "";
    try {
      if (!existsSync(worktree)) throw new Error("the card worktree is missing");
      await fetchOrigin(worktree);
      const dirty = await git(worktree, "status", "--porcelain");
      if (dirty) { console.log(`${tag} not pushing: uncommitted changes`); await say(`Bakery's sentinel's fix was left with uncommitted changes in its worktree, so nothing was pushed. A person needs to take it from here.${quoted}`); return; }
      if (await git(worktree, "rev-parse", "HEAD") === attempt.head) { console.log(`${tag} not pushing: head unchanged`); await say(`Bakery's sentinel tried to fix this pull request and left it unchanged, so nothing was pushed. A person needs to take it from here.${quoted}`); return; }
      const onMain = () => git(worktree, "merge-base", "--is-ancestor", "origin/main", "HEAD").then(() => true, () => false);
      let rebased = false;
      if (!await onMain()) {
        // Main moved while the agent worked (a long verification run on a busy main). Catch up, and push only if that is clean.
        console.log(`${tag} origin/main moved during the run; rebasing the result onto it`);
        try { await git(worktree, "rebase", "origin/main"); rebased = true; }
        catch (error) {
          await git(worktree, "rebase", "--abort").catch(() => undefined);
          console.log(`${tag} not pushing: rebasing onto the newer origin/main conflicts`);
          await say(`Bakery's sentinel fixed this pull request, but main moved while it worked and rebasing onto the newer main conflicts: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}. Nothing was pushed. The next sentinel pass tries again against the new main.${quoted}`);
          return;
        }
      }
      const tip = await git(worktree, "rev-parse", "HEAD");
      console.log(`${tag} worktree tip ${tip.slice(0, 12)} (card head ${attempt.head.slice(0, 12)})${rebased ? ", after catching up with main" : ""}`);
      await git(worktree, "push", `--force-with-lease=refs/heads/${attempt.branch}:${attempt.head}`, "origin", `HEAD:refs/heads/${attempt.branch}`);
      console.log(`${tag} pushed ${tip.slice(0, 12)} to ${attempt.branch}`);
      this.board.closeDelivered(run.cardId, `Pushed to ${attempt.branch} on the pull request`);
      await say(`Bakery's sentinel rebased this pull request onto the latest main and pushed ${tip.slice(0, 12)}. If CI fails again, it checks again on its next pass.${quoted}`);
    } catch (error) {
      console.error(`${tag} push failed: ${error instanceof Error ? error.message : String(error)}`);
      await say(`Bakery's sentinel could not push its fix: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}. A person needs to take it from here.${quoted}`);
    }
  }
}
