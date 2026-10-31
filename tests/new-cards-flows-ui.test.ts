import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

type Options = {
  path?: string;
  /** Called for each cards-seen request; return a status to fail it, or nothing to let it succeed. */
  seen?: (attempt: number, ids: string[]) => Promise<number | void>;
  cardsFail?: boolean;
  /** The count the boards list reports; defaults to the unseen CLI card. */
  count?: (state: { acknowledged: boolean; seenCalls: string[][] }) => number;
};

async function run(
  options: Options,
  check: (
    page: import("playwright").Page,
    state: { seenCalls: string[][]; acknowledged: boolean },
  ) => Promise<void>,
) {
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const card = (id: string, title: string) => ({
      id,
      title,
      body: "",
      repo: "/tmp/repo",
      source: "manual",
      status: "triage",
      priority: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      turns: 0,
      turnsIncomplete: 0,
      attempts: 0,
      reviewRounds: 0,
      runAgent: "",
      reviewAgent: "",
    });
    const cards = [card("old", "Old card"), card("cli", "Made by the CLI")];
    const state = { seenCalls: [] as string[][], acknowledged: false };
    await page.route("**/api/**", async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (path === "/api/status") {
        await route.fulfill({ json: { draining: false, activeRuns: 0 } });
        return;
      }
      if (path === "/api/boards/board/cards-seen") {
        const ids: string[] = request.postDataJSON().cardIds;
        state.seenCalls.push(ids);
        const failure = await options.seen?.(state.seenCalls.length, ids);
        if (failure) {
          await route.fulfill({ status: failure, json: { error: "nope" } });
          return;
        }
        state.acknowledged = true;
        await route.fulfill({
          json: { cardIds: ids.filter((id) => id === "cli") },
        });
        return;
      }
      if (path === "/api/boards/board/cards" && options.cardsFail) {
        await route.fulfill({
          status: 500,
          json: { error: "cards unavailable" },
        });
        return;
      }
      const data: Record<string, unknown> = {
        "/api/boards": [
          {
            id: "board",
            repo: "/tmp/repo",
            autoCollapseEmptySwimlanes: false,
            newCards: options.count
              ? options.count(state)
              : state.acknowledged
                ? 0
                : 1,
          },
        ],
        "/api/settings": {
          confirmRunStart: false,
          cardDetailsLayout: "dialog",
          theme: "default",
        },
        "/api/boards/board/cards": cards,
        "/api/boards/board/conflicts": [],
      };
      assert.ok(
        path in data || path.startsWith("/api/boards/board/cards/"),
        `Unexpected API request: ${path}`,
      );
      await route.fulfill({ json: data[path] ?? [] });
    });
    await page.goto(
      new URL(options.path ?? "/board/board", server.resolvedUrls!.local[0])
        .href,
    );
    await check(page, state);
  } finally {
    await browser.close();
    await server.close();
  }
}

const tile = (page: import("playwright").Page, title: string) =>
  page.locator("[data-card-tile]", { hasText: title });

test("a slow acknowledgment still highlights after a poll already reads zero new cards", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await run(
    {
      seen: async () => {
        await held;
      },
      // The server clears the count as soon as the acknowledgment arrives, before its response reaches the screen.
      count: (state) => (state.seenCalls.length > 0 ? 0 : 1),
    },
    async (page) => {
      await page.waitForFunction(() => true);
      await page.waitForTimeout(2600); // at least one 2s poll lands with a zero count while the acknowledgment is held
      release();
      await tile(page, "Made by the CLI")
        .locator("xpath=self::*[@data-new]")
        .waitFor();
    },
  );
});

test("nothing is acknowledged while the board's cards fail to load", async () => {
  await run({ cardsFail: true }, async (page, state) => {
    await page.getByRole("alert").waitFor();
    await page.waitForTimeout(2600);
    assert.deepEqual(state.seenCalls, []);
    await page.getByRole("status", { name: "1 new card" }).waitFor();
  });
});

test("a failed acknowledgment is retried during the same visit", async () => {
  await run(
    { seen: async (attempt) => (attempt === 1 ? 500 : undefined) },
    async (page, state) => {
      await tile(page, "Made by the CLI")
        .locator("xpath=self::*[@data-new]")
        .waitFor({ timeout: 8000 });
      assert.ok(
        state.seenCalls.length >= 2,
        "the first request failed and a later one succeeded",
      );
      assert.deepEqual(
        state.seenCalls.at(-1)?.sort(),
        ["cli", "old"],
        "only the loaded cards are acknowledged",
      );
    },
  );
});

test("a card opened by deep link is not highlighted", async () => {
  await run({ path: "/board/board/card/cli" }, async (page, state) => {
    await page.getByRole("dialog").waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-card-tile]").length > 0,
    );
    await page.waitForTimeout(500);
    assert.ok(state.seenCalls.length >= 1);
    assert.equal(await page.locator("[data-card-tile][data-new]").count(), 0);
  });
});
