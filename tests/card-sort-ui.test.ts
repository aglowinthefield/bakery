import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const card = (id: string, title: string, updatedAt: string, priority = 0) => ({
  id, title, body: "", repo: "/tmp/repo", source: "manual", status: "ready", priority,
  createdAt: "2026-01-01", updatedAt, turns: 0, turnsIncomplete: 0,
});

test("sort control reorders a lane and is remembered", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const data: Record<string, unknown> = {
        "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
        "/api/boards/board/cards": [
          card("a1a1a1a1-0", "Alpha", "2026-01-02", 5),
          card("b2b2b2b2-0", "Bravo", "2026-01-09"),
          card("c3c3c3c3-0", "Charlie", "2026-01-05"),
        ],
        "/api/boards/board/conflicts": [],
      };
      if (/\/(runs|comments|auto-review)$/.test(path)) return route.fulfill({ json: [] });
      if (path === "/api/status") return route.fulfill({ json: { draining: false, activeRuns: 0 } });
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    const lane = page.locator('section[data-status="ready"]');
    await lane.getByText("Alpha", { exact: true }).waitFor();
    const text = async () => (await lane.innerText()).match(/Alpha|Bravo|Charlie/g)!.join(",");
    assert.equal(await text(), "Alpha,Bravo,Charlie");
    const sort = page.getByRole("combobox", { name: "Sort cards" });
    await sort.selectOption("updated");
    assert.equal(await text(), "Bravo,Charlie,Alpha");
    await page.reload();
    await lane.getByText("Alpha", { exact: true }).waitFor();
    assert.equal(await sort.inputValue(), "updated");
    assert.equal(await text(), "Bravo,Charlie,Alpha");
  } finally {
    await browser.close();
    await server.close();
  }
});
