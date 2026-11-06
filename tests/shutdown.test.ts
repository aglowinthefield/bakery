import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
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

// An open browser tab holds a chat event stream. If shutdown leaves it open, the process never exits, systemd never
// restarts it, and the tab keeps talking to a server whose database is closed.
test("SIGTERM exits the server even while a chat event stream is open", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-shutdown-"));
  const repo = join(home, "code", "alpha"), dataDir = join(home, "data");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: dataDir, BAKERY_PORT: String(port), BAKERY_SENTINEL: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr?.on("data", chunk => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${port}`;
    const post = async (path: string, input: unknown) => (await fetch(`${url}/api${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).json();
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await fetch(`${url}/api/boards`); break; }
      catch {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Server did not start: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const boardId = (await post("/boards", { repo })).id;
    const chatId = (await post(`/boards/${boardId}/chats`, {})).id;
    const stream = httpRequest(`${url}/api/boards/${boardId}/chats/${chatId}/events?viewer=test&looking=1`);
    stream.on("error", () => undefined);
    await new Promise<void>(resolve => { stream.on("response", response => { response.resume(); resolve(); }); stream.end(); });

    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    child.kill("SIGTERM");
    const result = await Promise.race([exited, new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), 10_000))]);
    stream.destroy();
    assert.notEqual(result, "hung", `server did not exit after SIGTERM: ${output}`);
    assert.equal(result, 0, `server exited with ${result}: ${output}`);
  } finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});
