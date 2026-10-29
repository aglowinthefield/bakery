import { execFileSync } from "node:child_process";

// Local-mode boards never push, but their `main` should still track the shared repository when there is one.
// These helpers fetch `origin` best-effort: being offline is a warning, never a block.

function git(repo: string, args: string[], timeout?: number) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

export function hasOrigin(repo: string): boolean {
  try { git(repo, ["remote", "get-url", "origin"]); return true; } catch { return false; }
}

/** `git fetch origin` with a bounded timeout. Returns a warning instead of throwing when the fetch fails. */
export function fetchOriginBestEffort(repo: string, timeoutMs = 30_000): string | null {
  try { git(repo, ["fetch", "origin", "--prune", "--quiet"], timeoutMs); return null; }
  catch (error) {
    const failure = error as { stderr?: Buffer | string; code?: string; signal?: string };
    const detail = failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM" ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : (failure.stderr?.toString() || String(error)).trim().slice(0, 500);
    return `git fetch origin failed (${detail}); continuing with the last fetched origin/main`;
  }
}

/** Commits on `ref` not on origin/main (`ahead`) and the reverse (`behind`), or null when origin/main is unknown. */
export function compareWithOriginMain(repo: string, ref = "main"): { ahead: number; behind: number } | null {
  try { git(repo, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]); } catch { return null; }
  const [ahead, behind] = git(repo, ["rev-list", "--left-right", "--count", `${ref}...refs/remotes/origin/main`]).split(/\s+/).map(Number);
  return { ahead, behind };
}

/**
 * Brings local main level with origin/main when it is behind: a fast-forward, or a rebase of unpushed local commits
 * onto it. Only from a clean tracked checkout. A rebase that conflicts is aborted so main is left as it was.
 * Returns what it did, or null when it did not touch main (the caller then reports `behindOriginMessage`).
 */
export function syncMainWithOrigin(repo: string, state: { ahead: number; behind: number }): string | null {
  if (!state.behind) return null;
  try {
    if (git(repo, ["status", "--porcelain", "--untracked-files=no"])) return null;
    if (!state.ahead) { git(repo, ["merge", "--ff-only", "--quiet", "refs/remotes/origin/main"]); return `Fast-forwarded main over ${state.behind} commit${state.behind === 1 ? "" : "s"} from origin/main`; }
    try { git(repo, ["rebase", "refs/remotes/origin/main"]); }
    catch { try { git(repo, ["rebase", "--abort"]); } catch { /* Nothing in progress. */ } return null; }
    return `Rebased ${state.ahead} local commit${state.ahead === 1 ? "" : "s"} on main onto origin/main`;
  } catch { return null; }
}

/** Why approving into local main must wait, or null. Ahead of origin/main is fine; behind or diverged is not. */
export function behindOriginMessage(repo: string, state: { ahead: number; behind: number }): string | null {
  if (!state.behind) return null;
  const count = `${state.behind} commit${state.behind === 1 ? "" : "s"}`;
  if (state.ahead) return `Local main has diverged from origin/main (${state.ahead} local, ${count} behind). Reconcile main with origin/main at ${repo}, then approve again`;
  return `Local main is ${count} behind origin/main. Update main first (git -C ${repo} merge --ff-only origin/main), then refresh the diff and approve again`;
}
