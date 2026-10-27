import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

test("github-pr Approve shows the drafted PR, flags a title the semantic check rejects, and sends the edited draft", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // These tests cover the board, not the Today landing page.
    await page.addInitScript(() => localStorage.setItem("bakery-view", "board"));
    const fingerprint = "a".repeat(64);
    const sent: { path: string; body: unknown }[] = [];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname, method = route.request().method();
      if (method === "POST") sent.push({ path, body: route.request().postDataJSON() });
      const data: Record<string, unknown> = {
        "/api/boards": [{ id: "board", repo: "/tmp/repo", integration: "github-pr", remoteUrl: "https://github.com/acme/widgets", autoCollapseEmptySwimlanes: false }],
        "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "dark" },
        "/api/boards/board/cards": [{ id: "card", title: "Review card", body: "Card body", repo: "/tmp/repo", source: "manual", status: "review", createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, turnsIncomplete: 0 }],
        "/api/boards/board/conflicts": [],
        "/api/boards/board/cards/card/runs": [{ id: "run", attempt: 1, status: "review", output: "", error: null, worktree: null, startedAt: "2026-01-01", finishedAt: "2026-01-01", startedBy: "manual" }],
        "/api/boards/board/cards/card/approval": { pending: false },
        "/api/boards/board/cards/card/comments": [],
        "/api/boards/board/cards/card/auto-review": [],
        "/api/boards/board/cards/card/review": { fingerprint, files: [{ path: "a.ts", patch: "@@ -0,0 +1 @@\n+a\n" }] },
        "/api/boards/board/cards/card/pr-draft": { title: "feat(web): add a", body: "## Staging QA\n\nNo manual step: fixture", source: "agent", problem: "", templatePath: ".github/PULL_REQUEST_TEMPLATE.md",
          semantic: { types: ["feat", "fix"], scopes: ["web", "api"], requireScope: false, source: ".github/workflows/semantic-pr.yml" } },
        "/api/boards/board/cards/card/approve": { id: "card" },
      };
      if (!(path in data)) return route.fulfill({ json: [] });
      await route.fulfill({ json: data[path] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.getByRole("button", { name: /Review card/ }).click();
    await page.getByText("Changed files (1)").waitFor();
    await page.getByRole("button", { name: "Approve and open PR" }).click();
    const dialog = page.getByRole("dialog", { name: "Open pull request" });
    const title = dialog.getByRole("textbox", { name: "Pull request title" });
    await title.waitFor();
    assert.equal(await title.inputValue(), "feat(web): add a");
    assert.equal(await dialog.getByRole("textbox", { name: "Pull request body" }).inputValue(), "## Staging QA\n\nNo manual step: fixture");
    await dialog.getByText(/Drafted by the agent from \.github\/PULL_REQUEST_TEMPLATE\.md and \.github\/workflows\/semantic-pr\.yml/).waitFor();
    assert.deepEqual(sent.find(item => item.path.endsWith("/pr-draft"))?.body, { fingerprint });

    await title.fill("feat(mobile): add a");
    await dialog.getByText('Unknown scope "mobile"; use one of web, api').waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Approve and open PR" }).isDisabled(), true);
    await title.fill("fix(api): add a");
    await dialog.getByRole("textbox", { name: "Pull request body" }).fill("Edited body");
    await dialog.getByRole("button", { name: "Approve and open PR" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(sent.find(item => item.path.endsWith("/approve"))?.body, { fingerprint, title: "fix(api): add a", body: "Edited body" });
  } finally { await browser.close(); await server.close(); }
});
