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

const card = (id: string, title: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, title, body: "", repo: "/tmp/repo", source: "manual", status, priority: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0, attempts: 1, reviewRounds: 0, runAgent: "", reviewAgent: "", ...extra });

async function open(integration: "local" | "github-pr") {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
  const fingerprint = "a".repeat(64);
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", icon: "sprinkle_donut", color: "violet", remoteUrl: "https://github.com/acme/widgets", integration, autoCollapseEmptySwimlanes: false, verificationCommand: "" }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": [
        card("review", "Review card", "review"),
        card("pushed", "Pushed card", "done", integration === "local" ? { originMain: "pushed" } : {}),
        card("local", "Local card", "done", integration === "local" ? { originMain: "local" } : {}),
      ],
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/review/runs": [{ id: "run", attempt: 1, status: "review", output: "", error: null, worktree: null, startedAt: "2026-01-01", finishedAt: "2026-01-01", startedBy: "manual" }],
      "/api/boards/board/cards/review/approval": { pending: false },
      "/api/boards/board/cards/review/comments": [],
      "/api/boards/board/cards/review/auto-review": [],
      "/api/boards/board/cards/review/dependencies": [],
      "/api/boards/board/cards/review/review": { fingerprint, files: [{ path: "a.ts", patch: "@@ -0,0 +1 @@\n+a\n" }] },
    };
    if (path in data) await route.fulfill({ json: data[path] });
    else await route.fulfill({ json: [] });
  });
  await page.goto(url);
  await page.getByRole("button", { name: /Review card/ }).waitFor();
  return page;
}

test("local board: header names local main, Done cards say whether they reached origin/main, and the button says local main", async () => {
  const page = await open("local");
  try {
    assert.match(await page.getByTestId("integration-mode").innerText(), /local main.*does not push/);
    const badge = (title: string) => page.getByRole("button", { name: new RegExp(title) }).getByTestId("origin-main-badge");
    assert.equal(await badge("Pushed card").innerText(), "On origin/main");
    assert.equal(await badge("Local card").innerText(), "Merged locally, not pushed");
    assert.match((await badge("Local card").getAttribute("title"))!, /last fetch/);
    await page.getByRole("button", { name: /Review card/ }).click();
    await page.getByRole("button", { name: "Approve and merge into local main" }).waitFor();
  } finally { await page.close(); }
});

test("github-pr board: header names pull requests, no push badge, and the button opens a PR", async () => {
  const page = await open("github-pr");
  try {
    assert.match(await page.getByTestId("integration-mode").innerText(), /GitHub pull requests/);
    assert.equal(await page.getByTestId("origin-main-badge").count(), 0);
    await page.getByRole("button", { name: /Review card/ }).click();
    await page.getByRole("button", { name: "Approve and open PR" }).waitFor();
  } finally { await page.close(); }
});
