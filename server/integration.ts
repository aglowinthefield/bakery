import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Board, type Card } from "./board.js";

function git(repo: string, ...args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const result = error as { stderr?: Buffer; stdout?: Buffer };
    const detail = (result.stderr?.toString() || result.stdout?.toString() || "Git command failed").trim();
    throw new Error(`${args[0]} failed: ${detail.slice(0, 600)}`);
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

export class Integration {
  constructor(private board: Board, private dataDir: string) {}

  withdraw(card: Card): Card {
    const approval = this.board.getApproval(card.id);
    if (card.status !== "review" || !approval) throw new Error("No pending approval to withdraw");
    if (approval.preparedHead && isAncestor(card.repo, approval.preparedHead, "main")) throw new Error("This approval reached main; inspect it before withdrawing");
    this.board.cancelApproval(card.id, approval.runId, true);
    return this.board.getCard(card.id)!;
  }

  approve(card: Card): Card {
    const run = this.board.listRuns(card.id)[0];
    if (card.status !== "review" || !run || run.status !== "review" || !run.worktree) throw new Error("Only a reviewed run can be approved");
    const repo = card.repo, worktree = join(this.dataDir, "worktrees", card.id);
    if (!existsSync(worktree) || realpathSync(worktree) !== realpathSync(run.worktree)) throw new Error("Card worktree is missing or has moved");
    if (realpathSync(git(repo, "rev-parse", "--show-toplevel")) !== realpathSync(repo) ||
      realpathSync(git(worktree, "rev-parse", "--show-toplevel")) !== realpathSync(worktree) ||
      realpathSync(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")) !==
      realpathSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")) ||
      git(worktree, "symbolic-ref", "--short", "HEAD") !== `bakery/${card.id}`) throw new Error("Card worktree is not on its expected branch in this repository");
    if (git(repo, "symbolic-ref", "--short", "HEAD") !== "main") throw new Error("Check out main at the repository root before approving");
    if (!clean(repo)) throw new Error("Main worktree has changes; commit or move them before approving");
    if (git(worktree, "ls-files", "-u")) throw new Error("Resolve conflicts in the card worktree before approving");

    let approved = this.board.getApproval(card.id);
    if (approved) {
      if (approved.runId !== run.id || git(worktree, "rev-parse", "HEAD") !== approved.candidate || !clean(worktree)) throw new Error("Card worktree changed after approval; inspect it before retrying");
    } else {
      git(worktree, "add", "-A");
      if (git(worktree, "diff", "--cached", "--name-only")) {
        git(worktree, "diff", "--cached", "--check");
        git(worktree, "-c", "user.name=Bakery", "-c", "user.email=bakery@localhost", "commit", "-m", `Bakery card: ${card.title.slice(0, 70)}`);
      }
      if (!clean(worktree)) throw new Error("Card worktree changed while committing; inspect it and retry");
      const candidate = git(worktree, "rev-parse", "HEAD");
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
    const directory = join(this.dataDir, "integrations");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(directory, `${card.id}-`));
    try {
      git(repo, "worktree", "add", "--detach", scratch, base);
      try {
        git(scratch, "-c", "user.name=Bakery", "-c", "user.email=bakery@localhost", "merge", "--no-ff", "--no-edit", approved.candidate);
      } catch (error) {
        // No integration was prepared or published. Keep the branch commit, but allow another run to revise it.
        this.board.cancelApproval(card.id, run.id);
        throw error;
      }
      const merged = git(scratch, "rev-parse", "HEAD");
      git(repo, "diff", "--check", base, merged);
      if (git(repo, "rev-parse", "main") !== base || !clean(repo)) throw new Error("Main changed during approval; retry to reconcile with its new tip");
      this.board.recordPreparedMerge(card.id, run.id, approved.candidate, merged);
      git(repo, "merge", "--no-overwrite-ignore", "--ff-only", merged);
      if (!clean(repo)) throw new Error("Main was merged but has new local changes; inspect it and retry approval");
      return this.board.completeApproval(card.id, run.id, approved.candidate);
    } finally {
      // Only remove Bakery's temporary integration checkout. Keep the card worktree on every failure.
      try { git(repo, "worktree", "remove", "--force", scratch); } catch { /* Keep the original error; the scratch path is recoverable. */ }
    }
  }
}
