import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const boards = [
  { id: "gh", repo: "/tmp/gh", remoteUrl: "https://github.com/acme/gh", autoCollapseEmptySwimlanes: false },
  { id: "gl", repo: "/tmp/gl", remoteUrl: "https://gitlab.com/acme/gl", autoCollapseEmptySwimlanes: false },
  { id: "none", repo: "/tmp/none", autoCollapseEmptySwimlanes: false },
];
const pulls = [
  { number: 7, title: "Add widgets", url: "https://github.com/acme/gh/pull/7", headRefName: "bakery/c1", isDraft: false, updatedAt: "2025-01-01T00:00:00Z", author: { login: "me" },
    card: { id: "c1", title: "Widgets", status: "review", prChecks: "passing" } },
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
      if (path === "/api/boards/gh/pull-requests/8") return route.fulfill({ json: { body: "Does **things**", baseRefName: "main", changedFiles: 1, files: [{ path: "src/a.ts", additions: 3, deletions: 1, changeType: "MODIFIED" }], commits: [{ oid: "abcdef123456", messageHeadline: "Do things", authors: [{ login: "you" }], committedDate: "2025-01-02T00:00:00Z" }], comments: [], latestReviews: [], statusCheckRollup: [{ name: "build", conclusion: "SUCCESS" }] } });
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
    assert.equal(await page.locator("[data-pr='8']").getByText("No card").count(), 1);
    await page.locator("[data-pr='8']").getByRole("button", { name: /Outside change/ }).click();
    const dialog = page.locator("[data-pr='8']");
    await dialog.getByText("src/a.ts").waitFor();
    assert.equal(await dialog.getByText("Do things").count(), 1);
    assert.equal(await dialog.getByText("build").count(), 1);
    assert.equal(await dialog.locator("strong", { hasText: "things" }).count(), 1);
    assert.equal(await page.getByRole("dialog").count(), 0);
    await dialog.getByRole("button", { name: /Outside change/ }).click();
    await dialog.getByText("src/a.ts").waitFor({ state: "detached" });
    await page.locator("[data-pr='7']").getByRole("button", { name: /Card · review · passing/ }).click();
    await page.locator("h1").filter({ hasText: "gh" }).waitFor();
    assert.equal(await page.getByRole("list", { name: "Pull requests" }).count(), 0);
  } finally {
    await browser.close();
    await server.close();
  }
});
