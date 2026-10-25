import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Board, type Card, type Run } from "./board.js";

function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export class Worker {
  private active = new Map<string, ChildProcess>();
  constructor(private board: Board, private dataDir: string, private piBin = "pi") {}
  start(card: Card): Run {
    if (card.status === "triage") throw new Error("Move this card to Ready before starting a run");
    // Validate the workspace before claiming. Never run an agent in the app's own directory by default.
    const root = git(card.repo, "rev-parse", "--show-toplevel");
    if (realpathSync(root) !== realpathSync(card.repo)) throw new Error("Workspace must be the root of a Git repository");
    try { git(root, "rev-parse", "--verify", "HEAD^{commit}"); }
    catch { throw new Error(`Repository ${root} has no HEAD commit. Make an initial commit before starting a run; Bakery will not commit for you.`); }
    const worktree = join(this.dataDir, "worktrees", card.id);
    const branch = `bakery/${card.id}`;
    const conflict = this.board.getMergeFailure(card.id);
    const mainTip = conflict ? git(root, "rev-parse", "main") : null;
    if (conflict && !existsSync(worktree)) throw new Error("Card worktree is missing; inspect and restore it before repairing the conflict");
    if (conflict && (
      realpathSync(git(worktree, "rev-parse", "--show-toplevel")) !== realpathSync(worktree) ||
      git(worktree, "symbolic-ref", "--short", "HEAD") !== branch ||
      realpathSync(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")) !==
      realpathSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    )) throw new Error("Conflict repair requires the card worktree on its original branch in this repository");
    const run = this.board.claim(card.id);
    try {
      if (existsSync(worktree) && realpathSync(git(worktree, "rev-parse", "--show-toplevel")) !== realpathSync(worktree)) throw new Error("Existing path is not the card worktree");
      mkdirSync(join(this.dataDir, "worktrees"), { recursive: true });
      if (!existsSync(worktree)) git(root, "worktree", "add", "-b", branch, worktree, "HEAD");
    } catch (error) {
      this.board.finish(run.id, "failed", error instanceof Error ? error.message : String(error));
      return this.board.getRun(run.id)!;
    }
    const instructions = conflict
      ? `This is a merge-conflict repair attempt. Bakery could not merge this card into main. Conflicting files: ${JSON.stringify(conflict.files)}. Current main tip: ${mainTip}. Reconcile the reviewed card work with current main. You may merge current main into the card worktree and stage and commit the resolution on the card branch only. Preserve both the card's intended behavior and unrelated changes already on main. Do not change main, push, create a PR, deploy, or post externally. Check the resolved work and report what you verified. Bakery will ask for human review and approval again; do not attempt to integrate it yourself.`
      : "This is an implementation attempt. Do not stage, commit, push, create a PR, merge, deploy, or post externally unless the operator has independently authorized that action.";
    const prompt = `Task from Bakery card ${card.id}: ${card.title}\n\n${card.body}\n\nWork in this dedicated worktree: ${worktree}. ${instructions} Follow this repository's own instructions. Stop and explain any blocker. As you work, give brief plain-language progress updates about what you learned and what comes next, rather than narrating each tool call. At the end, state what changed, what you verified, and what remains. A finished agent session requests review; it does not mark the card done.`;
    let child: ChildProcess;
    try {
      child = spawn(this.piBin, ["--mode", "json", "--session-id", run.sessionId, "--", prompt], { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { this.board.finish(run.id, "failed", String(error)); return this.board.getRun(run.id)!; }
    this.active.set(run.id, child);
    if (child.pid) this.board.attach(run.id, child.pid, worktree);
    let buffer = "", settled = false, aborted = false, modelError = false, stderr = "";
    let turn = 0, lastWorktreeSnapshot = "";
    const tools = new Map<string, { name: string; finished: boolean; failed: boolean }>();
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, ""); buffer = buffer.slice(i + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "agent_settled") { settled = true; aborted = event.aborted === true; }
          if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") modelError = true;
          if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") this.board.append(run.id, event.assistantMessageEvent.delta);
          if (event.type === "turn_start") { turn++; tools.clear(); }
          if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
            const name = typeof event.toolName === "string" && /^[a-z][a-z0-9_-]{0,40}$/i.test(event.toolName) ? event.toolName : "tool";
            tools.set(event.toolCallId, { name, finished: false, failed: false });
          }
          if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
            const tool = tools.get(event.toolCallId);
            if (tool) { tool.finished = true; tool.failed = event.isError === true; }
          }
          if (event.type === "turn_end") this.board.completeTurn(run.id);
          if (event.type === "turn_end" && tools.size) {
            const counts = new Map<string, number>();
            let failed = 0, unfinished = 0;
            for (const tool of tools.values()) {
              counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
              if (!tool.finished) unfinished++;
              else if (tool.failed) failed++;
            }
            const summary = [...counts].map(([name, count]) => `${name} ×${count}`).join(", ");
            this.board.append(run.id, `\nTurn ${turn || 1}: ${summary}${failed ? `; ${failed} failed` : ""}${unfinished ? `; ${unfinished} unfinished` : ""}\n`);
            try {
              const paths = [
                execFileSync("git", ["-C", worktree, "diff", "--name-only", "-z", "HEAD", "--"], { encoding: "utf8" }),
                execFileSync("git", ["-C", worktree, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }),
              ].flatMap(list => list.split("\0").filter(Boolean)).sort();
              const snapshot = JSON.stringify(paths);
              if (paths.length && snapshot !== lastWorktreeSnapshot) {
                const shown = paths.slice(0, 3).map(path => path.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 80));
                this.board.append(run.id, `worktree: ${paths.length} changed file${paths.length === 1 ? "" : "s"} (${shown.join(", ")}${paths.length > shown.length ? `, +${paths.length - shown.length} more` : ""})\n`);
              }
              lastWorktreeSnapshot = snapshot;
            } catch { /* A transcript hint must not fail the run if Git is unavailable. */ }
            tools.clear();
          }
        } catch { modelError = true; }
      }
      if (buffer.length > 1_000_000) { modelError = true; child.kill(); }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60 * 1000);
    child.on("error", (error) => { this.board.finish(run.id, "failed", `Pi could not start: ${error.message}`); });
    child.on("close", (code, signal) => {
      clearTimeout(timer); this.active.delete(run.id);
      const ok = code === 0 && settled && !aborted && !modelError;
      // Stderr stays on disk only as a generic error, never echoed into the browser.
      this.board.finish(run.id, ok ? "review" : "failed", ok ? null : `Pi exited (${signal ?? code ?? "unknown"}); ${settled ? "settled" : "no settlement event"}${stderr ? "; see server stderr" : ""}`);
      if (stderr) console.error(`Pi diagnostics for run ${run.id}:`, stderr);
    });
    return this.board.getRun(run.id)!;
  }
  stop(id: string) {
    const child = this.active.get(id);
    if (!child) throw new Error("This run is not owned by the current server process");
    child.kill("SIGTERM");
  }
  async shutdown() {
    await Promise.all([...this.active.values()].map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once("close", () => resolve());
      child.kill("SIGTERM");
    })));
  }
}
