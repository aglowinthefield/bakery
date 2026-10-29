import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}

test("POST /start during a drain answers 202 queued, starts no run, and persists the start", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-drain-"));
  const repo = join(home, "code", "alpha"), dataDir = join(home, "data");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const port = await freePort();
  // An IPC channel lets the test play the dev supervisor and send the drain message.
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, BAKERY_DATA_DIR: dataDir, BAKERY_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stderr?.on("data", chunk => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${port}`;
    const request = async (path: string, method = "GET", input?: unknown) => {
      const response = await fetch(`${url}/api${path}`, { method, headers: input ? { "Content-Type": "application/json" } : undefined, body: input ? JSON.stringify(input) : undefined });
      return { status: response.status, data: await response.json() };
    };
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await fetch(`${url}/api/boards`); break; }
      catch {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Server did not start: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const boardId = (await request("/boards", "POST", { repo })).data.id;
    const ready = (await request(`/boards/${boardId}/cards`, "POST", { title: "Ready", body: "" })).data;
    const triage = (await request(`/boards/${boardId}/cards`, "POST", { title: "Triage", body: "" })).data;
    assert.equal((await request(`/boards/${boardId}/cards/${ready.id}/status`, "POST", { status: "ready" })).status, 200);

    const drained = new Promise<void>(resolve => child.on("message", (message: { type?: string }) => { if (message.type === "drained") resolve(); }));
    child.send({ type: "drain" });
    await drained;
    assert.equal((await request("/status")).data.draining, true);

    const queued = await request(`/boards/${boardId}/cards/${ready.id}/start`, "POST");
    assert.equal(queued.status, 202);
    assert.deepEqual(queued.data, { queued: true, cardId: ready.id });
    assert.deepEqual((await request(`/boards/${boardId}/cards/${ready.id}/runs`)).data, [], "no run starts while draining");
    assert.equal((await request(`/boards/${boardId}/cards/${triage.id}/start`, "POST")).status, 400, "a Triage card cannot be queued");

    // The queue survives the restart: the next process reads it from the database.
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    const board = new Board(join(dataDir, "bakery.sqlite"));
    try { assert.deepEqual(board.takeQueuedStarts(), [ready.id]); } finally { board.close(); }
  } finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});
