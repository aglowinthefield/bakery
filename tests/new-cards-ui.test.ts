import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("new cards from elsewhere badge the sidebar, then highlight on the board and clear once opened", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const card = (id: string, title: string) => ({ id, title, body: "", repo: "/tmp/repo", source: "manual", status: "triage", priority: 0,
      createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0 });
    const cards = [card("old", "Old card"), card("cli", "Made by the CLI")];
    let unseen = ["cli"];
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const posted: Record<string, unknown>[] = [];
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
      if (path === "/api/boards/board/cards-seen") {
        await held;
        const cardIds = unseen;
        unseen = [];
        await route.fulfill({ json: { cardIds } });
        return;
      }
      if (path === "/api/boards/board/cards" && request.method() === "POST") {
        posted.push(request.postDataJSON());
        const made = card("ui", request.postDataJSON().title);
        cards.push(made);
        await route.fulfill({ status: 201, json: made });
        return;
      }
      const data: Record<string, unknown> = {
        "/api/boards": [
          { id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false, newCards: unseen.length },
          { id: "other", repo: "/tmp/other", autoCollapseEmptySwimlanes: false, newCards: 3 },
        ],
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
        "/api/boards/board/cards": cards,
        "/api/boards/board/conflicts": [],
        "/api/boards/other/cards": [],
        "/api/boards/other/conflicts": [],
      };
      assert.ok(path in data || path.startsWith("/api/boards/board/cards/"), `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] ?? {} });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);

    // Another board's count shows on its collapsed repo row; this board's shows on its Kanban entry until the visit marks it seen.
    const otherRow = page.getByRole("button", { name: "other", exact: true }).locator("xpath=..");
    await otherRow.getByRole("status", { name: "3 new cards" }).waitFor();
    await page.getByRole("button", { name: /Kanban/ }).getByRole("status", { name: "1 new card" }).waitFor();
    release();

    // Opening this board highlights only the unseen card; its own badge never shows.
    const tile = (title: string) => page.locator("[data-card-tile]", { hasText: title });
    await tile("Made by the CLI").locator("xpath=self::*[@data-new]").waitFor();
    assert.equal(await page.locator("[data-card-tile][data-new]").count(), 1);
    assert.equal(await tile("Made by the CLI").getByText("New", { exact: true }).count(), 1);
    assert.equal(await tile("Old card").getByText("New", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "repo", exact: true }).locator("xpath=../..").getByRole("status", { name: /new card/ }).count(), 0, "this board's badge is clear");

    // A card created in this UI is sent as UI-made and is never highlighted.
    await page.keyboard.press("n");
    await page.getByLabel("Title").fill("Typed here");
    await page.getByRole("button", { name: /^(Create|Save)/ }).click();
    await tile("Typed here").waitFor();
    assert.equal(posted[0].origin, "ui");
    assert.equal(await page.locator("[data-card-tile][data-new]").count(), 1);

    // Opening the highlighted card ends its highlight.
    await page.keyboard.press("Escape");
    await tile("Made by the CLI").click();
    await page.locator("[data-card-tile][data-new]").waitFor({ state: "detached" });
  } finally {
    await browser.close();
    await server.close();
  }
});
