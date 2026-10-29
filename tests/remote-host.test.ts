import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freePort() {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}

function call(port: number, host: string, method = "GET", origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: host };
    if (origin) headers.Origin = origin;
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/boards", method, headers }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(env: Record<string, string>, run: (port: number) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "bakery-remote-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: join(home, "data"), BAKERY_PORT: String(port), ...env },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 8000;
    while (true) {
      try { await call(port, "127.0.0.1"); break; }
      catch { if (Date.now() > deadline) throw new Error("Server did not start"); await new Promise(r => setTimeout(r, 25)); }
    }
    await run(port);
  } finally { child.kill(); }
}

test("remote hostnames are rejected unless listed in BAKERY_ALLOWED_HOSTS", async () => {
  await withServer({}, async port => {
    assert.equal(await call(port, "mochi:4317"), 403);
  });
  await withServer({ BAKERY_ALLOWED_HOSTS: "mochi, mochi.tail1234.ts.net" }, async port => {
    assert.equal(await call(port, "mochi:4317"), 200);
    assert.equal(await call(port, "MOCHI.tail1234.ts.net"), 200);
    assert.equal(await call(port, "evil.example"), 403);
    assert.notEqual(await call(port, "mochi", "POST", "https://mochi.tail1234.ts.net"), 403);
    assert.equal(await call(port, "mochi", "POST", "https://evil.example"), 403);
  });
});
