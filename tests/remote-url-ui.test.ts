import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("remote repository link is saved in repository settings and listed below the board heading", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage();
    // These tests cover the board, not the Today landing page.
    await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
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
      else if (path === "/api/repository-root") await route.fulfill({ json: { root: new URL(route.request().url()).searchParams.get("path") } });
      else if (path === "/api/path-suggestions") await route.fulfill({ json: [] });
      else if (path === "/api/settings") await route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      else if (path.endsWith("/cards") || path.endsWith("/conflicts")) await route.fulfill({ json: [] });
      else if (path.endsWith("/local-merges")) await route.fulfill({ json: { cards: [], main: null } });
      else throw new Error(`Unexpected API request: ${path}`);
    });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.locator("header h1").filter({ hasText: "example" }).waitFor();
    const link = page.locator("header").getByRole("link", { name: "Remote repository" });
    assert.equal(await link.count(), 0);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Remote repository link" }).count(), 0, "not in global settings");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });

    await page.getByRole("button", { name: "Edit /tmp/example" }).click();
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
    assert.equal((await link.textContent())?.trim(), "owner/example");
    assert.equal(await link.getAttribute("title"), "https://github.com/owner/example");
    assert.equal(await link.locator("svg.lucide-github").count(), 1);
    const headingBox = await page.locator("header h1").boundingBox();
    const linkBox = await link.boundingBox();
    assert.ok(headingBox && linkBox && linkBox.y >= headingBox.y + headingBox.height - 1, "link sits below the heading");
    assert.equal(await page.locator("header").getByText("/tmp/example", { exact: true }).count(), 0, "the repo path is not shown under the name");

    await page.reload();
    await link.waitFor();
    await page.getByRole("button", { name: "Edit /tmp/example" }).click();
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
