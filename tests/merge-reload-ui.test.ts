import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

// Approving a card on Bakery's own board merges into the checkout the dev server
// serves. The open card must survive the resulting hot update or page reload.

const card = (id: string, status: string, title: string) => ({
  id, title, body: "", repo: "/tmp/repo", source: "manual", status,
  createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0,
});
const boardCards = [card("a1b2c3d4-0000", "ready", "Fix login redirect"), card("e5f6a7b8-0000", "done", "Polish sidebar")];

async function openCard(server: ViteDevServer, page: Page) {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const data: Record<string, unknown> = {
      "/api/boards": [
        { id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false },
        { id: "other", repo: "/tmp/other", autoCollapseEmptySwimlanes: false },
      ],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "side", theme: "default" },
      "/api/boards/board/cards": boardCards,
      "/api/boards/board/conflicts": [],
      "/api/boards/other/cards": [],
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
  await page.locator("section[data-status]").getByText("Polish sidebar", { exact: true }).click();
  await page.getByRole("dialog").getByText("Polish sidebar").waitFor();
}

test("a page reload reopens the card this tab had open", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await openCard(server, page);
    // Another tab picking a different repo must not move this tab on reload.
    await page.evaluate(() => localStorage.setItem("bakery-board", "other"));
    await page.reload();
    await page.getByRole("dialog").getByText("Polish sidebar").waitFor();
    assert.match((await page.locator("h1").first().textContent()) ?? "", /repo/);

    // A closed card stays closed after the next reload.
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.reload();
    await page.locator("section[data-status]").getByText("Polish sidebar", { exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("a change to the app module hot-swaps without reloading the page", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await openCard(server, page);
    let reloads = 0;
    page.on("load", () => reloads++);
    const updated = page.waitForEvent("console", message => message.text().includes("hot updated"));
    const app = await server.moduleGraph.getModuleByUrl("/src/main.tsx");
    assert.ok(app, "main.tsx is in the module graph");
    await server.reloadModule(app);
    await updated;
    // A module that cannot Fast Refresh invalidates and reloads the page shortly after.
    await page.waitForTimeout(1500);
    assert.equal(reloads, 0, "the update reloaded the page");
    await page.getByRole("dialog").getByText("Polish sidebar").waitFor();
  } finally {
    await browser.close();
    await server.close();
  }
});
