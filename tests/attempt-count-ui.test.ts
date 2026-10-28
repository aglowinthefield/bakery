import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("cards that needed rework show their attempt count in every lane and review rounds in details", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // These tests cover the board, not the Today landing page.
    await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
    const card = (id: string, status: string, attempts: number, reviewRounds: number) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual", status,
      createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0, attempts, reviewRounds, runAgent: "", reviewAgent: "" });
    const run = (attempt: number) => ({ id: `run-${attempt}`, attempt, status: "review", output: "", error: null, worktree: null, startedAt: "2026-01-01", finishedAt: "2026-01-01", startedBy: "manual", agent: "" });
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": [card("once", "ready", 1, 0), card("reworked", "done", 3, 2), card("old", "archived", 2, 1)],
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/reworked/runs": [run(3), run(2), run(1)],
      "/api/boards/board/cards/reworked/approval": { pending: false },
      "/api/boards/board/cards/reworked/push-progress": null,
      "/api/boards/board/cards/reworked/comments": [],
      "/api/boards/board/cards/reworked/auto-review": [],
    };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    const lane = (status: string) => page.locator(`section[data-status="${status}"]`);
    const done = lane("done").getByRole("button", { name: /reworked card/ });
    await done.waitFor();
    assert.equal((await done.getByTestId("attempt-count").textContent())?.trim(), "3 attempts");
    assert.equal(await done.getByTestId("attempt-count").getAttribute("title"), "3 attempts · 2 review rounds (Request changes)");
    assert.equal(await lane("ready").getByTestId("attempt-count").count(), 0, "a single attempt shows no badge");
    await page.getByRole("button", { name: "Expand Archive lane" }).click();
    const archived = lane("archived").getByRole("button", { name: /old card/ });
    await archived.waitFor();
    assert.equal((await archived.getByTestId("attempt-count").textContent())?.trim(), "2 attempts");
    await done.click();
    await page.getByRole("tab", { name: /^Attempts/ }).click();
    const summary = page.getByTestId("rework-summary");
    await summary.waitFor();
    assert.equal((await summary.textContent())?.trim(), "3 attempts · 2 review rounds (Request changes)");
  } finally {
    await browser.close();
    await server.close();
  }
});
