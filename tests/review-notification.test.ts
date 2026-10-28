import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("Review notifications require opt-in and a newly observed status change", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // These tests cover the board, not the Today landing page.
  await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
  let notifyOnReview = false;
  let polls = 0;
  const statuses: Record<string, string> = { existing: "review", changing: "running" };
  const installNotifications = () => page.evaluate(`
    window.notices = [];
    window.Notification = class {
      static permission = "denied";
      static async requestPermission() { return this.permission; }
      constructor(title, options) {
        window.notices.push({ title, body: options.body, click: () => this.onclick?.() });
      }
      close() {}
    };
  `);
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/settings" && route.request().method() === "PATCH") {
      notifyOnReview = (route.request().postDataJSON() as { notifyOnReview: boolean }).notifyOnReview;
    }
    if (path === "/api/boards/board/cards") polls++;
    const cards = Object.entries(statuses).map(([id, status]) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual", status, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0 }));
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, notifyOnReview, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": cards,
      "/api/boards/board/conflicts": [],
    };
    if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
    assert.ok(path in data, `Unexpected API request: ${path}`);
    await route.fulfill({ json: data[path] });
  });
  const notices = () => page.evaluate(() => (window as unknown as { notices: { title: string; body: string }[] }).notices.map(({ title, body }) => ({ title, body })));
  try {
    await page.goto(server.resolvedUrls!.local[0]);
    await installNotifications();
    await page.getByRole("button", { name: /changing card/ }).waitFor();
    await page.getByRole("button", { name: "Settings" }).click();
    const checkbox = page.getByRole("checkbox", { name: /Notify when a card enters Review/ });
    await checkbox.click();
    await page.getByRole("alert").filter({ hasText: "permission was not granted" }).waitFor();
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(notifyOnReview, false);
    await page.evaluate(() => { Object.defineProperty(Notification, "permission", { value: "granted", configurable: true }); });
    await checkbox.click();
    await page.waitForFunction(() => [...document.querySelectorAll("label")].find(label => label.textContent?.includes("Notify when a card enters Review"))?.querySelector("input")?.checked);
    assert.equal(await checkbox.isChecked(), true);
    assert.equal(notifyOnReview, true);
    assert.deepEqual(await notices(), []);
    statuses.changing = "review";
    await page.waitForFunction(() => (window as unknown as { notices: unknown[] }).notices.length === 1);
    assert.deepEqual(await notices(), [{ title: "Card ready for review", body: "changing card" }]);
    const before = polls;
    await page.waitForResponse(response => response.url().endsWith("/api/boards/board/cards") && polls > before);
    assert.equal((await notices()).length, 1);
    await page.reload();
    await installNotifications();
    await page.getByRole("button", { name: /changing card/ }).waitFor();
    assert.deepEqual(await notices(), []);
  } finally {
    await page.close();
    await browser.close();
    await server.close();
  }
});
