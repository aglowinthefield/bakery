import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createServer } from "vite";

const boards = [
  { id: "one", repo: "/tmp/one", autoCollapseEmptySwimlanes: false },
  { id: "two", repo: "/tmp/two", autoCollapseEmptySwimlanes: false },
];

async function openTab(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "one", exact: true }).waitFor();
  return page;
}

async function openRepo(page: Page, name: string) {
  const row = page.getByRole("button", { name, exact: true });
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  await row.locator("xpath=../..").getByRole("button", { name: "Kanban" }).click();
}

test("a new tab opens the repo last viewed in any tab", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards") return route.fulfill({ json: boards });
      if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      // Cards, conflicts and Today's lists are all empty here.
      await route.fulfill({ json: [] });
    });
    const url = server.resolvedUrls!.local[0];
    const activeRepo = (page: Page) => page.locator("h1").first().textContent();

    const first = await openTab(context, url);
    await openRepo(first, "one");
    const second = await openTab(context, url);
    assert.match((await activeRepo(second)) ?? "", /one/, "new tab opens the repo picked in the first tab");
    await openRepo(second, "two");

    // Returning to the first tab makes its repo the last viewed again.
    await first.bringToFront();
    await first.evaluate(() => window.dispatchEvent(new Event("focus")));
    const third = await openTab(context, url);
    assert.match((await activeRepo(third)) ?? "", /one/, "new tab opens the repo of the tab viewed last");
  } finally {
    await browser.close();
    await server.close();
  }
});
