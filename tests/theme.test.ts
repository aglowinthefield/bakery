import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("Settings switches between the preserved default and Compline after reload", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
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
      } else if (path === "/api/boards/board/conflicts" || path.endsWith("/comments") || path.endsWith("/auto-review") || path.endsWith("/runs")) {
        await route.fulfill({ json: [] });
      } else if (path.endsWith("/approval")) {
        await route.fulfill({ json: { pending: false } });
      } else if (path.endsWith("/review")) {
        await route.fulfill({ json: { fingerprint: "a".repeat(64), files: [{ path: "src/example.ts", patch: "@@ -1 +1 @@\n-old\n+new\n" }] } });
      } else {
        assert.fail(`Unexpected API request: ${path}`);
      }
    });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog");
    assert.equal(await dialog.getByRole("radio", { name: "Default" }).isChecked(), true);
    const background = await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);
    const defaultSidebar = await page.locator("aside").evaluate((el) => getComputedStyle(el).backgroundColor);
    await dialog.getByRole("radio", { name: "Compline" }).check();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "compline");
    assert.equal(await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor), background);
    assert.equal(await page.locator("aside").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(34, 38, 43)");
    assert.notEqual(defaultSidebar, "rgb(34, 38, 43)");
    const colors = await Promise.all([
      "--foreground", "--background", "--muted-foreground", "--muted",
      "--primary-foreground", "--primary", "--diff-add-foreground", "--diff-add-background",
      "--diff-remove-foreground", "--diff-remove-background",
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
    assert.equal(await dialog.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(34, 38, 43)");
    await dialog.getByRole("radio", { name: "Compline" }).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    assert.equal(await dialog.getByRole("radio", { name: "Compline" }).evaluate((el) => getComputedStyle(el).outlineColor), "rgb(180, 188, 196)");
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: /Review card/ }).click();
    assert.equal(await page.locator('section [class*="--review-status"]').first().evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(180, 196, 188)");
    const added = page.locator('[data-change="add"]');
    const removed = page.locator('[data-change="remove"]');
    assert.equal(await added.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(41, 55, 47)");
    assert.equal(await removed.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(57, 46, 50)");
    assert.equal(await added.locator("button").evaluate((el) => getComputedStyle(el).opacity), "1");
    delaySettings = true;
    await page.reload();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "compline");
    releaseSettings?.();
    await page.getByRole("button", { name: "Settings" }).click();
    assert.equal(await page.getByRole("dialog").getByRole("radio", { name: "Compline" }).isChecked(), true);
    assert.equal(await page.locator("html").getAttribute("data-theme"), "compline");
    await page.getByRole("dialog").getByRole("radio", { name: "Default" }).check();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "default");
    assert.equal(await page.locator("aside").evaluate((el) => getComputedStyle(el).backgroundColor), defaultSidebar);
    await page.close();
  } finally {
    releaseSettings?.();
    await browser?.close();
    await server.close();
  }
});
