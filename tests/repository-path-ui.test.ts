import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("repository path suggestions can be picked by keyboard or pointer without submitting", async () => {
  const server = await createServer({ server: { port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const submitted: string[] = [];
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/path-suggestions") {
        const path = url.searchParams.get("path");
        await route.fulfill({ json: path === "~/co" ? ["~/code/", "~/config/"] : [] });
        return;
      }
      if (url.pathname === "/api/boards" && route.request().method() === "POST") {
        submitted.push(route.request().postDataJSON().repo);
        await route.fulfill({ json: { id: "board", repo: "/home/code" } });
        return;
      }
      await route.fulfill({ json: url.pathname === "/api/settings"
        ? { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" }
        : [] });
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByRole("button", { name: "Add repository" }).click();
    const input = page.getByRole("combobox", { name: "Repository root" });
    await input.fill("~/co");
    await page.getByRole("option", { name: "~/code/" }).waitFor();
    await input.press("ArrowDown");
    await input.press("Enter");
    assert.equal(await input.inputValue(), "~/code/");
    assert.deepEqual(submitted, []);
    await input.fill("~/co");
    await page.getByRole("option", { name: "~/config/" }).click();
    assert.equal(await input.inputValue(), "~/config/");
    assert.deepEqual(submitted, []);
    await input.fill("~/co");
    await page.getByRole("option", { name: "~/code/" }).waitFor();
    await input.press("Escape");
    assert.equal(await page.getByRole("option").count(), 0);
    await input.fill("~/code");
    await page.getByRole("dialog").getByRole("button", { name: "Add" }).click();
    assert.deepEqual(submitted, ["~/code"]);
  } finally {
    await browser.close();
    await server.close();
  }
});
