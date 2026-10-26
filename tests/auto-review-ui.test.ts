import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("Settings identifies the selected repository and loads its own auto-review command", async () => {
  const server = await createServer({ server: { port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const boards = [
      { id: "first", repo: "/tmp/first/app", autoReviewEnabled: true, verificationCommand: "npm test", autoCollapseEmptySwimlanes: false },
      { id: "second", repo: "/tmp/second/app", autoReviewEnabled: false, verificationCommand: "npm run check", autoCollapseEmptySwimlanes: false },
    ];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      await route.fulfill({ json: path === "/api/boards" ? boards
        : path === "/api/settings" ? { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" }
        : [] });
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Unattended review · /tmp/first/app").waitFor();
    assert.equal(await dialog.getByRole("textbox", { name: "Auto-review verification command" }).inputValue(), "npm test");
    await page.keyboard.press("Escape");
    await page.locator('button[title="/tmp/second/app"]').click();
    await page.getByRole("button", { name: "Settings" }).click();
    await dialog.getByText("Unattended review · /tmp/second/app").waitFor();
    assert.equal(await dialog.getByRole("textbox", { name: "Auto-review verification command" }).inputValue(), "npm run check");
    await dialog.getByRole("button", { name: "Enable auto-review" }).waitFor();
  } finally { await browser.close(); await server.close(); }
});
