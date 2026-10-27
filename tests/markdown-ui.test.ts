import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let url: string;

before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

const body = [
  "## Goal",
  "",
  "Render **bold** text and [docs](https://example.com/docs).",
  "",
  "- [x] parser",
  "- [ ] `renderer`",
  "",
  "```ts",
  "const ready = true;",
  "```",
  "",
  "<img src=x onerror=\"window.injected = true\"> [bad](javascript:window.injected=true)",
].join("\n");

test("card details render description markdown without injecting HTML", async () => {
  const page = await browser.newPage();
  // These tests cover the board, not the Today landing page.
  await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "dark" },
      "/api/boards/board/cards": [{ id: "card", title: "Markdown card", body, repo: "/tmp/repo", source: "manual", status: "triage", createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0 }],
    };
    // Other board and card resources are empty for an unstarted card.
    await route.fulfill({ json: path in data ? data[path] : path.endsWith("/approval") ? { pending: false } : [] });
  });
  try {
    await page.goto(url);
    const preview = page.getByRole("button", { name: /Markdown card/ });
    assert.match(await preview.innerText(), /Goal Render bold text and docs\. parser renderer/);
    assert.doesNotMatch(await preview.innerText(), /\*\*|##/);
    await preview.click();
    const details = page.locator(".markdown");
    await details.waitFor();
    assert.equal(await details.getByRole("heading", { level: 2, name: "Goal" }).count(), 1);
    assert.equal(await details.locator("strong").innerText(), "bold");
    const link = details.getByRole("link", { name: "docs" });
    assert.equal(await link.getAttribute("href"), "https://example.com/docs");
    assert.equal(await link.getAttribute("rel"), "noreferrer");
    assert.deepEqual(await details.getByRole("checkbox").evaluateAll(boxes => boxes.map(box => (box as HTMLInputElement).checked)), [true, false]);
    assert.equal(await details.locator("li code").innerText(), "renderer");
    assert.match(await details.locator("pre code .hljs-keyword").first().innerText(), /const/);
    assert.equal(await details.locator("img").count(), 0);
    assert.equal(await details.getByRole("link", { name: "bad" }).count(), 0);
    assert.match(await details.innerText(), /<img src=x onerror="window.injected = true"> bad/);
    assert.equal(await page.evaluate(() => (window as { injected?: boolean }).injected), undefined);
  } finally {
    await page.close();
  }
});
