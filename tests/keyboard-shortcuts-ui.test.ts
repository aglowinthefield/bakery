import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const card = (id: string, status: string, title: string, body = "") => ({
  id,
  title,
  body,
  repo: "/tmp/repo",
  source: "manual",
  status,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  turns: 0,
  turnsIncomplete: 0,
});

const boardCards = [
  card("a1b2c3d4-0000", "triage", "Fix login redirect"),
  card("e5f6a7b8-0000", "ready", "Polish sidebar", "Tweak the Lantern spacing"),
  card("c9d0e1f2-0000", "review", "Add export button"),
  card(
    "f3a4b5c6-0000",
    "done",
    "Archive old runs",
    "mentions a1b2 in the body",
  ),
];
const otherCards = [card("9999aaaa-0000", "ready", "Other board card")];

test("keyboard shortcuts: n, j/k, ?, cmd+enter", async () => {
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() =>
      localStorage.setItem("bakery-view", "board"),
    );
    let posted: any = null;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const data: Record<string, unknown> = {
        "/api/boards": [
          { id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false },
          {
            id: "other",
            repo: "/tmp/other",
            autoCollapseEmptySwimlanes: false,
          },
        ],
        "/api/cards": [...boardCards, ...otherCards],
        "/api/settings": {
          confirmRunStart: false,
          cardDetailsLayout: "dialog",
          theme: "default",
        },
        "/api/boards/board/cards": boardCards,
        "/api/boards/board/conflicts": [],
        "/api/boards/other/cards": otherCards,
        "/api/boards/other/conflicts": [],
      };
      if (
        path === "/api/boards/board/cards" &&
        route.request().method() === "POST"
      ) {
        posted = route.request().postDataJSON();
        return route.fulfill({
          json: card("new00000-0000", "triage", posted.title),
        });
      }
      if (/\/(runs|comments|auto-review)$/.test(path))
        return route.fulfill({ json: [] });
      if (path.endsWith("/approval"))
        return route.fulfill({ json: { pending: false } });
      if (path.endsWith("/push-progress")) return route.fulfill({ json: null });
      if (path.endsWith("/history")) return route.fulfill({ json: [] });
      if (path === "/api/status") {
        await route.fulfill({ json: { draining: false, activeRuns: 0 } });
        return;
      }
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole("button", { name: "repo", exact: true }).click();
    const lanes = page.locator("section[data-status]");
    const shown = (title: string) => lanes.getByText(title, { exact: true });
    await shown("Fix login redirect").waitFor();

    await lanes.getByText("Fix login redirect", { exact: true }).waitFor();
    await page.locator("body").click({ position: { x: 5, y: 5 } });

    await page.keyboard.press("?");
    await page.getByRole("heading", { name: "Keyboard shortcuts" }).waitFor();
    await page.keyboard.press("Escape");
    await page
      .getByRole("heading", { name: "Keyboard shortcuts" })
      .waitFor({ state: "detached" });

    await page.keyboard.press("g");
    const leaderHint = page.getByRole("status", { name: "Go to" });
    await leaderHint.waitFor();
    assert.match(await leaderHint.innerText(), /Pull requests/);
    await page.keyboard.press("Escape");
    await page.keyboard.press("x");
    await leaderHint.waitFor({ state: "detached" });

    await page.keyboard.press("j");
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.textContent?.includes("Fix login redirect"),
      ),
      true,
    );

    await page.keyboard.press("n");
    const title = page.getByPlaceholder("What needs doing?");
    await title.waitFor();
    await title.fill("Shortcut card");
    await page.keyboard.press("Meta+Enter");
    await page
      .getByRole("heading", { name: "New card" })
      .waitFor({ state: "detached" });
    assert.equal(posted?.title, "Shortcut card");
  } finally {
    await browser.close();
    await server.close();
  }
});
