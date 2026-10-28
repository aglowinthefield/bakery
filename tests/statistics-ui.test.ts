import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { buildStats } from "../server/stats.js";

let server: ViteDevServer;
let browser: Browser;
let url: string;

before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

const board = { autoCollapseEmptySwimlanes: false, autoPickupEnabled: false, autoReviewEnabled: false, icon: "rocket", color: "violet", cardCounts: {} };
const boards = [{ ...board, id: "board-a", repo: "/code/alpha" }, { ...board, id: "board-b", repo: "/code/beta" }];
const now = Date.now();
const run = (over: object) => ({ repo: "/code/alpha", cardId: "c", status: "review", startedBy: "manual", agent: "pi · sonnet", ciFix: 0, startedAt: new Date(now - 3_600_000).toISOString(), finishedAt: new Date(now - 3_000_000).toISOString(), cost: 1.5, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100, ...over });
const data = { runs: [run({}), run({ status: "failed", cost: 0.5 }), run({ repo: "/code/beta", agent: "pi · opus", startedBy: "auto" })], reviews: [], cards: [] };

test("Statistics charts the aggregated stats and refetches when the range or repository changes", async () => {
  const page = await browser.newPage();
  const queries: string[] = [];
  await page.route("**/api/**", async route => {
    const request = new URL(route.request().url());
    if (request.pathname === "/api/boards") return route.fulfill({ json: boards });
    if (request.pathname === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, notifyOnReview: false, cardDetailsLayout: "dialog", theme: "default" } });
    if (request.pathname === "/api/stats") {
      queries.push(request.search);
      const repo = request.searchParams.get("repo"), days = request.searchParams.get("days");
      return route.fulfill({ json: buildStats(data, { days: days === "all" ? null : Number(days), repo }) });
    }
    return route.fulfill({ json: [] });
  });
  try {
    await page.goto(url);
    await page.getByRole("button", { name: "Statistics" }).click();
    await page.getByRole("heading", { name: "Statistics" }).waitFor();
    await page.getByText("$3.50").first().waitFor();
    assert.equal(await page.locator(".recharts-wrapper").count(), 6);
    assert.deepEqual(queries, ["?days=30"]);
    await page.getByRole("combobox", { name: "Time range" }).selectOption("7");
    await page.getByRole("combobox", { name: "Repository" }).selectOption({ label: "beta" });
    await page.getByText("$1.50").first().waitFor();
    assert.equal(queries.at(-1), `?days=7&repo=${encodeURIComponent("/code/beta")}`);
    await page.reload();
    await page.getByRole("heading", { name: "Statistics" }).waitFor();
  } finally { await page.close(); }
});
