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
  statusCheckRollup?: { conclusion?: string | null; state?: string | null; status?: string | null }[];
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

/** One-word state of a PR's checks, or null when it has none. */
export function checksState(pr: PullRequest): string | null {
  const checks = pr.statusCheckRollup ?? [];
  if (!checks.length) return null;
  const outcome = (check: (typeof checks)[number]) => (check.conclusion || check.state || check.status || "").toUpperCase();
  if (checks.some(check => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(outcome(check)))) return "failing";
  if (checks.some(check => ["", "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED"].includes(outcome(check)))) return "pending";
  return "passing";
}

export class GitHub {
  constructor(private readonly ghBin = "gh", private readonly cwd?: string) {}
  private async gh(args: string[]): Promise<string> { return (await run(this.ghBin, args, this.cwd)).stdout; }
  check(): Promise<void> { return checkGh(this.ghBin); }
  /** Recent PRs in the repository, newest first. One call per board per tick. */
  async listPullRequests(repo: string): Promise<PullRequest[]> {
    return JSON.parse(await this.gh(["pr", "list", "--repo", repo, "--state", "all", "--limit", "200", "--json", listFields])) as PullRequest[];
  }
  /** CI checks of one PR. */
  async checks(repo: string, number: number): Promise<PullRequest["statusCheckRollup"]> {
    return (JSON.parse(await this.gh(["pr", "view", String(number), "--repo", repo, "--json", "statusCheckRollup"])) as PullRequest).statusCheckRollup ?? [];
  }
  /** The newest PR whose head is `branch`, if any. */
  async findByBranch(repo: string, branch: string): Promise<PullRequest | undefined> {
    const found = JSON.parse(await this.gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", prFields])) as PullRequest[];
    return found[0];
  }
  async view(repo: string, number: number): Promise<PullRequest> {
    return JSON.parse(await this.gh(["pr", "view", String(number), "--repo", repo, "--json", prFields])) as PullRequest;
  }
  /** Opens a PR and returns its URL. `gh` errors (title rules, permissions) are thrown verbatim. */
  async create(repo: string, branch: string, title: string, body: string): Promise<string> {
    const output = await this.gh(["pr", "create", "--repo", repo, "--head", branch, "--base", "main", "--title", title, "--body", body]);
    const url = output.trim().split("\n").reverse().find(line => parsePullRequestUrl(line.trim()));
    if (!url) throw new Error(`gh pr create did not print a pull request URL: ${output.trim().slice(0, 500)}`);
    return url.trim();
  }
}

/** The repository `gh` should query for a github-pr board. */
export function boardGithubRepo(repoBoard: Pick<RepoBoard, "remoteUrl">): string {
  const repo = githubRepo(repoBoard.remoteUrl);
  if (!repo) throw new Error("github-pr integration requires the board's remote to be a GitHub repository link (https://github.com/OWNER/REPO)");
  return repo;
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
  constructor(private readonly board: Board, private readonly dataDir: string, private readonly github: GitHub, private readonly wtBin?: string, private readonly intervalMs = 60_000) {}
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
    const recent = await this.github.listPullRequests(repo);
    for (const card of cards) {
      try {
        let pr = await linkedPullRequest(this.github, repo, card, recent);
        if (pr?.state === "OPEN" && !pr.statusCheckRollup) pr = { ...pr, statusCheckRollup: await this.github.checks(prRepo(card, repo), pr.number) };
        if (pr) await this.settle(repoBoard, card, pr);
      } catch (error) {
        this.board.recordPullRequestError(card.id, `Could not check the pull request: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  private async settle(repoBoard: RepoBoard, card: Card, pr: PullRequest): Promise<void> {
    const checks = checksState(pr);
    if (pr.state === "OPEN") { this.board.recordPullRequest(card.id, { ...pr, checks }); return; }
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
