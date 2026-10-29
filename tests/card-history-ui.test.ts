import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("Details has a collapsed History that lists state changes with reasons, newest first", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const card = { id: "card", title: "Backfill", body: "", repo: "/tmp/repo", source: "manual", status: "review", priority: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0, attempts: 2, reviewRounds: 0, runAgent: "", reviewAgent: "", dependsOn: [], blocked: false };
    const history = [
      { at: "2026-01-01T10:00:00.000Z", from: null, to: null, text: "Card created" },
      { at: "2026-01-01T10:05:00.000Z", from: "running", to: "review", text: "Attempt 1 finished; waiting for review" },
      { at: "2026-01-01T10:09:00.000Z", from: null, to: null, text: "Agent reviewer requested changes of attempt 1", detail: "Fix the budget check" },
      { at: "2026-01-01T10:09:01.000Z", from: null, to: null, text: "The agent reviewer sent this back, but Bakery could not start the new attempt: Repository is at its 2-run concurrency limit" },
    ];
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": [card],
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/card/runs": [],
      "/api/boards/board/cards/card/approval": { pending: false },
      "/api/boards/board/cards/card/push-progress": null,
      "/api/boards/board/cards/card/comments": [],
      "/api/boards/board/cards/card/auto-review": [],
      "/api/boards/board/cards/card/history": history,
      "/api/boards/board/cards/card/review": { fingerprint: "a".repeat(64), files: [] },
      "/api/boards/board/cards/card/pr-draft": { startedAt: 0, steps: [], fingerprint: null },
      "/api/status": { draining: false, activeRuns: 0 },
    };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await page.getByRole("button", { name: /Backfill/ }).click();
    await page.getByRole("tab", { name: "Details" }).click();
    const section = page.getByTestId("card-history");
    await section.waitFor();
    assert.equal(await section.evaluate(element => (element as HTMLDetailsElement).open), false, "collapsed by default");
    await section.getByText("History (4)").click();
    const items = await section.locator("li").allTextContents();
    assert.equal(items.length, 4);
    assert.match(items[0], /could not start the new attempt: Repository is at its 2-run concurrency limit/, "newest first");
    assert.match(items[1], /Agent reviewer requested changes of attempt 1.*Fix the budget check/);
    assert.match(items[2], /Running → Review.*Attempt 1 finished/);
    assert.match(items[3], /Card created/);
  } finally { await browser.close(); await server.close(); }
});
