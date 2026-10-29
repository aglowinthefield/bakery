import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const card = (id: string, status: string, title: string, body = "") => ({
  id, title, body, repo: "/tmp/repo", source: "manual", status,
  createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0,
});

const boardCards = [
  card("a1b2c3d4-0000", "triage", "Fix login redirect"),
  card("e5f6a7b8-0000", "ready", "Polish sidebar", "Tweak the Lantern spacing"),
  card("c9d0e1f2-0000", "review", "Add export button"),
  card("f3a4b5c6-0000", "done", "Archive old runs", "mentions a1b2 in the body"),
];
const otherCards = [card("9999aaaa-0000", "ready", "Other board card")];

test("search filters cards by title, body, and ID prefix and clears", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const data: Record<string, unknown> = {
        "/api/boards": [
          { id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false },
          { id: "other", repo: "/tmp/other", autoCollapseEmptySwimlanes: false },
        ],
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
        "/api/boards/board/cards": boardCards,
        "/api/boards/board/conflicts": [],
        "/api/boards/other/cards": otherCards,
        "/api/boards/other/conflicts": [],
      };
      if (/\/(runs|comments|auto-review)$/.test(path)) return route.fulfill({ json: [] });
      if (path.endsWith("/approval")) return route.fulfill({ json: { pending: false } });
      if (path.endsWith("/push-progress")) return route.fulfill({ json: null });
      if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await page.getByRole("button", { name: "repo", exact: true }).click();
    const lanes = page.locator("section[data-status]");
    const shown = (title: string) => lanes.getByText(title, { exact: true });
    await shown("Fix login redirect").waitFor();

    const search = page.getByRole("searchbox", { name: "Search cards" });
    const hint = page.getByRole("status", { name: "Search results" });
    const laneCount = (status: string) =>
      page.locator(`section[data-status="${status}"] span.font-mono`).first().textContent();

    // Title match, case-insensitive.
    await search.fill("EXPORT");
    await shown("Fix login redirect").waitFor({ state: "detached" });
    assert.equal(await shown("Add export button").count(), 1);
    assert.equal(await hint.textContent(), "1 of 4 cards");
    assert.equal((await laneCount("review"))?.trim(), "1");
    assert.equal((await laneCount("triage"))?.trim(), "0");

    // Body match.
    await search.fill("lantern");
    await shown("Polish sidebar").waitFor();
    assert.equal(await shown("Add export button").count(), 0);
    assert.equal(await hint.textContent(), "1 of 4 cards");

    // Opening and closing card details keeps the filter.
    await shown("Polish sidebar").click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await search.inputValue(), "lantern");
    assert.equal(await shown("Add export button").count(), 0);
    assert.equal(await hint.textContent(), "1 of 4 cards");

    // ID prefix match; also matches a body mentioning the same text.
    await search.fill("A1B2");
    await shown("Fix login redirect").waitFor();
    assert.equal(await shown("Archive old runs").count(), 1);
    assert.equal(await shown("Polish sidebar").count(), 0);
    assert.equal(await hint.textContent(), "2 of 4 cards");

    // ID matches only as a prefix: an inner ID fragment doesn't match.
    await search.fill("c3d4");
    await shown("Fix login redirect").waitFor({ state: "detached" });
    assert.equal(await hint.textContent(), "0 of 4 cards");

    // Clear (×) button restores everything.
    await page.getByRole("button", { name: "Clear search" }).click();
    assert.equal(await search.inputValue(), "");
    await shown("Fix login redirect").waitFor();
    assert.equal(await hint.count(), 0);
    assert.equal((await laneCount("triage"))?.trim(), "1");

    // `/` focuses the box; Esc clears it.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("/");
    assert.ok(await search.evaluate(el => el === document.activeElement), "/ focuses search");
    await page.keyboard.type("polish");
    await shown("Fix login redirect").waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    assert.equal(await search.inputValue(), "");
    await shown("Fix login redirect").waitFor();

    // Switching boards resets the filter.
    await search.fill("polish");
    await shown("Fix login redirect").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "other", exact: true }).click();
    await page.getByRole("button", { name: "Kanban" }).click();
    await shown("Other board card").waitFor();
    assert.equal(await search.inputValue(), "");
  } finally {
    await browser.close();
    await server.close();
  }
});
