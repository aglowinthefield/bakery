import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const boards = [
  { id: "gh", repo: "/tmp/gh", remoteUrl: "https://github.com/acme/gh", autoCollapseEmptySwimlanes: false },
  { id: "gl", repo: "/tmp/gl", remoteUrl: "https://gitlab.com/acme/gl", autoCollapseEmptySwimlanes: false },
  { id: "none", repo: "/tmp/none", autoCollapseEmptySwimlanes: false },
];
const merged: string[] = [];
const pulls = [
  { number: 7, title: "Add widgets", url: "https://github.com/acme/gh/pull/7", headRefName: "bakery/c1", isDraft: false, updatedAt: "2025-01-01T00:00:00Z", author: { login: "me" },
    card: { id: "c1", title: "Widgets", status: "review", prChecks: "passing" }, checks: "passing" },
  { number: 8, title: "Outside change", url: "https://github.com/acme/gh/pull/8", headRefName: "feature", isDraft: true, updatedAt: "2025-01-02T00:00:00Z", author: { login: "you" }, card: null },
];

test("Pull requests appears only for GitHub remotes and links PRs to their cards", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards") return route.fulfill({ json: boards });
      if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      if (path === "/api/boards/gh/pull-requests/7/merge") { merged.push(route.request().method()); return route.fulfill({ json: { ok: true } }); }
      if (path === "/api/boards/gh/pull-requests") return route.fulfill({ json: pulls });
      await route.fulfill({ json: [] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    for (const name of ["gh", "gl", "none"]) {
      const row = page.getByRole("button", { name, exact: true });
      await row.waitFor();
      if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
    }
    assert.equal(await page.getByRole("button", { name: "Pull requests" }).count(), 1);
    await page.getByRole("button", { name: "Pull requests" }).click();
    await page.getByRole("list", { name: "Pull requests" }).waitFor();
    assert.equal(await page.locator("[data-pr]").count(), 2);
    assert.equal(await page.locator("[data-pr='7']").getByText("CI passing").count(), 1);
    assert.equal(await page.locator("[data-pr='8']").getByRole("button", { name: "Queue merge" }).isDisabled(), true);
    await page.locator("[data-pr='7']").getByRole("button", { name: "Queue merge" }).click();
    await page.locator("[data-pr='7']").getByText("Queued").waitFor();
    assert.deepEqual(merged, ["POST"]);
    await page.locator("[data-pr='7']").getByRole("button", { name: /Card · review/ }).click();
    await page.locator("h1").filter({ hasText: "gh" }).waitFor();
    assert.equal(await page.getByRole("list", { name: "Pull requests" }).count(), 0);
  } finally {
    await browser.close();
    await server.close();
  }
});
