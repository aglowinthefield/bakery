import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { Worker } from "../server/worker.js";
import { AutoPickup } from "../server/auto-pickup.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakery-deps-")), repo = join(dir, "repo"), other = join(dir, "other"), data = join(dir, "data"), fakePi = join(dir, "fake-pi");
  mkdirSync(repo); execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  writeFileSync(fakePi, `#!/bin/sh\nwhile [ ! -f '${join(dir, "release")}' ]; do sleep 0.05; done\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`); chmodSync(fakePi, 0o755);
  const board = new Board(join(dir, "board.sqlite")), repoBoard = board.addRepo(repo);
  const worker = new Worker(board, data, fakePi), pickup = new AutoPickup(board, worker);
  const card = (title: string, dependsOn?: string[]) => board.setStatus(board.createCard({ title, body: "Small change", repo, dependsOn }).id, "ready");
  return { dir, repo, other, board, repoBoard, worker, pickup, card, release: () => writeFileSync(join(dir, "release"), "ok"), close: async () => { await worker.shutdown(); board.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw new Error("Timed out waiting for fake Pi"); await new Promise(resolve => setTimeout(resolve, 25)); }
}

test("auto-pickup skips a blocked card without spending a slot, and picks it up once its parent is Done", async () => {
  const item = fixture();
  try {
    const parent = item.board.createCard({ title: "Parent", body: "", repo: item.repo });
    const child = item.card("Child", [parent.id]), free = item.card("Free");
    // The blocked child is older and would otherwise go first; with one slot, the free card must still start.
    item.board.updateCard(child.id, { title: child.title, body: child.body, repo: item.repo, priority: 2 });
    assert.deepEqual(item.board.getCard(child.id)!.dependsOn, [parent.id]);
    assert.equal(item.board.getCard(child.id)!.blocked, true);
    assert.equal(item.board.getCard(free.id)!.blocked, false);
    item.board.setAutoPickup(item.repoBoard.id, true, 1, 2);
    assert.deepEqual(item.board.listAutoPickupCandidates().map(candidate => candidate.card.id), [free.id]);
    item.pickup.tick();
    assert.equal(item.board.listRuns(child.id).length, 0, "blocked card did not start");
    assert.equal(item.board.listRuns(free.id)[0]?.status, "running");
    assert.equal(item.board.getBoard(item.repoBoard.id)!.autoPickupEnabled, true, "a blocked card does not pause pickup");
    item.release();
    await waitFor(() => item.board.getCard(free.id)?.status === "review");
    item.pickup.tick();
    assert.equal(item.board.listRuns(child.id).length, 0, "still blocked with a free slot");
    assert.equal(item.board.getBoard(item.repoBoard.id)!.autoPickupStarts, 1, "the blocked card used no daily start");
    item.board.setStatus(parent.id, "done");
    assert.equal(item.board.getCard(child.id)!.blocked, false);
    item.pickup.tick();
    assert.equal(item.board.listRuns(child.id)[0]?.startedBy, "auto");
    await waitFor(() => item.board.getCard(child.id)?.status === "review");
  } finally { await item.close(); }
});

test("manual start of a blocked card is refused naming the unfinished cards; archived parents count as finished", async () => {
  const item = fixture();
  try {
    const done = item.board.setStatus(item.board.createCard({ title: "Finished parent", body: "", repo: item.repo }).id, "done");
    const open = item.card("Open parent");
    const child = item.card("Child", [done.id, open.id]);
    assert.throws(() => item.worker.start(item.board.getCard(child.id)!), (error: Error) =>
      /Waiting on 1 unfinished card: Open parent \(/.test(error.message) && error.message.includes(open.id) && !error.message.includes(done.id));
    assert.throws(() => item.board.claim(child.id), /Waiting on 1 unfinished card/);
    assert.equal(item.board.listRuns(child.id).length, 0, "a refused start consumes no attempt");
    item.board.setStatus(open.id, "done");
    item.board.setArchived(item.repo, [open.id], true);
    assert.equal(item.board.getCard(child.id)!.blocked, false, "archived counts as finished");
    item.worker.start(item.board.getCard(child.id)!);
    assert.equal(item.board.listRuns(child.id)[0]?.status, "running");
    item.release();
    await waitFor(() => item.board.getCard(child.id)?.status === "review");
    // A retry is not gated: the card already has its worktree.
    item.board.setArchived(item.repo, [open.id], false);
    item.board.setStatus(open.id, "ready");
    assert.equal(item.board.getCard(child.id)!.blocked, true);
    const retry = item.board.claim(child.id);
    assert.equal(retry.attempt, 2);
    item.board.finish(retry.id, "review");
  } finally { await item.close(); }
});

test("self-edges, cycles, cross-board and missing dependencies are rejected; removal unblocks", async () => {
  const item = fixture();
  try {
    const a = item.card("A"), b = item.card("B", [a.id]), c = item.card("C", [b.id]);
    assert.throws(() => item.board.addDependency(a.id, a.id), /cannot depend on itself/);
    assert.throws(() => item.board.addDependency(a.id, b.id), /would create a cycle/);
    assert.throws(() => item.board.addDependency(a.id, c.id), /would create a cycle: C already depends on A/);
    assert.throws(() => item.board.addDependency(a.id, "missing"), /Dependency not found/);
    const elsewhere = item.board.createCard({ title: "Elsewhere", body: "", repo: item.other });
    assert.throws(() => item.board.addDependency(a.id, elsewhere.id), /same board/);
    assert.throws(() => item.board.createCard({ title: "Bad", body: "", repo: item.repo, dependsOn: [elsewhere.id] }), /same board/);
    assert.equal(item.board.listCards(item.repo).some(card => card.title === "Bad"), false, "a rejected create leaves no card");
    assert.deepEqual(item.board.getCard(a.id)!.dependsOn, []);
    item.board.addDependency(c.id, a.id);
    assert.deepEqual(item.board.getCard(c.id)!.dependsOn, [a.id, b.id]);
    const deps = item.board.listDependencies(b.id);
    assert.deepEqual(deps.dependsOn.map(ref => ref.id), [a.id]);
    assert.deepEqual(deps.dependents, [{ id: c.id, title: "C", status: "ready" }]);
    item.board.removeDependency(b.id, a.id);
    assert.equal(item.board.getCard(b.id)!.blocked, false);
    assert.throws(() => item.board.removeDependency(b.id, a.id), /does not depend/);
  } finally { await item.close(); }
});

test("an edge to a card that no longer exists is dropped", async () => {
  const item = fixture();
  try {
    const parent = item.card("Parent"), child = item.card("Child", [parent.id]);
    item.board.close();
    // Bakery has no card delete path, and foreign keys block one; simulate a card removed outside the app.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(item.dir, "board.sqlite"));
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare("DELETE FROM cards WHERE id=?").run(parent.id);
    db.close();
    const reopened = new Board(join(item.dir, "board.sqlite"));
    try {
      assert.deepEqual(reopened.getCard(child.id)!.dependsOn, []);
      assert.equal(reopened.getCard(child.id)!.blocked, false);
    } finally { reopened.close(); }
  } finally { rmSync(item.dir, { recursive: true, force: true }); }
});

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}

test("the HTTP API creates cards with dependencies, adds and removes them, and refuses a blocked start", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-deps-api-")), repo = join(home, "repo");
  mkdirSync(repo); execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: join(home, "data"), BAKERY_PORT: String(port), BAKERY_PI_BIN: "/bin/false", BAKERY_WT_BIN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    async function request(path: string, method = "GET", input?: unknown) {
      const response = await fetch(`${url}/api${path}`, { method, headers: input ? { "Content-Type": "application/json" } : undefined, body: input ? JSON.stringify(input) : undefined });
      return { status: response.status, data: await response.json() };
    }
    const deadline = Date.now() + 5000;
    while (true) {
      try { await request("/boards"); break; } catch { if (Date.now() > deadline) throw new Error("Server did not start"); await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    const boardId = (await request("/boards", "POST", { repo })).data.id as string;
    const cards = `/boards/${boardId}/cards`;
    const parent = (await request(cards, "POST", { title: "Parent", body: "" })).data;
    const created = await request(cards, "POST", { title: "Child", body: "", dependsOn: [parent.id] });
    assert.equal(created.status, 201);
    assert.deepEqual(created.data.dependsOn, [parent.id]);
    assert.equal(created.data.blocked, true);
    assert.equal((await request(cards, "POST", { title: "Bad", body: "", dependsOn: "nope" })).status, 400);
    await request(`${cards}/${created.data.id}/status`, "POST", { status: "ready" });
    const refused = await request(`${cards}/${created.data.id}/start`, "POST");
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /Waiting on 1 unfinished card: Parent/);
    const other = (await request(cards, "POST", { title: "Other", body: "" })).data;
    const added = await request(`${cards}/${created.data.id}/dependencies`, "POST", { dependsOn: other.id });
    assert.deepEqual(added.data.dependsOn, [parent.id, other.id]);
    assert.match((await request(`${cards}/${other.id}/dependencies`, "POST", { dependsOn: created.data.id })).data.error, /cycle/);
    const listed = await request(`${cards}/${parent.id}/dependencies`);
    assert.deepEqual(listed.data, { dependsOn: [], dependents: [{ id: created.data.id, title: "Child", status: "ready" }] });
    const removed = await request(`${cards}/${created.data.id}/dependencies/${parent.id}`, "DELETE");
    assert.deepEqual(removed.data.dependsOn, [other.id]);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("close", resolve));
    rmSync(home, { recursive: true, force: true });
  }
});

test("moving a Triage card to Ready brings its Triage dependencies, transitively, and leaves finished and unrelated cards", async () => {
  const item = fixture();
  try {
    const make = (title: string, dependsOn?: string[]) => item.board.createCard({ title, body: "", repo: item.repo, dependsOn });
    const leaf = make("Leaf"), mid = make("Mid", [leaf.id]), done = item.board.setStatus(make("Done dep").id, "done"), other = make("Other");
    const top = make("Top", [mid.id, done.id]);
    assert.deepEqual(item.board.moveToReadyWithDependencies(top.id).map(moved => moved.title), ["Top", "Leaf", "Mid"]);
    for (const id of [top.id, mid.id, leaf.id]) assert.equal(item.board.getCard(id)!.status, "ready");
    assert.equal(item.board.getCard(done.id)!.status, "done");
    assert.equal(item.board.getCard(other.id)!.status, "triage");
    assert.match(item.board.listCardEvents(leaf.id).at(-1)!.reason, /Top.*waits on it/);
  } finally { await item.close(); }
});
