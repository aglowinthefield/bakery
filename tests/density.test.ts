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

// The size of one Tailwind spacing unit and of text-xs, in px, at the page's current density.
const measure = () => {
  const probe = document.createElement("div");
  probe.className = "p-1 text-xs";
  document.body.append(probe);
  const style = getComputedStyle(probe), result = { space: parseFloat(style.paddingTop), text: parseFloat(style.fontSize) };
  probe.remove();
  return result;
};

test("density picker rescales spacing and type, saves, and paints the cached density before settings load", async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
  let density = "default", hold = false, release!: () => void;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path !== "/api/settings") { await route.fulfill({ json: [] }); return; }
    if (route.request().method() === "PATCH") density = (route.request().postDataJSON() as { density: string }).density;
    else if (hold) await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { confirmRunStart: false, notifyOnReview: false, cardDetailsLayout: "dialog", theme: "default", density } });
  });
  try {
    await page.goto(url);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Appearance" }).click();
    const group = page.getByRole("group", { name: "Density" });
    assert.equal(await group.getByRole("radio", { name: "Default" }).isChecked(), true);
    const base = await page.evaluate(measure);
    assert.deepEqual(base, { space: 4, text: 12 });

    await group.getByRole("radio", { name: "Compact" }).check();
    await page.waitForFunction(() => document.documentElement.dataset.density === "compact");
    const compact = await page.evaluate(measure);
    assert.ok(compact.space < base.space && compact.text < base.text, JSON.stringify(compact));

    await group.getByRole("radio", { name: "Cozy" }).check();
    await page.waitForFunction(() => localStorage.getItem("bakery-density") === "cozy");
    assert.equal(density, "cozy");
    const cozy = await page.evaluate(measure);
    assert.ok(cozy.space > base.space && cozy.text > base.text, JSON.stringify(cozy));

    // On reload the cached density applies before the settings request answers.
    hold = true;
    await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.density), "cozy");
    release();

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Appearance" }).click();
    await page.getByRole("group", { name: "Density" }).getByRole("radio", { name: "Default" }).check();
    await page.waitForFunction(() => document.documentElement.dataset.density === undefined && localStorage.getItem("bakery-density") === "default");
    assert.deepEqual(await page.evaluate(measure), base);
  } finally { release?.(); await page.close(); }
});
