import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("remote repository link is saved in settings and listed below the board heading", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage();
    let board = { id: "board", repo: "/tmp/example", icon: "layout-grid", color: "violet", remoteUrl: "", autoCollapseEmptySwimlanes: false, verificationCommand: "" };
    const patches: unknown[] = [];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards/board/settings" && route.request().method() === "PATCH") {
        const input = route.request().postDataJSON();
        patches.push(input);
        board = { ...board, remoteUrl: input.remoteUrl.trim() };
        await route.fulfill({ json: board });
      } else if (path === "/api/boards") await route.fulfill({ json: [board] });
      else if (path === "/api/settings") await route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      else if (path.endsWith("/cards") || path.endsWith("/conflicts")) await route.fulfill({ json: [] });
      else throw new Error(`Unexpected API request: ${path}`);
    });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.locator("header h1").filter({ hasText: "example" }).waitFor();
    const link = page.locator("header").getByRole("link", { name: "Remote repository" });
    assert.equal(await link.count(), 0);

    await page.getByRole("button", { name: "Settings" }).click();
    const input = page.getByRole("textbox", { name: "Remote repository link" });
    const save = page.getByRole("button", { name: "Save link" });
    assert.equal(await save.isDisabled(), true);
    await input.fill("https://github.com/owner/example");
    await save.click();
    await save.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("header a[href]"));
    await page.keyboard.press("Escape");
    await link.waitFor();
    assert.equal(await link.getAttribute("href"), "https://github.com/owner/example");
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.match((await link.textContent()) ?? "", /^github\.com\/owner\/example$/);
    const pathBox = await page.locator("header p").filter({ hasText: "/tmp/example" }).boundingBox();
    const linkBox = await link.boundingBox();
    assert.ok(pathBox && linkBox && linkBox.y >= pathBox.y + pathBox.height - 1, "link sits below the heading and path");

    await page.reload();
    await link.waitFor();
    await page.getByRole("button", { name: "Settings" }).click();
    assert.equal(await input.inputValue(), "https://github.com/owner/example");
    await input.fill("");
    await page.getByRole("button", { name: "Remove link" }).click();
    await page.waitForFunction(() => !document.querySelector("header a[href]"));
    await page.keyboard.press("Escape");
    assert.equal(await link.count(), 0);
    assert.deepEqual(patches, [{ remoteUrl: "https://github.com/owner/example" }, { remoteUrl: "" }]);
  } finally {
    await browser?.close();
    await server.close();
  }
});
