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

const at = new Date().toISOString();
const line = (seq: number, level: string, message: string) => ({ seq, at, level, message });

test("Logs shows the server's output, polls for new lines, and filters by level and text", async () => {
  const page = await browser.newPage();
  const queries: string[] = [];
  let batches = [[line(1, "info", "Bakery listening on http://127.0.0.1:4317"), line(2, "debug", "GET /api/x -> 404: Not found")], [line(3, "error", "GitHub sync for /code/alpha: gh failed")]];
  await page.route("**/api/**", async route => {
    const request = new URL(route.request().url());
    if (request.pathname === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, notifyOnReview: false, cardDetailsLayout: "dialog", theme: "default" } });
    if (request.pathname === "/api/logs") {
      queries.push(request.search);
      const entries = batches[0] ?? [];
      batches = batches.slice(1);
      return route.fulfill({ json: { startedAt: at, entries } });
    }
    return route.fulfill({ json: [] });
  });
  try {
    await page.goto(url);
    await page.getByRole("button", { name: "Logs" }).click();
    await page.getByRole("heading", { name: "Logs" }).waitFor();
    await page.getByText("Bakery listening on http://127.0.0.1:4317").waitFor();
    await page.getByText("gh failed").waitFor();
    assert.deepEqual(queries.slice(0, 2), ["?after=0", "?after=2"]);
    assert.equal(new URL(page.url()).pathname, "/logs");
    await page.getByRole("combobox", { name: "Log level" }).selectOption("warn");
    assert.equal(await page.locator("[data-log-level]").count(), 1);
    await page.getByRole("combobox", { name: "Log level" }).selectOption("debug");
    await page.getByRole("textbox", { name: "Filter logs" }).fill("api/x");
    assert.deepEqual(await page.locator("[data-log-level]").evaluateAll(rows => rows.map(row => row.getAttribute("data-log-level"))), ["debug"]);
  } finally { await page.close(); }
});
