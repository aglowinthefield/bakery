import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("a blocked Ready card shows a waiting badge, and details list, link, add and remove dependencies", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // These tests cover the board, not the Today landing page.
    await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
    const card = (id: string, status: string, dependsOn: string[] = [], blocked = false) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual", status, priority: 0,
      createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0, attempts: 0, reviewRounds: 0, runAgent: "", reviewAgent: "", dependsOn, blocked });
    const cards = [card("child", "ready", ["parent", "merged"], true), card("parent", "running"), card("merged", "done"), card("free", "ready")];
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": cards,
      "/api/boards/board/conflicts": [],
    };
    for (const id of ["child", "parent"]) Object.assign(data, {
      [`/api/boards/board/cards/${id}/runs`]: [],
      [`/api/boards/board/cards/${id}/approval`]: { pending: false },
      [`/api/boards/board/cards/${id}/push-progress`]: null,
      [`/api/boards/board/cards/${id}/comments`]: [],
      [`/api/boards/board/cards/${id}/auto-review`]: [],
    });
    const changes: { method: string; path: string; input: unknown }[] = [];
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path.startsWith("/api/boards/board/cards/child/dependencies")) {
        changes.push({ method: request.method(), path, input: request.postDataJSON() });
        await route.fulfill({ json: cards[0] });
        return;
      }
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    const ready = page.locator('section[data-status="ready"]');
    const child = ready.getByRole("button", { name: /child card/ });
    await child.waitFor();
    // A blocked card stays in Ready; only one of its two dependencies is unfinished.
    assert.equal((await child.getByTestId("waiting-badge").textContent())?.trim(), "Waiting on 1");
    assert.equal(await child.getByTestId("waiting-badge").getAttribute("title"), "Starts after parent card is Done");
    assert.equal(await ready.getByRole("button", { name: /free card/ }).getByTestId("waiting-badge").count(), 0);

    await child.click();
    const details = page.getByRole("region", { name: "Dependencies" });
    await details.waitFor();
    assert.deepEqual(await details.getByTestId("dependency").evaluateAll(items => items.map(item => item.textContent)), ["parent cardrunningRemove", "merged cardfinishedRemove"]);
    await details.getByRole("button", { name: "Remove dependency on parent card" }).click();
    for (let i = 0; i < 50 && !changes.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(changes, [{ method: "DELETE", path: "/api/boards/board/cards/child/dependencies/parent", input: null }]);
    const add = details.getByLabel("Add dependency");
    assert.deepEqual(await add.locator("option").allTextContents(), ["Add dependency…", "free card"], "offers cards it does not already depend on");
    await add.selectOption({ label: "free card" });
    for (let i = 0; i < 50 && changes.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(changes[1], { method: "POST", path: "/api/boards/board/cards/child/dependencies", input: { dependsOn: "free" } });

    // Each dependency links to its card; that card names the cards waiting on it.
    await details.getByRole("button", { name: "parent card", exact: true }).click();
    await page.getByRole("region", { name: "Dependencies" }).getByText("Needed by:").waitFor();
    assert.equal(await page.getByRole("region", { name: "Dependencies" }).getByRole("button", { name: "child card", exact: true }).count(), 1);
  } finally {
    await browser.close();
    await server.close();
  }
});
