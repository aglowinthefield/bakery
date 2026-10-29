import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

// The update notice: pending commits with an install button, then the wait for active runs before the restart.

const card = (id: string, title: string) => ({
  id, title, body: "", repo: "/tmp/repo", source: "manual", status: "running",
  createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0,
});

async function openApp(status: Record<string, unknown>, onUpdate?: () => unknown) {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let statusServed!: () => void;
  const served = new Promise<void>(resolve => { statusServed = resolve; });
  await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "side", theme: "default" },
      "/api/boards/board/cards": [card("a1b2c3d4-0000", "Fix login redirect")],
      "/api/boards/board/conflicts": [],
      "/api/cards": [],
      "/api/status": status,
    };
    if (path === "/api/update" && onUpdate) return route.fulfill({ status: 202, json: onUpdate() });
    if (/\/(runs|comments|auto-review)$/.test(path)) return route.fulfill({ json: [] });
    if (path.endsWith("/approval")) return route.fulfill({ json: { pending: false } });
    if (path.endsWith("/push-progress")) return route.fulfill({ json: null });
    assert.ok(path in data, `Unexpected API request: ${path}`);
    await route.fulfill({ json: data[path] });
    if (path === "/api/status") statusServed();
  });
  await page.goto(server.resolvedUrls!.local[0]);
  return { page, served, close: async () => { await browser.close(); await server.close(); } };
}

test("the update notice lists the cards it waits on and opens one", async () => {
  const { page, close } = await openApp({ draining: true, activeRuns: 1, cards: [{ id: "a1b2c3d4-0000", title: "Fix login redirect", repo: "/tmp/repo" }] });
  try {
    await page.getByTestId("update-notice-toggle").click();
    await page.getByTestId("update-notice-cards").getByText("Fix login redirect").click();
    await page.getByRole("dialog").getByText("Fix login redirect").waitFor();
  } finally { await close(); }
});

test("pending updates show their changelog and install from the button", async () => {
  const commits = [{ sha: "abc1234", subject: "Add pending updates notice" }, { sha: "def5678", subject: "Fix typo" }];
  let requested = 0;
  const { page, close } = await openApp(
    { draining: false, activeRuns: 2, cards: [], updates: { commits, installing: false, error: null } },
    () => { requested++; return { commits, installing: true, error: null }; },
  );
  try {
    await page.getByTestId("update-notice-toggle").getByText("2 updates available").click();
    const changelog = page.getByTestId("update-notice-changelog");
    await changelog.getByText("Add pending updates notice").waitFor();
    await changelog.getByText("Restarts after 2 active runs finish.").waitFor();
    await changelog.getByRole("button", { name: "Update and restart" }).click();
    await page.getByTestId("update-notice-toggle").getByText("Installing update…").waitFor();
    assert.equal(requested, 1);
  } finally { await close(); }
});

test("no notice when the server is up to date or does not update itself", async () => {
  for (const updates of [{ commits: [], installing: false, error: null }, null]) {
    const { page, served, close } = await openApp({ draining: false, activeRuns: 0, cards: [], updates });
    try {
      await served;
      await page.waitForTimeout(200);
      assert.equal(await page.getByTestId("update-notice-toggle").count(), 0);
    } finally { await close(); }
  }
});
