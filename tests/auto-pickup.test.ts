import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { Worker } from "../server/worker.js";
import { AutoPickup } from "../server/auto-pickup.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakery-pickup-")), repo = join(dir, "repo"), data = join(dir, "data"), fakePi = join(dir, "fake-pi");
  mkdirSync(repo); execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  writeFileSync(fakePi, `#!/bin/sh\nwhile [ ! -f '${join(dir, "release")}' ]; do sleep 0.05; done\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`); chmodSync(fakePi, 0o755);
  const board = new Board(join(dir, "board.sqlite")), repoBoard = board.addRepo(repo);
  const worker = new Worker(board, data, fakePi), pickup = new AutoPickup(board, worker);
  const card = (title: string) => board.setStatus(board.createCard({ title, body: "Small change", repo }).id, "ready");
  return { dir, repo, board, repoBoard, worker, pickup, card, release: () => writeFileSync(join(dir, "release"), "ok"), close: async () => { await worker.shutdown(); board.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw new Error("Timed out waiting for fake Pi"); await new Promise(resolve => setTimeout(resolve, 25)); }
}

test("auto-pickup is opt-in, starts oldest Ready cards, and counts manual runs toward concurrency", async () => {
  const item = fixture();
  try {
    const manual = item.card("Manual"), first = item.card("First"), second = item.card("Second"), third = item.card("Third");
    item.worker.start(manual);
    item.pickup.tick();
    assert.equal(item.board.listRuns(first.id).length, 0, "disabled boards do not start Pi");
    item.board.setAutoPickup(item.repoBoard.id, true, 2);
    item.pickup.tick();
    assert.equal(item.board.listRuns(first.id)[0]?.status, "running");
    assert.equal(item.board.listRuns(first.id)[0]?.startedBy, "auto");
    assert.equal(item.board.listRuns(manual.id)[0]?.startedBy, "manual");
    assert.equal(item.board.listRuns(second.id).length, 0, "manual run occupies one of two slots");
    assert.throws(() => item.worker.start(second), /2-run concurrency limit/, "manual start cannot bypass the shared cap");
    assert.equal(item.board.listRuns(second.id).length, 0);
    item.release();
    await waitFor(() => item.board.getCard(manual.id)?.status === "review" && item.board.getCard(first.id)?.status === "review");
    item.pickup.tick();
    assert.equal(item.board.listRuns(second.id)[0]?.status, "running");
    assert.equal(item.board.listRuns(third.id)[0]?.status, "running");
    await waitFor(() => item.board.getCard(second.id)?.status === "review" && item.board.getCard(third.id)?.status === "review");
    item.pickup.tick();
    assert.equal(item.board.autoStartsToday(item.repo), 3);
    assert.equal(item.board.listRuns(first.id).length, 1, "reviewed cards never restart automatically");
  } finally { await item.close(); }
});

test("turning off pickup blocks new runs but leaves already running Pi alone", async () => {
  const item = fixture();
  try {
    const first = item.card("First"), second = item.card("Second");
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    item.pickup.tick();
    item.board.setAutoPickup(item.repoBoard.id, false, 1);
    item.pickup.tick();
    assert.equal(item.board.getCard(first.id)?.status, "running");
    assert.equal(item.board.listRuns(second.id).length, 0);
    item.release();
    await waitFor(() => item.board.getCard(first.id)?.status === "review");
    item.pickup.tick();
    assert.equal(item.board.listRuns(second.id).length, 0);
  } finally { await item.close(); }
});

test("a failed automatic run pauses pickup before another card starts", async () => {
  const item = fixture();
  try {
    writeFileSync(join(item.dir, "fake-pi"), "#!/bin/sh\nexit 2\n");
    const first = item.card("Will fail"), second = item.card("Must wait");
    item.board.setAutoPickup(item.repoBoard.id, true, 1);
    item.pickup.tick();
    await waitFor(() => item.board.getCard(first.id)?.status === "failed");
    item.pickup.tick();
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupEnabled, false);
    assert.match(item.board.getBoard(item.repoBoard.id)?.autoPickupError ?? "", /automatic run failed/i);
    assert.equal(item.board.listRuns(second.id).length, 0);
  } finally { await item.close(); }
});

test("a rolling six-start limit prevents unbounded model spend and persists after reopening", async () => {
  const item = fixture();
  try {
    item.release();
    item.board.setAutoPickup(item.repoBoard.id, true, 2);
    for (let i = 0; i < 7; i++) item.card(`Task ${i}`);
    for (let i = 0; i < 6; i += 2) { item.pickup.tick(); await waitFor(() => item.board.autoStartsToday(item.repo) === i + 2 && item.board.runningCount(item.repo) === 0); }
    item.pickup.tick();
    assert.equal(item.board.autoStartsToday(item.repo), 6);
    assert.equal(item.board.listCards(item.repo).filter(card => card.status === "ready").length, 1);
    const capped = item.board.getBoard(item.repoBoard.id)!;
    assert.equal(capped.pickupDailyLimit, 6);
    assert.equal(capped.autoPickupStarts, 6);
    const oldest = item.board.listRuns(item.board.listCards(item.repo).find(card => card.title === "Task 0")!.id)[0].startedAt;
    assert.equal(capped.autoPickupNextAt, new Date(Date.parse(oldest) + 86_400_000).toISOString());
    const second = new Board(join(item.dir, "board.sqlite"));
    assert.equal(second.autoStartsToday(item.repo), 6);
    assert.equal(second.listAutoPickupCandidates().length, 0);
    assert.equal(second.getBoard(item.repoBoard.id)?.autoPickupNextAt, capped.autoPickupNextAt);
    assert.throws(() => second.setAutoPickup(item.repoBoard.id, true, 2, 0), /daily.*limit/i);
    second.setAutoPickup(item.repoBoard.id, true, 2, 99);
    assert.equal(second.getBoard(item.repoBoard.id)?.pickupDailyLimit, 99);
    assert.equal(second.listAutoPickupCandidates().length, 1);
    assert.throws(() => second.resetAutoPickupLimit(item.repoBoard.id), /limit|enabled/i);
    assert.throws(() => second.setAutoPickup(item.repoBoard.id, true, 2, 100), /daily.*limit/i);
    second.setAutoPickup(item.repoBoard.id, true, 2, 6);
    second.close();
  } finally { await item.close(); }
});

test("a start in the same millisecond as a reset counts against the new limit", async () => {
  const item = fixture();
  mock.timers.enable({ apis: ["Date"], now: new Date() });
  try {
    const first = item.card("Before reset"), second = item.card("After reset"), third = item.card("Blocked");
    item.board.setAutoPickup(item.repoBoard.id, true, 2, 1);
    const before = item.board.claim(first.id, "auto");
    item.board.finish(before.id, "review");
    item.board.resetAutoPickupLimit(item.repoBoard.id);
    const after = item.board.claim(second.id, "auto");
    assert.equal(after.startedAt, before.startedAt);
    item.board.finish(after.id, "review");
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupStarts, 1);
    assert.throws(() => item.board.claim(third.id, "auto"), /not eligible/);
  } finally { mock.timers.reset(); await item.close(); }
});

test("an explicit reset clears the rolling count but retains run history and permits another start", async () => {
  const item = fixture();
  try {
    item.release();
    item.board.setAutoPickup(item.repoBoard.id, true, 2, 1);
    const first = item.card("First"), second = item.card("After reset");
    item.pickup.tick();
    await waitFor(() => item.board.getCard(first.id)?.status === "review");
    item.pickup.tick();
    assert.equal(item.board.getCard(second.id)?.status, "ready");
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupStarts, 1);
    assert.throws(() => item.board.resetAutoPickupLimit("missing"), /Board not found/);
    item.board.resetAutoPickupLimit(item.repoBoard.id);
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupStarts, 0);
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupNextAt, null);
    assert.equal(item.board.listRuns(first.id).length, 1, "reset does not erase attempts");
    item.pickup.tick();
    await waitFor(() => item.board.getCard(second.id)?.status === "review");
    assert.equal(item.board.getBoard(item.repoBoard.id)?.autoPickupStarts, 1);
  } finally { await item.close(); }
});

test("a second Board connection does not interrupt live runs; explicit server recovery does", async () => {
  const item = fixture();
  try {
    const card = item.card("Active");
    item.worker.start(card);
    const second = new Board(join(item.dir, "board.sqlite"));
    assert.equal(second.getCard(card.id)?.status, "running");
    item.release();
    await waitFor(() => item.board.getCard(card.id)?.status === "review");
    second.close();
    const afterRestart = new Board(join(item.dir, "board.sqlite"));
    const another = item.card("Interrupted");
    item.worker.start(another);
    afterRestart.recoverInterruptedRuns(); // Only the exclusive-lock server calls this after startup.
    assert.equal(afterRestart.getCard(another.id)?.status, "interrupted");
    item.release();
    afterRestart.close();
  } finally { await item.close(); }
});
