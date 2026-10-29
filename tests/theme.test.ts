import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let url: string;
before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

test("cached theme colors the first paint while the database request is pending", async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem("bakery-theme", "light"));
  let reply!: () => void;
  const pending = new Promise<void>(resolve => { reply = resolve; });
  await page.route("**/api/**", async route => {
    if (new URL(route.request().url()).pathname === "/api/settings") {
      await pending;
      await route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
    } else {
      await route.fulfill({ json: [] });
    }
  });
  try {
    await page.goto(new URL("/board/board", url).href);
    assert.deepEqual(await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      background: getComputedStyle(document.body).backgroundColor,
      rendered: document.getElementById("root")!.childElementCount,
    })), { theme: "light", background: "rgb(245, 243, 238)", rendered: 0 });
    reply();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "default");
    assert.equal(await page.evaluate(() => localStorage.getItem("bakery-theme")), "default");
  } finally { reply(); await page.close(); }
});

test("database theme still loads when browser storage rejects writes", async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new Error("Storage disabled"); };
  });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const data: Record<string, unknown> = {
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "light" },
      "/api/boards": [],
    };
    if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
    assert.ok(path in data, `Unexpected API request: ${path}`);
    await route.fulfill({ json: data[path] });
  });
  try {
    await page.goto(new URL("/board/board", url).href);
    await page.getByRole("button", { name: "Settings" }).click();
    assert.equal(await page.getByRole("radio", { name: "Light", exact: true }).isChecked(), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(245, 243, 238)");
  } finally { await page.close(); }
});

test("theme picker changes board and reopened review, then loads the saved palette before rendering", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let theme: "default" | "light" = "default";
  let failPatch = false;
  let releasePatch!: () => void;
  const heldPatch = new Promise<void>(resolve => { releasePatch = resolve; });
  const settings = () => ({ confirmRunStart: false, cardDetailsLayout: "side", theme });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/settings") {
      if (route.request().method() === "PATCH") {
        await heldPatch;
        if (failPatch) {
          await route.fulfill({ status: 400, json: { error: "Save rejected" } });
          return;
        }
        theme = (route.request().postDataJSON() as { theme: typeof theme }).theme;
      }
      await route.fulfill({ json: settings() });
      return;
    }
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/boards/board/cards": [{ id: "card", title: "Review card", body: "", repo: "/tmp/repo", source: "manual", status: "review", createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0 }],
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/card/runs": [{ id: "run", attempt: 1, status: "review", output: "", error: null, worktree: null, startedAt: "2026-01-01", finishedAt: "2026-01-01", startedBy: "manual" }],
      "/api/boards/board/cards/card/approval": { pending: false },
      "/api/boards/board/cards/card/pr-draft": { startedAt: 0, steps: [], fingerprint: null },
      "/api/boards/board/cards/card/push-progress": null,
      "/api/boards/board/cards/card/comments": [],
      "/api/boards/board/cards/card/auto-review": [],
      "/api/boards/board/cards/card/review": { fingerprint: "a".repeat(64), files: [{ path: "src/example.ts", patch: "@@ -1 +1 @@\n-const old = 1;\n+const next = 2;\n" }] },
    };
    if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
    assert.ok(path in data, `Unexpected API request: ${path}`);
    await route.fulfill({ json: data[path] });
  });
  const palette = () => page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    sidebar: getComputedStyle(document.querySelector("aside")!).backgroundColor,
    details: getComputedStyle(document.querySelector('[role="dialog"]:has([aria-label="Resize card panel"])')!).backgroundColor,
    add: getComputedStyle(document.querySelector("diffs-container")!.shadowRoot!.querySelector('[data-line][data-line-type="change-addition"]')!).backgroundColor,
    remove: getComputedStyle(document.querySelector("diffs-container")!.shadowRoot!.querySelector('[data-line][data-line-type="change-deletion"]')!).backgroundColor,
    code: getComputedStyle(document.querySelector("diffs-container")!.shadowRoot!.querySelector('[data-line][data-line-type="change-addition"] span')!).color,
  }));
  const diffRendered = () => page.locator('[data-line][data-line-type="change-addition"] span').first().waitFor();
  try {
    await page.goto(new URL("/board/board", url).href);
    await page.getByRole("button", { name: /Review card/ }).click();
    await page.getByRole("tab", { name: /^Reviews?\b/ }).click();
    await diffRendered();
    const dark = await palette();
    assert.equal(dark.background, "rgb(26, 29, 33)");
    assert.equal(dark.add, "rgb(25, 53, 41)");
    assert.equal(dark.remove, "rgb(59, 37, 40)");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("radio", { name: "Light", exact: true }).check();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
    assert.equal(await page.evaluate(() => localStorage.getItem("bakery-theme")), "default");
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: /Review card/ }).click();
    await page.getByRole("tab", { name: /^Reviews?\b/ }).click();
    await diffRendered();
    const light = await palette();
    assert.equal(light.background, "rgb(245, 243, 238)");
    assert.equal(light.add, "rgb(225, 242, 230)");
    assert.equal(light.remove, "rgb(250, 230, 231)");
    assert.notEqual(light.code, dark.code, "syntax colors follow the light palette");
    assert.notEqual(light.sidebar, dark.sidebar);
    assert.notEqual(light.details, dark.details);
    releasePatch();
    await page.waitForFunction(() => localStorage.getItem("bakery-theme") === "light");
    // The reload reopens the card this tab had open.
    await page.reload();
    await page.getByRole("tab", { name: /^Reviews?\b/ }).click();
    await diffRendered();
    assert.deepEqual(await palette(), light);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
    assert.equal(await page.locator('section[data-status="review"] .lane-status-dot').first().evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(56, 104, 74)");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("group", { name: "Theme" }).getByRole("radio", { name: "Default" }).check();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "default" && localStorage.getItem("bakery-theme") === "default");
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: /Review card/ }).click();
    await page.getByRole("tab", { name: /^Reviews?\b/ }).click();
    await diffRendered();
    assert.deepEqual(await palette(), dark);
    failPatch = true;
    await page.getByRole("button", { name: "Settings" }).click();
    // click, not check: the rejected save reverts the radio, which check() reports as a failure when it lands first.
    await page.getByRole("radio", { name: "Light", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Save rejected" }).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: /Review card/ }).click();
    await page.getByRole("tab", { name: /^Reviews?\b/ }).click();
    await diffRendered();
    assert.deepEqual(await palette(), dark);
    assert.equal(await page.evaluate(() => localStorage.getItem("bakery-theme")), "default");
  } finally { releasePatch(); await page.close(); }
});
