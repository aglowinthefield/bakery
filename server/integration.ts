import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Board, type Card } from "./board.js";
import { boardGithubRepo, commentOnPullRequest, fetchOrigin, type GitHub } from "./github.js";
import { cardTitle, pullRequestBody, readPullRequestRules } from "./pr-draft.js";
import { semanticTitleProblem } from "../src/pr-title.js";
import { githubRepo } from "./github-url.js";
import { behindOriginMessage, compareWithOriginMain, fetchOriginBestEffort, hasOrigin, syncMainWithOrigin } from "./origin.js";

function gitCommand(repo: string, args: string[], index?: string, raw = false): string {
  try {
    const output = execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env, maxBuffer: 8 * 1024 * 1024 });
    return raw ? output : output.trim();
  } catch (error) {
    const result = error as { stderr?: Buffer; stdout?: Buffer };
    const detail = (result.stderr?.toString() || result.stdout?.toString() || "Git command failed").trim();
    const operation = args[0] === "-c" ? args.find(arg => arg === "merge" || arg === "commit") ?? "git" : args[0];
    throw new Error(`${operation} failed: ${detail.slice(0, 4000)}`);
  }
}
function git(repo: string, ...args: string[]): string { return gitCommand(repo, args); }
export type ReviewDiff = { fingerprint: string; files: { path: string; patch: string }[] };
export class IntegrationConflictError extends Error {
  readonly code = "merge_conflict";
  constructor(readonly cardId: string, readonly files: string[], readonly details: string) {
    super("Changes conflict with current main");
  }
}
function clean(repo: string) { return git(repo, "status", "--porcelain") === ""; }
function hasCommit(repo: string, rev: string) {
  try { execFileSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { stdio: "ignore" }); return true; }
  catch { return false; }
}
/** A Done card Bakery merged into local main, offered as "Publish as PR". `blocker` says why it cannot be published. */
export type LocalMerge = { card: Card; candidate: string; commits: number; blocker: string };
/** Local main has commits origin/main lacks. `resettable` means they are only published card merges. */
export type MainRecovery = { tip: string; originMain: string; recoveryBranch: string; localCommits: number; resettable: boolean; reason: string };
/** Why a locally merged card's candidate cannot become a PR as it is, or "". */
function publishBlocker(repo: string, card: Card, candidate: string): string {
  if (card.prOverrideUrl) return `Linked to ${card.prOverrideUrl}; Bakery only pushes bakery/${card.id}`;
  if (!hasCommit(repo, candidate)) return `The approved commit ${candidate.slice(0, 12)} is no longer in the repository`;
  // The candidate was built on local main. Other local merges under it would ride along in this PR.
  const merges = git(repo, "rev-list", "--merges", `refs/remotes/origin/main..${candidate}`).split("\n").filter(Boolean);
  if (merges.length) return `bakery/${card.id} includes ${merges.length} merge commit${merges.length === 1 ? "" : "s"} from local main that origin/main lacks (${git(repo, "log", "-1", "--format=%s", merges[0])}), which would land in this pull request. Rebase the card branch onto origin/main yourself, then publish`;
  return "";
}
function isAncestor(repo: string, ancestor: string, descendant: string) {
  try {
    execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

/**
 * Where `candidate` stands against `branch` on origin, after a fetch. "push" when the branch is new there or a plain
 * push fast-forwards it; "on-origin" when origin's branch already contains the candidate (someone pushed to the pull
 * request, for example merging main into it, and Bakery has nothing new). When both sides hold commits the other
 * lacks, throws instead of letting Git reject the push, naming what origin has so nobody's work is overwritten.
 */
function remoteBranchState(repo: string, branch: string, candidate: string, resolve: string): "push" | "on-origin" {
  const remote = `refs/remotes/origin/${branch}`;
  if (!hasCommit(repo, remote) || isAncestor(repo, remote, candidate)) return "push";
  if (isAncestor(repo, candidate, remote)) return "on-origin";
  const theirs = Number(git(repo, "rev-list", "--count", `${candidate}..${remote}`));
  const ours = Number(git(repo, "rev-list", "--count", `${remote}..${candidate}`));
  const latest = git(repo, "log", "-1", "--format=%h %s (%an)", remote);
  throw new Error(`${branch} on origin has ${theirs} commit${theirs === 1 ? "" : "s"} this card lacks (latest: ${latest}), and the card has ${ours} that origin lacks. Someone pushed to the pull request; Bakery will not overwrite it. ${resolve}`);
}

// The title is user text. It reaches Git only as an argv entry, never through a shell.
export function mergeMessage(card: Pick<Card, "id" | "title">): string[] {
  const prefix = "Merge card: ", limit = 72 - prefix.length;
  const title = card.title.replace(/\s+/g, " ").trim() || "(untitled)";
  const chars = [...title];
  const subject = prefix + (chars.length > limit ? chars.slice(0, limit - 1).join("").trimEnd() + "…" : title);
  return ["-m", subject, "-m", `Card: ${card.id}\nBranch: bakery/${card.id}`];
}

/**
 * What Bakery is doing while it pushes a card to GitHub: the current step and the output Git and the repository's
 * pre-push hooks printed so far. Kept per card after it finishes, so the board can show how the last push ended.
 */
export type PushProgress = { step: string; log: string[]; startedAt: string; finishedAt: string | null; error: string | null };
const progressLogLines = 400;

/**
 * `git push` without blocking the server, streaming stdout and stderr together, in order, into `onLine`. A
 * pre-push hook's own stdout is part of the push output, so a failure message carries everything it printed, not
 * only stderr. `\r` progress redraws replace the line they redraw.
 */
/** A failed `git push`. `hookFailed` when a pre-push hook refused it, as opposed to the remote or the network. */
export class PushError extends Error {
  constructor(message: string, readonly output: string, readonly hookFailed: boolean) { super(message); }
}
/** A pre-push hook refused the push of `sha`, which Bakery had committed from the card's reviewed work. */
export class PushHookError extends PushError {
  constructor(error: PushError, readonly sha: string) { super(error.message, error.output, true); }
}

export function pushBranch(cwd: string, refspec: string, onLine: (line: string, replace: boolean) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, "push", "--progress", "origin", refspec], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const output: string[] = [];
    // Per stream: text not yet ended by a newline, and whether the next line redraws the last (after a bare \r).
    const state = { stdout: { pending: "", redraw: false }, stderr: { pending: "", redraw: false } };
    const emit = (line: string, replace: boolean) => {
      const text = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
      if (replace && output.length) output[output.length - 1] = text; else output.push(text);
      onLine(text, replace);
    };
    const read = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const current = state[stream];
      const parts = (current.pending + chunk.toString("utf8")).split(/(\r\n|\r|\n)/);
      current.pending = parts.pop() ?? "";
      for (let i = 0; i < parts.length; i += 2) {
        emit(parts[i], current.redraw);
        current.redraw = parts[i + 1] === "\r";
      }
    };
    child.stdout.on("data", read("stdout"));
    child.stderr.on("data", read("stderr"));
    child.on("error", reject);
    child.on("close", code => {
      for (const stream of ["stdout", "stderr"] as const) if (state[stream].pending) emit(state[stream].pending, state[stream].redraw);
      if (code === 0) { resolve(); return; }
      const detail = output.filter(line => line.trim()).join("\n") || `git push exited with code ${code}`;
      // The end of the output names the failing check; keep it when the output is long.
      // Git prints "! [rejected]" lines when the remote refuses and "fatal:" when it cannot connect. A hook failing
      // prints neither: only the hook's own output, then "error: failed to push some refs".
      const hookFailed = !output.some(line => /^\s*! \[|^(fatal|remote):/.test(line));
      const body = (detail.length > 6000 ? "…" + detail.slice(-6000) : detail);
      reject(new PushError(`push failed: ${hookFailed ? "the repository's pre-push hook refused it.\n\n" : ""}${body}`, detail, hookFailed));
    });
  });
}

export class Integration {
  private reconciliationErrors = new Set<string>();
  private progress = new Map<string, PushProgress>();
  /** Non-blocking problems seen while approving, such as an offline fetch. Kept for inspection; also logged. */
  readonly warnings: string[] = [];
  constructor(private board: Board, private dataDir: string, private fetchTimeoutMs = 30_000) {}

  /** The current or last push of `cardId` to GitHub, or null when Bakery has not pushed it since starting. */
  pushProgress(cardId: string): PushProgress | null { return this.progress.get(cardId) ?? null; }

  /** Runs `work` as a tracked push of `cardId`: steps and push output go to `pushProgress`, and so does the outcome. */
  private async trackPush<T>(cardId: string, work: (step: (name: string) => void, push: (cwd: string, refspec: string) => Promise<void>) => Promise<T>): Promise<T> {
    const entry: PushProgress = { step: "Starting", log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null };
    this.progress.set(cardId, entry);
    const step = (name: string) => { entry.step = name; };
    const push = (cwd: string, refspec: string) => pushBranch(cwd, refspec, (line, replace) => {
      if (replace && entry.log.length) entry.log[entry.log.length - 1] = line; else entry.log.push(line);
      if (entry.log.length > progressLogLines) entry.log.splice(0, entry.log.length - progressLogLines);
    });
    try {
      const result = await work(step, push);
      entry.step = "Done";
      return result;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      entry.finishedAt = new Date().toISOString();
    }
  }

  private location(card: Card, allowFailed = false) {
    const run = this.board.listRuns(card.id)[0];
    if (!run || !run.worktree || !(card.status === "review" && run.status === "review" ||
      allowFailed && card.status === "failed" && run.status === "failed")) throw new Error("Only a reviewed run can be inspected or approved");
    const repo = card.repo, worktree = join(this.dataDir, "worktrees", card.id);
    if (!existsSync(worktree) || realpathSync(worktree) !== realpathSync(run.worktree)) throw new Error("Card worktree is missing or has moved");
    if (realpathSync(git(repo, "rev-parse", "--show-toplevel")) !== realpathSync(repo) ||
      realpathSync(git(worktree, "rev-parse", "--show-toplevel")) !== realpathSync(worktree) ||
      realpathSync(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")) !==
      realpathSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")) ||
      git(worktree, "symbolic-ref", "--short", "HEAD") !== `bakery/${card.id}`) throw new Error("Card worktree is not on its expected branch in this repository");
    if (git(worktree, "ls-files", "-u")) throw new Error("Resolve conflicts in the card worktree before review");
    return { repo, worktree, run };
  }

  private snapshot(card: Card, includeFiles: boolean) {
    const { repo, worktree, run } = this.location(card);
    // The fingerprint keys on the merge base, not the branch tip: committing the reviewed work (as opening a PR
    // does) moves HEAD without changing the tree, and must not mark the loaded diff stale.
    const main = git(repo, "rev-parse", "main"), branch = git(worktree, "rev-parse", "HEAD");
    const base = git(worktree, "merge-base", main, branch);
    const temp = mkdtempSync(join(tmpdir(), "bakery-review-"));
    try {
      const index = join(temp, "index");
      // Seed from the worktree's own index: its stat cache lets `add -A` rehash only changed files.
      // A fresh read-tree makes git rehash the whole tree (about 0.5s on a 3 GB worktree).
      try {
        const source = resolve(worktree, git(worktree, "rev-parse", "--git-path", "index"));
        copyFileSync(source, index);
        // Git decides whether an entry is "racily clean" by comparing file times with the index file's own
        // time, so the copy must keep the original's, or a same-second edit could be missed.
        const { atime, mtime } = statSync(source);
        utimesSync(index, atime, mtime);
      }
      catch { gitCommand(worktree, ["read-tree", "HEAD"], index); }
      gitCommand(worktree, ["add", "-A"], index);
      const tree = gitCommand(worktree, ["write-tree"], index);
      const fingerprint = createHash("sha256").update(JSON.stringify({ run: run.id, main, base, tree })).digest("hex");
      if (!includeFiles) return { fingerprint, tree, main, files: [] as ReviewDiff["files"] };
      const paths = gitCommand(worktree, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, tree], undefined, true).split("\0").filter(Boolean);
      if (paths.length > 200) throw new Error("Review has more than 200 changed files; inspect the worktree outside Bakery");
      // One diff for every file, split at each header, instead of one git process per file. Git lists files
      // and emits patches in the same path order; if the counts ever disagree, fall back to per-file diffs.
      const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", base, tree];
      const patches = gitCommand(worktree, diffArgs, undefined, true).split(/^(?=diff --git )/m).filter(Boolean);
      const files = paths.map((path, i) => ({ path, patch: patches.length === paths.length ? patches[i].trim() : gitCommand(worktree, [...diffArgs, "--", path]) }));
      if (files.reduce((size, file) => size + file.patch.length, 0) > 2_000_000) throw new Error("Review diff exceeds 2 MB; inspect the worktree outside Bakery");
      return { fingerprint, tree, main, files };
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }

  // Git refuses a fast-forward that would overwrite uncommitted edits at the repository root. Name the overlap
  // before approval starts so it fails early and clearly instead of as a raw "merge failed" after verification.
  localConflicts(card: Card): string[] {
    const { repo, worktree } = this.location(card);
    const fields = gitCommand(repo, ["status", "--porcelain", "-z", "--untracked-files=all"], undefined, true).split("\0");
    const dirty: string[] = [];
    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i];
      if (entry.length < 4) continue;
      dirty.push(entry.slice(3));
      if (entry[0] === "R" || entry[0] === "C") dirty.push(fields[++i]); // Renames and copies carry their source path next.
    }
    if (!dirty.length) return [];
    const { tree } = this.snapshot(card, false);
    const base = git(worktree, "merge-base", git(repo, "rev-parse", "main"), git(worktree, "rev-parse", "HEAD"));
    const changed = gitCommand(worktree, ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base, tree], undefined, true).split("\0").filter(Boolean);
    const overlaps = (a: string, b: string) => a === b || a.startsWith(b.endsWith("/") ? b : b + "/") || b.startsWith(a.endsWith("/") ? a : a + "/");
    return [...new Set(dirty.filter(path => changed.some(file => overlaps(path, file))))];
  }

  // Cheap staleness check: the fingerprint alone, without building any patches.
  reviewFingerprint(card: Card): string { return this.snapshot(card, false).fingerprint; }

  review(card: Card): ReviewDiff {
    const { fingerprint, files } = this.snapshot(card, true);
    return { fingerprint, files };
  }

  // A merge parent proves the branch was deliberately integrated. An old, unchanged
  // branch tip being an ancestor of main does not. Do not count an "ours" merge
  // whose result tree is identical to its first parent.
  reconcileExternallyMerged(): void {
    for (const { card } of this.board.listExternalMergeCandidates()) {
      try {
        const { repo, worktree, run } = this.location(card, true);
        if (gitCommand(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"], undefined, true) ||
          git(worktree, "ls-files", "-u")) continue;
        const candidate = git(worktree, "rev-parse", "HEAD");
        if (!isAncestor(repo, candidate, "main")) continue;
        const main = git(repo, "rev-parse", "main");
        const merges = git(repo, "rev-list", "--first-parent", "--parents", "--merges", `${candidate}..${main}`);
        const merged = merges.split("\n").filter(Boolean).map(line => line.split(" ")).find(([merge, firstParent, ...others]) =>
          others.includes(candidate) && git(repo, "rev-parse", `${merge}^{tree}`) !== git(repo, "rev-parse", `${firstParent}^{tree}`));
        if (!merged || git(repo, "rev-parse", "main") !== main || git(worktree, "rev-parse", "HEAD") !== candidate ||
          gitCommand(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"], undefined, true)) continue;
        this.board.recordExternalIntegration(card.id, run.id, candidate, merged[0]);
        this.reconciliationErrors.delete(card.id);
        console.log(`Reconciled externally merged card ${card.id} at ${merged[0]}`);
      } catch (error) {
        // Git worktrees can disappear independently of Bakery. Leave ambiguous cards unchanged.
        if (!this.reconciliationErrors.has(card.id)) console.error(`Could not reconcile card ${card.id}: ${String(error)}`);
        this.reconciliationErrors.add(card.id);
      }
    }
  }

  withdraw(card: Card): Card {
    const approval = this.board.getApproval(card.id);
    if (card.status !== "review" || !approval) throw new Error("No pending approval to withdraw");
    if (approval.preparedHead && isAncestor(card.repo, approval.preparedHead, "main")) throw new Error("This approval reached main; inspect it before withdrawing");
    this.board.cancelApproval(card.id, approval.runId, true);
    return this.board.getCard(card.id)!;
  }

  /**
   * Approve on a github-pr board: commit the reviewed work on `bakery/<id>`, push that branch to origin, and open
   * a PR (or reuse the open one). Nothing merges locally; the card stays in Review until the PR merges on GitHub.
   * The operator's Approve is the authorization to push; the agent itself never pushes.
   * `draft` is the title and body the operator approved; without it the card title and body are used. A new PR's
   * title must pass the repository's semantic-PR check, when it has one, before anything is pushed.
   * `automatic` marks a CI fix Bakery pushes without Approve, so the PR comment says no person reviewed it.
   */
  async openPullRequest(card: Card, reviewedFingerprint: string, github: GitHub, draft?: { title: string; body: string }, automatic = false): Promise<Card> {
    const repoBoard = this.board.boardForRepo(card.repo);
    if (repoBoard?.integration !== "github-pr") throw new Error("This board merges locally; use Approve and merge into local main");
    if (card.prOverrideUrl) throw new Error(`This card is linked to ${card.prOverrideUrl}. Bakery only pushes bakery/${card.id}; update that pull request yourself, or clear the link`);
    const slug = boardGithubRepo(repoBoard);
    return this.trackPush(card.id, async (step, push) => {
      step("Checking GitHub access");
      await github.check();
      const { repo, worktree, run } = this.location(card);
      if (this.board.hasRequestedChanges(card.id, run.id)) throw new Error("Changes requested; review a new attempt before approving");
      if (this.board.hasDraftReviewComments(card.id, run.id)) throw new Error("Submit or remove draft review comments before approving");
      const inspected = this.snapshot(card, false);
      if (!reviewedFingerprint || inspected.fingerprint !== reviewedFingerprint) throw new Error("Worktree or main changed since review; refresh the diff before approving");
      const branch = `bakery/${card.id}`;
      // An open PR keeps its title and body; only a new one must pass the repository's title check.
      const existing = await github.findByBranch(slug, branch);
      const hasOpenPr = existing?.state === "OPEN";
      const title = draft ? draft.title.replace(/\s+/g, " ").trim().slice(0, 250) : cardTitle(card);
      const semantic = readPullRequestRules(worktree).semantic;
      const problem = !hasOpenPr && semantic ? semanticTitleProblem(title, semantic) : "";
      if (problem) throw new Error(`Pull request title "${title}" would fail ${semantic!.source}: ${problem}. Edit the title in the Approve dialog`);
      if (draft && !title) throw new Error("Pull request title is required");
      step("Committing the reviewed work");
      const candidate = this.commitReviewed(card, worktree, inspected.tree);
      step("Fetching origin");
      await fetchOrigin(repo);
      if (!git(repo, "rev-list", "refs/remotes/origin/main.." + candidate)) throw new Error("This card has no commits that are not already on origin/main");
      const state = remoteBranchState(repo, branch, candidate, `Merge origin/${branch} into the card worktree (${worktree}), then approve again`);
      if (state === "on-origin") {
        // Origin is ahead with nothing of ours missing: catch the worktree up so the next attempt builds on it.
        step(`Fast-forwarding the card worktree to origin/${branch}`);
        git(worktree, "merge", "--ff-only", "--quiet", `refs/remotes/origin/${branch}`);
      } else {
        step(`Pushing ${branch} (the repository's pre-push hooks run first)`);
        // A plain push: if the branch on GitHub moved after the fetch, Git still refuses instead of overwriting it.
        try { await push(worktree, `${candidate}:refs/heads/${branch}`); }
        catch (error) { throw error instanceof PushError && error.hookFailed ? new PushHookError(error, candidate) : error; }
      }
      step(hasOpenPr ? "Updating the pull request" : "Opening the pull request");
      const why = automatic ? "a fix for the failing CI, pushed automatically without human review" : "changes the operator reviewed and approved in Bakery";
      const pushed = state === "push" ? { sha: candidate, why } : null;
      const pr = await this.ensurePullRequest(card, run.output, slug, github, pushed, { title, body: draft ? draft.body : card.body });
      this.board.recordPullRequest(card.id, { number: pr.number, url: pr.url, state: "OPEN" });
      this.board.recordPullRequestPush(card.id, run.id);
      return this.board.getCard(card.id)!;
    });
  }

  /**
   * The open PR from `bakery/<id>`, or a new one with `content` (default: the card title and body) plus the footer and
   * run summary. `pushed` is what Bakery just pushed, commented on an open PR; null when nothing was pushed.
   */
  private async ensurePullRequest(card: Card, output: string, slug: string, github: GitHub, pushed: { sha: string; why: string } | null, content?: { title: string; body: string }): Promise<{ number: number; url: string }> {
    const branch = `bakery/${card.id}`;
    const existing = await github.findByBranch(slug, branch);
    let url = existing?.state === "OPEN" ? existing.url : "";
    const summary = (output || "").trim().slice(-3000);
    const details = summary ? `\n\n<details><summary>Run summary</summary>\n\n${summary}\n\n</details>` : "";
    if (existing && url && pushed) await commentOnPullRequest(github, slug, existing.number, `Bakery pushed ${pushed.sha.slice(0, 12)}: ${pushed.why}.${details}`);
    if (!url) url = await github.create(slug, branch, content?.title ?? cardTitle(card), pullRequestBody(content?.body ?? card.body, card, { output }));
    return { number: Number(url.match(/\/pull\/(\d+)/)?.[1]), url };
  }

  /**
   * Done cards Bakery merged into local main whose approved candidate is not on origin/main, after a fetch, and
   * whether local main can be reset to origin/main. Works on a local board too, so switching to github-pr can list them.
   */
  async localMerges(repo: string): Promise<{ cards: LocalMerge[]; main: MainRecovery | null }> {
    await fetchOrigin(repo);
    const cards: LocalMerge[] = [];
    for (const { card, candidate } of this.board.listLocalMerges(repo)) {
      if (hasCommit(repo, candidate) && isAncestor(repo, candidate, "refs/remotes/origin/main")) continue;
      cards.push({ card, candidate, commits: hasCommit(repo, candidate) ? Number(git(repo, "rev-list", "--count", `refs/remotes/origin/main..${candidate}`)) : 0, blocker: publishBlocker(repo, card, candidate) });
    }
    return { cards, main: this.mainRecovery(repo) };
  }

  /**
   * "Publish as PR" for a Done card that Bakery merged into local main on a github-pr board: push the approved
   * candidate to `bakery/<id>`, open its PR (or reuse the open one) as Approve does, then clear the local integration
   * record and move the card back to Review, so it reaches Done when the PR merges. Local main is not touched here;
   * the result says whether it can be reset, which needs a separate confirmation.
   */
  async publishLocalMerge(card: Card, github: GitHub): Promise<{ card: Card; main: MainRecovery | null }> {
    const repoBoard = this.board.boardForRepo(card.repo);
    if (repoBoard?.integration !== "github-pr") throw new Error("Switch this board to GitHub pull requests before publishing a card as a pull request");
    if (card.status !== "done") throw new Error("Only a Done card that was merged into local main can be published as a pull request");
    if (card.prOverrideUrl) throw new Error(`This card is linked to ${card.prOverrideUrl}. Bakery only pushes bakery/${card.id}; clear the link first`);
    const slug = boardGithubRepo(repoBoard);
    return this.trackPush(card.id, async (step, push) => {
      step("Checking GitHub access");
      await github.check();
      const repo = card.repo;
      step("Fetching origin");
      await fetchOrigin(repo);
      const merge = this.board.listLocalMerges(repo).find(item => item.card.id === card.id);
      if (!merge) throw new Error("This card was not merged into local main by Bakery; there is nothing to publish");
      const { candidate } = merge;
      const blocker = publishBlocker(repo, card, candidate);
      if (blocker) throw new Error(blocker);
      if (isAncestor(repo, candidate, "refs/remotes/origin/main")) throw new Error("This card's approved work is already on origin/main; there is nothing to publish");
      const state = remoteBranchState(repo, `bakery/${card.id}`, candidate, `Reconcile origin/bakery/${card.id} with the approved commit ${candidate.slice(0, 12)} yourself, then publish`);
      if (state === "push") {
        step(`Pushing bakery/${card.id} (the repository's pre-push hooks run first)`);
        // A plain push: if bakery/<id> on GitHub moved after the fetch, Git still refuses instead of overwriting it.
        await push(repo, `${candidate}:refs/heads/bakery/${card.id}`);
      }
      step("Opening the pull request");
      const pr = await this.ensurePullRequest(card, this.board.listRuns(card.id)[0]?.output ?? "", slug, github, state === "push" ? { sha: candidate, why: "work the operator approved in Bakery and merged into local main earlier, now published as a pull request" } : null);
      return { card: this.board.recordPublishedLocalMerge(card.id, candidate, pr), main: this.mainRecovery(repo) };
    });
  }

  /**
   * Whether local main can go back to origin/main without losing anything: it is checked out with no uncommitted
   * tracked changes, and every local commit on its first-parent line is a Bakery card merge whose card branch is
   * on origin. Null when local main has no commits that origin/main lacks.
   */
  mainRecovery(repo: string): MainRecovery | null {
    let head = "";
    try { head = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD"); } catch { /* Detached HEAD. */ }
    if (!hasCommit(repo, "refs/remotes/origin/main") || !hasCommit(repo, "refs/heads/main")) return null;
    const tip = git(repo, "rev-parse", "refs/heads/main"), originMain = git(repo, "rev-parse", "refs/remotes/origin/main");
    const local = git(repo, "rev-list", "--first-parent", `${originMain}..${tip}`).split("\n").filter(Boolean);
    if (!local.length) return null;
    const recovery = { tip, originMain, recoveryBranch: `bakery-recovery/${tip.slice(0, 12)}`, localCommits: local.length };
    const refuse = (reason: string): MainRecovery => ({ ...recovery, resettable: false, reason });
    if (head !== "main") return refuse(`The repository root is ${head ? `on branch ${head}` : "in detached HEAD"}, not main`);
    const dirty = git(repo, "status", "--porcelain", "--untracked-files=no");
    if (dirty) return refuse("Local main has uncommitted changes");
    for (const commit of local) {
      const [, ...parents] = git(repo, "rev-list", "--parents", "-n", "1", commit).split(" ");
      const id = git(repo, "log", "-1", "--format=%B", commit).match(/^Card: ([\w-]+)$/m)?.[1];
      const subject = git(repo, "log", "-1", "--format=%s", commit);
      if (parents.length < 2 || !id || !subject.startsWith("Merge card: ")) return refuse(`Local main has commit ${commit.slice(0, 12)} (${subject}) that is not a Bakery card merge`);
      const card = this.board.getCard(id);
      if (card?.locallyMerged) return refuse(`${card.title} (${id}) is still merged only into local main; publish it as a pull request first`);
      const onOrigin = (ref: string) => hasCommit(repo, ref) && parents.slice(1).every(parent => isAncestor(repo, parent, ref));
      if (!onOrigin(`refs/remotes/origin/bakery/${id}`) && !onOrigin("refs/remotes/origin/main")) return refuse(`Card ${id}'s merged work is not on origin yet; publish it as a pull request first`);
    }
    return { ...recovery, resettable: true, reason: "" };
  }

  /**
   * Resets local main to origin/main after saving its tip as `bakery-recovery/<sha>`. Only on the operator's
   * confirmation of the exact tip they saw, and only while `mainRecovery` still allows it. `reset --keep`
   * refuses instead of overwriting untracked files.
   */
  async resetLocalMain(repo: string, confirmedTip: string): Promise<MainRecovery | null> {
    await fetchOrigin(repo);
    const recovery = this.mainRecovery(repo);
    if (!recovery) throw new Error("Local main has no commits that origin/main lacks; nothing to reset");
    if (recovery.tip !== confirmedTip) throw new Error("Local main moved since you confirmed; review it again before resetting");
    if (!recovery.resettable) throw new Error(recovery.reason);
    const branch = `refs/heads/${recovery.recoveryBranch}`;
    if (hasCommit(repo, branch)) {
      if (git(repo, "rev-parse", branch) !== recovery.tip) throw new Error(`${recovery.recoveryBranch} already exists at another commit`);
    } else git(repo, "branch", recovery.recoveryBranch, recovery.tip);
    git(repo, "reset", "--keep", recovery.originMain);
    return this.mainRecovery(repo);
  }

  /** Commits the reviewed worktree on the card branch, if it has uncommitted changes, and returns the commit. */
  private commitReviewed(card: Card, worktree: string, reviewedTree: string): string {
    git(worktree, "add", "-A");
    if (git(worktree, "write-tree") !== reviewedTree) throw new Error("Worktree changed since review; refresh the diff before approving");
    if (git(worktree, "diff", "--cached", "--name-only")) {
      git(worktree, "diff", "--cached", "--check");
      git(worktree, "-c", "user.name=Bakery", "-c", "user.email=bakery@localhost", "commit", "-m", `Bakery card: ${card.title.slice(0, 70)}`);
    }
    if (!clean(worktree)) throw new Error("Card worktree changed while committing; inspect it and retry");
    const candidate = git(worktree, "rev-parse", "HEAD");
    if (git(worktree, "rev-parse", "HEAD^{tree}") !== reviewedTree) throw new Error("Committed work changed since review; refresh the diff before approving");
    return candidate;
  }

  /**
   * When the repository has an `origin`, fetch it and refuse to merge into a main that is behind origin/main, so a
   * card never lands on a stale main. Ahead is fine (local work not yet pushed). A failed fetch only warns.
   * Behind main is brought level when that is safe (clean checkout, no rebase conflict). The review diff and its
   * fingerprint were taken against the old main, so the operator still refreshes and approves again.
   */
  private requireMainCurrent(repo: string) {
    if (!hasOrigin(repo)) return;
    const warning = fetchOriginBestEffort(repo, this.fetchTimeoutMs);
    if (warning) { this.warnings.push(warning); this.warnings.splice(0, this.warnings.length - 20); console.warn(`${repo}: ${warning}`); }
    const state = compareWithOriginMain(repo);
    if (!state) return;
    const synced = syncMainWithOrigin(repo, state);
    if (synced) throw new Error(`${synced}. Refresh the diff and approve again`);
    const blocked = behindOriginMessage(repo, state);
    if (blocked) throw new Error(blocked);
  }

  /** A research run answers in its final message and leaves no diff; accepting it closes the card without Git. */
  acceptFindings(card: Card, reviewedFingerprint: string): Card {
    const { run } = this.location(card);
    if (this.board.getAutoReviewJob(run.id)?.state === "running") throw new Error("Agent review is in progress; wait for its result");
    const inspected = this.snapshot(card, true);
    if (!reviewedFingerprint || inspected.fingerprint !== reviewedFingerprint) throw new Error("Worktree or main changed since review; refresh the diff before accepting");
    if (inspected.files.length) throw new Error("This run changed files; approve or request changes instead");
    return this.board.acceptFindings(card.id, run.id);
  }

  /** Marks the card Done, then pushes main when the board asks for it. A failed push never undoes the merge; it goes in the card's history. */
  private completeAndPush(card: Card, runId: string, candidate: string, repo: string): Card {
    const done = this.board.completeApproval(card.id, runId, candidate);
    if (!this.board.boardForRepo(card.repo)?.pushMainAfterMerge) return done;
    try {
      execFileSync("git", ["-C", repo, "push", "origin", "main"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
      this.board.noteCard(card.id, "Pushed main to origin after the merge");
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
      this.board.noteCard(card.id, `Merged into local main, but pushing main to origin failed: ${detail.slice(0, 500)}. Push it yourself.`);
    }
    return done;
  }
  approve(card: Card, reviewedFingerprint: string, origin: "human" | "auto" = "human", verifyMerged?: (worktree: string) => void): Card {
    if (this.board.integrationFor(card.repo) === "github-pr") throw new Error("This board integrates through GitHub pull requests; Approve opens a pull request instead of merging locally");
    const repoBoard = this.board.boardForRepo(card.repo);
    if (repoBoard?.githubMainProtected && !repoBoard.integrationChosen)
      throw new Error(`main on ${githubRepo(repoBoard.remoteUrl) ?? repoBoard.remoteUrl} only accepts pull requests, so merging into local main would leave it ahead of GitHub. Switch Integration to GitHub pull requests in the board's settings, or choose Local merge there to merge locally anyway`);
    const { repo, worktree, run } = this.location(card);
    const job = this.board.getAutoReviewJob(run.id);
    if (job?.state === "running" && origin !== "auto") throw new Error("Agent review is in progress; wait for its result");
    if (origin === "auto" && job?.state !== "running") throw new Error("Agent review is no longer active");
    if (this.board.hasRequestedChanges(card.id, run.id)) throw new Error("Changes requested; review a new attempt before approving");
    if (this.board.hasDraftReviewComments(card.id, run.id)) throw new Error("Submit or remove draft review comments before approving");
    if (git(repo, "symbolic-ref", "--short", "HEAD") !== "main") throw new Error("Check out main at the repository root before approving");
    const pending = this.board.getApproval(card.id);
    if (!(pending?.preparedHead && isAncestor(repo, pending.preparedHead, "main"))) this.requireMainCurrent(repo);
    const localStatus = gitCommand(repo, ["status", "--porcelain", "-z", "--untracked-files=all"], undefined, true);
    const blocked = this.localConflicts(card);
    if (blocked.length) throw new Error(`Uncommitted changes on main would be overwritten: ${blocked.slice(0, 10).join(", ")}${blocked.length > 10 ? ", …" : ""}. Commit or stash them at ${repo}, then approve again`);
    const inspected = this.snapshot(card, false);
    if (!reviewedFingerprint || inspected.fingerprint !== reviewedFingerprint) throw new Error("Worktree or main changed since review; refresh the diff before approving");

    let approved = this.board.getApproval(card.id);
    if (approved) {
      if (approved.runId !== run.id || git(worktree, "rev-parse", "HEAD") !== approved.candidate || !clean(worktree)) throw new Error("Card worktree changed after approval; inspect it before retrying");
    } else {
      const candidate = this.commitReviewed(card, worktree, inspected.tree);
      // A card must contribute a commit, not merely close an unchanged run.
      if (!git(repo, "rev-list", "main.." + candidate)) throw new Error("This card has no unmerged commits to approve");
      approved = this.board.recordApproval(card.id, run.id, candidate);
    }

    if (approved.preparedHead && isAncestor(repo, approved.preparedHead, "main")) {
      if (git(repo, "rev-parse", "main") !== approved.preparedHead) throw new Error("Main changed after Bakery merged this card; inspect the result before closing it");
      return this.completeAndPush(card, run.id, approved.candidate, repo);
    }
    if (isAncestor(repo, approved.candidate, "main")) throw new Error("Card branch was merged outside Bakery; inspect main before closing this card");
    const base = git(repo, "rev-parse", "main");
    if (base !== inspected.main) throw new Error("Main changed since review; refresh the diff before approving");
    const directory = join(this.dataDir, "integrations");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(directory, `${card.id}-`));
    try {
      git(repo, "worktree", "add", "--detach", scratch, base);
      try {
        git(scratch, "-c", "user.name=Bakery", "-c", "user.email=bakery@localhost", "merge", "--no-ff", "--no-edit", ...mergeMessage(card), approved.candidate);
      } catch (error) {
        // No integration was published. Read the scratch index before removing it so the UI can name the conflicts.
        let files: string[] = [];
        try { files = [...new Set(git(scratch, "ls-files", "-u", "-z").split("\0").filter(Boolean).map(entry => entry.slice(entry.indexOf("\t") + 1)))]; }
        catch { /* Keep the original Git failure if the scratch index cannot be read. */ }
        this.board.cancelApproval(card.id, run.id);
        if (files.length) {
          const details = error instanceof Error ? error.message : String(error);
          this.board.recordMergeFailure(card.id, files, details);
          throw new IntegrationConflictError(card.id, files, details);
        }
        throw error;
      }
      const merged = git(scratch, "rev-parse", "HEAD");
      if (origin === "auto" && !verifyMerged) throw new Error("Auto-review requires verification of the merged result");
      verifyMerged?.(scratch);
      if (!clean(scratch) || git(scratch, "rev-parse", "HEAD") !== merged) throw new Error("Verification changed the merged worktree");
      git(repo, "diff", "--check", base, merged);
      if (git(repo, "rev-parse", "main") !== base || gitCommand(repo, ["status", "--porcelain", "-z", "--untracked-files=all"], undefined, true) !== localStatus) throw new Error("Main or its local changes changed during approval; retry before merging");
      if (origin === "auto" && this.board.getAutoReviewJob(run.id)?.state !== "running") throw new Error("Agent review was interrupted before merge");
      this.board.recordPreparedMerge(card.id, run.id, approved.candidate, merged);
      git(repo, "merge", "--no-overwrite-ignore", "--ff-only", merged);
      // Git refuses to overwrite local changes; unrelated edits may remain after the fast-forward.
      return this.completeAndPush(card, run.id, approved.candidate, repo);
    } finally {
      // Only remove Bakery's temporary integration checkout. Keep the card worktree on every failure.
      try { git(repo, "worktree", "remove", "--force", scratch); } catch { /* Keep the original error; the scratch path is recoverable. */ }
    }
  }
}
