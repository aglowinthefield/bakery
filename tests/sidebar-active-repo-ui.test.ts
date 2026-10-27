import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("clicking the already open repo in the sidebar does nothing", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // These tests cover the board, not the Today landing page.
    await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
    let cardLoads = 0;
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards/board/cards") cardLoads++;
      const data: Record<string, unknown> = {
        "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
        "/api/boards/board/cards": [{ id: "card", title: "Open card", body: "", repo: "/tmp/repo", source: "manual", status: "triage", createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0 }],
        "/api/boards/board/conflicts": [],
      };
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    const card = page.getByRole("button", { name: /Open card/ });
    await card.waitFor();
    await page.waitForTimeout(500);
    const loadsBefore = cardLoads;
    await page.getByRole("button", { name: "repo", exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await card.count(), 1, "cards stay on the board");
    assert.equal(cardLoads, loadsBefore, "cards are not reloaded");
  } finally {
    await browser.close();
    await server.close();
  }
});
