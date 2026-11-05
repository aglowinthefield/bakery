import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { applyOrder, moveId } from "../src/model.js";

test("applyOrder and moveId order repos by saved ids", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(
    applyOrder(items, ["c", "a"]).map((i) => i.id),
    ["c", "a", "b"],
  );
  assert.deepEqual(moveId(items, "a", "c"), ["b", "a", "c"]);
  assert.deepEqual(moveId(items, "a", null), ["b", "c", "a"]);
});

test("dragging a repo in the sidebar reorders it and remembers the order", async () => {
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const data: Record<string, unknown> = {
        "/api/boards": [
          { id: "one", repo: "/tmp/alpha", autoCollapseEmptySwimlanes: false },
          { id: "two", repo: "/tmp/beta", autoCollapseEmptySwimlanes: false },
        ],
        "/api/settings": {
          confirmRunStart: false,
          cardDetailsLayout: "dialog",
          theme: "default",
        },
      };
      await route.fulfill({ json: data[path] ?? [] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    const rows = page.locator("[data-repo-id]");
    await rows.first().waitFor();
    const order = async () =>
      rows.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-repo-id")),
      );
    assert.deepEqual(await order(), ["one", "two"]);

    await page
      .locator('[data-repo-id="two"]')
      .dragTo(page.locator('[data-repo-id="one"]'));
    assert.deepEqual(await order(), ["two", "one"]);

    await page.reload();
    await rows.first().waitFor();
    assert.deepEqual(await order(), ["two", "one"]);
  } finally {
    await browser.close();
    await server.close();
  }
});
