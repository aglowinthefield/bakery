import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";

// The focus-ring check relies on Chromium's Tab order; Safari skips radios and buttons by default.
process.env.BAKERY_TEST_BROWSER = "chromium";
import { createServer } from "vite";

test("Settings switches between the preserved default and Compline after reload", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  let browser;
  let releaseSettings: (() => void) | undefined;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage();
    let theme: "default" | "compline" = "default";
    let delaySettings = false;
    const settingsReady = new Promise<void>((resolve) => { releaseSettings = resolve; });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/settings") {
        if (delaySettings && route.request().method() === "GET") await settingsReady;
        if (route.request().method() === "PATCH") {
          theme = (route.request().postDataJSON() as { theme: typeof theme }).theme;
        }
        await route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme } });
      } else if (path === "/api/boards") {
        await route.fulfill({ json: [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }] });
      } else if (path === "/api/boards/board/cards") {
        await route.fulfill({ json: [{ id: "card", title: "Review card", body: "", repo: "/tmp/repo", source: "manual", status: "review", createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0 }] });
      } else if (path === "/api/boards/board/conflicts" || path.endsWith("/comments") || path.endsWith("/history") || path.endsWith("/auto-review") || path.endsWith("/runs")) {
        await route.fulfill({ json: [] });
      } else if (path.endsWith("/push-progress")) {
        await route.fulfill({ json: null });
      } else if (path.endsWith("/approval")) {
        await route.fulfill({ json: { pending: false } });
      } else if (path.endsWith("/pr-draft")) {
        await route.fulfill({ json: { startedAt: 0, steps: [], fingerprint: null } });
      } else if (path.endsWith("/review")) {
        await route.fulfill({ json: { fingerprint: "a".repeat(64), files: [{ path: "src/example.ts", patch: "@@ -1 +1 @@\n-old\n+new\n" }] } });
      } else if (path === "/api/status") {
        await route.fulfill({ json: { draining: false, activeRuns: 0 } });
      } else {
        assert.fail(`Unexpected API request: ${path}`);
      }
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Appearance" }).click();
    const dialog = page.locator("main:visible");
    assert.equal(await dialog.getByRole("group", { name: "Theme" }).getByRole("radio", { name: "Default" }).isChecked(), true);
    const background = await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);
    const defaultSidebar = await page.locator("aside").evaluate((el) => getComputedStyle(el).backgroundColor);
    await dialog.getByRole("radio", { name: "Compline Dark", exact: true }).check();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "compline");
    assert.notEqual(background, "rgb(31, 34, 38)");
    assert.equal(await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(31, 34, 38)");
    assert.equal(await page.locator("aside").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(38, 42, 47)");
    assert.notEqual(defaultSidebar, "rgb(38, 42, 47)");
    const colors = await Promise.all([
      "--foreground", "--background", "--muted-foreground", "--muted",
      "--primary-foreground", "--primary", "--diff-add-foreground", "--diff-add",
      "--diff-remove-foreground", "--diff-remove",
    ].map((name) => page.locator("html").evaluate((element, property) => getComputedStyle(element).getPropertyValue(property).trim(), name)));
    const luminance = (hex: string) => [0, 2, 4]
      .map((i) => parseInt(hex.slice(i + 1, i + 3), 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const contrast = [0, 2, 4, 6, 8].map((index) => {
      const a = luminance(colors[index]), b = luminance(colors[index + 1]);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    assert.ok(contrast.every((ratio) => ratio >= 4.5), `Text contrast below 4.5: ${contrast}`);
    await dialog.getByRole("radio", { name: "Compline Dark", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    assert.equal(await dialog.getByRole("radio", { name: "Compline Dark", exact: true }).evaluate((el) => getComputedStyle(el).outlineColor), "rgb(163, 173, 183)");
    await page.goBack();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /Review card/ }).click();
    await page.getByRole("tab", { name: /^Reviews?\b/ }).click();
    assert.equal(await page.locator('section[data-status="review"] .lane-status-dot').first().evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(165, 181, 170)");
    const added = page.locator('[data-line][data-line-type="change-addition"]');
    const removed = page.locator('[data-line][data-line-type="change-deletion"]');
    assert.equal(await added.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(39, 51, 44)");
    assert.equal(await removed.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(53, 43, 47)");
    assert.equal(await page.locator('[data-column-number][data-line-type="change-addition"]').evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(39, 51, 44)");
    delaySettings = true;
    await page.reload();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "compline");
    releaseSettings?.();
    // The reload reopens the card this tab had open; close it to reach Settings.
    await page.getByRole("dialog").getByText("Review card").first().waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Appearance" }).click();
    assert.equal(await page.locator("main:visible").getByRole("radio", { name: "Compline Dark", exact: true }).isChecked(), true);
    assert.equal(await page.locator("html").getAttribute("data-theme"), "compline");
    await page.locator("main:visible").getByRole("group", { name: "Theme" }).getByRole("radio", { name: "Default" }).check();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "default");
    assert.equal(await page.locator("aside").evaluate((el) => getComputedStyle(el).backgroundColor), defaultSidebar);
    await page.close();
  } finally {
    releaseSettings?.();
    await browser?.close();
    await server.close();
  }
});

test("Compline (match system) follows the system light/dark setting", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage({ colorScheme: "light" });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/settings") {
        await route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "compline-system" } });
      } else if (path === "/api/boards") {
        await route.fulfill({ json: [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }] });
      } else if (path === "/api/status") {
        await route.fulfill({ json: { draining: false, activeRuns: 0 } });
      } else {
        await route.fulfill({ json: [] });
      }
    });
    await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
    await page.waitForFunction(() => document.documentElement.dataset.theme === "compline-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "compline");
    await page.reload();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "compline");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Appearance" }).click();
    assert.equal(await page.locator("main:visible").getByRole("radio", { name: "Compline (match system)" }).isChecked(), true);
    await page.close();
  } finally {
    await browser?.close();
    await server.close();
  }
});
