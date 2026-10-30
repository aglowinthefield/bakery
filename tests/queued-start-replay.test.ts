import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}

async function until<T>(read: () => Promise<T | undefined | false>, what: string): Promise<T> {
  const end = Date.now() + 15_000;
  while (true) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

type Replay = {
  request: (path: string, method?: string, input?: unknown) => Promise<{ status: number; data: any }>;
  boardId: string;
  card: { id: string };
  read: () => Promise<any>;
};

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

/** Queues a start while draining, restarts on the same data dir, then runs `check`. Always cleans up. */
async function withReplay(options: { commit: boolean }, check: (state: Replay) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "bakery-replay-"));
  const children: ChildProcess[] = [];
  try {
    const repo = join(home, "code", "alpha"), dataDir = join(home, "data"), fakePi = join(home, "pi-fake");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    if (options.commit) {
      writeFileSync(join(repo, "README.md"), "fixture\n");
      execFileSync("git", ["-C", repo, "add", "README.md"]);
      execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    }
    // Stays alive long enough for the test to observe the run as running.
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' '{"type":"turn_start"}'\nsleep 3\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`);
    chmodSync(fakePi, 0o755);
    const port = await freePort(), url = `http://127.0.0.1:${port}`;
    const launch = async () => {
      const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
        cwd: process.cwd(),
        env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: dataDir, BAKERY_PORT: String(port), BAKERY_PI_BIN: fakePi },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      children.push(child);
      let output = "";
      child.stderr?.on("data", chunk => { output += chunk.toString(); });
      await until(async () => {
        if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
        try { await fetch(`${url}/api/boards`); return true; } catch { return false; }
      }, "the server to listen");
      return child;
    };
    const request: Replay["request"] = async (path, method = "GET", input) => {
      const response = await fetch(`${url}/api${path}`, { method, headers: input ? { "Content-Type": "application/json" } : undefined, body: input ? JSON.stringify(input) : undefined });
      return { status: response.status, data: await response.json() };
    };

    const first = await launch();
    const boardId = (await request("/boards", "POST", { repo })).data.id;
    const card = (await request(`/boards/${boardId}/cards`, "POST", { title: "Queued", body: "" })).data;
    assert.equal((await request(`/boards/${boardId}/cards/${card.id}/status`, "POST", { status: "ready" })).status, 200);

    const drained = new Promise<void>(resolve => first.on("message", (message: { type?: string }) => { if (message.type === "drained") resolve(); }));
    first.send({ type: "drain" });
    await drained;
    const queued = await request(`/boards/${boardId}/cards/${card.id}/start`, "POST");
    assert.equal(queued.status, 202);
    assert.deepEqual(queued.data, { queued: true, cardId: card.id });

    await stop(first);
    await launch();
    const read = async () => (await request(`/boards/${boardId}/cards`)).data.find((item: { id: string }) => item.id === card.id);
    await check({ request, boardId, card, read });
  } finally {
    await Promise.all(children.map(stop));
    rmSync(home, { recursive: true, force: true });
  }
}

test("a start queued during a drain runs after the server restarts on the same data dir", async () => {
  await withReplay({ commit: true }, async ({ request, boardId, card, read }) => {
    const running = await until(async () => { const item = await read(); return item?.status === "running" && item; }, "the replayed card to run");
    assert.equal(running.startQueued, false, "the queue is emptied once replayed");
    const runs = (await request(`/boards/${boardId}/cards/${card.id}/runs`)).data;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "running");
  });
});

test("a start queued during a drain that cannot run after the restart leaves the card Ready with a note", async () => {
  await withReplay({ commit: false }, async ({ request, boardId, card, read }) => {
    const item = await until(async () => { const current = await read(); return current?.startQueued === false && current; }, "the queue to be replayed");
    assert.equal(item.status, "ready");
    assert.deepEqual((await request(`/boards/${boardId}/cards/${card.id}/runs`)).data, []);
    const notes = JSON.stringify((await request(`/boards/${boardId}/cards/${card.id}/history`)).data);
    assert.match(notes, /A start queued during the last restart could not run/);
  });
});
