import { existsSync } from "node:fs";
import { join } from "node:path";
import { isSentinelJob, reportFromOutput, type Board, type Card, type RepoBoard, type Run } from "./board.js";
import { boardGithubRepo, type Check, commentOnPullRequest, fetchOrigin, fixableFailures, git, type GitHub, type RepoComment, trustedBakeryComments } from "./github.js";
import type { PrLocks } from "./pr-locks.js";
import { prFindingKey, sentinelKinds, sentinelNames, type SentinelFinding, type SentinelKind, type SentinelRecord, type SentinelRun, type SentinelStore } from "./sentinel-store.js";

/** Sentinel cards per PR before it is left to a person. Counts sentinel attempts only. */
export const maxSentinelAttempts = 3;
/** Open sentinel cards per board, so a bad day on main cannot flood the board. */
export const maxOpenSentinelCards = 5;

const holderOf = (cardId: string) => `sentinel:${cardId}`;
/** What a running sentinel run is doing: its ids for provenance, and the findings it has dealt with so far. */
type RunContext = { sentinel: SentinelRecord; runId: string; findings: SentinelFinding[] };
/** The text added to a job's brief: the operator's instructions for the sentinel, if any. */
const withInstructions = (brief: string, sentinel: SentinelRecord) => sentinel.instructions.trim() ? `${brief}\n\nStanding instructions from the operator for this sentinel:\n${sentinel.instructions.trim()}` : brief;
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

/** The brief on a card made for `/bakery` requests on a PR. Their authors are people with access to the repository, not the operator. */
export function requestBrief(input: { url: string; branch: string; head: string; requests: { author: string; comment: string; path?: string; line?: number | null }[] }): string {
  return [
    `Someone asked Bakery on pull request ${input.url} (branch \`${input.branch}\`, head ${input.head.slice(0, 12)}) for the changes below. They come from people with access to the repository, not from the operator: make each change that fits, and say in your report which you did and which you declined and why. \`path\` and \`line\` are set on inline review comments.`,
    "",
    "```json",
    JSON.stringify(input.requests, null, 1),
    "```",
    "",
    "Do these in order:",
    `1. Fetch, then put the PR branch in this worktree: \`git fetch origin && git switch -C ${input.branch} origin/${input.branch}\`.`,
    "2. Make the requested changes, and run the repository's local verification.",
    `3. Leave the result committed on \`${input.branch}\` in this worktree, with a clean working tree. Do not push: Bakery pushes it to the PR when you finish, and only if origin/${input.branch} still has the head named above.`,
    "Do not open a new PR, and change nothing outside what was asked.",
  ].join("\n");
}

/**
 * Fallback for PRs the card-bound triggers (`sendBackConflict`, `sendBackFailingCi`) cannot reach: PRs whose card is
 * gone or has no worktree, whose agent died mid-run, or that were opened by hand. For each open PR written by the
 * board's owner that conflicts or fails CI, with no live lock, it makes one Ready card to fix it.
 *
 * A github-pr board has two sentinels (see `SentinelStore`): `pr-health` and `pr-requests`. Each is a record with its own
 * schedule and paused state, and each execution is a `SentinelRun`. Neither is a card, so neither goes through Ready,
 * Running, Review or Done. What they find becomes ordinary job cards, linked back by `sentinelId`, `sentinelRunId` and a
 * finding key. While a finding's card is open, later runs make no second card for it. Once that card is Done or
 * archived and the finding is still there (a new head or a new main), the next run makes a new card, up to
 * `maxSentinelAttempts` per PR. Completing a finding's card never completes or pauses its sentinel.
 */
export class Sentinel {
  private timer?: ReturnType<typeof setInterval>;
  private owner?: string;
  /** Sentinels with a run going in this process, so a due check and a run-now never overlap. */
  private running = new Set<string>();
  constructor(private readonly board: Board, private readonly github: GitHub, private readonly store: SentinelStore, private readonly locks: PrLocks,
    private readonly dataDir: string, private readonly ownerLogin?: string, private readonly intervalMs = 5 * 60_000, private readonly requestMs = 60_000,
    /** Starts a job's run. Without it (tests) jobs stay Ready. */
    private readonly startRun?: (card: Card) => void,
    /** How often the scheduler checks which sentinels are due. */
    private readonly pollMs = 15_000,
    /** False when BAKERY_SENTINEL=0: nothing dispatches, whoever asks (timer, run-now or resume). */
    readonly active = true) {
    board.onRun((event, run) => event === "finished" ? this.afterRun(run) : undefined);
    // Before any timer: link job cards made before sentinels had records. Idempotent, so a crash here repeats it.
    const adopted = store.adoptLegacyJobs({ "pr-health": intervalMs, "pr-requests": requestMs });
    if (adopted) console.log(`[sentinel] linked ${adopted} existing job card(s) to their sentinels`);
  }
  /** Starts the scheduler (nothing when sentinels are turned off). Each sentinel runs when its own `nextRunAt` is due, so the poll can be much shorter than any interval. */
  start(): void {
    if (this.timer || !this.active) return;
    this.timer = setInterval(() => void this.dispatchDue(), this.pollMs);
    void this.locks.reconcile().then(() => this.dispatchDue());
  }
  shutdown(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  /** What the Sentinels screen shows for a board: each sentinel with its latest runs and the job cards it made, newest first. */
  describe(boardId: string): { sentinel: SentinelRecord; name: string; running: boolean; runs: SentinelRun[]; jobs: Card[] }[] {
    const repoBoard = this.board.getBoard(boardId);
    const jobs = repoBoard ? this.board.listCards(repoBoard.repo).filter(isSentinelJob) : [];
    return this.sentinelsOf(boardId).map(sentinel => ({ sentinel, name: sentinelNames[sentinel.kind], running: this.running.has(sentinel.id),
      runs: this.store.listRuns(sentinel.id, 10), jobs: jobs.filter(card => card.sentinelId === sentinel.id) }));
  }
  /** The github-pr boards' sentinels, made on first sight. */
  private sentinelsOf(boardId: string): SentinelRecord[] {
    const repoBoard = this.board.getBoard(boardId);
    if (repoBoard?.integration !== "github-pr") return [];
    return sentinelKinds.map(kind => this.store.ensureSentinel(boardId, kind, kind === "pr-health" ? this.intervalMs : this.requestMs, boardGithubRepo(repoBoard)));
  }
  private sentinelFor(boardId: string, kind: SentinelKind): SentinelRecord | undefined { return this.sentinelsOf(boardId).find(item => item.kind === kind); }
  /** Runs every enabled sentinel that is due, then starts jobs that could not start when they were made. */
  async dispatchDue(): Promise<void> {
    if (!this.active) return;
    for (const item of this.board.listBoards()) this.sentinelsOf(item.id);
    // Queued health jobs are checked against their PRs first: one resolved while paused, stopped or restarting is withdrawn, not started.
    const unchecked = await this.revalidateQueued();
    this.startReadyJobs(unchecked);
    await Promise.all(this.store.dueSentinels(new Date().toISOString()).map(sentinel => this.runSentinel(sentinel.id)));
  }
  /** Every enabled sentinel of every github-pr board, now, due or not. */
  async tick(): Promise<void> {
    await Promise.all(this.board.listBoards().filter(item => item.integration === "github-pr").map(item => this.pass(item.id)));
  }
  /** The board's `pr-health` sentinel, once. Runs never overlap; a paused sentinel does nothing. */
  async pass(boardId: string): Promise<void> {
    const sentinel = this.sentinelFor(boardId, "pr-health");
    if (sentinel) await this.runSentinel(sentinel.id);
  }
  /**
   * One execution of a sentinel, recorded as a `SentinelRun`: when it started and ended, what it found, and any error.
   * Returns without running when the sentinel is paused or a run of it is already going, here or (after a crash) not
   * yet marked interrupted. Errors are recorded and logged, and the next scheduled run retries.
   */
  async runSentinel(sentinelId: string): Promise<SentinelRun | undefined> {
    const sentinel = this.store.getSentinel(sentinelId);
    if (!this.active || !sentinel?.enabled || this.running.has(sentinelId)) return undefined;
    this.running.add(sentinelId);
    const started = Date.now();
    try {
      const runId = this.store.beginRun(sentinelId);
      if (!runId) return undefined;
      const context: RunContext = { sentinel, runId, findings: [] };
      const repoBoard = this.board.getBoard(sentinel.boardId);
      try {
        if (repoBoard?.integration !== "github-pr") throw new Error("The board no longer integrates through GitHub pull requests");
        if (sentinel.kind === "pr-health") await this.passOnce(repoBoard, context); else await this.requestsOnce(repoBoard, context);
        const made = context.findings.filter(item => item.outcome === "created").length;
        this.store.finishRun(runId, { status: "succeeded", findings: context.findings, summary: `${made} new job card${made === 1 ? "" : "s"}, ${context.findings.length} finding${context.findings.length === 1 ? "" : "s"} in all` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[sentinel ${sentinel.boardId.slice(0, 8)} ${sentinel.kind}] run failed after ${Date.now() - started}ms: ${message}`);
        this.store.finishRun(runId, { status: "failed", findings: context.findings, summary: "The run failed", error: message });
      }
      return this.store.getRun(runId);
    } finally { this.running.delete(sentinelId); }
  }

  /**
   * Starts a sentinel job right away. Jobs skip auto-pickup, so a paused board, its limits or a card's failed run never
   * hold them up. A start that throws (Bakery draining for a restart, say) leaves the card Ready for `startReadyJobs`.
   */
  private startJob(card: Card): void {
    if (!this.startRun || !this.active) return;
    // A paused sentinel starts nothing, its waiting jobs included; resuming lets the next poll start them.
    if (card.sentinelId && this.store.getSentinel(card.sentinelId)?.enabled === false) return;
    try { this.startRun(card); }
    catch (error) { console.error(`[sentinel] could not start job ${card.id.slice(0, 8)} "${card.title.slice(0, 60)}": ${error instanceof Error ? error.message : String(error)}`); }
  }
  /** Ready jobs that could not start when they were made. `hold` names boards whose queued health jobs could not be checked, which wait. */
  startReadyJobs(hold: ReadonlySet<string> = new Set()): void {
    for (const repoBoard of this.board.listBoards().filter(item => item.integration === "github-pr"))
      for (const card of this.board.listCards(repoBoard.repo)) {
        if (card.status !== "ready" || !isSentinelJob(card)) continue;
        if (hold.has(repoBoard.id) && this.store.attemptPr(card.id) !== undefined && !this.store.isRequestCard(card.id)) continue;
        this.startJob(this.board.getCard(card.id) ?? card);
      }
  }
  /**
   * Withdraws queued health jobs (Ready, not started, their sentinel enabled) whose PR was merged, closed or fixed in the
   * meantime, so a job queued while paused or across a restart never runs against a stale finding. Returns the boards
   * whose PRs could not be read; their queued health jobs are not started until the next check succeeds.
   */
  private async revalidateQueued(): Promise<Set<string>> {
    const unchecked = new Set<string>();
    for (const repoBoard of this.board.listBoards().filter(item => item.integration === "github-pr")) {
      const queued = this.board.listCards(repoBoard.repo).filter(card => card.status === "ready" && isSentinelJob(card) && this.store.attemptPr(card.id) !== undefined && !this.store.isRequestCard(card.id)
        && (!card.sentinelId || this.store.getSentinel(card.sentinelId)?.enabled !== false));
      if (!queued.length || !this.owner && !this.ownerLogin) { if (queued.length) unchecked.add(repoBoard.id); continue; }
      const repo = boardGithubRepo(repoBoard);
      try {
        const prs = await this.github.listOpenPullRequests(repo, this.owner ?? this.ownerLogin);
        const open = new Set(prs.map(pr => pr.number)), broken: number[] = [];
        for (const number of new Set(queued.map(card => this.store.attemptPr(card.id)!))) {
          if (!open.has(number)) continue;
          const health = await this.github.health(repo, number);
          if (health.mergeable === "CONFLICTING" || fixableFailures({ statusCheckRollup: health.statusCheckRollup }).length > 0) broken.push(number);
        }
        await this.withdrawResolved(repoBoard, repo, queued, new Set(queued.map(card => card.id)), undefined, broken, open);
      } catch (error) {
        unchecked.add(repoBoard.id);
        console.error(`[sentinel ${repoBoard.id.slice(0, 8)}] could not recheck queued jobs: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return unchecked;
  }

  /** The board's `pr-requests` sentinel, once. */
  async requestsPass(repoBoard: RepoBoard): Promise<void> {
    const sentinel = this.sentinelFor(repoBoard.id, "pr-requests");
    if (sentinel) await this.runSentinel(sentinel.id);
  }

  /**
   * A comment starting with `/bakery` from the repository's owner, a member or a collaborator, on any open PR of the
   * board's repository, becomes a Ready card that checks out the PR branch and makes the change. The result is pushed
   * to that branch when the run finishes (`afterRun`). One card per PR per pass, however many comments; while a request
   * card for a PR is open, newer comments on it wait. A repository is first read from the moment Bakery first sees it, so
   * old comments are not replayed. PRs from forks are declined, as Bakery cannot push there. PRs with a card of their
   * own are left to that card's sync, which sends the card back.
   */
  private async requestsOnce(repoBoard: RepoBoard, context: RunContext): Promise<void> {
    const repo = boardGithubRepo(repoBoard), tag = `[requests ${repo}]`;
    const since = this.store.requestCursor(repo);
    if (!since) { this.store.setRequestCursor(repo, new Date().toISOString()); return; }
    const asked = trustedBakeryComments((await this.github.repoComments(repo, since)).filter(item => item.at > since));
    if (!asked.length) return;
    const cards = this.board.listCards(repoBoard.repo).filter(isOpen);
    const requestCards = new Set(this.store.listRequestCards(repo).filter(item => cards.some(card => card.id === item.cardId)).map(item => item.prNumber));
    const groups = new Map<number, RepoComment[]>();
    let stopAt: string | undefined;
    for (const item of asked) {
      if (requestCards.has(item.prNumber)) { stopAt = item.at; console.log(`${tag} #${item.prNumber}: a request card is still open; the request waits`); break; }
      groups.set(item.prNumber, [...groups.get(item.prNumber) ?? [], item]);
    }
    const handled = asked.filter(item => !stopAt || item.at < stopAt);
    if (handled.length) await fetchOrigin(repoBoard.repo);
    for (const [number, items] of groups) {
      try { await this.requestCard(repoBoard, repo, number, items, cards, context); }
      catch (error) { console.error(`${tag} #${number}: could not act on the request: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (handled.length) this.store.setRequestCursor(repo, handled[handled.length - 1].at);
  }

  private async requestCard(repoBoard: RepoBoard, repo: string, number: number, items: RepoComment[], cards: Card[], context: RunContext): Promise<void> {
    const tag = `[requests ${repo}]`;
    let pr;
    try { pr = await this.github.requestTarget(repo, number); }
    catch { console.debug(`${tag} #${number}: not a pull request, ignoring`); return; }
    if (pr.state !== "OPEN") return;
    if (cards.some(card => card.prNumber === number)) { console.debug(`${tag} #${number}: has its own card, which handles requests`); return; }
    if (pr.isCrossRepository) { await commentOnPullRequest(this.github, repo, number, "Bakery can't act on this request: the pull request comes from a fork, and Bakery only pushes to branches in this repository."); return; }
    const mainTip = await git(repoBoard.repo, "rev-parse", "origin/main");
    const requests = items.map(item => ({ author: item.author, comment: item.body.trim().slice(0, 4000), ...(item.path ? { path: item.path, line: item.line } : {}) }));
    const findingKey = `request:${items[0].id}`;
    // One transaction: the attempt exists before the card is Ready, so its run locks the PR and its result is pushed.
    const card = this.board.createCard({ title: `Requested on PR #${number}: ${pr.title}`, repo: repoBoard.repo, idempotencyKey: findingKey, priority: 0,
      provenance: { sentinelId: context.sentinel.id, sentinelRunId: context.runId, findingKey },
      body: withInstructions(requestBrief({ url: pr.url, branch: pr.headRefName, head: pr.headRefOid, requests }), context.sentinel),
      ready: `Created by a /bakery comment on pull request #${number}`,
      inTransaction: made => { this.store.recordAttempt(repo, number, pr.headRefName, pr.headRefOid, mainTip, made.id, new Date().toISOString()); this.store.markRequestCard(made.id); } });
    context.findings.push({ key: findingKey, cardId: card.id, outcome: "created" });
    console.log(`${tag} #${number}: created card ${card.id.slice(0, 8)} for ${items.length} request(s) from ${[...new Set(items.map(item => item.author))].join(", ")}`);
    this.startJob(card);
    await commentOnPullRequest(this.github, repo, number, `Bakery picked this up as a card and will push the change to \`${pr.headRefName}\` when its coding agent finishes.`);
  }

  private async passOnce(repoBoard: RepoBoard, context: RunContext): Promise<void> {
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

    await this.withdrawResolved(repoBoard, repo, cards, sentinelCards, context, prs.filter(pr => {
      const item = extra.get(pr.number);
      // A PR whose state could not be read counts as broken, so its unstarted card is not withdrawn on a guess.
      return !extra.has(pr.number) || !item || item.mergeable === "CONFLICTING" || fixableFailures({ statusCheckRollup: item?.statusCheckRollup }).length > 0;
    }).map(pr => pr.number), open);

    this.repairStranded(repo, prs, cards, sentinelCards);
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
      // Deduplication: one open card per finding. The finding key is the PR, so a new head or main adds no second card while one is open.
      const openCard = this.store.openFindingCard(context.sentinel.id, prFindingKey(pr.number)) ?? cards.find(card => card.prNumber === pr.number && sentinelCards.has(card.id))?.id;
      if (openCard) { context.findings.push({ key: prFindingKey(pr.number), cardId: openCard, outcome: "open" }); skip(pr, "a sentinel card is already open for it"); continue; }
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
      const created = await this.createCard(repoBoard, repo, pr, fresh.headRefOid, fresh.headRefName, mainTip, problems, context);
      if (created) openSentinel += 1;
    }
    console.log(`${tag} pass done: ${[...tally].map(([why, n]) => `${n}× ${why.replace(/ \(.*$/, "")}`).join("; ") || "nothing skipped"}`);
  }

  private async createCard(repoBoard: RepoBoard, repo: string, pr: { number: number; title: string; url: string }, head: string, branch: string, mainTip: string, problems: string[], context: RunContext): Promise<boolean> {
    const findingKey = prFindingKey(pr.number);
    // The card, its attempt and its Ready status are one transaction, so a crash leaves no half-made finding that later runs would skip.
    const ready = this.board.createCard({ title: `Fix PR #${pr.number}: ${pr.title}`, repo: repoBoard.repo, idempotencyKey: `sentinel:${pr.number}:${head}:${mainTip}`, priority: 0,
      provenance: { sentinelId: context.sentinel.id, sentinelRunId: context.runId, findingKey },
      body: withInstructions(sentinelBrief({ repo, number: pr.number, url: pr.url, branch, head, mainTip, problems }), context.sentinel),
      ready: "Created by Bakery's sentinel: the pull request is not mergeable and nothing is working on it",
      inTransaction: made => this.store.recordAttempt(repo, pr.number, branch, head, mainTip, made.id, new Date().toISOString()) });
    const card = ready;
    context.findings.push({ key: findingKey, cardId: card.id, outcome: "created" });
    console.log(`[sentinel ${repo}] #${pr.number}: created card ${card.id.slice(0, 8)} for branch ${branch}`);
    try { await this.locks.acquire(repo, pr.number, holderOf(card.id)); }
    catch (error) { console.error(`Sentinel could not lock ${repo}#${pr.number}: ${error instanceof Error ? error.message : String(error)}`); }
    this.startJob(ready);
    return true;
  }

  /**
   * Cards made by an earlier version that stopped between creating the card and recording its attempt sit in Triage with no
   * attempt, which would hide the finding forever. Each is completed from its key (`sentinel:PR:head:main`) while its PR is
   * open, and withdrawn otherwise. New cards are made in one transaction and never get here.
   */
  private repairStranded(repo: string, prs: { number: number; headRefName: string }[], cards: Card[], sentinelCards: Set<string>): void {
    for (const card of cards) {
      if (card.status !== "triage" || !card.sentinelId || sentinelCards.has(card.id)) continue;
      const found = card.idempotencyKey?.match(/^sentinel:(\d+):([^:]+):([^:]+)$/);
      if (!found) continue;
      const pr = prs.find(item => item.number === Number(found[1]));
      try {
        if (!pr) { this.board.setStatus(card.id, "done", "Withdrawn by Bakery's sentinel: this job was left unfinished and its pull request is no longer open"); continue; }
        this.store.recordAttempt(repo, pr.number, pr.headRefName, found[2], found[3], card.id, new Date().toISOString());
        sentinelCards.add(card.id);
        this.board.setStatus(card.id, "ready", "Recovered by Bakery's sentinel: the job was left unfinished by a restart");
        console.log(`[sentinel ${repo}] #${pr.number}: recovered unfinished card ${card.id.slice(0, 8)}`);
      } catch (error) { console.error(`Sentinel could not recover card ${card.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /** Sentinel cards that have not started and whose PR is merged, closed or fine again no longer have a job. */
  private async withdrawResolved(repoBoard: RepoBoard, repo: string, cards: Card[], sentinelCards: Set<string>, context: RunContext | undefined, broken: number[], open: Set<number>): Promise<void> {
    for (const card of cards) {
      if (!sentinelCards.has(card.id) || (card.status !== "ready" && card.status !== "triage")) continue;
      const number = this.store.attemptPr(card.id);
      if (number === undefined || (open.has(number) && broken.includes(number))) continue;
      const why = open.has(number) ? "is mergeable again" : "was merged or closed";
      console.log(`[sentinel ${repo}] #${number}: withdrawing unstarted card ${card.id.slice(0, 8)}, the pull request ${why}`);
      try {
        this.board.setStatus(card.id, "done", `Withdrawn by Bakery's sentinel: the pull request ${why}`);
        context?.findings.push({ key: card.findingKey ?? prFindingKey(number), cardId: card.id, outcome: "withdrawn" });
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
    const request = this.store.isRequestCard(run.cardId);
    const say = (text: string) => commentOnPullRequest(this.github, attempt.repo, attempt.prNumber, text);
    const report = (reportFromOutput(this.board.getRun(run.id)?.output ?? "") ?? "").trim();
    const quoted = report ? `\n\nThe agent's report:\n\n${report.slice(0, 3000).split("\n").map(line => `> ${line}`).join("\n")}` : "";
    try {
      if (!existsSync(worktree)) throw new Error("the card worktree is missing");
      await fetchOrigin(worktree);
      const dirty = await git(worktree, "status", "--porcelain");
      if (dirty) { console.log(`${tag} not pushing: uncommitted changes`); await say(`${request ? "Bakery's change" : "Bakery's sentinel's fix"} was left with uncommitted changes in its worktree, so nothing was pushed. A person needs to take it from here.${quoted}`); return; }
      if (await git(worktree, "rev-parse", "HEAD") === attempt.head) { console.log(`${tag} not pushing: head unchanged`); await say(`${request ? "Bakery tried to make the requested change" : "Bakery's sentinel tried to fix this pull request"} and left it unchanged, so nothing was pushed. A person needs to take it from here.${quoted}`); return; }
      const onMain = () => git(worktree, "merge-base", "--is-ancestor", "origin/main", "HEAD").then(() => true, () => false);
      let rebased = false;
      // A request changes what was asked and nothing else, so it is not rebased.
      if (!request && !await onMain()) {
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
      // The agent already ran the repository's checks, and CI runs again on the PR. The pre-push hook would repeat them
      // in an environment without the developer's secrets (a mobile build needing API variables, say) and refuse a good fix.
      await git(worktree, "push", "--no-verify", `--force-with-lease=refs/heads/${attempt.branch}:${attempt.head}`, "origin", `HEAD:refs/heads/${attempt.branch}`);
      console.log(`${tag} pushed ${tip.slice(0, 12)} to ${attempt.branch}`);
      this.board.closeDelivered(run.cardId, `Pushed to ${attempt.branch} on the pull request`);
      await say(request ? `Bakery pushed ${tip.slice(0, 12)} with the requested changes.${quoted}` : `Bakery's sentinel rebased this pull request onto the latest main and pushed ${tip.slice(0, 12)}. If CI fails again, it checks again on its next pass.${quoted}`);
    } catch (error) {
      console.error(`${tag} push failed: ${error instanceof Error ? error.message : String(error)}`);
      await say(`${request ? "Bakery" : "Bakery's sentinel"} could not push its ${request ? "change" : "fix"}: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}. A person needs to take it from here.${quoted}`);
    }
  }
}
