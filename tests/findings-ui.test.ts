import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let url: string;

before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

const card = (id: string, title: string, status: string) =>
  ({ id, title, body: "", repo: "/tmp/repo", source: "manual", status, priority: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0, attempts: 1, reviewRounds: 0, runAgent: "", reviewAgent: "" });

test("a reviewed run with no diff shows its report as markdown findings and offers Accept findings instead of Approve", async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
  const fingerprint = "a".repeat(64);
  let accepted: unknown = null;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/accept-findings")) { accepted = route.request().postDataJSON(); return route.fulfill({ json: card("research", "Research card", "done") }); }
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", icon: "layout-grid", color: "violet", remoteUrl: "", integration: "local", autoCollapseEmptySwimlanes: false, verificationCommand: "" }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": [card("research", "Research card", "review")],
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/research/runs": [{ id: "run", attempt: 1, status: "review", output: "Turn 1: bash ×1\n**Answer: yes.**", report: "**Answer: yes, if** one change lands.\n\n1. Pass `token` through\n2. Add a test", error: null, worktree: null, startedAt: "2026-01-01", finishedAt: "2026-01-01", startedBy: "manual" }],
      "/api/boards/board/cards/research/approval": { pending: false },
      "/api/boards/board/cards/research/comments": [],
      "/api/boards/board/cards/research/auto-review": [],
      "/api/boards/board/cards/research/dependencies": [],
      "/api/boards/board/cards/research/review": { fingerprint, files: [] },
    };
    await route.fulfill({ json: path in data ? data[path] : [] });
  });
  try {
    await page.goto(url);
    await page.getByRole("button", { name: /Research card/ }).click();
    const findings = page.getByRole("region", { name: "Findings" });
    await findings.waitFor();
    assert.equal(await findings.locator("strong").first().innerText(), "Answer: yes, if");
    assert.equal(await findings.locator("ol > li").count(), 2);
    assert.equal(await findings.locator("code").innerText(), "token");
    assert.equal(await page.getByRole("button", { name: /^Approve/ }).count(), 0);
    page.once("dialog", dialog => void dialog.accept());
    await page.getByRole("button", { name: "Accept findings" }).click();
    for (let i = 0; i < 50 && !accepted; i++) await page.waitForTimeout(50);
    assert.deepEqual(accepted, { fingerprint });
  } finally { await page.close(); }
});
