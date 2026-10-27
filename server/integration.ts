import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Card } from "./board.js";
import { boardGithubRepo, commentOnPullRequest, fetchOrigin, type GitHub } from "./github.js";
import { behindOriginMessage, compareWithOriginMain, fetchOriginBestEffort, hasOrigin } from "./origin.js";

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

// The title is user text. It reaches Git only as an argv entry, never through a shell.
export function mergeMessage(card: Pick<Card, "id" | "title">): string[] {
  const prefix = "Merge card: ", limit = 72 - prefix.length;
  const title = card.title.replace(/\s+/g, " ").trim() || "(untitled)";
  const chars = [...title];
  const subject = prefix + (chars.length > limit ? chars.slice(0, limit - 1).join("").trimEnd() + "…" : title);
  return ["-m", subject, "-m", `Card: ${card.id}\nBranch: bakery/${card.id}`];
}

export class Integration {
  private reconciliationErrors = new Set<string>();
  /** Non-blocking problems seen while approving, such as an offline fetch. Kept for inspection; also logged. */
  readonly warnings: string[] = [];
  constructor(private board: Board, private dataDir: string, private fetchTimeoutMs = 30_000) {}

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
    const main = git(repo, "rev-parse", "main"), branch = git(worktree, "rev-parse", "HEAD");
    const base = includeFiles ? git(worktree, "merge-base", main, branch) : "";
    const temp = mkdtempSync(join(tmpdir(), "bakery-review-"));
    try {
      const index = join(temp, "index");
      gitCommand(worktree, ["read-tree", "HEAD"], index);
      gitCommand(worktree, ["add", "-A"], index);
      const tree = gitCommand(worktree, ["write-tree"], index);
      const fingerprint = createHash("sha256").update(JSON.stringify({ run: run.id, main, branch, tree })).digest("hex");
      if (!includeFiles) return { fingerprint, tree, main, files: [] as ReviewDiff["files"] };
      const paths = gitCommand(worktree, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, tree], undefined, true).split("\0").filter(Boolean);
      if (paths.length > 200) throw new Error("Review has more than 200 changed files; inspect the worktree outside Bakery");
      const files = paths.map(path => ({ path, patch: git(worktree, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", base, tree, "--", path) }));
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
   */
  /** `automatic` marks a CI fix Bakery pushes without Approve, so the PR comment says no person reviewed it. */
  async openPullRequest(card: Card, reviewedFingerprint: string, github: GitHub, automatic = false): Promise<Card> {
    const repoBoard = this.board.boardForRepo(card.repo);
    if (repoBoard?.integration !== "github-pr") throw new Error("This board merges locally; use Approve and merge into local main");
    if (card.prOverrideUrl) throw new Error(`This card is linked to ${card.prOverrideUrl}. Bakery only pushes bakery/${card.id}; update that pull request yourself, or clear the link`);
    const slug = boardGithubRepo(repoBoard);
    await github.check();
    const { repo, worktree, run } = this.location(card);
    if (this.board.hasRequestedChanges(card.id, run.id)) throw new Error("Changes requested; review a new attempt before approving");
    if (this.board.hasDraftReviewComments(card.id, run.id)) throw new Error("Submit or remove draft review comments before approving");
    const inspected = this.snapshot(card, false);
    if (!reviewedFingerprint || inspected.fingerprint !== reviewedFingerprint) throw new Error("Worktree or main changed since review; refresh the diff before approving");
    const candidate = this.commitReviewed(card, worktree, inspected.tree);
    await fetchOrigin(repo);
    if (!git(repo, "rev-list", "refs/remotes/origin/main.." + candidate)) throw new Error("This card has no commits that are not already on origin/main");
    const branch = `bakery/${card.id}`;
    // A plain push: if the branch on GitHub has moved (someone pushed to the PR), Git refuses instead of overwriting it.
    git(worktree, "push", "origin", `${candidate}:refs/heads/${branch}`);
    const why = automatic ? "a fix for the failing CI, pushed automatically without human review" : "changes the operator reviewed and approved in Bakery";
    const { number, url } = await this.ensurePullRequest(card, run.output, slug, github, { sha: candidate, why });
    this.board.recordPullRequest(card.id, { number, url, state: "OPEN" });
    this.board.recordPullRequestPush(card.id, run.id);
    return this.board.getCard(card.id)!;
  }

  /** The open PR from `bakery/<id>`, or a new one with the card title and the card body plus the run summary. */
  private async ensurePullRequest(card: Card, output: string, slug: string, github: GitHub, pushed: { sha: string; why: string }): Promise<{ number: number; url: string }> {
    const branch = `bakery/${card.id}`;
    const existing = await github.findByBranch(slug, branch);
    let url = existing?.state === "OPEN" ? existing.url : "";
    const summary = (output || "").trim().slice(-3000);
    const details = summary ? `\n\n<details><summary>Run summary</summary>\n\n${summary}\n\n</details>` : "";
    if (existing && url) await commentOnPullRequest(github, slug, existing.number, `Bakery pushed ${pushed.sha.slice(0, 12)}: ${pushed.why}.${details}`);
    if (!url) {
      const body = `${card.body.trim()}\n\n---\n\nOpened by Bakery for card \`${card.id}\`.${details}`;
      url = await github.create(slug, branch, card.title.replace(/\s+/g, " ").trim().slice(0, 250) || `Bakery card ${card.id}`, body);
    }
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
    await github.check();
    const repo = card.repo;
    await fetchOrigin(repo);
    const merge = this.board.listLocalMerges(repo).find(item => item.card.id === card.id);
    if (!merge) throw new Error("This card was not merged into local main by Bakery; there is nothing to publish");
    const { candidate } = merge;
    const blocker = publishBlocker(repo, card, candidate);
    if (blocker) throw new Error(blocker);
    if (isAncestor(repo, candidate, "refs/remotes/origin/main")) throw new Error("This card's approved work is already on origin/main; there is nothing to publish");
    // A plain push: if bakery/<id> on GitHub holds other commits, Git refuses instead of overwriting them.
    git(repo, "push", "origin", `${candidate}:refs/heads/bakery/${card.id}`);
    const pr = await this.ensurePullRequest(card, this.board.listRuns(card.id)[0]?.output ?? "", slug, github, { sha: candidate, why: "work the operator approved in Bakery and merged into local main earlier, now published as a pull request" });
    return { card: this.board.recordPublishedLocalMerge(card.id, candidate, pr), main: this.mainRecovery(repo) };
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
   */
  private requireMainCurrent(repo: string) {
    if (!hasOrigin(repo)) return;
    const warning = fetchOriginBestEffort(repo, this.fetchTimeoutMs);
    if (warning) { this.warnings.push(warning); this.warnings.splice(0, this.warnings.length - 20); console.warn(`${repo}: ${warning}`); }
    const state = compareWithOriginMain(repo);
    const blocked = state && behindOriginMessage(repo, state);
    if (blocked) throw new Error(blocked);
  }

  approve(card: Card, reviewedFingerprint: string, origin: "human" | "auto" = "human", verifyMerged?: (worktree: string) => void): Card {
    if (this.board.integrationFor(card.repo) === "github-pr") throw new Error("This board integrates through GitHub pull requests; Approve opens a pull request instead of merging locally");
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
      return this.board.completeApproval(card.id, run.id, approved.candidate);
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
      return this.board.completeApproval(card.id, run.id, approved.candidate);
    } finally {
      // Only remove Bakery's temporary integration checkout. Keep the card worktree on every failure.
      try { git(repo, "worktree", "remove", "--force", scratch); } catch { /* Keep the original error; the scratch path is recoverable. */ }
    }
  }
}
