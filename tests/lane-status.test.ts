import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const statuses = ["triage", "ready", "running", "review", "failed", "interrupted", "done", "archived"];
const labels: Record<string, string> = { archived: "Archive" };
let server: ViteDevServer;
let browser: Browser;

before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

test("each lane keeps its label and a readable status dot in both palettes and when collapsed", async () => {
  const page = await browser.newPage();
  // These tests cover the board, not the Today landing page.
  await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog" },
      "/api/boards/board/cards": statuses.map(status => ({ id: status, title: `${status} card`, body: "", repo: "/tmp/repo", source: "manual", status, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0 })),
      "/api/boards/board/conflicts": [],
    };
    assert.ok(path in data, `Unexpected API request: ${path}`);
    await route.fulfill({ json: data[path] });
  });
  try {
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole("heading", { name: "Triage" }).waitFor();
    assert.equal(await page.getByText("Can start a Pi run", { exact: true }).count(), 0, "lane captions do not take space below headings");
    assert.equal(await page.getByRole("button", { name: /ready card/ }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: /archived card/ }).count(), 0, "Archive starts collapsed");
    await page.getByRole("button", { name: "Expand Archive lane" }).click();
    let defaultColors: string[] = [];
    for (const theme of ["default", "compline", "hearth", "gruvbox-dark", "gruvbox-light", "nord"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      const colors = new Set<string>();
      for (const status of statuses) {
        const lane = page.locator(`section[data-status="${status}"]`);
        assert.equal(await lane.getByRole("heading", { name: labels[status] ?? status[0].toUpperCase() + status.slice(1), exact: true }).isVisible(), true);
        const { dot, surface } = await lane.evaluate(element => {
          const dot = element.querySelector(".lane-status-dot")!;
          return { dot: getComputedStyle(dot).backgroundColor, surface: getComputedStyle(document.body).backgroundColor };
        });
        colors.add(dot);
        const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        const luminance = (color: string) => rgb(color).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
        const a = luminance(dot);
        const b = luminance(surface);
        assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, `${theme} ${status}: ${dot} against ${surface}`);
      }
      assert.equal(colors.size, statuses.length, `${theme} dots are distinct`);
      if (theme === "default") defaultColors = [...colors];
      else assert.notDeepEqual([...colors], defaultColors, "switching palettes changes status dots");
      await page.getByRole("button", { name: "Collapse Done lane" }).click();
      const collapsed = page.getByRole("button", { name: "Expand Done lane" });
      assert.equal(await collapsed.getByText("Done", { exact: true }).isVisible(), true);
      assert.equal(await collapsed.locator(".lane-status-dot").count(), 1);
      await collapsed.click();
    }
  } finally { await page.close(); }
});
