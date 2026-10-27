import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Board, Card, RepoBoard } from "./board.js";
import { githubRepo, parsePullRequestUrl } from "./github-url.js";

// GitHub pull request integration. On a `github-pr` board a card is Done once its PR has merged on GitHub
// and the merge commit is on origin/main. Local main is only ever fast-forwarded to origin/main.
// `gh` is required: when it is missing or not signed in the board shows the error and nothing else happens.

export type PullRequest = {
  number: number; url: string; state: "OPEN" | "CLOSED" | "MERGED"; mergedAt: string | null;
  mergeCommit: { oid: string } | null; headRefName: string; headRefOid?: string;
  statusCheckRollup?: Check[];
};
/** One entry of `statusCheckRollup`: a CheckRun (name, workflowName) or a commit StatusContext (context). */
export type Check = {
  conclusion?: string | null; state?: string | null; status?: string | null;
  name?: string; context?: string; workflowName?: string; startedAt?: string; completedAt?: string; detailsUrl?: string; targetUrl?: string;
};
/** One open PR as the Pull requests page shows it. */
export type RepoPullRequest = {
  number: number; title: string; url: string; headRefName: string; isDraft: boolean; updatedAt: string;
  author?: { login?: string } | null; additions?: number; deletions?: number; reviewDecision?: string | null;
};
const prFields = "number,url,state,mergedAt,mergeCommit,headRefName,headRefOid,statusCheckRollup";
// statusCheckRollup is expensive: across 200 PRs on a busy repo GitHub's GraphQL API times out (HTTP 504).
// The batched list leaves it out; checks are fetched per open PR instead.
const listFields = "number,url,state,mergedAt,mergeCommit,headRefName,headRefOid";

type Exec = { stdout: string; stderr: string };
function run(bin: string, args: string[], cwd?: string, timeout = 60_000): Promise<Exec> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const detail = code === "ENOENT" ? `${bin} is not installed or not on PATH` : (stderr || stdout || error.message).trim();
        reject(Object.assign(new Error(detail.slice(0, 4000)), { exitCode: typeof code === "number" ? code : (error as { code?: unknown }).code }));
      } else resolve({ stdout, stderr });
    });
  });
}
const git = async (repo: string, ...args: string[]) => (await run("git", ["-C", repo, ...args])).stdout.trim();
async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  try { await run("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]); return true; }
  catch (error) { if ((error as { exitCode?: unknown }).exitCode === 1) return false; throw error; }
}

/** Throws the reason `gh` cannot be used: not installed, or `gh auth status` fails. */
export async function checkGh(ghBin: string): Promise<void> {
  try { await run(ghBin, ["--version"], undefined, 15_000); }
  catch (error) { throw new Error(`GitHub CLI unavailable: ${(error as Error).message}`); }
  try { await run(ghBin, ["auth", "status", "--hostname", "github.com"], undefined, 15_000); }
  catch (error) { throw new Error(`GitHub CLI is not signed in (gh auth status failed): ${(error as Error).message}`); }
}

/** `git fetch origin --prune`. A fetch failure is a board error. */
export async function fetchOrigin(repo: string): Promise<void> {
  try { await git(repo, "fetch", "origin", "--prune", "--quiet"); }
  catch (error) { throw new Error(`git fetch origin failed: ${(error as Error).message}`); }
}

/**
 * Fast-forwards the main checkout to origin/main. The main checkout is never a workspace, so local main is
 * always clean and behind or equal to origin/main. When that does not hold, nothing is reset, rebased, stashed,
 * or forced: the problem is thrown so the board can show it. Untracked files do not count as dirty; Git still
 * refuses a fast-forward that would overwrite one. Returns true when main moved.
 */
export async function fastForwardMain(repo: string): Promise<boolean> {
  try { await git(repo, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"); }
  catch { throw new Error("origin/main does not exist; fetch the repository's origin and check its default branch is main"); }
  let head = "";
  try { head = await git(repo, "symbolic-ref", "--quiet", "--short", "HEAD"); } catch { /* Detached HEAD. */ }
  if (head !== "main") throw new Error(`The repository root is ${head ? `on branch ${head}` : "in detached HEAD"}, not main. Check out main at ${repo}; Bakery keeps it in step with origin/main`);
  const dirty = (await run("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"])).stdout.split("\n").filter(Boolean).map(line => line.slice(3));
  if (dirty.length) throw new Error(`Local main at ${repo} has uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}). Bakery fast-forwards main only from a clean checkout; commit them on a branch or discard them`);
  const ahead = Number(await git(repo, "rev-list", "--count", "origin/main..main"));
  const behind = Number(await git(repo, "rev-list", "--count", "main..origin/main"));
  if (ahead) throw new Error(`Local main ${behind ? "has diverged from" : "is ahead of"} origin/main (${ahead} local commit${ahead === 1 ? "" : "s"}${behind ? `, ${behind} behind` : ""}). Bakery only fast-forwards main; move the local commits to a branch and reset main yourself`);
  if (!behind) return false;
  try { await git(repo, "merge", "--ff-only", "--quiet", "origin/main"); }
  catch (error) { throw new Error(`Fast-forward of main to origin/main failed: ${(error as Error).message}`); }
  return true;
}

const failed = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];
const unfinished = ["", "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED"];
// Failures an agent can act on. A cancelled or action-required check needs a person, not a code change.
const fixable = ["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"];
const outcome = (check: Check) => (check.conclusion || check.state || check.status || "").toUpperCase();
const checkName = (check: Check) => check.context ?? [check.workflowName, check.name].filter(Boolean).join(" / ");

/**
 * The newest run of each check. The rollup keeps every run on the head commit, so a check that was
 * cancelled and rerun, or that failed and then passed, appears more than once; only the newest counts.
 */
export function latestChecks(pr: Pick<PullRequest, "statusCheckRollup">): Check[] {
  const latest = new Map<string, Check>();
  (pr.statusCheckRollup ?? []).forEach((check, index) => {
    const key = checkName(check) || `#${index}`, seen = latest.get(key);
    if (!seen || (check.startedAt ?? "") >= (seen.startedAt ?? "")) latest.set(key, check);
  });
  return [...latest.values()];
}

/** One-word state of a PR's checks, or null when it has none. */
export function checksState(pr: Pick<PullRequest, "statusCheckRollup">): string | null {
  const checks = latestChecks(pr);
  if (!checks.length) return null;
  if (checks.some(check => failed.includes(outcome(check)))) return "failing";
  if (checks.some(check => unfinished.includes(outcome(check)))) return "pending";
  return "passing";
}

/** Checks whose newest run failed in a way a code change can fix. */
export function fixableFailures(pr: Pick<PullRequest, "statusCheckRollup">): Check[] {
  return latestChecks(pr).filter(check => fixable.includes(outcome(check)));
}

/** GitHub Actions job id from a check's details link, when the check is an Actions job. */
export function actionsJobId(check: Check): string | undefined {
  return (check.detailsUrl || check.targetUrl || "").match(/\/actions\/runs\/\d+\/job\/(\d+)/)?.[1];
}

/** `gh run view --log-failed` output reduced to its last lines, without the job/step/timestamp prefix or colour codes. */
export function trimFailedLog(log: string, maxLines = 60, maxChars = 4000): string {
  const lines = log.split("\n")
    .map(line => line.replace(/^[^\t]*\t[^\t]*\t\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(/\x1b\[[\d;]*m/g, "").replace(/\^\[\[[\d;]*m/g, "").trimEnd())
    .filter(line => line && !/^##\[(group|endgroup)\]/.test(line));
  return lines.slice(-maxLines).join("\n").slice(-maxChars);
}

/** Most automatic CI fix runs per card. After that a failing PR waits for the operator. */
export const maxCiReworks = 3;

export class GitHub {
  constructor(private readonly ghBin = "gh", private readonly cwd?: string) {}
  private async gh(args: string[]): Promise<string> { return (await run(this.ghBin, args, this.cwd)).stdout; }
  check(): Promise<void> { return checkGh(this.ghBin); }
  /** Recent PRs in the repository, newest first. One call per board per tick. */
  async listPullRequests(repo: string): Promise<PullRequest[]> {
    return JSON.parse(await this.gh(["pr", "list", "--repo", repo, "--state", "all", "--limit", "200", "--json", listFields])) as PullRequest[];
  }
  /** Open PRs of a repository for the Pull requests page, newest first. */
  async listOpenPullRequests(repo: string): Promise<RepoPullRequest[]> {
    return JSON.parse(await this.gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,title,url,author,headRefName,isDraft,updatedAt,reviewDecision,additions,deletions"])) as RepoPullRequest[];
  }
  /** CI checks of one PR. */
  async checks(repo: string, number: number): Promise<PullRequest["statusCheckRollup"]> {
    return (JSON.parse(await this.gh(["pr", "view", String(number), "--repo", repo, "--json", "statusCheckRollup"])) as PullRequest).statusCheckRollup ?? [];
  }
  /** The failed steps' log of one GitHub Actions job. */
  async failedLog(repo: string, jobId: string): Promise<string> {
    return this.gh(["run", "view", "--job", jobId, "--repo", repo, "--log-failed"]);
  }
  /** The newest PR whose head is `branch`, if any. */
  async findByBranch(repo: string, branch: string): Promise<PullRequest | undefined> {
    const found = JSON.parse(await this.gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", prFields])) as PullRequest[];
    return found[0];
  }
  async view(repo: string, number: number): Promise<PullRequest> {
    return JSON.parse(await this.gh(["pr", "view", String(number), "--repo", repo, "--json", prFields])) as PullRequest;
  }
  /**
   * Why `main` on GitHub accepts changes only through pull requests, or null when direct pushes are allowed.
   * Checks the branch rules (rulesets) and then classic branch protection. Throws when GitHub cannot say.
   */
  async mainPullRequestRule(repo: string): Promise<string | null> {
    const rules = JSON.parse(await this.gh(["api", `repos/${repo}/rules/branches/main`])) as { type?: string }[];
    const rule = rules.find(item => item.type === "pull_request" || item.type === "merge_queue");
    if (rule) return `a ruleset requires ${rule.type === "merge_queue" ? "a merge queue" : "a pull request"}`;
    let protection: { required_pull_request_reviews?: unknown };
    try { protection = JSON.parse(await this.gh(["api", `repos/${repo}/branches/main/protection`])); }
    catch (error) {
      if (/Branch not protected/i.test((error as Error).message)) return null;
      throw new Error(`could not read branch protection: ${(error as Error).message}`);
    }
    return protection.required_pull_request_reviews ? "branch protection requires a pull request" : null;
  }
  /** Posts a comment on a PR. */
  async comment(repo: string, number: number, body: string): Promise<void> {
    await this.gh(["pr", "comment", String(number), "--repo", repo, "--body", body]);
  }
  /** Opens a PR and returns its URL. `gh` errors (title rules, permissions) are thrown verbatim. */
  async create(repo: string, branch: string, title: string, body: string): Promise<string> {
    const output = await this.gh(["pr", "create", "--repo", repo, "--head", branch, "--base", "main", "--title", title, "--body", body]);
    const url = output.trim().split("\n").reverse().find(line => parsePullRequestUrl(line.trim()));
    if (!url) throw new Error(`gh pr create did not print a pull request URL: ${output.trim().slice(0, 500)}`);
    return url.trim();
  }
}

/**
 * Bakery comments on its PRs at each turning point (sent back for CI, fix pushed, gave up, update pushed) so
 * reviewers can see what the automation did. A comment that fails to post never blocks the work; it is logged.
 */
export async function commentOnPullRequest(github: GitHub, repo: string, number: number | null | undefined, body: string): Promise<void> {
  if (!number) return;
  try { await github.comment(repo, number, `${body}\n\n<sub>Posted by Bakery.</sub>`); }
  catch (error) { console.error(`Could not comment on ${repo}#${number}: ${error instanceof Error ? error.message : String(error)}`); }
}

/** The repository `gh` should query for a github-pr board. */
export function boardGithubRepo(repoBoard: Pick<RepoBoard, "remoteUrl">): string {
  const repo = githubRepo(repoBoard.remoteUrl);
  if (!repo) throw new Error("github-pr integration requires the board's remote to be a GitHub repository link (https://github.com/OWNER/REPO)");
  return repo;
}

/**
 * Checks whether the board's GitHub `main` only accepts pull requests and records it, with a note for board settings.
 * With `switchMode` (a remote was just set), a protected main moves the board to github-pr unless the operator chose
 * its mode. When `gh` is missing, signed out, or GitHub cannot say, the mode is left alone and the note says why.
 */
export async function detectGithubIntegration(board: Board, boardId: string, github: GitHub, switchMode: boolean): Promise<RepoBoard | undefined> {
  const before = board.getBoard(boardId);
  const repo = before && githubRepo(before.remoteUrl);
  if (!before || !repo) return before;
  let rule: string | null;
  try {
    await github.check();
    rule = await github.mainPullRequestRule(repo);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return board.recordGithubProtection(boardId, before.remoteUrl, null,
      `Could not check whether main on ${repo} requires pull requests, so Integration was left as is: ${message}`, false);
  }
  if (!rule) return board.recordGithubProtection(boardId, before.remoteUrl, false, `main on ${repo} accepts direct pushes, so Local merge works.`, switchMode);
  const after = board.recordGithubProtection(boardId, before.remoteUrl, true, `main on ${repo} only accepts pull requests (${rule}).`, switchMode);
  if (!after || after.remoteUrl !== before.remoteUrl) return after;
  const outcome = after.integration === "github-pr"
    ? (before.integration === "local" ? " Bakery switched Integration to GitHub pull requests." : "")
    : after.integrationChosen ? " Integration stays Local merge because you chose it; Approve merges into local main only." : " Choose an Integration mode: Approve refuses to merge locally until you do.";
  return board.recordGithubProtection(boardId, after.remoteUrl, true, `main on ${repo} only accepts pull requests (${rule}).${outcome}`, false);
}

/** The repository a card's PR lives in: its override link's repository, else the board's. */
function prRepo(card: Card, repo: string): string {
  return (card.prOverrideUrl && parsePullRequestUrl(card.prOverrideUrl)?.repo) || repo;
}

/** The PR linked to a card: its override URL if set, else the newest PR from `bakery/<id>`. */
export async function linkedPullRequest(github: GitHub, repo: string, card: Card, recent?: PullRequest[]): Promise<PullRequest | undefined> {
  if (card.prOverrideUrl) {
    const link = parsePullRequestUrl(card.prOverrideUrl);
    if (!link) throw new Error(`Invalid pull request link ${card.prOverrideUrl}`);
    return recent?.find(pr => pr.number === link.number) ?? github.view(link.repo, link.number);
  }
  const branch = `bakery/${card.id}`;
  return recent?.find(pr => pr.headRefName === branch) ?? (recent && !card.prNumber ? undefined : github.findByBranch(repo, branch));
}

/**
 * The github-pr timer. Every tick visits each github-pr board at most once per `intervalMs`:
 * check `gh`, fetch origin, settle Review cards from their PRs, then fast-forward local main.
 * Any failure is recorded as the board's integration error, which pauses auto pickup; success clears it.
 */
export class GitHubSync {
  private timer?: ReturnType<typeof setInterval>;
  private lastRun = new Map<string, number>();
  private inFlight = new Map<string, Promise<void>>();
  /** `rework` starts a fix run on a card whose PR failed CI; without it failures are only shown. */
  constructor(private readonly board: Board, private readonly dataDir: string, private readonly github: GitHub, private readonly wtBin?: string, private readonly intervalMs = 60_000,
    private readonly rework?: (card: Card) => unknown, private readonly autoApprove?: (card: Card) => Promise<unknown>) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5000);
    void this.tick();
  }
  shutdown(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  /** Starts due boards; resolves when the boards it started have finished. */
  async tick(force = false): Promise<void> {
    const due = this.board.listBoards().filter(item => item.integration === "github-pr" &&
      (force || Date.now() - (this.lastRun.get(item.id) ?? 0) >= this.intervalMs));
    await Promise.all(due.map(item => this.syncBoard(item.id)));
  }
  /** Runs one board now, sharing an in-flight pass instead of starting a second one. */
  syncBoard(boardId: string): Promise<void> {
    const existing = this.inFlight.get(boardId);
    if (existing) return existing;
    this.lastRun.set(boardId, Date.now());
    const pass = this.syncBoardOnce(boardId).finally(() => this.inFlight.delete(boardId));
    this.inFlight.set(boardId, pass);
    return pass;
  }
  private async syncBoardOnce(boardId: string): Promise<void> {
    const repoBoard = this.board.getBoard(boardId);
    if (!repoBoard || repoBoard.integration !== "github-pr") return;
    try {
      const repo = boardGithubRepo(repoBoard);
      await this.github.check();
      await fetchOrigin(repoBoard.repo);
      await this.settleCards(repoBoard, repo);
      await fastForwardMain(repoBoard.repo);
      if (this.board.getBoard(boardId)?.integrationError) this.board.setIntegrationError(boardId, "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.board.getBoard(boardId)?.integrationError !== message) console.error(`GitHub sync for ${repoBoard.repo}: ${message}`);
      this.board.setIntegrationError(boardId, message);
    }
  }
  private async settleCards(repoBoard: RepoBoard, repo: string): Promise<void> {
    const cards = this.board.listPullRequestCards(repoBoard.repo);
    if (!cards.length) return;
    // The batched list is only a shortcut. When GitHub fails it (an HTTP 504 on a busy repo), each card is
    // looked up on its own, so one slow query does not stop every card from linking or settling.
    let recent: PullRequest[] | undefined;
    try { recent = await this.github.listPullRequests(repo); }
    catch (error) { console.error(`GitHub sync for ${repoBoard.repo}: gh pr list failed, checking each card on its own: ${error instanceof Error ? error.message : String(error)}`); }
    for (const card of cards) {
      try {
        let pr = await linkedPullRequest(this.github, repo, card, recent);
        if (pr?.state === "OPEN" && !pr.statusCheckRollup) pr = { ...pr, statusCheckRollup: await this.github.checks(prRepo(card, repo), pr.number) };
        if (pr) await this.settle(repoBoard, card, pr, prRepo(card, repo));
      } catch (error) {
        this.board.recordPullRequestError(card.id, `Could not check the pull request: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  private async settle(repoBoard: RepoBoard, card: Card, pr: PullRequest, repo: string): Promise<void> {
    const checks = checksState(pr);
    if (pr.state === "OPEN") {
      if (await this.pushCiFix(card, pr)) return;
      const ci = await this.sendBackFailingCi(card, pr, repo);
      this.board.recordPullRequest(card.id, { ...pr, checks, error: ci.error, ciPending: ci.pending || !!ci.rework });
      if (ci.rework) {
        try { await ci.rework(); }
        catch (error) { this.board.recordPullRequestError(card.id, `CI failed, and Bakery could not start a fix run yet: ${error instanceof Error ? error.message : String(error)}. It retries on the next sync, and the failures go to whichever run starts next.`); }
      }
      return;
    }
    if (pr.state === "CLOSED") {
      this.board.recordPullRequest(card.id, { ...pr, checks });
      this.board.closePullRequestUnmerged(card.id, `Pull request #${pr.number} was closed without merging. Reopen it on GitHub, or run the card again and approve to open a new one.`);
      return;
    }
    const merge = pr.mergeCommit?.oid;
    if (!merge) { this.board.recordPullRequest(card.id, { ...pr, checks, error: "GitHub reports the pull request merged but gave no merge commit" }); return; }
    // The merge must be on origin/main, not just reported by GitHub: local main fast-forwards from there.
    let onMain = false;
    try { onMain = await isAncestor(repoBoard.repo, merge, "refs/remotes/origin/main"); }
    catch { onMain = false; /* The merge commit is not fetched yet. */ }
    if (!onMain) { this.board.recordPullRequest(card.id, { ...pr, checks, error: `Merged on GitHub; waiting for ${merge.slice(0, 12)} to reach origin/main` }); return; }
    this.board.recordPullRequest(card.id, { ...pr, checks });
    this.board.recordPullRequestMerge(card.id, pr.headRefOid || merge, merge);
    await this.removeWorktree(repoBoard.repo, card);
  }
  /**
   * A PR whose checks failed goes back to the agent with the failures, so it returns to Review only once it has a
   * fix for CI. Each head commit is sent back once, and only when it is what the card worktree holds: newer local
   * work, uncommitted changes, or someone else's push mean a person is already handling it. The fix is pushed by
   * `pushCiFix`. Each step is announced on the PR. After `maxCiReworks` rounds the card stays in Review with the reason.
   */
  private async sendBackFailingCi(card: Card, pr: PullRequest, repo: string): Promise<{ error?: string; rework?: () => unknown; pending?: boolean }> {
    const head = pr.headRefOid, failures = fixableFailures(pr);
    if (!this.rework || card.prOverrideUrl || !head) return {};
    // CI is re-running or went green (a label added, say) before the fix run started: those failures are stale.
    if (!failures.length) { this.board.dropCiFeedback(card.id); return {}; }
    const limit = `CI is failing after ${maxCiReworks} automatic fix runs. Fix it in the card worktree and run again, or push to the PR yourself.`;
    if (card.ciReworkSha === head) {
      // Sent back, but the fix run could not start (the board was at its run limit, say): try again.
      if (this.board.getCiFeedback(card.id)) return this.startRework(card);
      return card.ciReworks >= maxCiReworks ? { error: limit } : {};
    }
    // Wait for checks still running, so the agent sees every failure at once, but not forever: a check that never
    // starts (a merge-queue-only check, say) must not hold back a failure that finished 10 minutes ago.
    const running = latestChecks(pr).some(check => unfinished.includes(outcome(check)));
    const settledFor = Date.now() - Math.max(...failures.map(check => Date.parse(check.completedAt ?? "") || 0));
    if (running && settledFor < 10 * 60_000) return { pending: true };
    const worktree = join(this.dataDir, "worktrees", card.id);
    if (!existsSync(worktree)) return {};
    try {
      if (await git(worktree, "rev-parse", "HEAD") !== head) return {};
      if (await git(worktree, "status", "--porcelain")) return {};
    } catch { return {}; }
    if (card.ciReworks >= maxCiReworks) {
      this.board.markCiHandled(card.id, head);
      await commentOnPullRequest(this.github, repo, pr.number, `CI is still failing at ${head.slice(0, 12)} (${failures.map(checkName).join(", ")}) after ${maxCiReworks} automatic fix runs. Bakery has stopped sending it back; a person needs to take it from here.`);
      return { error: limit };
    }
    const sections: string[] = [];
    for (const check of failures.slice(0, 8)) {
      const jobId = actionsJobId(check);
      let log = "";
      if (jobId) {
        try { log = trimFailedLog(await this.github.failedLog(repo, jobId)); }
        catch (error) { log = `(log unavailable: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)})`; }
      }
      sections.push(`### ${checkName(check) || "check"}: ${outcome(check).toLowerCase()}\n${check.detailsUrl || check.targetUrl || ""}${log ? `\n\n\`\`\`\n${log}\n\`\`\`` : ""}`);
    }
    this.board.recordCiFailure(card.id, head, sections.join("\n\n"));
    await commentOnPullRequest(this.github, repo, pr.number, `CI failed at ${head.slice(0, 12)}: ${failures.map(check => `\`${checkName(check) || "check"}\``).join(", ")}. Bakery sent this back to its coding agent with the failure logs (automatic fix run ${card.ciReworks + 1} of ${maxCiReworks}). The fix will be pushed here when it's ready.`);
    return this.startRework(card);
  }
  /**
   * A CI fix run that reached Review is pushed to the PR without waiting for Approve: the operator chose to let
   * CI-only rounds run unattended. It still stops for review comments, and the PR still needs its merge review.
   * Returns true when it pushed.
   */
  private async pushCiFix(card: Card, pr: PullRequest): Promise<boolean> {
    const run = this.board.listRuns(card.id)[0];
    if (!this.autoApprove || card.prOverrideUrl || card.status !== "review" || run?.status !== "review" || !run.ciFix) return false;
    if (this.board.hasRequestedChanges(card.id, run.id) || this.board.hasDraftReviewComments(card.id, run.id) || this.board.getApproval(card.id)) return false;
    const worktree = join(this.dataDir, "worktrees", card.id);
    try {
      // Already pushed, or the fix run changed nothing: nothing to send.
      if (await git(worktree, "rev-parse", "HEAD") === pr.headRefOid && !(await git(worktree, "status", "--porcelain"))) return false;
    } catch { return false; }
    try {
      await this.autoApprove(card);
      return true;
    } catch (error) {
      this.board.recordPullRequestError(card.id, `Bakery could not push the CI fix: ${error instanceof Error ? error.message : String(error)}. Review it and Approve to push it yourself.`);
      return true;
    }
  }
  private startRework(card: Card): { rework: () => unknown } {
    const rework = this.rework!;
    return { rework: () => rework(this.board.getCard(card.id)!) };
  }
  /**
   * Removes a Done card's worktree and branch. A squash merge leaves the branch unmerged by Git ancestry, so
   * the branch is force-deleted, which is safe only because GitHub confirmed the PR merged. A dirty worktree is kept.
   */
  private async removeWorktree(repo: string, card: Card): Promise<void> {
    const branch = `bakery/${card.id}`, worktree = join(this.dataDir, "worktrees", card.id);
    try {
      if (this.wtBin && hasWorktrunk(this.wtBin)) await run(this.wtBin, ["-C", repo, "remove", branch, "--yes", "--foreground", "--force-delete"], repo, 120_000);
      else {
        if (existsSync(worktree)) await git(repo, "worktree", "remove", worktree);
        await git(repo, "branch", "-D", branch);
      }
    } catch (error) {
      console.error(`Card ${card.id} is Done, but its worktree was kept: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** True when `wtBin` is Worktrunk's `wt`, not another binary with the same name. */
export function hasWorktrunk(wtBin: string): boolean {
  try { return /^wt v\d/.test(execFileSync(wtBin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })); }
  catch { return false; }
}
