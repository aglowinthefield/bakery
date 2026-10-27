import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("every repo in the sidebar shows one condensed row of backlog, in progress and review counts", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // These tests cover the board, not the Today landing page.
    await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
    const card = (id: string, status: string) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual", status,
      createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0 });
    const cards = [card("a", "ready"), card("b", "ready"), card("c", "review"), card("d", "done"), card("e", "done"), card("f", "done")];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const data: Record<string, unknown> = {
        "/api/boards": [
          { id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false },
          { id: "other", repo: "/tmp/other", autoCollapseEmptySwimlanes: false, cardCounts: { running: 4, failed: 1 } },
        ],
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
        "/api/boards/board/cards": cards,
        "/api/boards/board/conflicts": [],
      };
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    const nav = page.getByRole("button", { name: "repo", exact: true }).locator("xpath=../..").getByRole("list", { name: "Card counts" });
    await nav.locator('[data-group="backlog"]').getByText("2", { exact: true }).waitFor();
    const repoButton = page.getByRole("button", { name: "repo", exact: true });
    const [repoBox, navBox] = [await repoButton.boundingBox(), await nav.boundingBox()];
    assert.ok(repoBox && navBox && navBox.x >= repoBox.x + repoBox.width - 1 && Math.abs(navBox.y + navBox.height / 2 - (repoBox.y + repoBox.height / 2)) < 4, "counts sit right-aligned on the repo row");
    assert.ok(await repoButton.locator("xpath=../..").locator('[aria-label="Card counts"]').count() === 1, "counts live in the repo's selection area");
    const items = nav.getByRole("listitem");
    const tops = await items.evaluateAll(els => els.map(el => el.getBoundingClientRect().top));
    assert.ok(tops.every(top => top === tops[0]), "counts sit on one row");
    // Done and Archive are left out, and Failed only shows when something failed.
    assert.deepEqual(await items.evaluateAll(els => els.map(el => el.getAttribute("aria-label"))), ["Backlog: 2", "In progress: 0", "Review: 1"]);
    for (const [group, status] of [["backlog", "ready"], ["in-progress", "running"], ["review", "review"]]) {
      const iconColor = await nav.locator(`[data-group="${group}"] svg.lane-status-icon`).evaluate(el => getComputedStyle(el).color);
      const laneColor = await page.locator(`section[data-status="${status}"] .lane-status-dot`).evaluate(el => getComputedStyle(el).backgroundColor);
      assert.equal(iconColor, laneColor, `${group} icon matches the ${status} lane color`);
    }
    const otherNav = page.getByRole("button", { name: "other", exact: true }).locator("xpath=../..").getByRole("list", { name: "Card counts" });
    assert.deepEqual(await otherNav.getByRole("listitem").evaluateAll(els => els.map(el => el.getAttribute("aria-label"))), ["Backlog: 0", "In progress: 4", "Review: 0", "Failed: 1"]);
    assert.equal(await otherNav.locator("svg.lane-status-icon").count(), 4, "unselected repo shows an icon per count");
  } finally {
    await browser.close();
    await server.close();
  }
});
