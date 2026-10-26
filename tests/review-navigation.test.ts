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

test("changed files open their own patches and focus the heading without changing review data", async () => {
  const page = await browser.newPage();
  const fingerprint = "a".repeat(64);
  const files = ["src/first.ts", "src/second.ts", "src/third.ts"];
  const comments = [{ id: "note", cardId: "card", runId: "run", fingerprint, path: files[1], line: 2, fileLine: 1, kind: "add", code: "second", body: "Keep this note", state: "draft", createdAt: "2026-01-01" }];
  const requests: string[] = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(`${route.request().method()} ${path}`);
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "dark" },
      "/api/boards/board/cards": [{ id: "card", title: "Review card", body: "", repo: "/tmp/repo", source: "manual", status: "review", createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0 }],
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/card/runs": [{ id: "run", attempt: 1, status: "review", output: "", error: null, worktree: null, startedAt: "2026-01-01", finishedAt: "2026-01-01", startedBy: "manual" }],
      "/api/boards/board/cards/card/approval": { pending: false },
      "/api/boards/board/cards/card/comments": comments,
      "/api/boards/board/cards/card/auto-review": [],
      "/api/boards/board/cards/card/review": { fingerprint, files: files.map((file, index) => ({ path: file, patch: `@@ -0,0 +1 @@\n+${["first", "second", "third"][index]}\n` })) },
    };
    assert.ok(path in data, `Unexpected API request: ${path}`);
    await route.fulfill({ json: data[path] });
  });
  try {
    await page.goto(url);
    await page.getByRole("button", { name: /Review card/ }).click();
    const list = page.getByRole("list").filter({ has: page.getByRole("button", { name: files[1], exact: true }) });
    const patchButton = (index: number) => page.locator(`button[aria-controls="review-file-${index}"]`);
    await page.getByText("Changed files (3)").waitFor();
    assert.equal(await patchButton(1).getAttribute("aria-expanded"), "false");
    await list.getByRole("button", { name: files[1] }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await patchButton(1).getAttribute("aria-expanded"), "true");
    assert.equal(await patchButton(1).evaluate(element => element === document.activeElement), true);
    assert.equal(await patchButton(1).evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.top >= 0 && bounds.bottom <= innerHeight; }), true);
    assert.equal(await page.getByText("Keep this note").count(), 2);
    await page.getByRole("button", { name: "Comment on src/second.ts line 1 (add)" }).click();
    await page.getByPlaceholder("What should change?").fill("Keep draft text");
    await list.getByRole("button", { name: files[2] }).focus();
    await page.keyboard.press("Space");
    assert.equal(await patchButton(2).getAttribute("aria-expanded"), "true");
    assert.equal(await patchButton(2).evaluate(element => element === document.activeElement), true);
    await list.getByRole("button", { name: files[0] }).click();
    assert.equal(await patchButton(0).getAttribute("aria-expanded"), "true");
    await list.getByRole("button", { name: files[1] }).click();
    assert.equal(await page.getByPlaceholder("What should change?").inputValue(), "Keep draft text");
    await patchButton(1).click();
    assert.equal(await patchButton(1).getAttribute("aria-expanded"), "false");
    await list.getByRole("button", { name: files[1] }).click();
    assert.equal(await patchButton(1).getAttribute("aria-expanded"), "true");
    assert.equal(await patchButton(1).evaluate(element => element === document.activeElement), true);
    assert.deepEqual(requests.filter(request => !request.startsWith("GET ")), []);
    assert.equal(requests.filter(request => request.endsWith("/review")).length, 1);
  } finally { await page.close(); }
});

test("Run again is unavailable while agent review is running and returns when it ends", async () => {
  const page = await browser.newPage();
  let reviewState: "running" | "needs_human" = "running";
  let starts = 0;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/start")) { starts++; await route.fulfill({ status: 500, json: { error: "Unexpected start" } }); return; }
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": [{ id: "card", title: "Review card", body: "", repo: "/tmp/repo", source: "manual", status: "review", createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0 }],
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/card/runs": [{ id: "run", attempt: 1, status: "review", output: "", error: null, worktree: null, startedAt: "2026-01-01", finishedAt: "2026-01-01", startedBy: "manual" }],
      "/api/boards/board/cards/card/approval": { pending: false },
      "/api/boards/board/cards/card/comments": [],
      "/api/boards/board/cards/card/auto-review": [{ cardId: "card", runId: "run", state: reviewState, details: "", fingerprint: "", startedAt: "2026-01-01", finishedAt: null }],
      "/api/boards/board/cards/card/review": { fingerprint: "a".repeat(64), files: [] },
    };
    assert.ok(path in data, `Unexpected API request: ${path}`);
    await route.fulfill({ json: data[path] });
  });
  try {
    await page.goto(url);
    await page.getByRole("button", { name: /Review card/ }).click();
    const runAgain = page.getByRole("button", { name: "Run again" });
    await page.getByText("Agent review: checking").waitFor();
    assert.equal(await runAgain.isDisabled(), true);
    reviewState = "needs_human";
    await page.getByText("Agent review: needs human review").waitFor();
    assert.equal(await runAgain.isEnabled(), true);
    assert.equal(starts, 0);
  } finally { await page.close(); }
});

test("a request failure remains visible after closing card details", async () => {
  const page = await browser.newPage();
  let resolveStart!: () => void;
  const started = new Promise<void>(resolve => { resolveStart = resolve; });
  let finishStart!: () => void;
  const response = new Promise<void>(resolve => { finishStart = resolve; });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/start")) {
      resolveStart();
      await response;
      await route.fulfill({ status: 409, json: { error: "The worktree changed before start" } });
      return;
    }
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "dark" },
      "/api/boards/board/cards": [{ id: "ready", title: "Ready card", body: "", repo: "/tmp/repo", source: "manual", status: "ready", createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0 }],
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/ready/runs": [],
      "/api/boards/board/cards/ready/approval": { pending: false },
      "/api/boards/board/cards/ready/comments": [],
      "/api/boards/board/cards/ready/auto-review": [],
    };
    assert.ok(path in data, `Unexpected API request: ${path}`);
    await route.fulfill({ json: data[path] });
  });
  try {
    await page.goto(url);
    await page.getByRole("button", { name: /Ready card/ }).click();
    await page.getByRole("button", { name: "Start Pi run" }).click();
    await started;
    await page.getByRole("button", { name: "Close" }).click();
    finishStart();
    await page.getByRole("alert").filter({ hasText: "The worktree changed before start" }).waitFor();
  } finally { finishStart(); await page.close(); }
});

test("the side panel switches cards without leaking the previous card's review or attempts", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const cards = [
      { id: "review", title: "Review card", status: "review" },
      { id: "ready", title: "Ready card", status: "ready" },
    ].map(card => ({ ...card, body: "", repo: "/tmp/repo", source: "manual", createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0 }));
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "side", theme: "dark" },
      "/api/boards/board/cards": cards,
      "/api/boards/board/conflicts": [],
      "/api/boards/board/cards/review/runs": [{ id: "run", attempt: 1, status: "review", output: "Old output", error: null, worktree: null, startedAt: "2026-01-01", finishedAt: "2026-01-01", startedBy: "manual" }],
      "/api/boards/board/cards/review/approval": { pending: false },
      "/api/boards/board/cards/review/comments": [],
      "/api/boards/board/cards/review/auto-review": [],
      "/api/boards/board/cards/review/review": { fingerprint: "a".repeat(64), files: [{ path: "src/old.ts", patch: "@@ -0,0 +1 @@\n+old\n" }] },
      "/api/boards/board/cards/ready/runs": [],
      "/api/boards/board/cards/ready/approval": { pending: false },
      "/api/boards/board/cards/ready/comments": [],
      "/api/boards/board/cards/ready/auto-review": [],
    };
    assert.ok(path in data, `Unexpected API request: ${path}`);
    await route.fulfill({ json: data[path] });
  });
  try {
    await page.goto(url);
    await page.getByRole("button", { name: /Review card/ }).click();
    await page.getByText("Changed files (1)").waitFor();
    await page.getByText("Old output").waitFor();
    await page.getByRole("button", { name: /Ready card/ }).click();
    await page.getByRole("heading", { name: "Ready card" }).waitFor();
    assert.equal(await page.getByText("Old output").count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Review diff" }).count(), 0);
    await page.getByRole("button", { name: /Review card/ }).click();
    await page.getByText("Changed files (1)").waitFor();
    await page.getByRole("heading", { name: "Review card" }).click();
    assert.equal(await page.getByRole("dialog").count(), 1, "clicking inside keeps the rail open");
    await page.locator("main").click({ position: { x: 40, y: 130 } });
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  } finally { await page.close(); }
});
