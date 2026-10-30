import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentModels } from "../server/agent-models.js";

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
  mkdirSync(join(home, "code", "alpine"));
  mkdirSync(join(alpha, "subfolder"));
  for (const repo of [alpha, beta, gamma]) execFileSync("git", ["init", "-q", repo]);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: join(home, "data"), BAKERY_PORT: String(port) },
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
    // The Logs view: the server's own output, including a debug line for each failed request.
    assert.equal((await request("/logs?after=x")).status, 400);
    const logs = (await request("/logs")).data as { startedAt: string; entries: { seq: number; level: string; message: string }[] };
    assert.ok(logs.entries.some(entry => entry.level === "info" && entry.message === `Bakery listening on http://127.0.0.1:${port}`));
    assert.ok(logs.entries.some(entry => entry.level === "debug" && entry.message === "GET /api/logs?after=x -> 400: after must be a whole number"));
    assert.deepEqual((await request(`/logs?after=${logs.entries.at(-1)!.seq}`)).data.entries, []);
    assert.deepEqual((await request("/path-suggestions?path=~%2Fcode%2Fal")).data, ["~/code/alpha/", "~/code/alpine/"]);
    assert.deepEqual((await request(`/path-suggestions?path=${encodeURIComponent(join(home, "code") + "/al")}`)).data, [alpha + "/", join(home, "code", "alpine") + "/"]);
    assert.deepEqual((await request("/path-suggestions?path=~%2Fcode%2Falpha%2F")).data, ["~/code/alpha/subfolder/"]);
    assert.deepEqual((await request("/path-suggestions?path=code%2Fal")).data, []);
    assert.deepEqual((await request("/path-suggestions?path=~%2Fmissing%2Fa")).data, []);
    assert.equal((await request(`/repository-root?path=${encodeURIComponent("~/code/alpha")}`)).data.root, realpathSync(alpha));
    assert.equal((await request(`/repository-root?path=${encodeURIComponent("~/code/alpine")}`)).status, 400);
    assert.equal((await request(`/repository-root?path=${encodeURIComponent("~/code")}`)).status, 400);
    assert.equal((await request(`/repository-root?path=${encodeURIComponent("~/code/alpha/subfolder")}`)).status, 400);
    assert.equal((await request(`/path-suggestions?path=${"a".repeat(1025)}`)).status, 400);
    assert.deepEqual((await request("/settings")).data, { confirmRunStart: false, notifyOnReview: false, cardDetailsLayout: "dialog", theme: "default", density: "default", showCardModels: false, agentModels: emptyAgentModels() });
    assert.equal((await request("/settings", "PATCH", { confirmRunStart: "false" })).status, 400);
    assert.equal((await request("/settings", "PATCH", { notifyOnReview: "true" })).status, 400);
    assert.equal((await request("/settings", "PATCH", { cardDetailsLayout: "drawer" })).status, 400);
    assert.equal((await request("/settings", "PATCH", { theme: "unknown" })).status, 400);
    assert.equal((await request("/settings", "PATCH", { density: "spacious" })).status, 400);
    assert.equal((await request("/settings", "PATCH", { density: "compact" })).data.density, "compact");
    assert.equal((await request("/settings", "PATCH", { density: "default" })).data.density, "default");
    assert.deepEqual((await request("/settings", "PATCH", { confirmRunStart: true })).data, { confirmRunStart: true, notifyOnReview: false, cardDetailsLayout: "dialog", theme: "default", density: "default", showCardModels: false, agentModels: emptyAgentModels() });
    assert.deepEqual((await request("/settings", "PATCH", { notifyOnReview: true })).data, { confirmRunStart: true, notifyOnReview: true, cardDetailsLayout: "dialog", theme: "default", density: "default", showCardModels: false, agentModels: emptyAgentModels() });
    assert.deepEqual((await request("/settings", "PATCH", { cardDetailsLayout: "side" })).data, { confirmRunStart: true, notifyOnReview: true, cardDetailsLayout: "side", theme: "default", density: "default", showCardModels: false, agentModels: emptyAgentModels() });
    assert.deepEqual((await request("/settings", "PATCH", { theme: "compline" })).data, { confirmRunStart: true, notifyOnReview: true, cardDetailsLayout: "side", theme: "compline", density: "default", showCardModels: false, agentModels: emptyAgentModels() });
    assert.deepEqual((await request("/settings", "PATCH", { theme: "light" })).data, { confirmRunStart: true, notifyOnReview: true, cardDetailsLayout: "side", theme: "light", density: "default", showCardModels: false, agentModels: emptyAgentModels() });
    assert.deepEqual((await request("/settings")).data, { confirmRunStart: true, notifyOnReview: true, cardDetailsLayout: "side", theme: "light", density: "default", showCardModels: false, agentModels: emptyAgentModels() });
    assert.equal((await request("/boards", "POST", { repo: "~/code/alpha" })).status, 201);
    const first = (await request("/boards")).data[0];
    assert.equal(first.repo, realpathSync(alpha));
    assert.deepEqual([first.icon, first.color], ["sprinkle_donut", "violet"]);
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
    assert.equal((await request("/boards", "POST", { repo: "~/code/alpine" })).status, 400);
    const second = (await request("/boards", "POST", { repo: beta })).data;
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { icon: "unknown", color: "coral" })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { icon: "croissant", color: "red; background:url(x)" })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { icon: "croissant" })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { icon: "croissant", color: "coral", autoCollapseEmptySwimlanes: true })).status, 400);
    const appearance = await request(`/boards/${first.id}/settings`, "PATCH", { icon: "croissant", color: "coral" });
    assert.equal(appearance.status, 200);
    assert.deepEqual([appearance.data.icon, appearance.data.color], ["croissant", "coral"]);
    assert.deepEqual([(await request("/boards")).data.find((item: { id: string }) => item.id === first.id).icon,
      (await request("/boards")).data.find((item: { id: string }) => item.id === second.id).color], ["croissant", "violet"]);
    assert.equal(first.remoteUrl, "");
    for (const remoteUrl of ["javascript:alert(1)", "github.com/owner/repo", `https://example.com/${"x".repeat(500)}`, 42])
      assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { remoteUrl })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { remoteUrl: "https://github.com/o/r", autoCollapseEmptySwimlanes: true })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { remoteUrl: " https://github.com/o/r " })).data.remoteUrl, "https://github.com/o/r");
    assert.deepEqual((await request("/boards")).data.map((item: { id: string; remoteUrl: string }) => [item.id, item.remoteUrl]).sort(),
      [[first.id, "https://github.com/o/r"], [second.id, ""]].sort());
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { remoteUrl: "" })).data.remoteUrl, "");
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
    const otherBefore = (await request("/boards")).data.find((item: { id: string }) => item.id === second.id);
    assert.equal(otherBefore.autoReviewEnabled, false);
    assert.equal(otherBefore.verificationCommand, "");
    const otherAuto = await request(`/boards/${second.id}/settings`, "PATCH", { autoReviewEnabled: true, verificationCommand: "npm run check:beta" });
    assert.equal(otherAuto.data.autoReviewEnabled, true);
    assert.equal(otherAuto.data.verificationCommand, "npm run check:beta");
    const firstAfter = (await request("/boards")).data.find((item: { id: string }) => item.id === first.id);
    assert.equal(firstAfter.autoReviewEnabled, true);
    assert.equal(firstAfter.verificationCommand, "npm test && npm run build");
    assert.deepEqual((await request(`/boards/${first.id}/cards/nonexistent/auto-review`)).status, 404);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoReviewEnabled: false, verificationCommand: "npm test && npm run build" })).data.autoReviewEnabled, false);
    const otherAfter = (await request("/boards")).data.find((item: { id: string }) => item.id === second.id);
    assert.equal(otherAfter.autoReviewEnabled, true);
    assert.equal(otherAfter.verificationCommand, "npm run check:beta");
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: true, pickupConcurrency: 0 })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: true, pickupConcurrency: 5 })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: true })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: -1 })).status, 400);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: 100 })).status, 400);
    const unlimited = await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: false, pickupConcurrency: 2, pickupDailyLimit: 0 });
    assert.equal(unlimited.status, 200);
    assert.equal(unlimited.data.pickupDailyLimit, 0);
    assert.equal(unlimited.data.autoPickupNextAt, null);
    const pickup = await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: 99 });
    assert.equal(pickup.data.autoPickupEnabled, true);
    assert.equal(pickup.data.pickupDailyLimit, 99);
    assert.equal((await request(`/boards/${first.id}/auto-pickup/reset-limit`, "POST")).status, 400);
    assert.equal((await request(`/boards/missing/auto-pickup/reset-limit`, "POST")).status, 404);
    assert.equal((await request(`/boards/${first.id}/settings`, "PATCH", { autoPickupEnabled: false, pickupConcurrency: 2 })).data.pickupDailyLimit, 99);
    assert.equal((await request("/boards")).data.find((item: { id: string }) => item.id === second.id).autoCollapseEmptySwimlanes, false);
    execFileSync("git", ["-C", alpha, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
    const card = (await request(`/boards/${first.id}/cards`, "POST", { title: "Alpha", body: "No Pi" })).data;
    assert.equal(card.repo, realpathSync(alpha));
    assert.equal(card.status, "triage");
    assert.equal(card.priority, 0, "new cards default to Normal");
    for (const priority of ["critical", "HIGH", 101, -101, 0.5, null])
      assert.match((await request(`/boards/${first.id}/cards`, "POST", { title: "Bad", body: "", priority })).data.error, /Priority must be a whole number from -100 to 100/);
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}`, "PATCH", { title: "Alpha", body: "No Pi", priority: "bogus" })).status, 400);
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}`, "PATCH", { title: "Alpha", body: "No Pi", priority: "high" })).data.priority, 50);
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}`, "PATCH", { title: "Alpha", body: "No Pi", priority: 80 })).data.priority, 80);
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}`, "PATCH", { title: "Alpha", body: "Edited" })).data.priority, 80, "omitting priority on edit keeps it");
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}`, "PATCH", { title: "Alpha", body: "No Pi", priority: 0 })).data.priority, 0);
    assert.equal(card.idempotencyKey, null);
    const keyed = await request(`/boards/${first.id}/cards`, "POST", { title: "Keyed", body: "", idempotencyKey: "script-1" });
    assert.equal(keyed.status, 201);
    const repeated = await request(`/boards/${first.id}/cards`, "POST", { title: "Keyed again", body: "", idempotencyKey: "script-1" });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.id, keyed.data.id);
    assert.equal(repeated.data.title, "Keyed");
    assert.equal((await request(`/boards/${second.id}/cards`, "POST", { title: "Beta keyed", body: "", idempotencyKey: "script-1" })).status, 201);
    assert.equal((await request(`/boards/${first.id}/cards`, "POST", { title: "Long", body: "", idempotencyKey: "k".repeat(201) })).status, 400);
    assert.equal((await request(`/boards/${first.id}/cards`, "POST", { title: "Blank", body: "", idempotencyKey: " " })).status, 400);
    assert.equal((await request(`/boards/${first.id}/cards`, "POST", { title: "Number", body: "", idempotencyKey: 7 })).status, 400);
    assert.match((await request(`/boards/${first.id}/cards/${card.id}/start`, "POST")).data.error, /Move.*Ready/);
    assert.deepEqual((await request(`/boards/${first.id}/cards/${card.id}/runs`)).data, []);
    assert.deepEqual(await request(`/boards/${first.id}/cards/${card.id}/push-progress`), { status: 200, data: null }, "card details poll push progress");
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}/status`, "POST", { status: "running" })).status, 400);
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}/status`, "POST", { status: "ready" })).data.status, "ready");
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}/status`, "POST", { status: "triage" })).data.status, "triage");
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}/status`, "POST", { status: "ready" })).data.status, "ready");
    assert.equal((await request(`/boards/${first.id}/cards/archive`, "POST", { cardIds: [card.id] })).status, 400);
    assert.equal((await request(`/boards/${first.id}/cards/archive`, "POST", { cardIds: "nope" })).status, 400);
    const finished = (await request(`/boards/${first.id}/cards`, "POST", { title: "Finished", body: "" })).data;
    assert.equal((await request(`/boards/${first.id}/cards/${finished.id}/status`, "POST", { status: "done" })).data.status, "done");
    assert.equal((await request(`/boards/${second.id}/cards/archive`, "POST", { cardIds: [finished.id] })).status, 404);
    assert.equal((await request(`/boards/${first.id}/cards/archive`, "POST", { cardIds: [finished.id] })).data[0].status, "archived");
    assert.equal((await request(`/boards/${first.id}/cards/unarchive`, "POST", { cardIds: [finished.id] })).data[0].status, "done");
    assert.equal((await request(`/boards/${first.id}/cards/archive`, "POST", { cardIds: [finished.id] })).data[0].status, "archived");
    assert.deepEqual((await request(`/boards/${first.id}/cards/${card.id}/runs`)).data, []);
    assert.deepEqual((await request(`/boards/${second.id}/cards`)).data.map((item: { title: string }) => item.title), ["Beta keyed"]);
    // Today reads every board at once and leaves archived cards out.
    const everyTitle = async () => (await request("/cards")).data.map((item: { title: string }) => item.title).sort();
    assert.deepEqual(await everyTitle(), ["Alpha", "Beta keyed", "Keyed"]);
    assert.equal((await request(`/boards/${second.id}/cards/${card.id}/runs`)).status, 404);
    assert.equal((await request(`/boards/${second.id}/cards/${card.id}/start`, "POST")).status, 404);
    assert.equal((await request(`/boards/${second.id}/cards/${card.id}/approve`, "POST")).status, 404);
    assert.equal((await request(`/boards/${second.id}/cards/${card.id}/review`)).status, 404);
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}/review`)).status, 400);
    assert.equal((await request(`/boards/${first.id}/cards/${card.id}/approve`, "POST")).status, 400);
    assert.ok((await request(`/boards/${first.id}/cards`)).data.some((item: { id: string }) => item.id === card.id));
    assert.equal((await request(`/boards/${first.id}`, "PATCH", { repo: beta })).status, 400);
    const moved = await request(`/boards/${first.id}`, "PATCH", { repo: "~/code/gamma" });
    assert.equal(moved.data.repo, realpathSync(gamma));
    assert.equal(moved.status, 200);
    assert.equal(moved.data.autoCollapseEmptySwimlanes, true);
    assert.deepEqual([moved.data.icon, moved.data.color], ["croissant", "coral"]);
    assert.equal((await request(`/boards/${first.id}/cards`)).data[0].repo, realpathSync(gamma));
    assert.equal((await request(`/boards/${first.id}`, "DELETE")).status, 200);
    assert.equal((await request(`/boards/${first.id}/cards`)).status, 404);
    assert.deepEqual(await everyTitle(), ["Beta keyed"]);
    assert.equal((await request("/boards")).data.length, 1);
    const restored = await request("/boards", "POST", { repo: gamma });
    assert.equal(restored.data.id, first.id);
    assert.equal(restored.data.autoCollapseEmptySwimlanes, true);
    assert.deepEqual([restored.data.icon, restored.data.color], ["croissant", "coral"]);
    assert.ok((await request(`/boards/${first.id}/cards`)).data.some((item: { id: string }) => item.id === card.id));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("close", resolve));
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("Pi model settings validate per phase and the model list comes from pi --list-models", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-api-models-"));
  const repo = join(home, "repo"), fakePi = join(home, "pi-fake"), calls = join(home, "calls.txt");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(fakePi, `#!/bin/sh
echo "$@" >> '${calls}'
[ -f '${home}/fail' ] && { echo "billing error" >&2; exit 1; }
printf '%s\\n' 'provider      model              context  max-out  thinking  images' 'anthropic     claude-sonnet-4-5  200K     64K      yes       yes' 'openai-codex  gpt-5.5            400K     128K     yes       yes'
`);
  chmodSync(fakePi, 0o755);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: join(home, "data"), BAKERY_PORT: String(port), BAKERY_PI_BIN: fakePi },
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
    writeFileSync(join(home, "fail"), "");
    const failed = await request("/models");
    assert.equal(failed.status, 200);
    assert.deepEqual(failed.data.models, []);
    assert.match(failed.data.error, /Could not list Pi models/);
    rmSync(join(home, "fail"));
    assert.deepEqual((await request("/models")).data, { models: ["anthropic/claude-sonnet-4-5", "openai-codex/gpt-5.5"] });
    assert.deepEqual((await request("/models")).data.models.length, 2);
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["--list-models", "--list-models"], "successful lists are cached");

    for (const agentModels of [{ work: { model: "--help", thinking: "" } }, { work: { model: "a b" } }, { review: { thinking: "huge" } }, { deploy: {} }, "anthropic/x"])
      assert.equal((await request("/settings", "PATCH", { agentModels })).status, 400, JSON.stringify(agentModels));
    const global = { work: { model: "anthropic/claude-sonnet-4-5", thinking: "medium" }, conflict: { model: "", thinking: "" }, review: { model: "", thinking: "high" }, draft: { model: "", thinking: "" } };
    assert.deepEqual((await request("/settings", "PATCH", { agentModels: global })).data.agentModels, global);
    const board = (await request("/boards", "POST", { repo })).data;
    assert.deepEqual(board.agentModels, emptyAgentModels());
    assert.equal((await request(`/boards/${board.id}/settings`, "PATCH", { agentModels: {}, autoCollapseEmptySwimlanes: true })).status, 400);
    assert.equal((await request(`/boards/${board.id}/settings`, "PATCH", { agentModels: { conflict: { model: "-x" } } })).status, 400);
    const updated = await request(`/boards/${board.id}/settings`, "PATCH", { agentModels: { conflict: { model: " openai-codex/gpt-5.5 ", thinking: "xhigh" } } });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.data.agentModels, { ...emptyAgentModels(), conflict: { model: "openai-codex/gpt-5.5", thinking: "xhigh" } });
    assert.deepEqual((await request("/boards")).data.find((item: { id: string }) => item.id === board.id).agentModels, updated.data.agentModels);
    assert.deepEqual((await request("/settings")).data.agentModels, global);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("close", resolve));
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("POST start while the server drains answers 202 queued and does not start a run", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-drain-"));
  const repo = join(home, "code", "alpha");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, BAKERY_DATA_DIR: join(home, "data"), BAKERY_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
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
    const board = (await request("/boards", "POST", { repo })).data;
    const card = (await request(`/boards/${board.id}/cards`, "POST", { title: "Queued", body: "" })).data;
    assert.equal((await request(`/boards/${board.id}/cards/${card.id}/status`, "POST", { status: "ready" })).data.status, "ready");
    // With no active runs the drain finishes at once, and the server keeps serving until it is restarted.
    const drained = new Promise<void>(resolve => child.on("message", message => { if ((message as { type?: string }).type === "drained") resolve(); }));
    child.send({ type: "drain" });
    await drained;
    assert.equal((await request("/status")).data.draining, true);
    const started = await request(`/boards/${board.id}/cards/${card.id}/start`, "POST");
    assert.deepEqual(started, { status: 202, data: { queued: true, cardId: card.id } });
    assert.deepEqual((await request(`/boards/${board.id}/cards/${card.id}/runs`)).data, [], "no run starts during the drain");
    assert.equal((await request(`/boards/${board.id}/cards/${card.id}/start`, "POST")).status, 202, "queueing twice is harmless");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("close", resolve));
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("card lists report the live tool and turn of a running card, and null once it finishes", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-live-"));
  const repo = join(home, "code", "alpha");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
  // Starts a turn and a tool, then holds until the test creates the release file, then settles.
  const release = join(home, "release"), fakePi = join(home, "fake-pi");
  const event = (value: unknown) => `echo '${JSON.stringify(value)}'`;
  writeFileSync(fakePi, `#!/bin/sh
${event({ type: "turn_start" })}
${event({ type: "tool_execution_start", toolCallId: "a", toolName: "read" })}
${event({ type: "tool_execution_start", toolCallId: "b", toolName: "bad name!" })}
while [ ! -e '${release}' ]; do sleep 0.05; done
${event({ type: "turn_end" })}
${event({ type: "agent_settled", aborted: false })}
`);
  chmodSync(fakePi, 0o755);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: join(home, "data"), BAKERY_PORT: String(port), BAKERY_PI_BIN: fakePi, BAKERY_WT_BIN: join(home, "no-wt") },
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
    const board = (await request("/boards", "POST", { repo })).data;
    const card = (await request(`/boards/${board.id}/cards`, "POST", { title: "Live", body: "" })).data;
    const lists = async () => [
      (await request("/cards")).data.find((item: { id: string }) => item.id === card.id),
      (await request(`/boards/${board.id}/cards`)).data.find((item: { id: string }) => item.id === card.id),
    ];
    assert.equal((await request(`/boards/${board.id}/cards/${card.id}/status`, "POST", { status: "ready" })).data.status, "ready");
    for (const item of await lists()) assert.equal(item.live, null, "a card that has not run reports null");
    assert.equal((await request(`/boards/${board.id}/cards/${card.id}/start`, "POST")).status, 202);
    const until = Date.now() + 10_000;
    let running = await lists();
    while (running[0].live?.tool !== "tool" && Date.now() < until) { await new Promise(resolve => setTimeout(resolve, 50)); running = await lists(); }
    for (const item of running) {
      assert.equal(item.status, "running");
      // The latest tool wins, and a name that fails the worker's check falls back to "tool".
      assert.deepEqual([item.live?.tool, item.live?.turn], ["tool", 1]);
      assert.ok(!Number.isNaN(Date.parse(item.live.since)));
    }
    writeFileSync(release, "");
    const done = Date.now() + 10_000;
    let finished = await lists();
    while (finished[0].status === "running" && Date.now() < done) { await new Promise(resolve => setTimeout(resolve, 50)); finished = await lists(); }
    for (const item of finished) { assert.equal(item.status, "review"); assert.equal(item.live, null); }
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("close", resolve));
    }
    rmSync(home, { recursive: true, force: true });
  }
});
