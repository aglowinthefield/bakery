import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Board } from "../server/board.js";
import { PoisonedSessionError, Worker } from "../server/worker.js";
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

test("a multi-megabyte Pi event line (a screenshot read back) does not kill the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), fakePi = join(dir, "pi-fake"), big = join(dir, "big.json");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    writeFileSync(big, JSON.stringify({ type: "turn_end", message: { stopReason: "stop", content: [{ type: "image", data: "A".repeat(3_000_000) }] } }) + "\n");
    writeFileSync(fakePi, `#!/bin/sh\ncat '${big}'\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`);
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, join(dir, "data"), fakePi);
    const card = board.createCard({ title: "Big event", body: "", repo });
    board.setStatus(card.id, "ready");
    const run = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(run.id)?.status !== "running");
    assert.equal(board.getRun(run.id)?.status, "review", board.getRun(run.id)?.error ?? "");
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a run keeps the agent's final message as its markdown report, separate from the transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), fakePi = join(dir, "pi-fake");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    const events = [
      { type: "turn_start" },
      { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Reading the code." }, { type: "toolCall", name: "read" }] } },
      { type: "tool_execution_start", toolCallId: "a", toolName: "read" },
      { type: "tool_execution_end", toolCallId: "a", isError: false },
      { type: "turn_end" },
      { type: "turn_start" },
      { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "**Answer: yes.**\n\n- one\n- two\n" }] } },
      { type: "turn_end" },
      { type: "agent_settled", aborted: false },
    ];
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' ${events.map(event => `'${JSON.stringify(event)}'`).join(" ")}\n`);
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, join(dir, "data"), fakePi);
    const card = board.createCard({ title: "Research", body: "", repo });
    board.setStatus(card.id, "ready");
    const run = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(run.id)?.status === "review");
    assert.equal(board.getRun(run.id)!.report, "**Answer: yes.**\n\n- one\n- two");
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
    assert.match(board.getRun(recovered.id)!.output, /SECRET_PROVIDER_DETAIL/);
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' '${errorEvent}' '{"type":"agent_settled","aborted":false}'\necho 'SECRET_STDERR' >&2\n`);
    const terminal = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(terminal.id)?.status !== "running");
    assert.equal(board.getRun(terminal.id)?.status, "failed");
    assert.match(board.getRun(terminal.id)!.error!, /provider request failed \(HTTP 503\)/i);
    assert.match(board.getRun(terminal.id)!.error!, /SECRET_PROVIDER_DETAIL.*stderr: SECRET_STDERR/);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a run Anthropic blocks as output duplication is retried once, without narration, in a fresh session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), fakePi = join(dir, "pi-fake"), calls = join(dir, "calls");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    const blocked = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs. To learn more, visit https://www.anthropic.com/legal/commercial-terms." } });
    // Records each call's session id and prompt, then fails with the block every time.
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n%s\\n---\\n' "$4" "$6" >> '${calls}'\nprintf '%s\\n' '${blocked.replace(/'/g, "'\\''")}' '{"type":"agent_settled","aborted":false}'\n`);
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, join(dir, "data"), fakePi);
    const card = board.createCard({ title: "Blocked", body: "", repo });
    board.setStatus(card.id, "ready");
    const first = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.listRuns(card.id).length === 2 && board.listRuns(card.id).every(run => run.status !== "running"));
    await new Promise(resolve => setTimeout(resolve, 300));
    const runs = board.listRuns(card.id);
    assert.equal(runs.length, 2, "a second block does not retry again");
    const retry = runs.find(run => run.id !== first.id)!;
    assert.equal(retry.attempt, 2);
    assert.notEqual(retry.sessionId, first.sessionId);
    const [firstCall, retryCall] = readFileSync(calls, "utf8").split("---\n");
    assert.match(firstCall, /write one plain sentence/);
    assert.doesNotMatch(retryCall, /write one plain sentence/);
    assert.match(retryCall, /Do not narrate before tool calls/);
    assert.match(retryCall, new RegExp(`^${retry.sessionId}\n`));
    assert.match(board.getRun(first.id)!.output, /Bakery will retry once in a fresh session without the narration instruction/);
    assert.match(retry.output, /Retry of attempt 1/);
    assert.ok(board.listCardEvents(card.id).some(event => /Attempt 2 started without the narration instruction/.test(event.reason)));
    assert.equal(board.getCard(card.id)!.status, "failed");
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
test("the agent reviewer's requested changes still reach the run after a failed attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), data = join(dir, "data"), fakePi = join(dir, "pi-fake"), promptFile = join(dir, "prompt.txt");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s' "$6" > '${promptFile}'\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`);
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, data, fakePi);
    const card = board.createCard({ title: "Test", body: "", repo });
    board.setStatus(card.id, "ready");
    const first = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(first.id)?.status === "review");
    const db = new DatabaseSync(join(dir, "board.sqlite"));
    db.prepare("INSERT INTO auto_review_jobs(cardId,runId,state,startedAt,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,cost,changes) VALUES (?,?,'needs_human',?,0,0,0,0,0,?)")
      .run(card.id, first.id, new Date().toISOString(), JSON.stringify([{ path: "README.md", comment: "Compute the limit once" }]));
    db.close();
    // The next attempt dies before Pi starts (a rebase conflict, say).
    board.finish(board.claim(card.id, "manual").id, "failed", "Rebase conflicted");
    const retry = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(retry.id)?.status === "review");
    assert.equal(retry.attempt, 3);
    assert.match(readFileSync(promptFile, "utf8"), /Compute the limit once/);
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

test("an agent run is terminated after 60 minutes, not earlier", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), fakePi = join(dir, "pi-fake");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    writeFileSync(fakePi, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, join(dir, "data"), fakePi);
    const card = board.createCard({ title: "Timeout", body: "", repo });
    board.setStatus(card.id, "ready");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const run = worker.start(board.getCard(card.id)!);
    t.mock.timers.tick(60 * 60 * 1000 - 1);
    t.mock.timers.reset();
    assert.equal(board.getRun(run.id)?.status, "running");
    const other = board.createCard({ title: "Timeout 2", body: "", repo });
    board.setStatus(other.id, "ready");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const second = worker.start(board.getCard(other.id)!);
    t.mock.timers.tick(60 * 60 * 1000);
    t.mock.timers.reset();
    await waitFor(() => board.getRun(second.id)?.status === "failed");
    assert.match(board.getRun(second.id)!.error!, /Bakery sent SIGTERM: 60-minute run timeout/);
    worker.stop(run.id);
    await waitFor(() => board.getRun(run.id)?.status === "failed");
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
    board.updateSettings({ agentModels: { work: { model: "anthropic/claude-sonnet-4-5", thinking: "medium" }, conflict: { model: "anthropic/claude-sonnet-4-5", thinking: "" }, review: { model: "", thinking: "" }, draft: { model: "", thinking: "" } } });
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

function worktrunkFixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), fakePi = join(dir, "pi-fake"), fakeWt = join(dir, "wt-fake"), log = join(dir, "wt.log");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  // Pi only settles if the pre-start hook already ran in its worktree.
  writeFileSync(fakePi, `#!/bin/sh\necho pi >> '${log}'\n[ -f hooked ] || exit 1\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`);
  writeFileSync(fakeWt, `#!/bin/sh\n[ "$1" = --version ] && { echo "wt v0.81.0"; exit 0; }\necho "$3 $4" >> '${log}'\nif [ "$4" = pre-start ]; then\n  [ -f '${join(dir, "fail")}' ] && { echo "npm ci failed"; exit 3; }\n  touch "$2/hooked"\nfi\n`);
  chmodSync(fakePi, 0o755); chmodSync(fakeWt, 0o755);
  const board = new Board(join(dir, "board.sqlite"));
  const card = board.createCard({ title: "Hooks", body: "", repo });
  board.setStatus(card.id, "ready");
  return { dir, repo, fakePi, fakeWt, log, board, card };
}

test("a new card worktree runs Worktrunk pre-start hooks before Pi, and a retry does not run them again", async () => {
  const { dir, fakePi, fakeWt, log, board, card } = worktrunkFixture();
  try {
    const worker = new Worker(board, join(dir, "data"), fakePi, fakeWt);
    const run = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(run.id)?.status === "review");
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["hook pre-start", "hook post-start", "pi"]);
    assert.match(board.getRun(run.id)!.output, /Worktrunk hooks done/);
    board.setStatus(card.id, "ready");
    const retry = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(retry.id)?.status === "review");
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["hook pre-start", "hook post-start", "pi", "pi"]);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed Worktrunk pre-start hook fails the attempt and removes the fresh worktree so a retry runs hooks again", async () => {
  const { dir, repo, fakePi, fakeWt, log, board, card } = worktrunkFixture();
  try {
    writeFileSync(join(dir, "fail"), "");
    const worker = new Worker(board, join(dir, "data"), fakePi, fakeWt);
    const run = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(run.id)?.status === "failed");
    const failed = board.getRun(run.id)!;
    assert.match(failed.error ?? "", /Worktrunk pre-start hooks failed \(3\)/);
    assert.match(failed.output, /npm ci failed/);
    assert.equal(readFileSync(log, "utf8").trim(), "hook pre-start");
    assert.equal(execFileSync("git", ["-C", repo, "branch", "--list", `bakery/${card.id}`], { encoding: "utf8" }).trim(), "");
    assert.throws(() => readFileSync(join(dir, "data", "worktrees", card.id, "README.md")));
    rmSync(join(dir, "fail"));
    board.setStatus(card.id, "ready");
    const retry = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(retry.id)?.status === "review");
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a `wt` binary that is not Worktrunk is ignored", async () => {
  const { dir, fakePi, log, board, card } = worktrunkFixture();
  try {
    const other = join(dir, "wiredtiger-wt");
    writeFileSync(other, `#!/bin/sh\necho "WiredTiger 11.2"\n`);
    chmodSync(other, 0o755);
    writeFileSync(fakePi, `#!/bin/sh\necho pi >> '${log}'\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`);
    const run = new Worker(board, join(dir, "data"), fakePi, other).start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(run.id)?.status === "review");
    assert.equal(readFileSync(log, "utf8").trim(), "pi");
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stopping a run during Worktrunk pre-start hooks fails it without starting Pi", async () => {
  const { dir, fakePi, log, board, card } = worktrunkFixture();
  try {
    const slowWt = join(dir, "wt-slow");
    writeFileSync(slowWt, `#!/bin/sh\n[ "$1" = --version ] && { echo "wt v0.81.0"; exit 0; }\necho "$3 $4" >> '${log}'\nexec sleep 5\n`);
    chmodSync(slowWt, 0o755);
    const worker = new Worker(board, join(dir, "data"), fakePi, slowWt);
    const run = worker.start(board.getCard(card.id)!);
    await waitFor(() => readFileSync(log, { encoding: "utf8", flag: "a+" }).includes("pre-start"));
    worker.stop(run.id);
    await waitFor(() => board.getRun(run.id)?.status === "failed");
    assert.match(board.getRun(run.id)!.error ?? "", /Bakery sent SIGTERM: manual stop/);
    assert.equal(readFileSync(log, "utf8").trim(), "hook pre-start");
    assert.equal(worker.activeCount, 0);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a local-mode card worktree starts from origin/main when local main is behind it, and from main when ahead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), remote = join(dir, "origin.git"), other = join(dir, "other"), fakePi = join(dir, "pi-fake");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    git(cwd, "add", file);
    git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", file);
  };
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commit(repo, "README.md");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "main");
    execFileSync("git", ["clone", "-q", remote, other]);
    commit(other, "upstream.txt");
    git(other, "push", "-q", "origin", "main");
    writeFileSync(fakePi, "#!/bin/sh\nexit 0\n");
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), data = join(dir, "data"), worker = new Worker(board, data, fakePi);
    const behind = board.createCard({ title: "Behind", body: "", repo });
    board.setStatus(behind.id, "ready");
    const first = worker.start(board.getCard(behind.id)!);
    assert.equal(git(join(data, "worktrees", behind.id), "rev-parse", "HEAD"), git(other, "rev-parse", "HEAD"), "starts from fetched origin/main");
    await waitFor(() => board.getRun(first.id)?.status !== "running");

    git(repo, "merge", "-q", "--ff-only", "origin/main");
    commit(repo, "local.txt");
    const ahead = board.createCard({ title: "Ahead", body: "", repo });
    board.setStatus(ahead.id, "ready");
    const second = worker.start(board.getCard(ahead.id)!);
    assert.equal(git(join(data, "worktrees", ahead.id), "rev-parse", "HEAD"), git(repo, "rev-parse", "main"), "keeps unpushed local commits");
    await waitFor(() => board.getRun(second.id)?.status !== "running");

    git(repo, "remote", "set-url", "origin", join(dir, "missing.git"));
    const offline = board.createCard({ title: "Offline", body: "", repo });
    board.setStatus(offline.id, "ready");
    const third = worker.start(board.getCard(offline.id)!);
    assert.equal(git(join(data, "worktrees", offline.id), "rev-parse", "HEAD"), git(repo, "rev-parse", "main"));
    assert.match(board.getRun(third.id)!.output, /git fetch origin failed/);
    await waitFor(() => board.getRun(third.id)?.status !== "running");
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("starts queued during a drain persist and are taken once, oldest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-queue-"));
  try {
    const path = join(dir, "board.sqlite");
    const board = new Board(path);
    const a = board.createCard({ title: "A", body: "", repo: dir }), b = board.createCard({ title: "B", body: "", repo: dir });
    assert.throws(() => board.queueStart(a.id), /Move this card to Ready/);
    board.setStatus(a.id, "ready"); board.setStatus(b.id, "ready");
    board.queueStart(b.id); board.queueStart(a.id); board.queueStart(b.id);
    board.close();
    const reopened = new Board(path);
    assert.equal(reopened.isStartQueued(a.id), true);
    assert.equal(reopened.getCard(a.id)?.startQueued, true);
    assert.equal(reopened.cancelQueuedStart(a.id), true);
    assert.equal(reopened.cancelQueuedStart(a.id), false);
    assert.equal(reopened.getCard(a.id)?.startQueued, false);
    assert.deepEqual(reopened.takeQueuedStarts(), [b.id]);
    reopened.queueStart(a.id);
    assert.deepEqual(reopened.takeQueuedStarts(), [a.id]);
    assert.deepEqual(reopened.takeQueuedStarts(), []);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A fake Pi whose behavior is chosen per call from a script file: one line per call, `ok`, or an error message.
// Each call records its session id and appends to README.md once, so tests can see edits survive across sessions.
function fakeProviderPi(dir: string, script: string[]) {
  const pi = join(dir, "pi-fake"), calls = join(dir, "calls"), scriptFile = join(dir, "script");
  writeFileSync(scriptFile, script.join("\n") + "\n");
  writeFileSync(join(dir, "count"), "0");
  writeFileSync(pi, `#!/bin/sh
n=$(( $(cat '${dir}/count') + 1 )); printf '%s' "$n" > '${dir}/count'
printf '%s\\t%s\\n' "$4" "$(printf '%s' "$6" | head -c 100000 | tr '\\n' ' ')" >> '${calls}'
printf 'edit from call %s\\n' "$n" >> README.md
line=$(sed -n "\${n}p" '${scriptFile}')
if [ "$line" = ok ]; then printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}' '{"type":"agent_settled","aborted":false}'
else printf '%s\\n' "{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"stopReason\\":\\"error\\",\\"errorMessage\\":$line}}" '{"type":"agent_settled","aborted":false}'; fi
`);
  chmodSync(pi, 0o755);
  return { pi, calls: () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map(line => { const [session, ...prompt] = line.split("\t"); return { session, prompt: prompt.join("\t") }; }) };
}
const rejectedHistory = JSON.stringify(`400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.105: role 'system' must precede an 'assistant' message or end the array; the directive-only form (content: [] with output_config) is accepted at any position"},"request_id":"req_x"}`);

function providerFixture(script: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  const fake = fakeProviderPi(dir, script);
  const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, join(dir, "data"), fake.pi);
  const card = board.createCard({ title: "Verify", body: "Add the flag", repo });
  board.setStatus(card.id, "ready");
  const settled = () => board.listRuns(card.id).every(run => run.status !== "running");
  return { dir, repo, board, worker, card, fake, settled, worktree: join(dir, "data", "worktrees", card.id) };
}

test("a rejected message history fails as a provider failure, then recovers once in a fresh session that keeps the worktree edits", async () => {
  const f = providerFixture([rejectedHistory, "ok"]);
  try {
    const first = f.worker.start(f.board.getCard(f.card.id)!);
    await waitFor(() => f.board.listRuns(f.card.id).length === 2 && f.settled());
    const [recovery, rejected] = f.board.listRuns(f.card.id);
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.failureKind, "invalid-history");
    assert.match(rejected.error!, /^Provider request failed \(HTTP 400\).*invalid-history.*; Pi exited \(0\); settled/s, "the provider failure leads; the clean exit code is only detail");
    assert.equal(recovery.status, "review");
    assert.equal(recovery.failureKind, null);
    assert.equal(recovery.recoveryOf, first.id);
    assert.notEqual(recovery.sessionId, rejected.sessionId);
    assert.equal(recovery.sessionId, `bakery-${f.card.id}-2`);
    const calls = f.fake.calls();
    assert.equal(calls[0].session, rejected.sessionId);
    assert.equal(calls[1].session, recovery.sessionId);
    assert.match(calls[1].prompt, /rejected by the model provider \(invalid message history\)/);
    assert.match(calls[1].prompt, /Do not discard or reset existing changes/);
    assert.match(calls[1].prompt, /Add the flag/, "card context is repeated in the fresh session");
    // The first run's edit is still in the same worktree when the recovery run adds its own.
    assert.equal(readFileSync(join(f.worktree, "README.md"), "utf8"), "fixture\nedit from call 1\nedit from call 2\n");
    assert.match(recovery.output, /Fresh-session recovery of attempt 1/);
    assert.ok(f.board.listCardEvents(f.card.id).some(event => /Attempt 2 started in a fresh session to recover from attempt 1's rejected session history \(automatic\)/.test(event.reason)));
    // The rejected run's log stays as evidence.
    assert.match(f.board.getRun(first.id)!.error!, /messages\.105/);
    // Later runs resume the recovery session, not the rejected one.
    const next = f.board.claim(f.card.id);
    assert.equal(next.sessionId, recovery.sessionId);
  } finally { f.board.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("a recovery that is rejected again stops; ordinary retry refuses the poisoned session; manual recover runs again", async () => {
  const f = providerFixture([rejectedHistory, rejectedHistory, rejectedHistory, "ok"]);
  try {
    f.worker.start(f.board.getCard(f.card.id)!);
    await waitFor(() => f.board.listRuns(f.card.id).length === 2 && f.settled());
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(f.board.listRuns(f.card.id).length, 2, "no third automatic attempt");
    assert.equal(f.board.getCard(f.card.id)!.status, "failed");
    assert.ok(f.board.listCardEvents(f.card.id).some(event => /fresh-session recovery, was rejected by the provider again; Bakery will not recover automatically a second time/.test(event.reason)));
    assert.throws(() => f.worker.start(f.board.getCard(f.card.id)!), (error: unknown) => error instanceof PoisonedSessionError && /recover this card in a fresh session/.test(error.message));
    assert.equal(f.board.listRuns(f.card.id).length, 2, "the refused retry claimed nothing");
    const manual = f.worker.recover(f.card.id);
    assert.equal(manual.attempt, 3);
    assert.equal(manual.sessionId, `bakery-${f.card.id}-3`);
    await waitFor(() => f.board.listRuns(f.card.id).length === 3 && f.settled());
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(f.board.listRuns(f.card.id).length, 3, "a rejected manual recovery is not followed by another automatic one");
    assert.equal(f.board.getRun(manual.id)!.failureKind, "invalid-history");
    // Evidence is kept: every attempt's error and every edit is still there.
    assert.equal(readFileSync(join(f.worktree, "README.md"), "utf8"), "fixture\nedit from call 1\nedit from call 2\nedit from call 3\n");
    // A fourth call finally succeeds, by hand again.
    const last = f.worker.recover(f.card.id);
    await waitFor(() => f.board.getRun(last.id)!.status !== "running");
    assert.equal(f.board.getRun(last.id)!.status, "review");
  } finally { f.board.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("only a rejected-history failure can be recovered", async () => {
  const f = providerFixture([JSON.stringify("503 upstream unavailable")]);
  try {
    f.worker.start(f.board.getCard(f.card.id)!);
    await waitFor(() => f.settled());
    assert.throws(() => f.worker.recover(f.card.id), /Only a failed card whose latest run was rejected/);
  } finally { f.board.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

for (const [name, message, kind] of [
  ["transient", "503 upstream unavailable", "transient"],
  ["billing", `400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}`, "billing"],
  ["auth", `401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`, "auth"],
  ["other 400", `400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 999999 > 128000"}}`, "invalid-request"],
] as const) {
  test(`a ${name} provider failure is classified, not recovered automatically, and an ordinary retry resumes the same session`, async () => {
    const f = providerFixture([JSON.stringify(message), "ok"]);
    try {
      const first = f.worker.start(f.board.getCard(f.card.id)!);
      await waitFor(() => f.settled());
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(f.board.listRuns(f.card.id).length, 1, "no automatic second run");
      assert.equal(f.board.getRun(first.id)!.status, "failed");
      assert.equal(f.board.getRun(first.id)!.failureKind, kind);
      assert.match(f.board.getRun(first.id)!.error!, /^Provider request failed/);
      const retry = f.worker.start(f.board.getCard(f.card.id)!);
      assert.equal(retry.sessionId, first.sessionId);
      await waitFor(() => f.board.getRun(retry.id)!.status !== "running");
      assert.equal(f.board.getRun(retry.id)!.status, "review");
      assert.equal(f.board.getRun(retry.id)!.recoveryOf, null);
    } finally { f.board.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test("a clean run records no failure kind and reads as a success", async () => {
  const f = providerFixture(["ok"]);
  try {
    const run = f.worker.start(f.board.getCard(f.card.id)!);
    await waitFor(() => f.settled());
    const done = f.board.getRun(run.id)!;
    assert.equal(done.status, "review");
    assert.equal(done.error, null);
    assert.equal(done.failureKind, null);
  } finally { f.board.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("restart-time migration classifies provider failures already recorded, so the affected card can be recovered", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  try {
    const path = join(dir, "board.sqlite");
    const first = new Board(path);
    const card = first.createCard({ title: "Old", body: "", repo: dir });
    first.close();
    const db = new DatabaseSync(path);
    db.exec("ALTER TABLE runs DROP COLUMN failureKind; ALTER TABLE runs DROP COLUMN recoveryOf");
    const error = `Pi exited (0); settled; Provider request failed (HTTP 400): ${JSON.parse(rejectedHistory)}; stderr: x`;
    db.prepare("INSERT INTO runs(id, cardId, attempt, status, sessionId, error, startedAt) VALUES ('r1', ?, 1, 'failed', 's', ?, '2026-01-01')").run(card.id, error);
    db.prepare("INSERT INTO runs(id, cardId, attempt, status, sessionId, error, startedAt) VALUES ('r2', ?, 2, 'failed', 's', 'Pi exited (143)', '2026-01-02')").run(card.id);
    db.close();
    const board = new Board(path);
    assert.equal(board.getRun("r1")!.failureKind, "invalid-history");
    assert.equal(board.getRun("r2")!.failureKind, null);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const outputBlocked = JSON.stringify("This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.");

test("a recovery's spent budget survives a narration-free retry: invalid-history, recovery, output-blocked, retry, invalid-history stops", async () => {
  const f = providerFixture([rejectedHistory, outputBlocked, rejectedHistory, "ok"]);
  try {
    f.worker.start(f.board.getCard(f.card.id)!);
    await waitFor(() => f.board.listRuns(f.card.id).length === 3 && f.settled());
    await new Promise(resolve => setTimeout(resolve, 400));
    const runs = f.board.listRuns(f.card.id);
    assert.equal(runs.length, 3, "no second automatic recovery");
    assert.deepEqual(runs.map(run => run.failureKind), ["invalid-history", "output-blocked", "invalid-history"]);
    assert.ok(runs[0].recoveryOf, "the narration-free retry keeps the recovery lineage");
    assert.equal(f.board.getCard(f.card.id)!.status, "failed");
    assert.ok(f.board.listCardEvents(f.card.id).some(event => /will not recover automatically a second time/.test(event.reason)));
  } finally { f.board.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("CI feedback a run consumed is restored when its narration-free replacement is rejected, then reaches the recovery run", async () => {
  const f = providerFixture([outputBlocked, rejectedHistory, "ok"]);
  try {
    f.board.recordCiFailure(f.card.id, "abc1234", "FAILED unit tests: SENTINEL_CI_FAILURE");
    f.worker.start(f.board.getCard(f.card.id)!);
    await waitFor(() => f.board.listRuns(f.card.id).length === 3 && f.settled());
    const [recovery, , first] = f.board.listRuns(f.card.id);
    assert.equal(first.failureKind, "output-blocked");
    assert.equal(recovery.status, "review");
    const prompts = f.fake.calls();
    assert.match(prompts[0].prompt, /SENTINEL_CI_FAILURE/);
    assert.match(prompts[2].prompt, /SENTINEL_CI_FAILURE/, "the recovery run is handed the same CI failures");
  } finally { f.board.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("later runs resume the session of the latest run, including a successful narration-free replacement after a recovery", async () => {
  const f = providerFixture([rejectedHistory, outputBlocked, "ok"]);
  try {
    f.worker.start(f.board.getCard(f.card.id)!);
    await waitFor(() => f.board.listRuns(f.card.id).length === 3 && f.settled());
    const [replacement, , original] = f.board.listRuns(f.card.id);
    assert.equal(replacement.status, "review");
    assert.equal(replacement.sessionId, `bakery-${f.card.id}-3`);
    assert.notEqual(replacement.sessionId, original.sessionId);
    assert.equal(f.board.claim(f.card.id).sessionId, replacement.sessionId);
  } finally { f.board.close(); rmSync(f.dir, { recursive: true, force: true }); }
});
