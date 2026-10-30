import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("the card lists its attachments with image thumbnails and download links for other files", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const card = { id: "card", title: "Backfill", body: "", repo: "/tmp/repo", source: "manual", status: "review", priority: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0, attempts: 2, reviewRounds: 0, runAgent: "", reviewAgent: "", dependsOn: [], blocked: false, attachmentCount: 2 };
    const files = [
      { id: "a1", cardId: "card", messageId: null, name: "screen.png", type: "image/png", size: 2048, createdAt: "2026-01-01" },
      { id: "a2", cardId: "card", messageId: null, name: "run.log", type: "text/plain", size: 5 * 1024 * 1024, createdAt: "2026-01-01" },
    ];
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": [card],
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/card/runs": [],
      "/api/boards/board/cards/card/approval": { pending: false },
      "/api/boards/board/cards/card/push-progress": null,
      "/api/boards/board/cards/card/comments": [],
      "/api/boards/board/cards/card/auto-review": [],
      "/api/boards/board/cards/card/history": [],
      "/api/boards/board/cards/card/attachments": files,
      "/api/boards/board/cards/card/review": { fingerprint: "a".repeat(64), files: [] },
      "/api/boards/board/cards/card/pr-draft": { startedAt: 0, steps: [], fingerprint: null },
      "/api/status": { draining: false, activeRuns: 0 },
    };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      // The thumbnail's bytes: a 1x1 PNG.
      if (path === "/api/boards/board/cards/card/attachments/a1") return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") });
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await page.getByRole("button", { name: /Backfill/ }).click();
    const section = page.getByRole("region", { name: "Card attachments" });
    await section.waitFor();
    const image = section.getByRole("img", { name: "screen.png" });
    await image.waitFor({ state: "attached" });
    assert.equal(await image.getAttribute("src"), "/api/boards/board/cards/card/attachments/a1");
    const link = section.getByRole("link", { name: /run\.log/ });
    assert.equal(await link.getAttribute("href"), "/api/boards/board/cards/card/attachments/a2");
    assert.match(await link.textContent() ?? "", /5\.0 MB/);
  } finally { await browser.close(); await server.close(); }
});
