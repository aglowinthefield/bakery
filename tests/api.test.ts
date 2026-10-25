import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
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

test("repository boards expand home paths, inherit roots, and isolate cards", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-api-"));
  const alpha = join(home, "code", "alpha"), beta = join(home, "code", "beta"), gamma = join(home, "code", "gamma");
  mkdirSync(alpha, { recursive: true }); mkdirSync(beta); mkdirSync(gamma);
  for (const repo of [alpha, beta, gamma]) execFileSync("git", ["init", "-q", repo]);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, BAKERY_DATA_DIR: join(home, "data"), BAKERY_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr?.on("data", chunk => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${port}`;
    async function request(path: string, method = "GET", input?: unknown) {
      const response = await fetch(`${url}/api${path}`, { method, headers: input ? { "Content-Type": "application/json" } : undefined, body: input ? JSON.stringify(input) : undefined });
      return { status: response.status, data: await response.json() };
    }
    const deadline = Date.now() + 5000;
    while (true) {
      try { await fetch(`${url}/api/boards`); break; }
      catch {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Server did not start: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    assert.equal(statSync(join(home, "data")).mode & 0o777, 0o700);
    assert.equal((await request("/boards", "POST", { repo: "~/code/alpha" })).status, 201);
    const first = (await request("/boards")).data[0];
    assert.equal(first.repo, realpathSync(alpha));
    assert.equal((await request("/boards", "POST", { repo: alpha })).status, 400);
    assert.equal((await request("/boards", "POST", { repo: "code/beta" })).status, 400);
    const second = (await request("/boards", "POST", { repo: beta })).data;
    const card = (await request(`/boards/${first.id}/cards`, "POST", { title: "Alpha", body: "No Pi" })).data;
    assert.equal(card.repo, realpathSync(alpha));
    assert.equal((await request(`/boards/${second.id}/cards`)).data.length, 0);
    assert.equal((await request(`/boards/${second.id}/cards/${card.id}/runs`)).status, 404);
    assert.equal((await request(`/boards/${second.id}/cards/${card.id}/start`, "POST")).status, 404);
    assert.equal((await request(`/boards/${first.id}/cards`)).data[0].id, card.id);
    assert.equal((await request(`/boards/${first.id}`, "PATCH", { repo: beta })).status, 400);
    const moved = await request(`/boards/${first.id}`, "PATCH", { repo: gamma });
    assert.equal(moved.status, 200);
    assert.equal((await request(`/boards/${first.id}/cards`)).data[0].repo, realpathSync(gamma));
    assert.equal((await request(`/boards/${first.id}`, "DELETE")).status, 200);
    assert.equal((await request(`/boards/${first.id}/cards`)).status, 404);
    assert.equal((await request("/boards")).data.length, 1);
    const restored = await request("/boards", "POST", { repo: gamma });
    assert.equal(restored.data.id, first.id);
    assert.equal((await request(`/boards/${first.id}/cards`)).data[0].id, card.id);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("close", resolve));
    }
    rmSync(home, { recursive: true, force: true });
  }
});
