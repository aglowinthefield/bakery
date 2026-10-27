import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../scripts/bakery-cli.mjs", import.meta.url));
const board = { id: "board-one", repo: "/tmp/bakery-project", autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: 6, autoPickupStarts: 6, autoPickupNextAt: "2026-10-26T07:04:01.000Z", autoReviewEnabled: false, autoPickupError: "" };

const cards = [
  { id: "card-one", title: "Make an improvement", body: "Line one\nLine two", repo: board.repo, status: "triage", priority: 1, attempts: 3, reviewRounds: 2 },
  { id: "card-done", title: "Finished", body: "", repo: board.repo, status: "done", attempts: 0, reviewRounds: 0 },
  { id: "card-old", title: "Old work", body: "", repo: board.repo, status: "archived", attempts: 0, reviewRounds: 0 },
];

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
    else if (path === `/api/boards/${board.id}/cards` && req.method === "GET") data = cards;
    else if (/^\/api\/boards\/board-one\/cards\/[\w-]+$/.test(path) && req.method === "PATCH") {
      const card = cards.find(item => item.id === path.split("/")[5]);
      if (!card) { res.writeHead(404); res.end(JSON.stringify({ error: "Card not found on this board" })); return; }
      data = { ...card, ...(input as object) };
    }
    else if (/^\/api\/boards\/board-one\/cards\/(archive|unarchive)$/.test(path) && req.method === "POST") {
      const archive = path.endsWith("/archive"), ids = (input as { cardIds: string[] }).cardIds;
      if (ids.some(id => cards.find(item => item.id === id)?.status !== (archive ? "done" : "archived"))) {
        res.writeHead(400); res.end(JSON.stringify({ error: archive ? "Only Done cards can be archived" : "Only archived cards can be restored" })); return;
      }
      data = ids.map(id => ({ ...cards.find(item => item.id === id), status: archive ? "archived" : "done" }));
    }
    else if (path === `/api/boards/${board.id}/cards` && req.method === "POST") data = { id: "new-card", ...(input as object), status: "triage" };
    else if (path === `/api/boards/${board.id}/cards/card-one/status` && req.method === "POST") data = { id: "card-one", status: (input as { status: string }).status };
    else if (/^\/api\/boards\/board-one\/cards\/card-(one|two)\/start$/.test(path) && req.method === "POST") data = { id: `run-${path.split("/")[5]}`, attempt: 2, status: "running" };
    else if (path === `/api/boards/${board.id}/cards/card-three/start` && req.method === "POST") { res.writeHead(400); res.end(JSON.stringify({ error: "Move this card to Ready before starting a run" })); return; }
    else if (path === `/api/boards/${board.id}/cards/card-one/runs`) data = [
      { id: "run-two", attempt: 2, status: "review", agent: "pi/claude", error: null, startedBy: "manual", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, cacheWriteTokens: 100, cost: 0.42 },
      { id: "run-one", attempt: 1, status: "failed", agent: "", error: "Pi exited with code 1", startedBy: "auto", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cost: null },
    ];
    else if (path === `/api/boards/${board.id}/cards/card-one/auto-review`) data = [{ runId: "run-two", state: "needs_human", details: "Verification failed", agent: "", inputTokens: 800, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.08 }];
    else if (/^\/api\/boards\/board-one\/cards\/card-done\/(runs|auto-review)$/.test(path)) data = [];
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
    assert.match((await f.run("cards")).stdout, /card-one\ttriage\tpriority:high\tattempts:3\treview-rounds:2\tMake an improvement/);
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
    const urgent = await f.run("create", "--title", "Hotfix", "--priority", "urgent");
    assert.equal(urgent.code, 0, urgent.stderr);
    const bad = await f.run("create", "--title", "Nope", "--priority", "critical");
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /Priority must be low, normal, high, or urgent/);
    assert.match((await f.run("cards", "--priority", "high")).stderr, /only valid with create/);
    const keyed = await f.run("create", "--title", "Scripted", "--key", "nightly-1");
    assert.equal(keyed.code, 0, keyed.stderr);
    assert.equal(keyed.stdout, "new-card\ttriage\tpriority:normal\tScripted\n");
    assert.match((await f.run("cards", "--key", "nightly-1")).stderr, /only valid with create/);
    assert.match((await f.run("create", "--title", "Long", "--key", "k".repeat(201))).stderr, /1 to 200/);
    assert.deepEqual(f.requests.filter(r => r.method === "POST").map(r => r.input), [{ status: "ready" }, { title: "New task", body: "Do it safely" }, { status: "triage" }, { title: "Hotfix", body: "", priority: "urgent" }, { title: "Scripted", body: "", idempotencyKey: "nightly-1" }]);
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

test("show prints the card, its attempts and the latest auto-review verdict", async () => {
  const f = await fixture();
  try {
    const shown = await f.run("show", "card-one");
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^Make an improvement$/m);
    assert.match(shown.stdout, /^status\ttriage$/m);
    assert.match(shown.stdout, /^repo\t\/tmp\/bakery-project$/m);
    assert.match(shown.stdout, /^Line one\nLine two$/m);
    assert.match(shown.stdout, /^#2\treview\tpi\/claude$/m);
    assert.match(shown.stdout, /^#1\tfailed\t-\tPi exited with code 1$/m);
    assert.match(shown.stdout, /^auto-review\tneeds_human\tVerification failed$/m);
    const json = JSON.parse((await f.run("show", "card-one", "--json")).stdout);
    assert.equal(json.card.id, "card-one");
    assert.equal(json.runs.length, 2);
    assert.equal(json.review.runId, "run-two");
    const unstarted = (await f.run("show", "card-done")).stdout;
    assert.match(unstarted, /^\(no description\)$/m);
    assert.match(unstarted, /^attempts\t0\nauto-review\tnone$/m);
    const missing = await f.run("show", "card-gone");
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /Card not found on this board: card-gone/);
    assert.notEqual((await f.run("show", "../evil")).code, 0);
  } finally { await f.close(); }
});

test("edit patches title and description, keeping the field not supplied", async () => {
  const f = await fixture();
  try {
    assert.match((await f.run("edit", "card-one")).stderr, /--title TITLE and\/or --body BODY/);
    assert.match((await f.run("cards", "--title", "x")).stderr, /only valid with create or edit/);
    assert.match((await f.run("edit", "card-one", "--title", "  ")).stderr, /cannot be empty/);
    assert.equal((await f.run("edit", "card-one", "--title", "Renamed")).code, 0);
    assert.equal((await f.run("edit", "card-one", "--body", "")).code, 0);
    const both = await f.run("edit", "card-one", "--title", "T", "--body", "B", "--json");
    assert.equal(both.code, 0, both.stderr);
    assert.equal(JSON.parse(both.stdout).title, "T");
    assert.deepEqual(f.requests.filter(r => r.method === "PATCH").map(r => [r.path, r.input]), [
      [`/api/boards/${board.id}/cards/card-one`, { title: "Renamed", body: "Line one\nLine two" }],
      [`/api/boards/${board.id}/cards/card-one`, { title: "Make an improvement", body: "" }],
      [`/api/boards/${board.id}/cards/card-one`, { title: "T", body: "B" }],
    ]);
    assert.equal(f.requests.filter(r => r.path.endsWith("/cards")).length, 2, "both fields given needs no lookup");
  } finally { await f.close(); }
});

test("archive takes Done cards, restore brings one back, and refusals are reported", async () => {
  const f = await fixture();
  try {
    const archived = await f.run("archive", "card-done");
    assert.equal(archived.code, 0, archived.stderr);
    assert.match(archived.stdout, /^card-done\tarchived\tFinished$/m);
    const refused = await f.run("archive", "card-done", "card-one");
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /Only Done cards can be archived/);
    const restored = await f.run("restore", "card-old", "--json");
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout)[0].status, "done");
    assert.match((await f.run("restore", "card-old", "card-done")).stderr, /Invalid arguments for restore/);
    assert.notEqual((await f.run("archive", "card-done", "../evil")).code, 0);
    assert.match((await f.run("archive", "card-done", "--yes")).stderr, /--yes is only valid/);
    assert.deepEqual(f.requests.filter(r => r.method === "POST").map(r => [r.path, r.input]), [
      [`/api/boards/${board.id}/cards/archive`, { cardIds: ["card-done"] }],
      [`/api/boards/${board.id}/cards/archive`, { cardIds: ["card-done", "card-one"] }],
      [`/api/boards/${board.id}/cards/unarchive`, { cardIds: ["card-old"] }],
    ]);
  } finally { await f.close(); }
});

test("stats prints per-lane counts and pickup state for the selected board", async () => {
  const f = await fixture([{ ...board, cardCounts: { triage: 2, review: 1, done: 4 } }, { ...board, id: "board-two", repo: "/tmp/another-project", cardCounts: { ready: 9 } }]);
  try {
    assert.match((await f.run("stats")).stderr, /More than one board/);
    const stats = await f.run("stats", "--board", board.id);
    assert.equal(stats.code, 0, stats.stderr);
    assert.match(stats.stdout, /^triage\t2\nready\t0\nrunning\t0\nreview\t1\nfailed\t0\ninterrupted\t0\ndone\t4\narchived\t0\ntotal\t7\nPickup on; concurrency 2; 6\/6 starts/m);
    const json = JSON.parse((await f.run("stats", "--board", board.repo, "--json")).stdout);
    assert.equal(json.boardId, board.id);
    assert.equal(json.total, 7);
    assert.equal(json.counts.ready, 0);
    assert.equal(json.pickup.autoPickupEnabled, true);
    assert.equal(f.requests.filter(r => r.path !== "/api/boards").length, 0, "stats uses only the boards list");
  } finally { await f.close(); }
});
