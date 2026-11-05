import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("Cards in any lane can be multi-selected and moved with the dropdown, here Done into the Archive lane", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const card = (id: string, status: string) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual", status,
      createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0 });
    let cards = [card("one", "done"), card("two", "done"), card("three", "done"), card("open", "ready")];
    const requests: string[][] = [];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards/board/cards/archive" && route.request().method() === "POST") {
        const ids: string[] = route.request().postDataJSON().cardIds;
        requests.push(ids);
        cards = cards.map(item => ids.includes(item.id) ? { ...item, status: "archived" } : item);
        await route.fulfill({ json: cards.filter(item => ids.includes(item.id)) }); return;
      }
      const data: Record<string, unknown> = {
        "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
        "/api/boards/board/cards": cards,
        "/api/boards/board/conflicts": [],
      };
      if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    const done = page.locator('section[data-status="done"]');
    await done.getByRole("button", { name: /one card/ }).waitFor();
    assert.equal(await page.locator('section[data-status="ready"]').getByRole("button", { name: "Select in Ready" }).count(), 1, "every lane with movable cards offers selection");
    assert.equal(await page.locator('section[data-status="review"]').getByRole("button", { name: /^Select/ }).count(), 0, "lanes with no moves offer none");
    const total = page.locator("span", { hasText: /^\s*\d+\s+cards$/ }).locator("strong");
    assert.equal(await total.textContent(), "4");

    await done.getByRole("button", { name: "Select in Done" }).click();
    const archive = done.getByRole("button", { name: "Move", exact: true });
    const target = done.getByLabel("Move selected cards to");
    assert.equal(await archive.isDisabled(), true, "nothing selected yet");
    await done.getByRole("checkbox", { name: "Select one card" }).check();
    await done.getByRole("checkbox", { name: "Select three card" }).check();
    await done.getByText("2 selected").waitFor();
    assert.equal(await done.getByRole("checkbox", { name: "Select all" }).evaluate(el => (el as HTMLInputElement).indeterminate), true);
    await target.selectOption({ label: "Archive" });
    await archive.click();
    await done.getByRole("button", { name: /two card/ }).waitFor();
    assert.deepEqual(requests, [["one", "three"]]);
    // "two card" was already in Done, so wait for the refreshed total rather than reading it once.
    await total.filter({ hasText: /^2$/ }).waitFor({ timeout: 5000 }).catch(() => {});
    assert.equal(await total.textContent(), "2", "archived cards are excluded from the total");
    assert.equal(await done.getByRole("checkbox").count(), 0, "selection mode ends after archiving");

    await page.getByRole("button", { name: "Expand Archive lane" }).click();
    const archived = page.locator('section[data-status="archived"]');
    await archived.getByRole("button", { name: /one card/ }).waitFor();
    assert.equal(await archived.getByRole("button", { name: /three card/ }).isVisible(), true);

    await done.getByRole("button", { name: "Select in Done" }).click();
    await done.getByRole("checkbox", { name: "Select all" }).check();
    await done.getByText("1 selected").waitFor();
    await target.selectOption({ label: "Archive" });
    await done.getByRole("button", { name: "Move", exact: true }).click();
    await archived.getByRole("button", { name: /two card/ }).waitFor();
    assert.deepEqual(requests, [["one", "three"], ["two"]]);
    assert.equal(await done.getByText("Nothing here yet.").isVisible(), true);
    assert.equal(await page.getByRole("button", { name: /open card/ }).isVisible(), true, "other lanes are untouched");
  } finally { await browser.close(); await server.close(); }
});
