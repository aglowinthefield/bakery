import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const boards = [{ id: "b1", repo: "/tmp/b1", remoteUrl: "", autoCollapseEmptySwimlanes: false }];
const chat = { id: "c1", boardId: "b1", title: "What is blocked?", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" };
const messages = [
  { id: "m1", chatId: "c1", role: "user", body: "What is blocked?", parts: [], createdAt: "2025-01-01T00:00:00Z" },
  { id: "m2", chatId: "c1", role: "agent", body: "Card B waits on A.", createdAt: "2025-01-01T00:00:01Z",
    parts: [
      { type: "tool", id: "t1", name: "bash", input: "bakery-cli cards", output: "A\nB", status: "done" },
      { type: "text", text: "Card B waits on A." },
    ] },
];

test("the Chat tab lists chats, shows tool calls, streams the live reply", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards") return route.fulfill({ json: boards });
      if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      if (path === "/api/boards/b1/chats") return route.fulfill({ json: [chat] });
      if (path === "/api/boards/b1/chats/c1") return route.fulfill({ json: { chat, messages, live: null } });
      if (path === "/api/boards/b1/chats/c1/events") {
        const live = { startedAt: "2025-01-01T00:00:02Z", parts: [{ type: "text", text: "Streaming **now**" }] };
        return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "live", live })}\n\n` });
      }
      await route.fulfill({ json: [] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    const row = page.getByRole("button", { name: "b1", exact: true });
    await row.waitFor();
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    assert.match(page.url(), /\/board\/b1\/chat$/);
    await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "What is blocked?", exact: true }).waitFor();
    await page.locator("[data-role='agent']").getByText("Card B waits on A.").waitFor();
    assert.equal(await page.locator("[data-tool='bash']").count(), 1);
    await page.locator("[data-live='true']").getByText("now").waitFor();
    assert.equal(await page.getByRole("button", { name: "Stop" }).count(), 1, "a live reply offers Stop, not Send");
    assert.equal(await page.getByRole("button", { name: "Send" }).count(), 0);
  } finally {
    await browser.close();
    await server.close();
  }
});
