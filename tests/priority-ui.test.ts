import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("lanes sort by priority, non-zero cards show their number, and details can change priority", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const card = (id: string, priority: number) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual", status: "ready", priority,
      createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0, attempts: 0, reviewRounds: 0, runAgent: "", reviewAgent: "" });
    // Server order is newest-first; the lane must regroup by priority and keep that order within a priority.
    const cards = [card("newer-normal", 0), card("low", -10), card("high", 50), card("older-normal", 0), card("urgent", 100)];
    const patches: unknown[] = [];
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": cards,
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/low/runs": [],
      "/api/boards/board/cards/low/approval": { pending: false },
      "/api/boards/board/cards/low/push-progress": null,
      "/api/boards/board/cards/low/history": [],
      "/api/boards/board/cards/low/comments": [],
      "/api/boards/board/cards/low/auto-review": [],
    };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "PATCH" && path === "/api/boards/board/cards/low") {
        const input = route.request().postDataJSON();
        patches.push(input);
        await route.fulfill({ json: { ...cards[1], ...input } });
        return;
      }
      if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    const lane = page.locator('section[data-status="ready"]');
    await lane.getByRole("button", { name: /urgent card/ }).waitFor();
    const titles = await lane.getByRole("button", { name: / card/ }).evaluateAll(items => items.map(item => item.textContent ?? ""));
    assert.deepEqual(titles.map(text => text.match(/(urgent|high|newer-normal|older-normal|low) card/)?.[1]), ["urgent", "high", "newer-normal", "older-normal", "low"]);
    assert.equal((await lane.getByRole("button", { name: /urgent card/ }).getByTestId("priority-badge").textContent())?.trim(), "↑100");
    assert.equal((await lane.getByRole("button", { name: /low card/ }).getByTestId("priority-badge").textContent())?.trim(), "↓10");
    assert.equal(await lane.getByRole("button", { name: /newer-normal card/ }).getByTestId("priority-badge").count(), 0, "Zero shows no number");
    await lane.getByRole("button", { name: /low card/ }).click();
    const select = page.getByLabel("Card priority");
    await select.waitFor();
    assert.equal(await select.inputValue(), "-10");
    await select.fill("75");
    await select.blur();
    for (let i = 0; i < 50 && !patches.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(patches, [{ title: "low card", body: "", priority: 75 }]);
  } finally {
    await browser.close();
    await server.close();
  }
});
