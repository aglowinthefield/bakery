import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { command } from "./platform.js";
import { settledReply } from "./agent.js";
import type { Card, DiscussionMessage, Run } from "./board.js";

const maxHistory = 12;

/** The prompt for one discussion turn: the card, its latest report, and the recent chat, ending in the operator's message. */
export function discussionPrompt(card: Card, run: Run | undefined, history: DiscussionMessage[], message: string, files = ""): string {
  const past = history.slice(-maxHistory).map(item => `${item.role === "user" ? "Operator" : "You"}: ${item.body}`).join("\n\n");
  return [
    "You are discussing a Bakery card with the operator. This is a conversation about the work, not a work run.",
    "Answer questions, explain what was done and why, and suggest next steps. You may read files and run read-only commands to check facts.",
    "Do NOT edit, create or delete files, commit, push, or change the card. If the operator wants changes, tell them to request changes or run the card again.",
    `Card: ${card.title} (status: ${card.status})`,
    card.body.trim() ? `Card description:\n${card.body.slice(0, 4000)}` : "",
    run ? `Latest attempt: #${run.attempt}, ${run.status}${run.error ? `, error: ${run.error.slice(0, 500)}` : ""}` : "No attempt has run yet.",
    run?.report ? `Latest attempt's final report:\n${run.report.slice(0, 6000)}` : "",
    files,
    past ? `Conversation so far:\n${past}` : "",
    `Operator: ${message}`,
  ].filter(Boolean).join("\n\n");
}

/** Runs Pi once, in the card's worktree when it exists, and returns its reply text. Throws a short reason on failure. */
export function discuss({ prompt, cwd, piBin, models }: { prompt: string; cwd: string; piBin: string; models: string[] }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(...command(piBin, ["--print", "--mode", "json", "--no-session", ...models, "--", prompt]), { cwd: existsSync(cwd) ? cwd : process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    // A screenshot the agent reads back makes one event line several MB, so the cap matches the worker's.
    const chunks: Buffer[] = [];
    let stdoutBytes = 0, stderr = "", exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill("SIGTERM"); }, 10 * 60_000);
    child.stdout?.on("data", (chunk: Buffer) => { chunks.push(chunk); stdoutBytes += chunk.length; if (stdoutBytes > 500_000_000) { exceeded = true; child.kill("SIGTERM"); } });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000); });
    child.once("error", error => { clearTimeout(timer); reject(new Error(`Pi could not start: ${error.message}`)); });
    child.once("close", code => {
      clearTimeout(timer);
      if (exceeded) return reject(new Error("Pi timed out or exceeded its output limit"));
      if (code !== 0) return reject(new Error(`Pi failed (${code})`));
      try { resolve(settledReply(Buffer.concat(chunks).toString("utf8"), { toolUse: true }).trim()); }
      catch (error) { reject(new Error(`Pi gave no usable reply: ${error instanceof Error ? error.message : String(error)}`)); }
    });
  });
}
