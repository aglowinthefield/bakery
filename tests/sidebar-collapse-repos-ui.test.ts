import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("the sidebar Repositories section collapses and remembers it across reloads", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const data: Record<string, unknown> = {
        "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
        "/api/cards": [],
        "/api/boards/board/cards": [],
        "/api/boards/board/conflicts": [],
      };
      await route.fulfill({ json: data[path] ?? [] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    const toggle = page.getByRole("button", { name: "Repositories" });
    const repo = page.getByRole("button", { name: "repo", exact: true });
    const addRepo = page.getByRole("button", { name: "Add repository" });
    await repo.waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");

    await toggle.click();
    await repo.waitFor({ state: "hidden" });
    assert.equal(await addRepo.isVisible(), false, "add repository hides with the list");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.ok(await page.getByRole("button", { name: "Settings" }).isVisible(), "settings stays visible");

    await page.reload();
    await toggle.waitFor();
    await page.waitForTimeout(300);
    assert.equal(await repo.isVisible(), false, "collapsed state survives reload");

    await toggle.click();
    await repo.waitFor();
  } finally {
    await browser.close();
    await server.close();
  }
});
