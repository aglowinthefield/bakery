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
    assert.deepEqual((await request("/settings")).data, { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" });
    assert.equal((await request("/settings", "PATCH", { confirmRunStart: "false" })).status, 400);
    assert.equal((await request("/settings", "PATCH", { cardDetailsLayout: "drawer" })).status, 400);
    assert.equal((await request("/settings", "PATCH", { theme: "unknown" })).status, 400);
    assert.deepEqual((await request("/settings", "PATCH", { confirmRunStart: true })).data, { confirmRunStart: true, cardDetailsLayout: "dialog", theme: "default" });
    assert.deepEqual((await request("/settings", "PATCH", { cardDetailsLayout: "side" })).data, { confirmRunStart: true, cardDetailsLayout: "side", theme: "default" });
    assert.deepEqual((await request("/settings", "PATCH", { theme: "compline" })).data, { confirmRunStart: true, cardDetailsLayout: "side", theme: "compline" });
    assert.deepEqual((await request("/settings", "PATCH", { theme: "light" })).data, { confirmRunStart: true, cardDetailsLayout: "side", theme: "light" });
    assert.deepEqual((await request("/settings")).data, { confirmRunStart: true, cardDetailsLayout: "side", theme: "light" });
    assert.equal((await request("/boards", "POST", { repo: "~/code/alpha" })).status, 201);
    const first = (await request("/boards")).data[0];
    assert.equal(first.repo, realpathSync(alpha));
    assert.deepEqual([first.icon, first.color], ["layout-grid", "violet"]);
    assert.equal(first.autoCollapseEmptySwimlanes, false);
    assert.equal(first.autoReviewEnabled, false);
    assert.equal(first.verificationCommand, "");
    assert.equal(first.autoPickupEnabled, false);
    assert.equal(first.pickupConcurrency, 2);
    assert.equal(first.pickupDailyLimit, 6);
    assert.equal(first.autoPickupStarts, 0);
    assert.equal(first.autoPickupNextAt, null);
    assert.equal((await request("/boards", "POST", { repo: alpha })).status, 400);
    assert.equal((await request("/boards", "POST", { repo: "code/beta" })).status, 400);
    const second = (await request("/boards", "POST", { repo: beta })).data;
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { icon: "unknown", color: "coral" })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { icon: "rocket", color: "red; background:url(x)" })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { icon: "rocket" })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { icon: "rocket", color: "coral", autoCollapseEmptySwimlanes: true })).status, 400);
    const appearance = await request(`/boards/${first.id}/settings`, "PATCH", { icon: "rocket", color: "coral" });
    assert.equal(appearance.status, 200);
    assert.deepEqual([appearance.data.icon, appearance.data.color], ["rocket", "coral"]);
    assert.deepEqual([(await request("/boards")).data.find((item: { id: string }) => item.id === first.id).icon,
      (await request("/boards")).data.find((item: { id: string }) => item.id === second.id).color], ["rocket", "violet"]);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoCollapseEmptySwimlanes: "yes" })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", {})).status, 400);
    assert.equal((await request(`/boards/missing/settings`, "PATCH", { autoCollapseEmptySwimlanes: true })).status, 404);
    const settings = await request(`/boards/${first.id}/settings`, "PATCH", { autoCollapseEmptySwimlanes: true });
    assert.equal(settings.status, 200);
    assert.equal(settings.data.autoCollapseEmptySwimlanes, true);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoReviewEnabled: true, verificationCommand: "" })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoReviewEnabled: true })).status, 400);
    const auto = await request(`/boards/${first.id}/settings`, "PATCH", { autoReviewEnabled: true, verificationCommand: "npm test && npm run build" });
    assert.equal(auto.status, 200);
    assert.equal(auto.data.autoReviewEnabled, true);
    assert.equal(auto.data.verificationCommand, "npm test && npm run build");
    assert.ok(auto.data.autoReviewEnabledAt);
    assert.deepEqual((await request(`/boards/${first.id}/cards/nonexistent/auto-review`)).status, 404);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoReviewEnabled: false, verificationCommand: "npm test && npm run build" })).data.autoReviewEnabled, false);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: true, pickupConcurrency: 0 })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: true, pickupConcurrency: 5 })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: true })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: 0 })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: 25 })).status, 400);
    const pickup = await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: 8 });
    assert.equal(pickup.data.autoPickupEnabled, true);
    assert.equal(pickup.data.pickupDailyLimit, 8);
    assert.equal((await request(`/boards/${first.id}/auto-pickup/reset-limit`, "POST")).status, 400);
    assert.equal((await request(`/boards/missing/auto-pickup/reset-limit`, "POST")).status, 404);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: false, pickupConcurrency: 2 })).data.pickupDailyLimit, 8);
    assert.equal((await request("/boards")).data.find((item: { id: string }) => item.id === second.id).autoCollapseEmptySwimlanes, false);
    execFileSync("git", ["-C", alpha, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
    const card = (await request(`/boards/${first.id}/cards`, "POST", { title: "Alpha", body: "No Pi" })).data;
    assert.equal(card.repo, realpathSync(alpha));
    assert.equal(card.status, "triage");
    assert.match((await request(`/boards/${first.id}/cards/${card.id}/start`, "POST")).data.error, /Move.*Ready/);
    assert.deepEqual((await request(`/boards/${first.id}/cards/${card.id}/runs`)).data, []);
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}/status`, "POST", { status: "running" })).status, 400);
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}/status`, "POST", { status: "ready" })).data.status, "ready");
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}/status`, "POST", { status: "triage" })).data.status, "triage");
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}/status`, "POST", { status: "ready" })).data.status, "ready");
    assert.deepEqual((await request(`/boards/${first.id}/cards/${card.id}/runs`)).data, []);
    assert.equal((await request(`/boards/${second.id}/cards`)).data.length, 0);
    assert.equal((await request(`/boards/${second.id}/cards/${card.id}/runs`)).status, 404);
    assert.equal((await request(`/boards/${second.id}/cards/${card.id}/start`, "POST")).status, 404);
    assert.equal((await request(`/boards/${second.id}/cards/${card.id}/approve`, "POST")).status, 404);
    assert.equal((await request(`/boards/${second.id}/cards/${card.id}/review`)).status, 404);
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}/review`)).status, 400);
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}/approve`, "POST")).status, 400);
    assert.equal((await request(`/boards/${first.id}/cards`)).data[0].id, card.id);
    assert.equal((await request(`/boards/${first.id}`, "PATCH", { repo: beta })).status, 400);
    const moved = await request(`/boards/${first.id}`, "PATCH", { repo: "~/code/gamma" });
    assert.equal(moved.data.repo, realpathSync(gamma));
    assert.equal(moved.status, 200);
    assert.equal(moved.data.autoCollapseEmptySwimlanes, true);
    assert.deepEqual([moved.data.icon, moved.data.color], ["rocket", "coral"]);
    assert.equal((await request(`/boards/${first.id}/cards`)).data[0].repo, realpathSync(gamma));
    assert.equal((await request(`/boards/${first.id}`, "DELETE")).status, 200);
    assert.equal((await request(`/boards/${first.id}/cards`)).status, 404);
    assert.equal((await request("/boards")).data.length, 1);
    const restored = await request("/boards", "POST", { repo: gamma });
    assert.equal(restored.data.id, first.id);
    assert.equal(restored.data.autoCollapseEmptySwimlanes, true);
    assert.deepEqual([restored.data.icon, restored.data.color], ["rocket", "coral"]);
    assert.equal((await request(`/boards/${first.id}/cards`)).data[0].id, card.id);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("close", resolve));
    }
    rmSync(home, { recursive: true, force: true });
  }
});
