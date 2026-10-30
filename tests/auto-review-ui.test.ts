import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("unattended review is configured per repository, not in global Settings", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false } });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const boards = [
      { id: "first", repo: "/tmp/first/app", icon: "sprinkle_donut", color: "violet", autoReviewEnabled: true, autoReviewMergeLimit: 5, verificationCommand: "npm test", autoCollapseEmptySwimlanes: false },
      { id: "second", repo: "/tmp/second/app", icon: "sprinkle_donut", color: "violet", autoReviewEnabled: false, autoReviewMergeLimit: 0, verificationCommand: "npm run check", autoCollapseEmptySwimlanes: false },
    ];
    const patches: Record<string, unknown>[] = [];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "PATCH") {
        const patch = route.request().postDataJSON() as Record<string, unknown>;
        patches.push(patch);
        Object.assign(boards.find(item => path.includes(`/${item.id}/`))!, patch);
        await route.fulfill({ json: boards.find(item => path.includes(`/${item.id}/`)) });
        return;
      }
      await route.fulfill({ json: path === "/api/boards" ? boards
        : path === "/api/settings" ? { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" }
        : path === "/api/repository-root" ? { root: "/tmp" }
        : [] });
    });
    await page.goto(`http://127.0.0.1:${address.port}/board/first`);
    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Theme").waitFor();
    assert.equal(await dialog.getByText("Unattended review").count(), 0);
    assert.equal(await dialog.getByRole("textbox", { name: "Auto-review verification command" }).count(), 0);
    await page.keyboard.press("Escape");

    // The edit pencil lives on the open board's heading.
    await page.getByRole("button", { name: "Kanban" }).click();
    await page.getByRole("button", { name: "Edit /tmp/first/app" }).click();
    await dialog.getByText("Unattended review").waitFor();
    assert.equal(await dialog.getByRole("textbox", { name: "Auto-review verification command" }).inputValue(), "npm test");
    await dialog.getByRole("button", { name: "Disable auto-review" }).waitFor();
    // The limit is a number field; 0 reads as no limit, and the text follows the board's real value.
    const limit = dialog.getByRole("spinbutton", { name: "Auto-review merge limit" });
    assert.equal(await limit.inputValue(), "5");
    await dialog.getByText("At most 5 merges per 24 hours.").waitFor();
    assert.equal(await dialog.getByText(/At most 3 merges/).count(), 0);
    assert.equal(await dialog.getByRole("combobox", { name: "Repository root" }).evaluate(input => input === document.activeElement), false,
      "the repository path picker is not focused when editing a repository");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "app", exact: true }).nth(1).click();
    await page.getByRole("button", { name: "Kanban" }).last().click();
    await page.getByRole("button", { name: "Edit /tmp/second/app" }).click();
    assert.equal(await dialog.getByRole("textbox", { name: "Auto-review verification command" }).inputValue(), "npm run check");
    await dialog.getByRole("button", { name: "Enable auto-review" }).waitFor();
    assert.equal(await limit.inputValue(), "0");
    await dialog.getByText("No limit on merges per 24 hours.").waitFor();
    // The enable confirm quotes the value in the field, saved before the board is enabled.
    const confirms: string[] = [];
    page.on("dialog", async confirm => { confirms.push(confirm.message()); await confirm.accept(); });
    await limit.fill("2");
    await dialog.getByText("At most 2 merges per 24 hours.").waitFor();
    await dialog.getByRole("button", { name: "Enable auto-review" }).click();
    await page.waitForTimeout(200);
    assert.match(confirms[0] ?? "", /up to 2 local merges per 24 hours/);
    assert.deepEqual(patches.map(patch => patch.autoReviewMergeLimit ?? (patch.autoReviewEnabled ? "enable" : "other")), [2, "enable"]);
  } finally { await browser.close(); await server.close(); }
});
