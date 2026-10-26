import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("sidebar shows an icon and card count for every status", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const card = (id: string, status: string) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual", status,
      createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0 });
    const cards = [card("a", "ready"), card("b", "ready"), card("c", "review"), card("d", "done"), card("e", "done"), card("f", "done")];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const data: Record<string, unknown> = {
        "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
        "/api/boards/board/cards": cards,
        "/api/boards/board/conflicts": [],
      };
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    const nav = page.getByRole("navigation", { name: "Card counts" });
    await nav.locator('[data-status="done"]').getByText("3", { exact: true }).waitFor();
    const expected: Record<string, number> = { triage: 0, ready: 2, running: 0, review: 1, failed: 0, interrupted: 0, done: 3, archived: 0 };
    for (const [status, count] of Object.entries(expected)) {
      const row = nav.locator(`[data-status="${status}"]`);
      assert.equal((await row.locator("span.font-mono").textContent())?.trim(), String(count), `${status} count`);
      const iconColor = await row.locator("svg.lane-status-icon").evaluate(el => getComputedStyle(el).color);
      const laneColor = await page.locator(`section[data-status="${status}"] .lane-status-dot`).evaluate(el => getComputedStyle(el).backgroundColor);
      assert.equal(iconColor, laneColor, `${status} icon matches lane color`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
