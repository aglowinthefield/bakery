import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Board } from "../server/board.js";
import { Worker } from "../server/worker.js";
import { Integration, IntegrationConflictError } from "../server/integration.js";

test("an uncommitted repository cannot start a worktree or consume an attempt", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "uncommitted\n");
    const board = new Board(join(dir, "board.sqlite"));
    const worker = new Worker(board, join(dir, "data"), join(dir, "missing-pi"));
    const card = board.createCard({ title: "Start", body: "", repo });
    assert.throws(() => worker.start(card), /Move.*Ready/);
    board.setStatus(card.id, "ready");
    assert.throws(() => worker.start(board.getCard(card.id)!), /initial commit/);
    assert.equal(board.getCard(card.id)?.status, "ready");
    assert.deepEqual(board.listRuns(card.id), []);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("card transcript groups tool activity by turn without storing tool arguments or results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), fakePi = join(dir, "pi-fake");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    const events = [
      { type: "turn_start" },
      { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "SECRET_ARGUMENT" } },
      { type: "tool_execution_end", toolCallId: "a", isError: false, result: { content: "SECRET_RESULT" } },
      { type: "tool_execution_start", toolCallId: "b", toolName: "read" },
      { type: "tool_execution_end", toolCallId: "b", isError: false },
      { type: "tool_execution_start", toolCallId: "c", toolName: "bash" },
      { type: "tool_execution_end", toolCallId: "c", isError: true },
      { type: "turn_end", message: { stopReason: "toolUse" } },
      { type: "turn_start" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Checked the layout." } },
      { type: "tool_execution_start", toolCallId: "d", toolName: "edit" },
      { type: "turn_end", message: { stopReason: "stop" } },
      { type: "agent_settled", aborted: false },
    ];
    writeFileSync(fakePi, `#!/bin/sh\nprintf 'change\\n' >> README.md\nprintf '%s\\n' ${events.slice(0, 8).map(event => `'${JSON.stringify(event)}'`).join(" ")}\nsleep 0.8\nprintf '%s\\n' ${events.slice(8).map(event => `'${JSON.stringify(event)}'`).join(" ")}\n`);
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, join(dir, "data"), fakePi);
    const card = board.createCard({ title: "Transcript", body: "", repo });
    board.setStatus(card.id, "ready");
    const run = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.listCards(repo)[0]?.turns === 1);
    assert.equal(board.getRun(run.id)?.status, "running");
    await waitFor(() => board.getRun(run.id)?.status === "review");
    assert.equal(board.listCards(repo)[0]?.turns, 2);
    const output = board.getRun(run.id)!.output;
    assert.match(output, /Turn 1: read ×2, bash ×1; 1 failed/);
    assert.match(output, /Turn 2: edit ×1; 1 unfinished/);
    assert.match(output, /worktree: 1 changed file \(README\.md\)/);
    assert.match(output, /Checked the layout\./);
    assert.doesNotMatch(output, /SECRET_ARGUMENT|SECRET_RESULT|\[tool:/);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a transient provider error followed by successful Pi settlement is Review, while a terminal error is diagnosed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), fakePi = join(dir, "pi-fake");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    const errorEvent = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "OpenAI API error (503): SECRET_PROVIDER_DETAIL" } });
    const successEvent = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' '${errorEvent}' '${successEvent}' '{"type":"agent_settled","aborted":false}'\necho 'SECRET_STDERR' >&2\n`);
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, join(dir, "data"), fakePi);
    const card = board.createCard({ title: "Recover", body: "", repo });
    board.setStatus(card.id, "ready");
    const recovered = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(recovered.id)?.status !== "running");
    assert.equal(board.getRun(recovered.id)?.status, "review");
    assert.match(board.getRun(recovered.id)!.output, /provider request failed \(HTTP 503\)/i);
    assert.match(board.getRun(recovered.id)!.output, /recovered and continued/i);
    assert.doesNotMatch(board.getRun(recovered.id)!.output, /SECRET_PROVIDER_DETAIL|SECRET_STDERR/);
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' '${errorEvent}' '{"type":"agent_settled","aborted":false}'\n`);
    const terminal = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(terminal.id)?.status !== "running");
    assert.equal(board.getRun(terminal.id)?.status, "failed");
    assert.match(board.getRun(terminal.id)!.error!, /provider request failed \(HTTP 503\)/i);
    assert.doesNotMatch(board.getRun(terminal.id)!.error!, /SECRET_PROVIDER_DETAIL/);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a Pi settlement requests review; retry uses the same card worktree and session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), data = join(dir, "data"), fakePi = join(dir, "pi-fake"), promptFile = join(dir, "prompt.txt");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s' "$6" > '${promptFile}'\nprintf '%s\\n' '{"type":"turn_start"}' '{"type":"message_start","message":{"role":"assistant","provider":"anthropic","model":"claude-sonnet-4-5"}}' '{"type":"message_end","message":{"role":"assistant","provider":"anthropic","model":"claude-sonnet-4-5","stopReason":"stop"}}' '{"type":"turn_end"}' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Worked offline."}}' '{"type":"agent_settled","aborted":false}'\n`);
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, data, fakePi);
    const card = board.createCard({ title: "Test", body: "No network", repo });
    board.setStatus(card.id, "ready");
    const first = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(first.id)?.status === "review");
    assert.match(board.getRun(first.id)!.output, /Worked offline/);
    assert.equal(board.getRun(first.id)!.agent, "anthropic/claude-sonnet-4-5");
    assert.equal(board.getCard(card.id)!.runAgent, "anthropic/claude-sonnet-4-5");
    const fingerprint = "a".repeat(64);
    board.addReviewComment(card.id, first.id, fingerprint, "README.md", 4, "add", "changed", "Add a regression test", 2);
    assert.throws(() => worker.start(board.getCard(card.id)!), /Submit or remove draft review comments/);
    assert.equal(board.listRuns(card.id).length, 1);
    board.requestChanges(card.id, first.id, fingerprint);
    const next = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(next.id)?.status === "review");
    assert.equal(next.attempt, 2);
    assert.match(readFileSync(promptFile, "utf8"), /Add a regression test/);
    assert.match(readFileSync(promptFile, "utf8"), /README\.md/);
    assert.match(readFileSync(promptFile, "utf8"), /"fileLine":2/);
    assert.equal(next.sessionId, first.sessionId);
    assert.equal(next.worktree, first.worktree);
    assert.equal(board.listCards(repo)[0]?.turns, 2);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("a conflict retry tells Pi to reconcile only the card branch with current main", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), data = join(dir, "data"), fakePi = join(dir, "pi-fake"), promptFile = join(dir, "prompt.txt");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "initial\n");
    git("add", "README.md");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s' "$6" > '${promptFile}'\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`);
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, data, fakePi);
    const card = board.createCard({ title: "Resolve safely", body: "Update README", repo });
    board.setStatus(card.id, "ready");
    const first = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(first.id)?.status === "review");
    writeFileSync(join(first.worktree!, "README.md"), "card change\n");
    writeFileSync(join(repo, "README.md"), "main change\n");
    git("add", "README.md");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "main change");
    const main = git("rev-parse", "main");
    const integration = new Integration(board, data);
    assert.throws(() => integration.approve(board.getCard(card.id)!, integration.review(board.getCard(card.id)!).fingerprint), IntegrationConflictError);
    assert.equal(board.listMergeFailures(repo).length, 1);
    renameSync(first.worktree!, `${first.worktree!}-moved`);
    assert.throws(() => worker.start(board.getCard(card.id)!), /worktree is missing/);
    assert.equal(board.listRuns(card.id).length, 1);
    assert.equal(board.listMergeFailures(repo).length, 1);
    renameSync(`${first.worktree!}-moved`, first.worktree!);
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s' "$6" > '${promptFile}'\nexit 1\n`);
    const failed = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(failed.id)?.status === "failed");
    assert.match(readFileSync(promptFile, "utf8"), /README\.md/);
    assert.equal(board.listMergeFailures(repo).length, 1);
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s' "$6" > '${promptFile}'\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`);
    const retry = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(retry.id)?.status === "review");
    const prompt = readFileSync(promptFile, "utf8");
    assert.match(prompt, /README\.md/);
    assert.match(prompt, new RegExp(main));
    assert.match(prompt, /merge (current )?main into (the )?card worktree/i);
    assert.match(prompt, /do not (change|modify|merge into) main/i);
    assert.equal(retry.worktree, first.worktree);
    assert.equal(retry.sessionId, first.sessionId);
    assert.equal(retry.attempt, 3);
    assert.deepEqual(board.listMergeFailures(repo), []);
    assert.equal(git("rev-parse", "main"), main);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Pi termination distinguishes Bakery stop and shutdown from an unexplained exit 143", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), fakePi = join(dir, "pi-fake");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, join(dir, "data"), fakePi);
    const card = board.createCard({ title: "Exit provenance", body: "", repo });
    board.setStatus(card.id, "ready");
    writeFileSync(fakePi, "#!/bin/sh\nexit 143\n");
    chmodSync(fakePi, 0o755);
    const external = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(external.id)?.status === "failed");
    assert.match(board.getRun(external.id)!.error!, /Pi exited \(143\); termination source unknown \(Bakery did not send SIGTERM\)/);

    writeFileSync(fakePi, "#!/bin/sh\nexec sleep 30\n");
    const stopped = worker.start(board.getCard(card.id)!);
    worker.stop(stopped.id);
    await waitFor(() => board.getRun(stopped.id)?.status === "failed");
    assert.match(board.getRun(stopped.id)!.error!, /Bakery sent SIGTERM: manual stop/);

    const shutdown = worker.start(board.getCard(card.id)!);
    await worker.shutdown("server received SIGTERM");
    assert.match(board.getRun(shutdown.id)!.error!, /Bakery sent SIGTERM: server received SIGTERM/);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Worker did not finish");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("draining refuses new runs and resolves only after active Pi runs finish on their own", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), data = join(dir, "data"), fakePi = join(dir, "pi-fake");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    writeFileSync(fakePi, `#!/bin/sh\nsleep 0.5\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`);
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, data, fakePi);
    const card = board.createCard({ title: "Long run", body: "", repo });
    const other = board.createCard({ title: "Queued", body: "", repo });
    board.setStatus(card.id, "ready"); board.setStatus(other.id, "ready");
    const run = worker.start(board.getCard(card.id)!);
    let drained = false;
    const drain = worker.drain().then(() => { drained = true; });
    assert.throws(() => worker.start(board.getCard(other.id)!), /waiting for active runs to finish before restarting/);
    assert.equal(board.listRuns(other.id).length, 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(drained, false);
    await drain;
    assert.equal(board.getRun(run.id)?.status, "review");
    assert.equal(worker.activeCount, 0);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Pi usage is summed per attempt and per card, and older attempts stay unrecorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), fakePi = join(dir, "pi-fake");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    const usage = (input: number, output: number, total: number) => ({ input, output, cacheRead: 100, cacheWrite: 10, totalTokens: input + output + 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
    const events = [
      { type: "message_start", message: { role: "assistant", provider: "anthropic", model: "claude" } },
      { type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage: usage(1000, 200, 0.25) } },
      { type: "message_end", message: { role: "user", usage: usage(9, 9, 9) } },
      { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "overloaded", usage: usage(5, 0, 0.01) } },
      { type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { ...usage(500, 100, 0.125), cost: "bogus" } } },
      { type: "agent_settled", aborted: false },
    ];
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' ${events.map(event => `'${JSON.stringify(event)}'`).join(" ")}\n`);
    chmodSync(fakePi, 0o755);
    const path = join(dir, "board.sqlite");
    let board = new Board(path);
    const card = board.createCard({ title: "Usage", body: "", repo });
    board.setStatus(card.id, "ready");
    // Simulate an attempt recorded before usage tracking existed.
    const legacy = board.claim(card.id);
    board.finish(legacy.id, "failed", "old");
    board.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE runs SET inputTokens=NULL, outputTokens=NULL, cacheReadTokens=NULL, cacheWriteTokens=NULL, cost=NULL WHERE id=?").run(legacy.id);
    db.close();
    board = new Board(path);
    const worker = new Worker(board, join(dir, "data"), fakePi);
    const run = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(run.id)?.status === "review");
    const recorded = board.getRun(run.id)!;
    assert.deepEqual([recorded.inputTokens, recorded.outputTokens, recorded.cacheReadTokens, recorded.cacheWriteTokens], [1505, 300, 300, 30]);
    assert.ok(Math.abs(recorded.cost! - 0.26) < 1e-9, "user messages and malformed cost are ignored");
    assert.equal(board.getRun(legacy.id)?.cost, null, "older attempts are not reported as free");
    const total = board.getCard(card.id)!;
    assert.ok(Math.abs(total.cost! - 0.26) < 1e-9);
    assert.equal(total.inputTokens, 1505);
    assert.equal(total.usageIncomplete, 1, "card total flags the unrecorded older attempt");
    assert.ok(Math.abs(board.listBoards()[0].cost24h - 0.26) < 1e-9);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("card runs and conflict repairs pass their resolved Pi model and thinking level before the prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), data = join(dir, "data"), fakePi = join(dir, "pi-fake"), argsFile = join(dir, "args.txt");
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`);
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, data, fakePi);
    const card = board.createCard({ title: "Models", body: "", repo });
    board.setStatus(card.id, "ready");
    const args = () => readFileSync(argsFile, "utf8").split("\n").slice(0, -1);
    const unset = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(unset.id)?.status === "review");
    assert.deepEqual(args().slice(0, 5), ["--mode", "json", "--session-id", unset.sessionId, "--"]);
    board.updateSettings({ agentModels: { work: { model: "anthropic/claude-sonnet-4-5", thinking: "medium" }, conflict: { model: "anthropic/claude-sonnet-4-5", thinking: "" }, review: { model: "", thinking: "" } } });
    board.setAgentModels(board.listBoards()[0].id, { conflict: { model: "openai-codex/gpt-5.5", thinking: "xhigh" } });
    const work = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(work.id)?.status === "review");
    assert.deepEqual(args().slice(0, 9), ["--mode", "json", "--session-id", work.sessionId, "--model", "anthropic/claude-sonnet-4-5", "--thinking", "medium", "--"]);
    board.recordMergeFailure(card.id, ["README.md"], "conflict");
    const conflict = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(conflict.id)?.status === "review");
    assert.deepEqual(args().slice(0, 9), ["--mode", "json", "--session-id", conflict.sessionId, "--model", "openai-codex/gpt-5.5", "--thinking", "xhigh", "--"]);
    assert.match(args().slice(9).join("\n"), /merge-conflict repair attempt/);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
