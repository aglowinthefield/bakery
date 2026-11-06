import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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

test("with BAKERY_SENTINEL=0, run-now and resume dispatch no work", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-sentinel-api-"));
  let child: ChildProcess | undefined;
  try {
    const repo = join(home, "code", "alpha"), dataDir = join(home, "data");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    const port = await freePort(), url = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: dataDir, BAKERY_PORT: String(port), BAKERY_SENTINEL: "0", BAKERY_GH_BIN: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const end = Date.now() + 15_000;
    while (true) {
      if (child.exitCode !== null) throw new Error("Server exited");
      try { await fetch(`${url}/api/boards`); break; } catch { /* not listening yet */ }
      if (Date.now() > end) throw new Error("Server did not listen");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const request = async (path: string, method = "GET", input?: unknown) => {
      const response = await fetch(`${url}/api${path}`, { method, headers: input ? { "Content-Type": "application/json" } : undefined, body: input ? JSON.stringify(input) : undefined });
      return { status: response.status, data: await response.json() as any };
    };
    const boardId = (await request("/boards", "POST", { repo })).data.id;
    assert.equal((await request(`/boards/${boardId}/settings`, "PATCH", { remoteUrl: "https://github.com/acme/widgets" })).status, 200);
    assert.equal((await request(`/boards/${boardId}/settings`, "PATCH", { integration: "github-pr" })).status, 200);
    const listed = await request(`/boards/${boardId}/sentinels`);
    assert.equal(listed.status, 200);
    const sentinels = listed.data.sentinels ?? listed.data;
    const target = sentinels[0].sentinel ?? sentinels[0];
    assert.ok(target.id, "a sentinel is listed");
    const run = await request(`/sentinels/${target.id}/run`, "POST");
    assert.equal(run.status, 409, "run-now is refused");
    assert.equal((await request(`/sentinels/${target.id}`, "PATCH", { enabled: false })).status, 200);
    assert.equal((await request(`/sentinels/${target.id}`, "PATCH", { enabled: true })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual((await request(`/sentinels/${target.id}/runs`)).data, [], "resuming started no run");
  } finally {
    if (child && child.exitCode === null) { const exited = new Promise(resolve => child!.once("exit", resolve)); child.kill("SIGKILL"); await exited; }
    rmSync(home, { recursive: true, force: true });
  }
});
