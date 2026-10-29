import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

for (const integration of ["github-pr", "local"]) {
  test(`${integration} board: Review lanes ${integration === "github-pr" ? "split by whose turn it is" : "stay one lane"}`, async () => {
    const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
    await server.listen();
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const cards: Record<string, Record<string, unknown>> = {
      mine: { status: "review", reviewWait: null },
      agent: { status: "review", reviewWait: "agent_review" },
      fixing: { status: "review", reviewWait: "ci_fix" },
      github: { status: "review", reviewWait: "github" },
      broke: { status: "failed" },
      paused: { status: "interrupted" },
    };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const data: Record<string, unknown> = {
        "/api/boards": [{ id: "board", repo: "/tmp/repo", integration, autoCollapseEmptySwimlanes: false }],
        "/api/settings": { confirmRunStart: false, notifyOnReview: false, cardDetailsLayout: "dialog", theme: "default" },
        "/api/boards/board/cards": Object.entries(cards).map(([id, fields]) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual",
          createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0, attempts: 1, ...fields })),
        "/api/boards/board/conflicts": [],
      };
      if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
      assert.ok(path in data, `Unexpected API request: ${path}`);
      await route.fulfill({ json: data[path] });
    });
    try {
      await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
      await page.getByRole("button", { name: /mine card/ }).waitFor();
      const inLane = (name: string) => page.getByRole("region", { name: `${name} lane` }).getByRole("button", { name: / card/ }).evaluateAll(els => els.map(el => el.textContent?.match(/(mine|agent|fixing|github|broke|paused) card/)?.[1]));
      assert.deepEqual((await inLane("Failed")).sort(), ["broke", "paused"], "failed and interrupted share one lane");
      assert.equal(await page.getByRole("region", { name: "Interrupted lane" }).count(), 0);
      assert.match(await page.getByRole("button", { name: /paused card/ }).innerText(), /Interrupted/);
      if (integration === "github-pr") {
        assert.deepEqual(await inLane("Review"), ["mine"]);
        assert.deepEqual((await inLane("Agent reviewing")).sort(), ["agent", "fixing"]);
        assert.deepEqual(await inLane("Waiting on GitHub"), ["github"]);
      } else {
        assert.equal(await page.getByRole("region", { name: "Agent reviewing lane" }).count(), 0);
        assert.equal((await inLane("Review")).length, 4);
      }
    } finally {
      await page.close();
      await browser.close();
      await server.close();
    }
  });
}
