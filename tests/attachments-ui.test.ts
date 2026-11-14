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

test("an agent report shows attached screenshots inline, links a missing file, and does not load local paths", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const card = { id: "card", title: "Shots", body: "", repo: "/tmp/repo", source: "manual", status: "review", priority: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0, attempts: 1, reviewRounds: 0, runAgent: "", reviewAgent: "", dependsOn: [], blocked: false, attachmentCount: 2 };
    const base = "/api/boards/board/cards/card/attachments";
    const run = { id: "run", cardId: "card", attempt: 1, status: "review", output: "", error: null, worktree: "/tmp/wt", startedBy: "manual", agent: "", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cost: null, report: `Before and after:\n\n![Before](${base}/shot)\n\n![After](${base}/lost)\n\n![Temp](/tmp/b05cap/after.png)\n\n[run.log](${base}/log) and [tmp.log](/tmp/b05cap/run.log)`, startedAt: "2026-01-01", finishedAt: "2026-01-01", changedFiles: 0 };
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": [card],
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/card/runs": [run],
      "/api/boards/board/cards/card/approval": { pending: false },
      "/api/boards/board/cards/card/push-progress": null,
      "/api/boards/board/cards/card/comments": [],
      "/api/boards/board/cards/card/auto-review": [],
      "/api/boards/board/cards/card/history": [],
      "/api/boards/board/cards/card/attachments": [],
      "/api/boards/board/cards/card/review": { fingerprint: "a".repeat(64), files: [] },
      "/api/boards/board/cards/card/pr-draft": { startedAt: 0, steps: [], fingerprint: null },
      "/api/status": { draining: false, activeRuns: 0 },
    };
    const requested: string[] = [];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      requested.push(path);
      if (path === `${base}/shot`) return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") });
      if (path === `${base}/lost`) return route.fulfill({ status: 404, json: { error: "The attachment's file is missing from disk" } });
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await page.getByRole("button", { name: /Shots/ }).click();
    const report = page.getByRole("region", { name: /Agent report|Findings/ });
    const shot = report.getByRole("img", { name: "Before" });
    await shot.waitFor();
    // Loaded for real, not just present in the DOM.
    await page.waitForFunction(() => { const img = document.querySelector<HTMLImageElement>('img[alt="Before"]'); return !!img && img.complete && img.naturalWidth > 0; });
    assert.equal(await shot.evaluate(img => (img.parentElement as HTMLAnchorElement).getAttribute("href")), `${base}/shot`);
    // The missing file becomes a link to the same URL.
    const fallback = report.getByRole("link", { name: "After (image unavailable)" });
    await fallback.waitFor();
    assert.equal(await fallback.getAttribute("href"), `${base}/lost`);
    assert.equal(await report.getByRole("img", { name: "After" }).count(), 0);
    // A non-image file stays a clickable link to its durable URL; a local path does not become a link.
    assert.equal(await report.getByRole("link", { name: "run.log" }).getAttribute("href"), `${base}/log`);
    assert.equal(await report.getByRole("link", { name: "tmp.log" }).count(), 0);
    // A local path stays text and is never requested.
    assert.equal(await report.getByRole("img", { name: "Temp" }).count(), 0);
    assert.ok(!requested.some(path => path.includes("b05cap")));
  } finally { await browser.close(); await server.close(); }
});

test("deleting an attachment asks first: Cancel or Escape keeps it, Delete removes it", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const card = { id: "card", title: "Backfill", body: "", repo: "/tmp/repo", source: "manual", status: "review", priority: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0, attempts: 2, reviewRounds: 0, runAgent: "", reviewAgent: "", dependsOn: [], blocked: false, attachmentCount: 2 };
    const files = [
      { id: "a1", cardId: "card", messageId: null, name: "screen.png", type: "image/png", size: 2048, createdAt: "2026-01-01" },
      { id: "a2", cardId: "card", messageId: null, name: "run.log", type: "text/plain", size: 5, createdAt: "2026-01-01" },
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
    const deleted: string[] = [];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "DELETE") { deleted.push(path); return route.fulfill({ json: { ok: true } }); }
      if (path === "/api/boards/board/cards/card/attachments/a1") return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") });
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    // The browser's own confirm box can only say OK, so it must never appear for this.
    let nativeDialogs = 0;
    page.on("dialog", dialog => { nativeDialogs++; void dialog.dismiss(); });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await page.getByRole("button", { name: /Backfill/ }).click();
    const section = page.getByRole("region", { name: "Card attachments" });
    await section.getByRole("img", { name: "screen.png" }).waitFor({ state: "attached" });
    const remove = section.getByRole("button", { name: "Delete screen.png" });
    const confirm = page.getByRole("dialog", { name: "Delete attachment?" });

    await remove.click();
    await confirm.waitFor();
    assert.match(await confirm.textContent() ?? "", /"screen\.png" will be permanently deleted/);
    assert.equal(await confirm.getByRole("button", { name: "Delete" }).count(), 1);
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await confirm.waitFor({ state: "hidden" });

    await remove.click();
    await confirm.waitFor();
    // Cancel has focus, so a stray Enter cannot delete.
    assert.equal(await confirm.getByRole("button", { name: "Cancel" }).evaluate(el => el === document.activeElement), true);
    // Radix attaches its Escape listener a tick after the dialog shows, so retry on a loaded machine. Retry only while
    // the dialog is still open: during its closing animation it stays visible, and a second Escape would close the card.
    for (let i = 0; i < 20 && await confirm.getAttribute("data-state", { timeout: 1_000 }).catch(() => null) === "open"; i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(100); }
    await confirm.waitFor({ state: "hidden" });
    await page.waitForTimeout(200);
    assert.deepEqual(deleted, [], "Cancel and Escape send no delete request");
    assert.equal(await section.getByRole("img", { name: "screen.png" }).count(), 1);

    await remove.click();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await section.getByRole("img", { name: "screen.png" }).waitFor({ state: "detached" });
    assert.deepEqual(deleted, ["/api/boards/board/cards/card/attachments/a1"]);
    // The other attachment stays.
    await section.getByRole("link", { name: /run\.log/ }).waitFor();
    assert.equal(nativeDialogs, 0);
  } finally { await browser.close(); await server.close(); }
});

test("purging an archived card's attachments asks first: Cancel or Escape sends nothing, Delete purges", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const card = { id: "card", title: "Old work", body: "", repo: "/tmp/repo", source: "manual", status: "archived", priority: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0, attempts: 1, reviewRounds: 0, runAgent: "", reviewAgent: "", dependsOn: [], blocked: false, attachmentCount: 2 };
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
      "/api/boards/board/cards/card/attachments": [],
      "/api/boards/board/cards/card/review": { fingerprint: "a".repeat(64), files: [] },
      "/api/boards/board/cards/card/pr-draft": { startedAt: 0, steps: [], fingerprint: null },
      "/api/status": { draining: false, activeRuns: 0 },
    };
    const purges: unknown[] = [];
    await page.route("**/api/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/boards/board/cards/purge-attachments") {
        purges.push(request.postDataJSON());
        return route.fulfill({ json: [{ cardId: "card", files: 2, bytes: 10 }] });
      }
      await route.fulfill({ json: path in data ? data[path] : [] });
    });
    let nativeDialogs = 0;
    page.on("dialog", dialog => { nativeDialogs++; void dialog.dismiss(); });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await page.getByRole("button", { name: "Expand Archive lane" }).click();
    await page.locator('section[data-status="archived"]').getByRole("button", { name: /Old work/ }).click();
    const purge = page.getByRole("button", { name: "Purge attachments" });
    const confirm = page.getByRole("dialog", { name: "Delete attachments?" });

    await purge.click();
    await confirm.waitFor();
    assert.match(await confirm.textContent() ?? "", /All 2 attachments of "Old work" will be permanently deleted/);
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await confirm.waitFor({ state: "hidden" });

    await purge.click();
    await confirm.waitFor();
    assert.equal(await confirm.getByRole("button", { name: "Cancel" }).evaluate(el => el === document.activeElement), true);
    // Radix attaches its Escape listener a tick after the dialog shows, so retry on a loaded machine. Retry only while
    // the dialog is still open: during its closing animation it stays visible, and a second Escape would close the card.
    for (let i = 0; i < 20 && await confirm.getAttribute("data-state", { timeout: 1_000 }).catch(() => null) === "open"; i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(100); }
    await confirm.waitFor({ state: "hidden" });
    await page.waitForTimeout(200);
    assert.deepEqual(purges, [], "Cancel and Escape send no purge request");

    await purge.click();
    await confirm.getByRole("button", { name: "Delete" }).click();
    for (let i = 0; i < 50 && !purges.length; i++) await page.waitForTimeout(50);
    assert.deepEqual(purges, [{ cardIds: ["card"] }]);
    assert.equal(nativeDialogs, 0);
  } finally { await browser.close(); await server.close(); }
});

test("clicking a thumbnail opens a lightbox carousel over the card's images, with a full-size view and the original", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const card = { id: "card", title: "Gallery", body: "", repo: "/tmp/repo", source: "manual", status: "review", priority: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0, attempts: 1, reviewRounds: 0, runAgent: "", reviewAgent: "", dependsOn: [], blocked: false, attachmentCount: 4 };
    const files = [
      { id: "a1", cardId: "card", messageId: null, name: "before.png", type: "image/png", size: 2048, createdAt: "2026-01-01" },
      { id: "a2", cardId: "card", messageId: null, name: "run.log", type: "text/plain", size: 5, createdAt: "2026-01-01" },
      { id: "a3", cardId: "card", messageId: null, name: "after.png", type: "image/png", size: 4096, createdAt: "2026-01-01" },
      { id: "a4", cardId: "card", messageId: null, name: "wide.svg", type: "image/svg+xml", size: 300, createdAt: "2026-01-01" },
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
    // A 3000x200 image: wider than the window, so "fit" shrinks it and "full size" does not.
    const wideImage = `<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="200"><rect width="3000" height="200" fill="teal"/></svg>`;
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (/\/attachments\/a[13]$/.test(path)) return route.fulfill({ contentType: "image/svg+xml", body: wideImage });
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await page.getByRole("button", { name: /Gallery/ }).click();
    const section = page.getByRole("region", { name: "Card attachments" });
    await section.getByRole("img", { name: "after.png" }).click();

    const viewer = page.getByRole("dialog", { name: "after.png" });
    await viewer.waitFor();
    assert.match(await viewer.textContent() ?? "", /2 of 2/);
    // The non-image file and the unsupported type are not part of the carousel.
    assert.equal(await viewer.getByRole("button", { name: /^Show / }).count(), 2);
    assert.equal(await viewer.getByRole("link", { name: "Open original" }).getAttribute("href"), "/api/boards/board/cards/card/attachments/a3");
    assert.equal(await viewer.getByRole("link", { name: "Open original" }).getAttribute("target"), "_blank");

    // Next wraps around to the first image; the arrow keys step too.
    await viewer.getByRole("button", { name: "Next image" }).click();
    await page.getByRole("dialog", { name: "before.png" }).waitFor();
    await page.keyboard.press("ArrowLeft");
    await page.getByRole("dialog", { name: "after.png" }).waitFor();
    await page.keyboard.press("ArrowRight");
    const first = page.getByRole("dialog", { name: "before.png" });
    await first.waitFor();
    assert.match(await first.textContent() ?? "", /1 of 2/);

    // Fitted, the wide image fits the window; at full size it keeps its natural width and the stage scrolls.
    const big = first.getByRole("img", { name: "before.png" });
    await page.waitForFunction(() => { const img = document.querySelector<HTMLImageElement>('[data-lightbox-stage] img'); return !!img && img.complete && img.naturalWidth > 0; });
    assert.ok((await big.evaluate(img => img.getBoundingClientRect().width)) < 1200);
    await first.getByRole("button", { name: "Full size" }).click();
    assert.equal(Math.round(await big.evaluate(img => img.getBoundingClientRect().width)), 3000);
    assert.ok(await first.evaluate(dialog => { const stage = dialog.querySelector("[data-lightbox-stage]")!; return stage.scrollWidth > stage.clientWidth; }));
    await first.getByRole("button", { name: "Fit to window" }).click();
    assert.ok((await big.evaluate(img => img.getBoundingClientRect().width)) < 1200);

    // Escape closes only the lightbox, not the card behind it.
    // Radix attaches its Escape listener a tick after the dialog shows, so retry, but never press twice for one close.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Escape");
      if (await first.waitFor({ state: "hidden", timeout: 1000 }).then(() => true, () => false)) break;
    }
    await first.waitFor({ state: "hidden" });
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole("dialog").count(), 1);
    await section.waitFor({ state: "visible" });
  } finally { await browser.close(); await server.close(); }
});
