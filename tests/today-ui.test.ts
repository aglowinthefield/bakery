import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
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

const lastVisit = "2026-03-01T09:00:00.000Z";
const board = { autoCollapseEmptySwimlanes: false, autoPickupEnabled: false, autoReviewEnabled: false, icon: "rocket", color: "violet", cardCounts: {} };
const boards = [
  { ...board, id: "board-a", repo: "/code/alpha", cost24h: 1.25 },
  { ...board, id: "board-b", repo: "/code/beta", cost24h: 0.5 },
];
const card = (id: string, repo: string, status: string, updatedAt: string) =>
  ({ id, title: `Card ${id}`, body: "", repo, status, source: "manual", priority: 0, createdAt: "2026-02-01T00:00:00.000Z", updatedAt, turns: 0, turnsIncomplete: 0, attempts: 1, reviewRounds: 0, runAgent: "", reviewAgent: "" });

async function open(options: { cards: ReturnType<typeof card>[] }) {
  const page = await browser.newPage();
  const requests: { method: string; path: string; input: unknown }[] = [];
  const state = { cards: options.cards };
  await page.addInitScript(visit => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("bakery-last-visit", visit); sessionStorage.setItem("seeded", "1"); } }, lastVisit);
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push({ method: request.method(), path, input: request.postDataJSON() });
    if (path === "/api/boards") return route.fulfill({ json: boards });
    if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, notifyOnReview: false, cardDetailsLayout: "dialog", theme: "default" } });
    if (path === "/api/cards") return route.fulfill({ json: state.cards });
    if (/^\/api\/boards\/board-[ab]\/cards$/.test(path) && request.method() === "POST")
      return route.fulfill({ status: 201, json: { ...card("new", "/code/beta", "triage", "2026-03-02T00:00:00.000Z"), ...request.postDataJSON() } });
    if (/^\/api\/boards\/board-[ab]\/cards$/.test(path)) return route.fulfill({ json: state.cards.filter(item => path.includes("board-a") === (item.repo === "/code/alpha")) });
    if (path.endsWith("/approval")) return route.fulfill({ json: { pending: false } });
    if (path.endsWith("/review")) return route.fulfill({ json: { cardId: "x", fingerprint: "f".repeat(64), files: [] } });
    return route.fulfill({ json: [] });
  });
  await page.goto(url);
  return { page, requests, state };
}

const section = (page: Page, name: string) => page.getByRole("region", { name });

test("Today opens first and gathers what needs you across every repository", async () => {
  const { page } = await open({ cards: [
    card("review-new", "/code/beta", "review", "2026-03-02T10:00:00.000Z"),
    card("review-old", "/code/alpha", "review", "2026-03-01T10:00:00.000Z"),
    card("broken", "/code/alpha", "failed", "2026-03-02T11:00:00.000Z"),
    card("busy", "/code/beta", "running", "2026-03-02T12:00:00.000Z"),
    card("merged", "/code/alpha", "done", "2026-03-02T08:00:00.000Z"),
    card("merged-before", "/code/alpha", "done", "2026-02-20T08:00:00.000Z"),
    card("idea", "/code/beta", "triage", "2026-03-02T08:00:00.000Z"),
  ] });
  try {
    await page.getByRole("heading", { name: "Today" }).waitFor();
    assert.deepEqual(await section(page, "Needs you").getByRole("listitem").allInnerTexts().then(items => items.map(item => item.split("\n")[0])),
      ["Card review-old", "Card review-new", "Card broken"]);
    assert.deepEqual(await section(page, "Running").getByRole("listitem").allInnerTexts().then(items => items.map(item => item.split("\n")[0])), ["Card busy"]);
    assert.deepEqual(await section(page, "Finished since your last visit").getByRole("listitem").allInnerTexts().then(items => items.map(item => item.split("\n")[0])), ["Card merged"]);
    assert.match(await page.getByRole("status", { name: "Since your last visit" }).innerText(), /1 merged · 3 need you · \$1\.75 in the last 24h/);
    await section(page, "Running").getByRole("button", { name: /Card busy/ }).click();
    await page.getByRole("dialog").getByText("Card busy").waitFor();
  } finally { await page.close(); }
});

test("quick capture adds a Triage card to the chosen repository and remembers it", async () => {
  const { page, requests } = await open({ cards: [] });
  try {
    await page.getByText("All caught up").waitFor();
    await page.getByRole("combobox", { name: "Repository" }).selectOption({ label: "beta" });
    const input = page.getByRole("textbox", { name: "Capture a card" });
    await input.fill("Water the plants");
    await input.press("Enter");
    await page.getByText("Added to beta Triage").waitFor();
    assert.equal(await input.inputValue(), "");
    assert.deepEqual(requests.filter(item => item.method === "POST").map(item => [item.path, item.input]),
      [["/api/boards/board-b/cards", { title: "Water the plants", body: "" }]]);
    await page.reload();
    assert.equal(await page.getByRole("combobox", { name: "Repository" }).inputValue(), "board-b");
  } finally { await page.close(); }
});

test("review queue walks Review cards oldest first and moves on once a card leaves Review", async () => {
  const { page, state } = await open({ cards: [
    card("second", "/code/beta", "review", "2026-03-02T10:00:00.000Z"),
    card("first", "/code/alpha", "review", "2026-03-01T10:00:00.000Z"),
    card("third", "/code/alpha", "review", "2026-03-03T10:00:00.000Z"),
  ] });
  try {
    await page.getByRole("button", { name: "Review 3 cards" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: "Card first" }).waitFor();
    assert.match(await dialog.getByRole("status", { name: "Review queue" }).innerText(), /1 of 3/);
    await dialog.getByRole("button", { name: "Next card" }).click();
    await dialog.getByRole("heading", { name: "Card second" }).waitFor();
    // Approving elsewhere (or here) moves the card to Done; the queue follows on the next poll.
    state.cards = state.cards.map(item => item.id === "second" ? { ...item, status: "done" } : item);
    await dialog.getByRole("heading", { name: "Card third" }).waitFor({ timeout: 10000 });
    assert.match(await dialog.getByRole("status", { name: "Review queue" }).innerText(), /3 of 3/);
    await dialog.getByRole("button", { name: "Finish" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
  } finally { await page.close(); }
});

test("sidebar switches between Today and a repository board, and the choice persists", async () => {
  const { page } = await open({ cards: [card("idea", "/code/beta", "triage", "2026-03-02T08:00:00.000Z")] });
  try {
    await page.getByRole("heading", { name: "Today" }).waitFor();
    await page.getByRole("button", { name: "beta", exact: true }).click();
    await page.getByRole("heading", { name: "beta" }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "beta" }).waitFor();
    await page.getByRole("button", { name: /^Today/ }).click();
    await page.getByRole("heading", { name: "Today" }).waitFor();
  } finally { await page.close(); }
});
