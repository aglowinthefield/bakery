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
    // Validate the workspace before claiming. Never run an agent in the app's own directory by default.
    const root = git(card.repo, "rev-parse", "--show-toplevel");
    if (realpathSync(root) !== realpathSync(card.repo)) throw new Error("Workspace must be the root of a Git repository");
    try { git(root, "rev-parse", "--verify", "HEAD^{commit}"); }
    catch { throw new Error(`Repository ${root} has no HEAD commit. Make an initial commit before starting a run; Bakery will not commit for you.`); }
    const worktree = join(this.dataDir, "worktrees", card.id);
    const branch = `bakery/${card.id}`;
    const run = this.board.claim(card.id);
    try {
      if (existsSync(worktree) && realpathSync(git(worktree, "rev-parse", "--show-toplevel")) !== realpathSync(worktree)) throw new Error("Existing path is not the card worktree");
      mkdirSync(join(this.dataDir, "worktrees"), { recursive: true });
      if (!existsSync(worktree)) git(root, "worktree", "add", "-b", branch, worktree, "HEAD");
    } catch (error) {
      this.board.finish(run.id, "failed", error instanceof Error ? error.message : String(error));
      return this.board.getRun(run.id)!;
    }
    const prompt = `Task from Bakery card ${card.id}: ${card.title}\n\n${card.body}\n\nWork in this dedicated worktree: ${worktree}. This is an implementation attempt. Follow this repository's own instructions. Do not stage, commit, push, create a PR, merge, deploy, or post externally unless the operator has independently authorized that action. Stop and explain any blocker. At the end, state what changed, what you verified, and what remains. A finished agent session requests review; it does not mark the card done.`;
    let child: ChildProcess;
    try {
      child = spawn(this.piBin, ["--mode", "json", "--session-id", run.sessionId, "--", prompt], { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { this.board.finish(run.id, "failed", String(error)); return this.board.getRun(run.id)!; }
    this.active.set(run.id, child);
    if (child.pid) this.board.attach(run.id, child.pid, worktree);
    let buffer = "", settled = false, aborted = false, modelError = false, stderr = "";
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
          if (event.type === "tool_execution_start") this.board.append(run.id, `\n[tool: ${event.toolName}]\n`);
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
