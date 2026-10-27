import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("a capped board shows the reason, next slot, and a confirmed reset in the repository settings", async () => {
  const server = await createServer({ server: { port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // These tests cover the board, not the Today landing page.
    await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
    let board = { id: "board", repo: "/tmp/bakery", autoPickupEnabled: true, pickupConcurrency: 2,
      pickupDailyLimit: 6, autoPickupStarts: 6, autoPickupNextAt: "2026-10-26T07:04:01.000Z" as string | null,
      autoPickupError: "", autoCollapseEmptySwimlanes: false, autoReviewEnabled: false, verificationCommand: "" };
    let resets = 0, dialogs = 0;
    page.on("dialog", dialog => { dialogs++; void (dialogs === 1 ? dialog.dismiss() : dialog.accept()); });
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards/board/auto-pickup/reset-limit" && route.request().method() === "POST") {
        resets++; board = { ...board, autoPickupStarts: 0, autoPickupNextAt: null };
        await route.fulfill({ json: board }); return;
      }
      if (path === "/api/boards/board/settings" && route.request().method() === "PATCH") {
        board = { ...board, ...route.request().postDataJSON() }; await route.fulfill({ json: board }); return;
      }
      const data = path === "/api/boards" ? [board]
        : path === "/api/settings" ? { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" }
        : [];
      await route.fulfill({ json: data });
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByText(/Auto pickup waiting: 6 \/ 6/).waitFor();
    await page.getByText(/Next slot around/).first().waitFor();
    await page.getByRole("button", { name: "Reset start limit" }).first().click();
    assert.equal(resets, 0, "cancelling does not restart paid pickup");
    await page.getByRole("button", { name: "Reset start limit" }).first().click();
    await page.getByText(/Auto pickup waiting/).waitFor({ state: "hidden" });
    assert.equal(resets, 1);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByText("Auto pickup is set per repository.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Auto pickup daily start limit" }).count(), 0, "global Settings has no pickup controls");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Edit /tmp/bakery" }).click();
    await page.getByRole("combobox", { name: "Auto pickup daily start limit" }).selectOption("99");
    await page.getByText(/0 \/ 99 starts/).waitFor();
    assert.equal(board.pickupDailyLimit, 99);
    assert.equal(dialogs, 3, "raising the limit confirms even before a Ready card is polled");
  } finally { await browser.close(); await server.close(); }
});
