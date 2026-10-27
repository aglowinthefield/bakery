import { execFileSync } from "node:child_process";
import type { Board, Card, RepoBoard } from "./board.js";
import { githubRepo } from "./github-url.js";

// On a local board, Approve merges into local main only. When the repository has a GitHub remote, a Done card
// says whether its merge commit is on origin/main yet. This reads the remote-tracking ref from the last fetch;
// it never fetches, so rendering a board makes no network call.

export type OriginMainState = NonNullable<Card["originMain"]>;

function gitOut(repo: string, ...args: string[]): string | undefined {
  try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return undefined; }
}
function isAncestor(repo: string, ancestor: string, descendant: string): boolean | undefined {
  try { execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" }); return true; }
  catch (error) { return (error as { status?: number }).status === 1 ? false : undefined; }
}

/** True when the board's remote link or the repository's origin points at GitHub. */
export function hasGithubRemote(repoBoard: Pick<RepoBoard, "repo" | "remoteUrl">): boolean {
  return !!githubRepo(repoBoard.remoteUrl) || !!githubRepo(gitOut(repoBoard.repo, "remote", "get-url", "origin"));
}

export class OriginMain {
  // Ancestry of a commit never changes for a given origin/main tip, so answers are cached by both.
  private cache = new Map<string, boolean>();
  constructor(private board: Board) {}

  /** Done cards on a local board with a GitHub remote get `originMain`; every other card is returned unchanged. */
  annotate(repoBoard: RepoBoard, cards: Card[]): Card[] {
    if (repoBoard.integration !== "local" || !cards.some(card => card.status === "done") || !hasGithubRemote(repoBoard)) return cards;
    const tip = gitOut(repoBoard.repo, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main");
    if (!tip) return cards;
    const merges = this.board.listMergeCommits(repoBoard.repo);
    return cards.map(card => {
      const merge = card.status === "done" ? merges.get(card.id) : undefined;
      if (!merge) return card;
      const key = `${repoBoard.repo}\0${tip}\0${merge}`;
      let pushed = this.cache.get(key);
      if (pushed === undefined) {
        const answer = isAncestor(repoBoard.repo, merge, tip);
        if (answer === undefined) return card; // The merge commit is gone from this clone; say nothing.
        if (this.cache.size > 5000) this.cache.clear();
        this.cache.set(key, pushed = answer);
      }
      return { ...card, originMain: pushed ? "pushed" : "local" };
    });
  }
}
