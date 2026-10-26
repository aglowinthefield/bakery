import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Card } from "./board.js";

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
  constructor(private board: Board, private dataDir: string) {}

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

  approve(card: Card, reviewedFingerprint: string, origin: "human" | "auto" = "human", verifyMerged?: (worktree: string) => void): Card {
    const { repo, worktree, run } = this.location(card);
    const job = this.board.getAutoReviewJob(run.id);
    if (job?.state === "running" && origin !== "auto") throw new Error("Agent review is in progress; wait for its result");
    if (origin === "auto" && job?.state !== "running") throw new Error("Agent review is no longer active");
    if (this.board.hasRequestedChanges(card.id, run.id)) throw new Error("Changes requested; review a new attempt before approving");
    if (this.board.hasDraftReviewComments(card.id, run.id)) throw new Error("Submit or remove draft review comments before approving");
    if (git(repo, "symbolic-ref", "--short", "HEAD") !== "main") throw new Error("Check out main at the repository root before approving");
    const localStatus = gitCommand(repo, ["status", "--porcelain", "-z", "--untracked-files=all"], undefined, true);
    const inspected = this.snapshot(card, false);
    if (!reviewedFingerprint || inspected.fingerprint !== reviewedFingerprint) throw new Error("Worktree or main changed since review; refresh the diff before approving");

    let approved = this.board.getApproval(card.id);
    if (approved) {
      if (approved.runId !== run.id || git(worktree, "rev-parse", "HEAD") !== approved.candidate || !clean(worktree)) throw new Error("Card worktree changed after approval; inspect it before retrying");
    } else {
      git(worktree, "add", "-A");
      if (git(worktree, "write-tree") !== inspected.tree) throw new Error("Worktree changed since review; refresh the diff before approving");
      if (git(worktree, "diff", "--cached", "--name-only")) {
        git(worktree, "diff", "--cached", "--check");
        git(worktree, "-c", "user.name=Bakery", "-c", "user.email=bakery@localhost", "commit", "-m", `Bakery card: ${card.title.slice(0, 70)}`);
      }
      if (!clean(worktree)) throw new Error("Card worktree changed while committing; inspect it and retry");
      const candidate = git(worktree, "rev-parse", "HEAD");
      if (git(worktree, "rev-parse", "HEAD^{tree}") !== inspected.tree) throw new Error("Committed work changed since review; refresh the diff before approving");
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
