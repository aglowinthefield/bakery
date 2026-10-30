import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { command } from "./platform.js";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { agentLabel, messageUsage } from "./agent.js";
import { piModelArgs, type AgentPhase } from "./agent-models.js";
import { attachmentsPrompt } from "./attachments.js";
import { Board, RunLimitError, type Card, type Run } from "./board.js";
import { compareWithOriginMain, fetchOriginBestEffort, hasOrigin } from "./origin.js";

function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fetchOrigin(repo: string) {
  try { execFileSync("git", ["-C", repo, "fetch", "origin", "--prune", "--quiet"], { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }); }
  catch (error) { throw new Error(`git fetch origin failed: ${((error as { stderr?: Buffer }).stderr?.toString() || String(error)).trim().slice(0, 2000)}`); }
}
function isAncestor(repo: string, ancestor: string, descendant: string) {
  try { execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" }); return true; }
  catch (error) { if ((error as { status?: number }).status === 1) return false; throw error; }
}

// Pi's provider error text may include request details. Keep only the HTTP status in the card transcript.
function providerFailure(error: unknown): string {
  const status = typeof error === "string" ? error.match(/\b[45]\d{2}\b/)?.[0] : undefined;
  return `Provider request failed${status ? ` (HTTP ${status})` : ""}`;
}

/** What a running Pi is doing now: its latest tool, that tool's turn, and when the tool started (ISO time). */
export type LiveActivity = { tool: string; turn: number; since: string };

// Screenshots read back into a session make single events several MB; the cap only guards against a runaway line.
const MAX_PI_EVENT_BYTES = 500_000_000;

export class Worker {
  private active = new Map<string, ChildProcess>();
  /** In memory only, keyed by run id; cleared when the run ends. */
  private live = new Map<string, LiveActivity>();
  private terminationReasons = new Map<string, string>();
  private draining = false;
  private idleWaiters: (() => void)[] = [];
  /** `wtBin` enables Worktrunk hooks for new card worktrees; omit it to skip hooks entirely. */
  constructor(private board: Board, private dataDir: string, private piBin = "pi", private wtBin?: string) {}
  private terminate(id: string, child: ChildProcess, reason: string) {
    if (child.kill("SIGTERM") && !this.terminationReasons.has(id)) this.terminationReasons.set(id, reason);
  }
  /** `why` finishes the history line "Attempt N started …" when something other than a person or auto-pickup asked. */
  start(card: Card, startedBy: "manual" | "auto" = "manual", why = ""): Run {
    if (this.draining) throw new Error("Bakery is waiting for active runs to finish before restarting to load code changes; start this run after the restart");
    if (card.status === "triage") throw new Error("Move this card to Ready before starting a run");
    // Validate the workspace before claiming. Never run an agent in the app's own directory by default.
    const root = git(card.repo, "rev-parse", "--show-toplevel");
    if (realpathSync(root) !== realpathSync(card.repo)) throw new Error("Workspace must be the root of a Git repository");
    try { git(root, "rev-parse", "--verify", "HEAD^{commit}"); }
    catch { throw new Error(`Repository ${root} has no HEAD commit. Make an initial commit before starting a run; Bakery will not commit for you.`); }
    const worktree = join(this.dataDir, "worktrees", card.id);
    const branch = `bakery/${card.id}`;
    const conflict = this.board.getMergeFailure(card.id);
    const latestRun = this.board.listRuns(card.id)[0];
    if (latestRun && this.board.hasDraftReviewComments(card.id, latestRun.id)) throw new Error("Submit or remove draft review comments before running Pi again");
    const feedback = this.board.getFeedbackForRun(card.id);
    // Requested changes belong to the last attempt that reached review. A run that failed or was interrupted after it
    // (a rebase conflict, say) never addressed them, so they go to the next run too.
    const lastReviewed = this.board.listRuns(card.id).find(run => run.status === "review");
    const reviewerChanges = lastReviewed && !feedback.length ? this.board.getReviewerChanges(lastReviewed.id) : [];
    const ciFeedback = this.board.getCiFeedback(card.id);
    if (conflict && !existsSync(worktree)) throw new Error("Card worktree is missing; inspect and restore it before repairing the conflict");
    if (conflict && (
      realpathSync(git(worktree, "rev-parse", "--show-toplevel")) !== realpathSync(worktree) ||
      git(worktree, "symbolic-ref", "--short", "HEAD") !== branch ||
      realpathSync(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")) !==
      realpathSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    )) throw new Error("Conflict repair requires the card worktree on its original branch in this repository");
    const run = this.board.claim(card.id, startedBy, why);
    const prMode = this.board.integrationFor(card.repo) === "github-pr";
    let created = false;
    try {
      if (existsSync(worktree) && realpathSync(git(worktree, "rev-parse", "--show-toplevel")) !== realpathSync(worktree)) throw new Error("Existing path is not the card worktree");
      mkdirSync(join(this.dataDir, "worktrees"), { recursive: true });
      // On a github-pr board a card starts from origin/main, fetched now, so it never builds on a stale checkout.
      if (prMode) fetchOrigin(root);
      if (!existsSync(worktree)) { git(root, "worktree", "add", "-b", branch, worktree, prMode ? "origin/main" : this.localBase(run, root)); created = true; }
      else if (prMode && !conflict) this.rebaseRetry(card, run, worktree, branch);
    } catch (error) {
      this.board.finish(run.id, "failed", error instanceof Error ? error.message : String(error));
      return this.board.getRun(run.id)!;
    }
    // A github-pr card conflicts with origin/main (fetched above), not with the local checkout's main.
    const mainRef = prMode ? "origin/main" : "main";
    const mainTip = conflict ? git(root, "rev-parse", mainRef) : null;
    // Bakery pushes this work through the repository's pre-push hook after Approve. A check the agent could have run
    // here otherwise surfaces only then, as another full round.
    const hookCheck = prMode || this.board.boardForRepo(card.repo)?.pushMainAfterMerge
      ? " After Approve, Bakery pushes this work through the repository's pre-push hook (find it with `git config core.hooksPath`, for example `.husky/pre-push`, or in `.git/hooks`). If there is one, run the checks it runs before you finish, and fix what they report, since a refused push sends the card back."
      : "";
    const instructions = conflict
      ? `This is a merge-conflict repair attempt. Bakery could not merge this card into ${mainRef}. Conflicting files: ${JSON.stringify(conflict.files)}. Current ${mainRef} tip: ${mainTip}. Reconcile the reviewed card work with current ${mainRef}. You may merge ${mainRef} into the card worktree and stage and commit the resolution on the card branch only. Preserve both the card's intended behavior and unrelated changes already on main. Do not change main, push, create a PR, deploy, or post externally. Check the resolved work and report what you verified. ${ciFeedback?.source === "conflict" ? "Resolve every conflict that is mechanical, meaning the right result follows from the two sides without a product or design decision (both sides added lines, renamed or moved code, formatting, lockfiles you can regenerate, generated files you can rebuild). Run the checks that cover the files you touched. Bakery pushes your resolution to the pull request itself once you finish, so commit the merge and leave nothing unresolved. If a conflict needs a human decision (the two sides change the same behavior in incompatible ways, say), run `git merge --abort`, change nothing, and explain exactly what the decision is; Bakery posts your report on the pull request." : "Bakery will ask for human review and approval again; do not attempt to integrate it yourself."}`
      : "This is an implementation attempt. Do not stage, commit, push, create a PR, merge, deploy, or post externally unless the operator has independently authorized that action." + hookCheck;
    const feedbackPrompt = feedback.length ? `\n\nThe reviewer requested these changes to the previous reviewed attempt. Address each item and report any you could not resolve: ${JSON.stringify(feedback.map(item => ({ path: item.path, fileLine: item.fileLine, diffRow: item.line, kind: item.kind, previousCode: item.code.slice(0, 200), comment: item.body })))}` : "";
    const reviewerPrompt = reviewerChanges.length ? `\n\nAn independent agent reviewer inspected the previous attempt and sent it back with these requested changes. Address each item and report any you could not resolve: ${JSON.stringify(reviewerChanges)}` : "";
    const ciPrompt = ciFeedback?.source === "ci" && !conflict ? `\n\nThis card's pull request failed CI at ${ciFeedback.headSha}. Bakery sent it back so you can make it CI-ready. Fix every failure below on the card branch, run the matching checks locally where you can, and report anything you could not fix. Some checks are satisfied outside the code, by a label or a line in the pull request description. For this run you are authorized to change that pull request${card.prNumber ? ` (#${card.prNumber}${card.prUrl ? `, ${card.prUrl}` : ""})` : ""} with \`gh pr edit\` (add or remove labels, edit the description) when the repository's own rules allow it, and to post a \`gh pr comment\` there explaining each such change and why the rules allow it. If a failure looks like a hang, timeout or flake rather than a code problem, re-run just the failed jobs once with \`gh run rerun <run-id> --failed\` (run ids are in the failure list or \`gh run list --branch\`) before changing code, and say so in your report; re-run each run at most once. Do not push, merge, close it, or touch any other pull request; Bakery pushes your code changes. The failed checks and their log excerpts:\n\n${ciFeedback.failures}` : "";
    // A conflict repair gets refused-push output too: the run that would have fixed the hook failed on the conflict
    // before Pi started, so without it the repair goes back to Review and the next push fails the same hook again.
    const pushPrompt = ciFeedback?.source === "push" ? `\n\nBakery tried to push this card's branch to GitHub, and the repository's pre-push hook refused it, so nothing was pushed. Make the hook pass: fix what it reports on the card branch (the commit it rejected is ${ciFeedback.headSha}), re-run the failing command locally, and report anything you could not fix. Do not skip or bypass the hook, and do not push; Bakery pushes after the operator approves again. The hook's output:\n\n\`\`\`\n${ciFeedback.failures}\n\`\`\`` : "";
    const filesPrompt = attachmentsPrompt(this.dataDir, this.board.listAttachments(card.id));
    const prompt = `Task from Bakery card ${card.id}: ${card.title}\n\n${card.body}${filesPrompt ? `\n\n${filesPrompt}` : ""}${feedbackPrompt}${reviewerPrompt}${ciPrompt}${pushPrompt}\n\nWork in this dedicated worktree: ${worktree}. ${instructions} Follow this repository's own instructions. Stop and explain any blocker. As you work, before each tool call or group of calls, write one plain sentence saying what you are checking or doing and why, and after a result that changes your plan, one sentence on what you learned. Keep each to a single sentence about intent and findings, not the command itself. At the end, state what changed, what you verified, and what remains. Do anything you can do in this worktree yourself and report it: run the checks, tests and scripts that verify your change, and finish small cleanups you noticed, instead of listing them. If there is work that should happen later but is not part of this card, or that you cannot do from here (it needs a push, credentials, a deploy, or a human decision), such as a migration to apply, list each as a bullet under a final "## Follow-ups" heading, each self-contained so someone can act on it without this conversation; Bakery turns them into triage cards. Omit the heading when there are none. If this card asks you to plan or break down a larger piece of work, do not implement it: finish your report with one fenced block tagged bakery-plan holding a JSON array of subtasks, each {"id":"short local id","title":"...","body":"self-contained instructions with acceptance criteria","dependsOn":["ids of subtasks that must finish first"]}, at most 20. Write each body as readable markdown, not one block of text: a one-line goal, then short sections or bullet lists (for example Steps, Acceptance), with backticks around file paths and commands. Make each subtask small enough for one agent run, and give subtasks that would edit the same files a dependsOn order so they do not conflict. Bakery turns the plan into Triage cards for a person to review. In a planning report the plan is the deliverable: do not repeat plan items under Follow-ups, and keep questions, assumptions and decisions for the person in ordinary prose, not as Follow-ups. A Follow-up is only concrete work outside the plan that someone must do. A finished agent session requests review; it does not mark the card done.`;
    // Handed to this run; a later run should not see the same failures again.
    if (ciPrompt || pushPrompt || (conflict && ciFeedback?.source === "conflict")) this.board.startCiFix(card.id, run.id, ciFeedback!.source);
    const phase = conflict ? "conflict" : "work";
    const launch = () => this.launchPi(card, run, worktree, prompt, phase);
    if (created && this.hasWorktrunk()) { this.runWorktrunkHooks(run, root, worktree, branch, launch); return this.board.getRun(run.id)!; }
    return launch();
  }
  /**
   * Sends a refused push, already recorded with `recordPushFailure`, back to the card's agent. Returns false when the
   * repository is at its run limit or Bakery is draining for a restart: the hook's output stays recorded and
   * `AutoPickup` starts the run once it can. Any other failure drops the output, since nothing will retry it, and throws.
   */
  startHookFix(card: Card): boolean {
    if (this.draining) return false;
    try { this.start(card, "manual", "to fix the failing pre-push hook"); return true; }
    catch (error) {
      if (error instanceof RunLimitError) return false;
      this.board.clearCiFeedback(card.id);
      throw error;
    }
  }
  /**
   * A local-mode card starts from origin/main when the repository has an origin and local HEAD is not ahead of it,
   * so it never builds on a stale checkout. Unpushed local commits win: then HEAD is the base. Offline only warns.
   */
  private localBase(run: Run, root: string): string {
    if (!hasOrigin(root)) return "HEAD";
    const warning = fetchOriginBestEffort(root);
    if (warning) this.board.append(run.id, `${warning}\n`);
    const state = compareWithOriginMain(root, "HEAD");
    return state && !state.ahead ? "refs/remotes/origin/main" : "HEAD";
  }
  /**
   * A retry on a github-pr board whose base is behind origin/main is rebased onto it (or, after a conflict repair, has it merged in) before Pi starts, but only
   * while nothing about it is published: a clean worktree whose branch was never pushed. A pushed branch is what
   * the open PR shows, so it is left alone. Conflicts abort the rebase, fail the run, and record a merge failure, so
   * the next start is a conflict-repair run that merges origin/main instead of retrying the same rebase.
   */
  private rebaseRetry(card: Card, run: Run, worktree: string, branch: string) {
    if (git(worktree, "status", "--porcelain")) return;
    try { git(worktree, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`); return; } catch { /* Never pushed. */ }
    if (isAncestor(worktree, "origin/main", "HEAD")) return;
    // A merge of origin/main on the branch is a conflict repair. A rebase would drop it and replay the card's own
    // commits onto the same conflict, so a branch carrying one is brought up to date by merging instead.
    const merging = git(worktree, "rev-list", "--merges", "--max-count=1", "origin/main..HEAD") !== "";
    this.board.append(run.id, merging ? "Merging origin/main into the card branch…\n" : "Rebasing the card branch onto origin/main…\n");
    try {
      if (merging) { git(worktree, "merge", "--no-edit", "origin/main"); return; }
      if (this.hasWorktrunk()) execFileSync(...command(this.wtBin!, ["-C", worktree, "step", "rebase", "origin/main", "--yes"]), { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
      else git(worktree, "rebase", "origin/main");
    } catch (error) {
      let files = "";
      try { files = git(worktree, "diff", "--name-only", "--diff-filter=U"); } catch { /* Keep the rebase error. */ }
      try { git(worktree, merging ? "merge" : "rebase", "--abort"); } catch { /* Nothing in progress. */ }
      const detail = (error as { stderr?: string }).stderr?.toString().trim() || (error instanceof Error ? error.message : String(error));
      const conflicted = files.split("\n").filter(Boolean);
      if (conflicted.length) this.board.recordMergeFailure(card.id, conflicted, detail);
      const next = conflicted.length ? "Choose Fix conflict with Pi, or resolve it yourself" : "Resolve it";
      throw new Error(`${merging ? "Merge of" : "Rebase onto"} origin/main conflicted${conflicted.length ? ` in ${conflicted.join(", ")}` : ""}; the card branch is unchanged. ${next} in ${worktree}, then run again. ${detail.slice(0, 1000)}`);
    }
  }
  /** True when `wtBin` is Worktrunk's `wt`, not another binary with the same name (wiredtiger ships one). */
  private hasWorktrunk() {
    if (!this.wtBin) return false;
    try { return /^wt v\d/.test(execFileSync(...command(this.wtBin, ["--version"]), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })); }
    catch { return false; }
  }
  private release(id: string) {
    this.active.delete(id);
    if (!this.active.size) for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
  /**
   * Runs the repository's Worktrunk pre-start hooks in a freshly created card worktree, starts
   * its post-start hooks in the background, then launches Pi. Approval prompts are skipped because
   * nobody is at a terminal; Pi runs arbitrary commands in the same worktree anyway. If pre-start
   * fails, the fresh worktree and branch are removed so a retry runs the hooks again.
   */
  private runWorktrunkHooks(run: Run, root: string, worktree: string, branch: string, launch: () => Run) {
    this.board.append(run.id, "Running Worktrunk pre-start hooks…\n");
    const child = spawn(...command(this.wtBin!, ["-C", worktree, "hook", "pre-start", "--foreground", "--yes"]), { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
    this.active.set(run.id, child);
    if (child.pid) this.board.attach(run.id, child.pid, worktree);
    let output = "", done = false;
    const collect = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-4000); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => this.terminate(run.id, child, "10-minute Worktrunk hook timeout"), 10 * 60 * 1000);
    const settle = (failure: string | null) => {
      if (done) return;
      done = true; clearTimeout(timer);
      const reason = this.terminationReasons.get(run.id);
      this.terminationReasons.delete(run.id);
      if (!failure && !reason) {
        try { execFileSync(...command(this.wtBin!, ["-C", worktree, "hook", "post-start", "--yes"]), { cwd: worktree, stdio: "ignore", timeout: 30_000 }); }
        catch { this.board.append(run.id, "Worktrunk post-start hooks could not start; continuing without them.\n"); }
        this.board.append(run.id, "Worktrunk hooks done. Starting Pi.\n");
        launch();
        if (!this.active.has(run.id) || this.active.get(run.id) === child) this.release(run.id);
        return;
      }
      this.release(run.id);
      if (output.trim()) this.board.append(run.id, `${output.trimEnd()}\n`);
      try { git(root, "worktree", "remove", "--force", worktree); git(root, "branch", "-D", branch); }
      catch { /* Keep the hook error; a leftover worktree only means the next attempt skips hooks. */ }
      this.board.finish(run.id, "failed", reason ? `Worktrunk pre-start hooks stopped; Bakery sent SIGTERM: ${reason}` : failure!);
    };
    child.on("error", error => settle(`Worktrunk could not start: ${error.message}`));
    child.on("close", (code, signal) => settle(code === 0 ? null : `Worktrunk pre-start hooks failed (${signal ?? code ?? "unknown"}); hook output is in the transcript`));
  }
  private launchPi(card: Card, run: Run, worktree: string, prompt: string, phase: AgentPhase): Run {
    let child: ChildProcess;
    try {
      const models = piModelArgs(this.board.agentModelFor(card.repo, phase));
      child = spawn(...command(this.piBin, ["--mode", "json", "--session-id", run.sessionId, ...models, "--", prompt]), { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { this.board.finish(run.id, "failed", String(error)); return this.board.getRun(run.id)!; }
    this.active.set(run.id, child);
    if (child.pid) this.board.attach(run.id, child.pid, worktree);
    const startedAt = Date.now();
    // Pi writes each event as one JSON line, and a line holding a screenshot can run to several MB.
    // Chunks stay as Buffers until a newline arrives, so a long line is concatenated once rather than rescanned per chunk.
    let pending: Buffer[] = [], pendingBytes = 0, overflowed = false;
    let settled = false, aborted = false, terminalModelError: string | null = null, protocolError: string | null = null, stderr = "";
    let turn = 0, lastWorktreeSnapshot = "", lastAgent = "";
    const tools = new Map<string, { name: string; finished: boolean; failed: boolean }>();
    let touchedAt = Date.now();
    child.stdout?.on("data", (chunk: Buffer) => {
      // Any output counts as activity; a write every 10s is enough for the board to tell working from quiet.
      if (Date.now() - touchedAt >= 10_000) { touchedAt = Date.now(); this.board.touch(run.id); }
      if (overflowed) return;
      pending.push(chunk); pendingBytes += chunk.length;
      if (chunk.indexOf(10) < 0) {
        if (pendingBytes > MAX_PI_EVENT_BYTES) {
          overflowed = true; pending = []; pendingBytes = 0;
          protocolError = "Pi event exceeded 500 MB"; this.terminate(run.id, child, "Pi event exceeded 500 MB");
        }
        return;
      }
      const data = pending.length === 1 ? chunk : Buffer.concat(pending, pendingBytes);
      let start = 0, i: number;
      while ((i = data.indexOf(10, start)) >= 0) {
        const line = data.toString("utf8", start, i).replace(/\r$/, ""); start = i + 1;
        try {
          const event = JSON.parse(line);
          if (event.type === "agent_settled") { settled = true; aborted = event.aborted === true; }
          if (event.type === "message_start" || event.type === "message_end") {
            const label = agentLabel(event.message);
            if (label && label !== lastAgent) { lastAgent = label; this.board.recordAgent(run.id, label); }
          }
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const usage = messageUsage(event.message);
            if (usage) this.board.recordUsage(run.id, usage);
            if (event.message.stopReason !== "error" && Array.isArray(event.message.content))
              this.board.recordReport(run.id, event.message.content.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: unknown }) => typeof part.text === "string" ? part.text : "").join(""));
            if (event.message.stopReason === "error") {
              terminalModelError = providerFailure(event.message.errorMessage);
              this.board.append(run.id, `\n${terminalModelError}; Pi may retry.\n`);
            } else if (terminalModelError) {
              terminalModelError = null;
              this.board.append(run.id, "\nPi recovered and continued after a provider error.\n");
            }
          }
          if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") this.board.append(run.id, event.assistantMessageEvent.delta);
          if (event.type === "turn_start") { turn++; tools.clear(); }
          if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
            const name = typeof event.toolName === "string" && /^[a-z][a-z0-9_-]{0,40}$/i.test(event.toolName) ? event.toolName : "tool";
            tools.set(event.toolCallId, { name, finished: false, failed: false });
            this.live.set(run.id, { tool: name, turn: turn || 1, since: new Date().toISOString() });
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
        } catch { protocolError = "Invalid Pi event stream"; }
      }
      pending = start < data.length ? [data.subarray(start)] : [];
      pendingBytes = data.length - start;
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const timer = setTimeout(() => this.terminate(run.id, child, "30-minute run timeout"), 30 * 60 * 1000);
    child.on("error", (error) => { this.live.delete(run.id); this.board.finish(run.id, "failed", `Pi could not start: ${error.message}`); });
    child.on("close", (code, signal) => {
      clearTimeout(timer); this.active.delete(run.id); this.live.delete(run.id);
      if (!this.active.size) for (const resolve of this.idleWaiters.splice(0)) resolve();
      const reason = this.terminationReasons.get(run.id);
      this.terminationReasons.delete(run.id);
      const ok = code === 0 && settled && !aborted && !terminalModelError && !protocolError;
      // Exit code 143 often means SIGTERM through a shell, but does not identify the sender.
      const termination = reason ? `; Bakery sent SIGTERM: ${reason}`
        : signal || code === 143 ? "; termination source unknown (Bakery did not send SIGTERM)" : "";
      // Stderr may contain request details, so only sanitized diagnostics reach the card.
      this.board.finish(run.id, ok ? "review" : "failed", ok ? null : `Pi exited (${signal ?? code ?? "unknown"})${termination}; ${settled ? "settled" : "no settlement event"}${terminalModelError ? `; ${terminalModelError}` : ""}${protocolError ? `; ${protocolError}` : ""}${stderr ? "; stderr logged on server" : ""}`);
      if (!ok) console.error(`Pi exit for run ${run.id}: pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"} source=${reason ?? "unknown"} elapsedMs=${Date.now() - startedAt}`);
      if (stderr) console.error(`Pi diagnostics for run ${run.id}:`, stderr);
    });
    return this.board.getRun(run.id)!;
  }
  stop(id: string) {
    const child = this.active.get(id);
    if (!child) throw new Error("This run is not owned by the current server process");
    this.terminate(id, child, "manual stop");
  }
  get activeCount() { return this.active.size; }
  /** Each card's live activity, or null for a card whose run is not in progress or has not used a tool yet. */
  withLive<T extends { id: string }>(cards: T[]): (T & { live: LiveActivity | null })[] {
    const byCard = new Map<string, LiveActivity>();
    for (const [runId, live] of this.live) {
      const run = this.active.has(runId) ? this.board.getRun(runId) : undefined;
      if (run) byCard.set(run.cardId, live);
    }
    return cards.map(card => ({ ...card, live: byCard.get(card.id) ?? null }));
  }
  /** Ids of the runs in progress. */
  get activeRunIds(): string[] { return [...this.active.keys()]; }
  /** Refuse new runs and resolve once every active Pi child has exited on its own. */
  drain(): Promise<void> {
    this.draining = true;
    if (!this.active.size) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }
  async shutdown(reason = "server shutdown") {
    await Promise.all([...this.active].map(([id, child]) => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once("close", () => resolve());
      this.terminate(id, child, reason);
    })));
  }
}
