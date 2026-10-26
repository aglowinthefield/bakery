import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("unattended review is configured per repository, not in global Settings", async () => {
  const server = await createServer({ server: { port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const boards = [
      { id: "first", repo: "/tmp/first/app", icon: "layout-grid", color: "violet", autoReviewEnabled: true, verificationCommand: "npm test", autoCollapseEmptySwimlanes: false },
      { id: "second", repo: "/tmp/second/app", icon: "layout-grid", color: "violet", autoReviewEnabled: false, verificationCommand: "npm run check", autoCollapseEmptySwimlanes: false },
    ];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      await route.fulfill({ json: path === "/api/boards" ? boards
        : path === "/api/settings" ? { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" }
        : path === "/api/repository-root" ? { root: "/tmp" }
        : [] });
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Theme").waitFor();
    assert.equal(await dialog.getByText("Unattended review").count(), 0);
    assert.equal(await dialog.getByRole("textbox", { name: "Auto-review verification command" }).count(), 0);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Edit /tmp/first/app" }).click();
    await dialog.getByText("Unattended review").waitFor();
    assert.equal(await dialog.getByRole("textbox", { name: "Auto-review verification command" }).inputValue(), "npm test");
    await dialog.getByRole("button", { name: "Disable auto-review" }).waitFor();
    assert.equal(await dialog.getByRole("combobox", { name: "Repository root" }).evaluate(input => input === document.activeElement), false,
      "the repository path picker is not focused when editing a repository");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Edit /tmp/second/app" }).click();
    assert.equal(await dialog.getByRole("textbox", { name: "Auto-review verification command" }).inputValue(), "npm run check");
    await dialog.getByRole("button", { name: "Enable auto-review" }).waitFor();
  } finally { await browser.close(); await server.close(); }
});
