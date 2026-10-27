import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const repo = "/Users/example/projects/repo";
const card = { id: "card", title: "Count tokens", body: "", repo, source: "manual", status: "failed", createdAt: "2025-01-01T10:00:00Z", updatedAt: "2025-01-01T10:00:00Z", turns: 0, turnsIncomplete: 0, runAgent: "", reviewAgent: "",
  inputTokens: 2000, outputTokens: 320, cacheReadTokens: 5000, cacheWriteTokens: 100, cost: 0.5, usageIncomplete: 1 };
const runs = [
  { id: "new", attempt: 2, status: "review", worktree: null, output: "", error: null, startedAt: "2025-01-01T12:00:00Z", finishedAt: "2025-01-01T12:05:00Z", startedBy: "manual", agent: "",
    inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, cacheWriteTokens: 100, cost: 0.42 },
  { id: "old", attempt: 1, status: "failed", worktree: null, output: "", error: null, startedAt: "2025-01-01T11:00:00Z", finishedAt: null, startedBy: "manual", agent: "",
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cost: null },
];

async function open(board: Record<string, unknown>, onPatch: (input: Record<string, unknown>) => Record<string, unknown> = input => input) {
  const server = await createServer({ server: { port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // These tests cover the board, not the Today landing page.
  await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
  let current = board;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/boards/board/settings" && route.request().method() === "PATCH") {
      current = { ...current, ...onPatch(route.request().postDataJSON()) };
      await route.fulfill({ json: current }); return;
    }
    const data = path === "/api/boards" ? [current]
      : path === "/api/settings" ? { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" }
      : path === "/api/boards/board/cards" ? [card]
      : path === "/api/boards/board/cards/card/runs" ? runs
      : path === "/api/boards/board/cards/card/auto-review" ? [{ cardId: "card", runId: "new", state: "needs_human", details: "Check it", fingerprint: "", startedAt: "2025-01-01T12:06:00Z", finishedAt: "2025-01-01T12:07:00Z", agent: "", cost: 0.08, inputTokens: 800, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }]
      : path === "/api/boards/board/cards/card/approval" ? { pending: false }
      : [];
    await route.fulfill({ json: data });
  });
  await page.goto(`http://127.0.0.1:${address.port}/`);
  return { page, close: async () => { await browser.close(); await server.close(); } };
}

const baseBoard = { id: "board", repo, autoPickupEnabled: true, pickupConcurrency: 2, pickupDailyLimit: 6, autoPickupStarts: 1, autoPickupNextAt: null,
  autoPickupError: "", autoCollapseEmptySwimlanes: false, autoReviewEnabled: false, verificationCommand: "" };

test("attempts show their cost, older attempts show a dash, and the card shows its total", async () => {
  const { page, close } = await open({ ...baseBoard, cost24h: 0.5, pickupCostBudget: null, autoPickupBudgetReached: false });
  try {
    await page.getByRole("button", { name: /Count tokens/ }).click();
    await page.getByRole("heading", { name: "Attempts" }).waitFor();
    await page.getByRole("button", { name: /Attempt #2/ }).getByText("Cost: $0.42").waitFor();
    await page.getByRole("button", { name: /Attempt #1/ }).getByText("Cost: —").waitFor();
    assert.match(await page.getByRole("button", { name: /Attempt #2/ }).getByText("Cost: $0.42").getAttribute("title") ?? "", /1,200 input, 300 output, 5,000 cache read, 100 cache write/);
    await page.getByText("Card total: $0.50 + older attempts not recorded").waitFor();
    await page.getByText("Review cost: $0.08").waitFor();
  } finally { await close(); }
});

test("the board shows rolling spend, a reached budget explains the wait, and the repository settings save or clear the budget", async () => {
  let dialogs = 0;
  const { page, close } = await open({ ...baseBoard, cost24h: 1.2, pickupCostBudget: 1, autoPickupBudgetReached: true }, input => ({
    ...input, autoPickupBudgetReached: typeof input.pickupCostBudget === "number" && input.pickupCostBudget <= 1.2,
  }));
  page.on("dialog", dialog => { dialogs++; void dialog.accept(); });
  try {
    await page.getByText("Last 24h: $1.20 of $1.00 budget").waitFor();
    await page.getByText(/Auto pickup waiting: daily cost budget reached/).waitFor();
    await page.getByText(/Manual starts still work/).waitFor();
    await page.getByRole("button", { name: `Edit ${repo}` }).click();
    const input = page.getByRole("textbox", { name: "Auto pickup daily cost budget" });
    assert.equal(await input.inputValue(), "1");
    await input.fill("abc");
    await page.getByRole("button", { name: "Save budget" }).click();
    await page.getByText(/must be blank \(off\) or between/).first().waitFor();
    await input.fill("5");
    await page.getByRole("button", { name: "Save budget" }).click();
    await page.getByText(/\$1\.20 spent in the last 24 hours of \$5\.00/).waitFor();
    assert.equal(dialogs, 1, "raising a reached budget asks first because pickup may start runs");
    await input.fill("");
    await page.getByRole("button", { name: "Save budget" }).click();
    await page.getByText(/\$1\.20 spent in the last 24 hours\. Leave blank/).waitFor();
    await page.keyboard.press("Escape");
    await page.getByText("Last 24h: $1.20", { exact: true }).waitFor();
    assert.equal(await page.getByText(/daily cost budget reached/).count(), 0);
  } finally { await close(); }
});
