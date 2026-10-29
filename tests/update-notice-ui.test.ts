import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

// While an update waits for active runs, clicking the notice lists those cards and opens one.

const card = (id: string, title: string) => ({
  id, title, body: "", repo: "/tmp/repo", source: "manual", status: "running",
  createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0,
});

test("the update notice lists the cards it waits on and opens one", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const data: Record<string, unknown> = {
        "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "side", theme: "default" },
        "/api/boards/board/cards": [card("a1b2c3d4-0000", "Fix login redirect")],
        "/api/boards/board/conflicts": [],
        "/api/cards": [],
        "/api/status": { draining: true, activeRuns: 1, cards: [{ id: "a1b2c3d4-0000", title: "Fix login redirect", repo: "/tmp/repo" }] },
      };
      if (/\/(runs|comments|auto-review)$/.test(path)) return route.fulfill({ json: [] });
      if (path.endsWith("/approval")) return route.fulfill({ json: { pending: false } });
      if (path.endsWith("/push-progress")) return route.fulfill({ json: null });
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByTestId("update-notice-toggle").click();
    await page.getByTestId("update-notice-cards").getByText("Fix login redirect").click();
    await page.getByRole("dialog").getByText("Fix login redirect").waitFor();
  } finally {
    await browser.close();
    await server.close();
  }
});
