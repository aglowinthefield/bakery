import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const worktree = "/Users/example/projects/a very long repository name/worktrees/attempt-with-an-exact-path";
const otherWorktree = "/Users/example/projects/other/worktrees/previous";
const failedWorktree = "/Users/example/.local/share/bakery/worktrees/failed-run";
const failure = "Pi exited (143); Bakery sent SIGTERM: server received SIGTERM; no settlement event; stderr logged on server";
const runs = [
  { id: "errored", attempt: 4, status: "failed", worktree: failedWorktree, output: "line one\nlast words", error: failure, startedAt: "2025-01-01T13:00:00Z", finishedAt: "2025-01-01T13:05:00Z", startedBy: "manual" },
  { id: "first", attempt: 3, status: "failed", worktree, output: "", error: null, startedAt: "2025-01-01T12:00:00Z", finishedAt: null, startedBy: "manual" },
  { id: "missing", attempt: 2, status: "failed", worktree: null, output: "", error: null, startedAt: "2025-01-01T11:00:00Z", finishedAt: null, startedBy: "manual" },
  { id: "older", attempt: 1, status: "failed", worktree: otherWorktree, output: "", error: null, startedAt: "2025-01-01T10:00:00Z", finishedAt: null, startedBy: "manual" },
];

async function openAttempts() {
  const server = await createServer({ server: { port: 0, strictPort: false } });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch();
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 390, height: 800 } });
  const page = await context.newPage();
  // These tests cover the board, not the Today landing page.
  await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    const data = path === "/api/boards" ? [{ id: "board", repo: "/Users/example/projects/repo" }]
      : path === "/api/settings" ? { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "dark" }
      : path === "/api/boards/board/cards" ? [{ id: "card", title: "Copy a path", body: "", repo: "/Users/example/projects/repo", source: "manual", status: "failed", createdAt: "2025-01-01T10:00:00Z", updatedAt: "2025-01-01T10:00:00Z", turns: 0, turnsIncomplete: 0 }]
      : path === "/api/boards/board/cards/card/runs" ? runs
      : path === "/api/boards/board/cards/card/approval" ? { pending: false }
      : [];
    return route.fulfill({ json: data });
  });
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.getByRole("button", { name: /Copy a path/ }).click();
  await page.getByRole("tab", { name: /^Attempts/ }).click();
  await page.getByRole("heading", { name: "Attempts" }).waitFor();
  await page.getByText(failedWorktree, { exact: true }).waitFor();
  return { page, browser, server };
}

test("attempt paths copy exactly, only where present, with visible success and failure", async () => {
  const { page, browser, server } = await openAttempts();
  try {
    await page.getByRole("button", { name: /Attempt #3/ }).click();
    await page.getByText(worktree, { exact: true }).waitFor();
    const first = page.locator("#attempt-first");
    const missing = page.locator("#attempt-missing");
    const older = page.locator("#attempt-older");
    assert.equal(await first.getByRole("button", { name: "Copy path" }).count(), 1);
    await page.getByRole("button", { name: /Attempt #2/ }).click();
    assert.equal(await missing.getByRole("button", { name: "Copy path" }).count(), 0);
    await page.getByRole("button", { name: /Attempt #1/ }).click();
    assert.equal(await older.getByRole("button", { name: "Copy path" }).count(), 1);
    await first.getByRole("button", { name: "Copy path" }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), worktree);
    await first.getByRole("status").getByText("Path copied").waitFor();
    assert.equal(await older.getByRole("status").count(), 0);
    assert.equal(await first.getByText(worktree, { exact: true }).evaluate(el => getComputedStyle(el).overflowWrap), "anywhere");
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => { throw new Error("denied"); };
    });
    await first.getByRole("button", { name: "Copy path" }).click();
    await first.getByRole("alert").getByText("Could not copy path").waitFor({ timeout: 2000 });
  } finally { await browser.close(); await server.close(); }
});

test("failed attempts with an error copy an agent prompt instead of the path", async () => {
  const { page, browser, server } = await openAttempts();
  try {
    const errored = page.locator("#attempt-errored");
    assert.equal(await errored.getByRole("button", { name: "Copy path" }).count(), 0);
    await errored.getByRole("button", { name: "Copy error" }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /Investigate the failure/);
    assert.ok(copied.includes("Card: Copy a path"));
    assert.ok(copied.includes("Repo: /Users/example/projects/repo"));
    assert.ok(copied.includes("Attempt: #4 (failed)"));
    assert.ok(copied.includes(`Worktree: ${failedWorktree}`));
    assert.ok(copied.includes(failure));
    assert.ok(copied.includes("last words"));
    await errored.getByRole("status").getByText("Error copied as agent prompt").waitFor();
  } finally { await browser.close(); await server.close(); }
});
