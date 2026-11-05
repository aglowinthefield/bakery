import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const boards = [{ id: "gh", repo: "/tmp/gh", remoteUrl: "https://github.com/acme/gh", integration: "github-pr", autoCollapseEmptySwimlanes: false }];
const card = (id: string, title: string, status: string, idempotencyKey: string | null) =>
  ({ id, title, body: "", repo: "/tmp/gh", source: "manual", status, priority: 0, idempotencyKey, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", dependsOn: [], attempts: 1 });
const cards = [
  card("k1", "Plain kanban card", "ready", null),
  card("s1", "Fix PR #5: Broken", "running", "sentinel:5:abc:def"),
  card("s2", "Requested on PR #6: Tweak", "review", "request:issues/comments:1"),
];

test("Sentinels lists timer and PR-comment jobs apart from the kanban", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards") return route.fulfill({ json: boards });
      if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      if (path === "/api/boards/gh/cards") return route.fulfill({ json: cards });
      await route.fulfill({ json: [] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    const repo = page.getByRole("button", { name: "gh", exact: true });
    await repo.waitFor();
    if ((await repo.getAttribute("aria-expanded")) !== "true") await repo.click();
    await page.getByRole("button", { name: "Kanban" }).click();
    await page.getByText("Plain kanban card").waitFor();
    assert.equal(await page.getByText("Fix PR #5: Broken").count(), 0, "jobs stay off the kanban");
    await page.getByRole("button", { name: "Sentinels" }).click();
    const active = page.getByRole("list", { name: "Active sentinel jobs" });
    await active.getByText("Fix PR #5: Broken").waitFor();
    await active.getByText("Timer").waitFor();
    const recent = page.getByRole("list", { name: "Recent sentinel jobs" });
    await recent.getByText("PR comment").waitFor();
    assert.equal(await page.getByText("Plain kanban card").isVisible(), false);
  } finally {
    await browser.close();
    await server.close();
  }
});
