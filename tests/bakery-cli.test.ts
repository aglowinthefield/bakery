import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../scripts/bakery-cli.mjs", import.meta.url));
const board = { id: "board-one", repo: "/tmp/bakery-project", autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: 6, autoPickupStarts: 6, autoPickupNextAt: "2026-10-26T07:04:01.000Z", autoReviewEnabled: false, autoPickupError: "" };

async function fixture(boards: object[] = [board]) {
  const requests: { method: string; path: string; input: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const input = text ? JSON.parse(text) : undefined;
    const path = req.url ?? "";
    requests.push({ method: req.method ?? "GET", path, input });
    res.setHeader("content-type", "application/json");
    let data: unknown;
    if (path === "/api/boards") data = boards;
    else if (path === `/api/boards/${board.id}/cards` && req.method === "GET") data = [{ id: "card-one", title: "Make an improvement", status: "triage" }];
    else if (path === `/api/boards/${board.id}/cards` && req.method === "POST") data = { id: "new-card", ...(input as object), status: "triage" };
    else if (path === `/api/boards/${board.id}/cards/card-one/status` && req.method === "POST") data = { id: "card-one", status: (input as { status: string }).status };
    else if (/^\/api\/boards\/board-one\/cards\/card-(one|two)\/start$/.test(path) && req.method === "POST") data = { id: `run-${path.split("/")[5]}`, attempt: 2, status: "running" };
    else if (path === `/api/boards/${board.id}/cards/card-three/start` && req.method === "POST") { res.writeHead(400); res.end(JSON.stringify({ error: "Move this card to Ready before starting a run" })); return; }
    else if (path === `/api/boards/${board.id}/cards/card-one/runs`) data = [
      { id: "run-two", status: "review", startedBy: "manual", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, cacheWriteTokens: 100, cost: 0.42 },
      { id: "run-one", status: "failed", startedBy: "auto", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cost: null },
    ];
    else if (path === `/api/boards/${board.id}/cards/card-one/auto-review`) data = [{ runId: "run-two", state: "needs_human", agent: "", inputTokens: 800, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.08 }];
    else if (path === `/api/boards/${board.id}/conflicts`) data = [{ cardId: "card-one", details: "merge conflict" }];
    else if (path === `/api/boards/${board.id}/settings` && req.method === "PATCH") data = { ...board, ...(input as object) };
    else if (path === `/api/boards/${board.id}/auto-pickup/reset-limit` && req.method === "POST") data = { ...board, autoPickupStarts: 0, autoPickupNextAt: null };
    else { res.writeHead(404); res.end(JSON.stringify({ error: "Not found" })); return; }
    res.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const run = async (...args: string[]) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, BAKERY_URL: `http://127.0.0.1:${port}` } });
    let stdout = "", stderr = "";
    for await (const chunk of child.stdout) stdout += chunk;
    for await (const chunk of child.stderr) stderr += chunk;
    const code = await new Promise<number | null>(resolve => child.once("close", resolve));
    return { code, stdout, stderr };
  };
  return { requests, run, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("lists boards, cards, runs and conflicts through the HTTP API", async () => {
  const f = await fixture();
  try {
    assert.match((await f.run("boards")).stdout, /bakery-project/);
    assert.match((await f.run("cards")).stdout, /card-one.*Make an improvement/);
    const runs = JSON.parse((await f.run("runs", "card-one", "--json")).stdout);
    assert.equal(runs.cardId, "card-one");
    assert.deepEqual(runs.runs.map((run: { id: string }) => run.id), ["run-two", "run-one"]);
    assert.equal(runs.reviews.length, 1);
    assert.deepEqual(runs.total, { inputTokens: 2000, outputTokens: 320, cacheReadTokens: 5000, cacheWriteTokens: 100, cost: 0.5, incomplete: true });
    const text = (await f.run("runs", "card-one")).stdout;
    assert.match(text, /run-two.*\$0\.42 \(1200 in, 300 out, 5000 cache read, 100 cache write\)/);
    assert.match(text, /run-one\tfailed.*\t—/, "an older attempt without usage shows a dash, not $0");
    assert.match(text, /^total\t\$0\.50 .*older attempts not recorded/m);
    assert.match((await f.run("conflicts")).stdout, /merge conflict/);
    assert.deepEqual(f.requests.map(r => r.path), ["/api/boards", "/api/boards", `/api/boards/${board.id}/cards`, "/api/boards", `/api/boards/${board.id}/cards/card-one/runs`, `/api/boards/${board.id}/cards/card-one/auto-review`,
      "/api/boards", `/api/boards/${board.id}/cards/card-one/runs`, `/api/boards/${board.id}/cards/card-one/auto-review`, "/api/boards", `/api/boards/${board.id}/conflicts`]);
  } finally { await f.close(); }
});

test("card creation and status changes go through the API; Ready needs consent when pickup is on", async () => {
  const f = await fixture();
  try {
    const unconfirmed = await f.run("ready", "card-one");
    assert.notEqual(unconfirmed.code, 0);
    assert.match(unconfirmed.stderr, /--yes/);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    const ready = await f.run("ready", "card-one", "--yes");
    assert.equal(ready.code, 0, ready.stderr);
    const created = await f.run("create", "--title", "New task", "--body", "Do it safely", "--json");
    assert.equal(created.code, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).id, "new-card");
    const triage = await f.run("triage", "card-one");
    assert.equal(triage.code, 0, triage.stderr);
    assert.deepEqual(f.requests.filter(r => r.method === "POST").map(r => r.input), [{ status: "ready" }, { title: "New task", body: "Do it safely" }, { status: "triage" }]);
  } finally { await f.close(); }
});

test("pickup enable needs consent; disable and concurrency changes use settings API", async () => {
  const f = await fixture();
  try {
    assert.notEqual((await f.run("pickup", "on")).code, 0);
    assert.equal(f.requests.filter(r => r.method === "PATCH").length, 0);
    const enabled = await f.run("pickup", "on", "--concurrency", "2", "--limit", "99", "--yes");
    assert.equal(enabled.code, 0, enabled.stderr);
    const disabled = await f.run("pickup", "off");
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.deepEqual(f.requests.filter(r => r.method === "PATCH").map(r => r.input), [
      { autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: 99 },
      { autoPickupEnabled: false, pickupConcurrency: 2, pickupDailyLimit: 6 },
    ]);
  } finally { await f.close(); }
});

test("pickup shows the rolling limit and requires consent to reset it", async () => {
  const f = await fixture();
  try {
    assert.match((await f.run("pickup")).stdout, /6\/6 starts.*next slot/);
    assert.match((await f.run("pickup", "reset")).stderr, /--yes/);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    const reset = await f.run("pickup", "reset", "--yes");
    assert.equal(reset.code, 0, reset.stderr);
    assert.match(reset.stdout, /0\/6 starts/);
    assert.equal(f.requests.filter(r => r.method === "POST")[0].path, `/api/boards/${board.id}/auto-pickup/reset-limit`);
  } finally { await f.close(); }
});

test("ambiguous boards require a selector and bad card ids fail before mutation", async () => {
  const f = await fixture([board, { ...board, id: "board-two", repo: "/tmp/another-project" }]);
  try {
    assert.match((await f.run("cards")).stderr, /More than one board/);
    assert.match((await f.run("cards", "--board", board.repo)).stdout, /card-one/);
    assert.notEqual((await f.run("ready", "../evil", "--board", board.id, "--yes")).code, 0);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
  } finally { await f.close(); }
});

test("start needs consent, starts each card independently, and reports refusals", async () => {
  const f = await fixture();
  try {
    const unconfirmed = await f.run("start", "card-one", "card-two");
    assert.notEqual(unconfirmed.code, 0);
    assert.match(unconfirmed.stderr, /2 runs uses paid Pi.*--yes/);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    assert.notEqual((await f.run("start", "../evil", "--yes")).code, 0);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 0);
    const started = await f.run("start", "card-one", "card-three", "card-two", "--yes");
    assert.equal(started.code, 1);
    assert.match(started.stdout, /card-one\tattempt #2\trunning/);
    assert.match(started.stdout, /card-three\terror\tBakery 400: Move this card to Ready/);
    assert.match(started.stdout, /card-two\tattempt #2\trunning/);
    assert.deepEqual(f.requests.filter(r => r.method === "POST").map(r => r.path), ["card-one", "card-three", "card-two"].map(id => `/api/boards/${board.id}/cards/${id}/start`));
  } finally { await f.close(); }
});

test("pickup shows 24-hour spend and sets or clears an optional cost budget", async () => {
  const f = await fixture([{ ...board, cost24h: 4.5, pickupCostBudget: 4, autoPickupBudgetReached: true }]);
  try {
    assert.match((await f.run("pickup")).stdout, /\$4\.50 spent in 24h of \$4\.00 budget \(waiting: budget reached\)/);
    assert.match((await f.run("pickup", "on", "--budget", "-1", "--yes")).stderr, /Budget must be off/);
    assert.match((await f.run("runs", "card-one", "--budget", "5")).stderr, /only valid with pickup/);
    assert.equal((await f.run("pickup", "on", "--budget", "$12.5", "--yes")).code, 0);
    assert.equal((await f.run("pickup", "off", "--budget", "off")).code, 0);
    assert.deepEqual(f.requests.filter(r => r.method === "PATCH").map(r => (r.input as { pickupCostBudget?: unknown }).pickupCostBudget), [12.5, null]);
  } finally { await f.close(); }
});
