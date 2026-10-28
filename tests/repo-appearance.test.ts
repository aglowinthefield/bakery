import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("repository icon and color picker updates navigation and heading after save and reload", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage();
    // These tests cover the board, not the Today landing page.
    await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
    let board = { id: "board", repo: "/tmp/example", icon: "layout-grid", color: "violet", autoCollapseEmptySwimlanes: false };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards/board" && route.request().method() === "PATCH") {
        board = { ...board, ...route.request().postDataJSON() };
        await route.fulfill({ json: board });
      } else if (path === "/api/boards/board/settings" && route.request().method() === "PATCH") {
        board = { ...board, ...route.request().postDataJSON() };
        await route.fulfill({ json: board });
      } else if (path === "/api/boards") await route.fulfill({ json: [board] });
      else if (path === "/api/repository-root") await route.fulfill({ json: { root: new URL(route.request().url()).searchParams.get("path") } });
      else if (path === "/api/path-suggestions") await route.fulfill({ json: [] });
      else if (path === "/api/settings") await route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      else if (path.endsWith("/cards") || path.endsWith("/conflicts")) await route.fulfill({ json: [] });
      else if (path.endsWith("/local-merges")) await route.fulfill({ json: { cards: [], main: null } });
      else if (path === "/api/status") await route.fulfill({ json: { draining: false, activeRuns: 0 } });
      else throw new Error(`Unexpected API request: ${path}`);
    });
    const badges = page.locator("aside button[title='/tmp/example'] svg, header h1 .repo-badge svg");
    await page.goto(server.resolvedUrls!.local[0]);
    await badges.first().waitFor();
    assert.equal(await badges.count(), 2);
    const initial = await badges.first().evaluate(el => el.innerHTML);
    await page.getByRole("button", { name: "Edit /tmp/example" }).click();
    await page.getByRole("button", { name: "Icon: rocket" }).click();
    await page.getByRole("button", { name: "Color: coral" }).click();
    assert.equal(await page.getByRole("button", { name: "Save appearance" }).isEnabled(), true);
    await page.getByRole("button", { name: "Save appearance" }).click();
    await page.getByRole("button", { name: "Save appearance" }).waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("header h1 .repo-badge svg")?.parentElement && getComputedStyle(document.querySelector("header h1 .repo-badge svg")!.parentElement!).color === "rgb(251, 113, 133)");
    assert.deepEqual([board.icon, board.color], ["rocket", "coral"]);
    assert.notEqual(await badges.first().evaluate(el => el.innerHTML), initial);
    assert.equal(await badges.first().evaluate(el => getComputedStyle(el.parentElement!).color), "rgb(251, 113, 133)");
    await page.reload();
    await badges.first().waitFor();
    assert.equal(await badges.count(), 2);
    assert.equal(await badges.last().evaluate(el => getComputedStyle(el.parentElement!).color), "rgb(251, 113, 133)");
    assert.notEqual(await badges.last().evaluate(el => el.innerHTML), initial);
    await page.getByRole("button", { name: "Edit /tmp/example" }).click();
    await page.getByRole("button", { name: "Icon: ghost" }).click();
    await page.getByRole("button", { name: "Color: amber" }).click();
    await page.getByRole("combobox", { name: "Repository root" }).fill("/tmp/renamed");
    await page.getByRole("button", { name: "Save repository" }).click();
    await page.waitForFunction(() => document.querySelector("header h1")?.textContent?.includes("renamed"));
    assert.deepEqual([board.repo, board.icon, board.color], ["/tmp/renamed", "ghost", "amber"]);
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    assert.notEqual(await badges.last().evaluate(el => getComputedStyle(el.parentElement!).color), "rgb(251, 191, 36)");
    await page.reload();
    assert.equal(await page.getByRole("button", { name: "Edit /tmp/renamed" }).count(), 1);
    assert.notEqual(await page.locator("header h1 .repo-badge svg").evaluate(el => el.innerHTML), initial);
    await page.close();
  } finally { await browser?.close(); await server.close(); }
});
