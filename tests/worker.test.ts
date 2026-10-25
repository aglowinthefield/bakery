import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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

test("a Pi settlement requests review; retry uses the same card worktree and session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-worker-"));
  const repo = join(dir, "repo"), data = join(dir, "data"), fakePi = join(dir, "pi-fake");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    writeFileSync(fakePi, "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"turn_start\"}' '{\"type\":\"turn_end\"}' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"Worked offline.\"}}' '{\"type\":\"agent_settled\",\"aborted\":false}'\n");
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, data, fakePi);
    const card = board.createCard({ title: "Test", body: "No network", repo });
    board.setStatus(card.id, "ready");
    const first = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(first.id)?.status === "review");
    assert.match(board.getRun(first.id)!.output, /Worked offline/);
    const next = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(next.id)?.status === "review");
    assert.equal(next.attempt, 2);
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

async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Worker did not finish");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
