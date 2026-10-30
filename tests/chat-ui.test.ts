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
      if (path === "/api/boards/b1/chats" && route.request().method() === "POST") return route.fulfill({ json: { ...chat, id: "c2", title: "" } });
      if (path === "/api/boards/b1/chats/c2") return route.fulfill({ json: { chat: { ...chat, id: "c2", title: "" }, messages: [], live: null } });
      if (path === "/api/boards/b1/chats/c2/events") return route.fulfill({ contentType: "text/event-stream", body: ": idle\n\n" });
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

    await page.getByRole("button", { name: "New chat", exact: true }).click();
    const box = page.getByRole("textbox", { name: "Message the agent" });
    await box.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Message the agent");
    await page.keyboard.type("hello");
    assert.equal(await box.inputValue(), "hello", "New chat leaves the message box focused for typing");
  } finally {
    await browser.close();
    await server.close();
  }
});

test("the chat list shows each chat's topic, updates it live, and collapses to a rail", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    const named = { ...chat, title: "Why is card B still waiting after A finished yesterday?", topic: "" };
    const other = { ...chat, id: "c2", title: "Please clean up the triage lane", topic: "Triage cleanup" };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards") return route.fulfill({ json: boards });
      if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      if (path === "/api/boards/b1/chats") return route.fulfill({ json: [named, other] });
      if (path === "/api/boards/b1/chats/c1") return route.fulfill({ json: { chat: named, messages, live: null } });
      if (path === "/api/boards/b1/chats/c1/events")
        return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "chat", chat: { ...named, topic: "Card B waiting" } })}\n\n` });
      await route.fulfill({ json: [] });
    });
    await page.goto(`${server.resolvedUrls!.local[0]}board/b1/chat`);
    const nav = page.getByRole("navigation", { name: "Chats" });
    await nav.getByRole("button", { name: "Triage cleanup", exact: true }).waitFor();
    await nav.getByRole("button", { name: "Card B waiting", exact: true }).waitFor();
    assert.equal(await nav.getByRole("button", { name: "Card B waiting", exact: true }).getAttribute("title"), named.title, "the full first line is the tooltip");

    await nav.getByRole("button", { name: "Collapse chat list" }).click();
    assert.equal(await nav.getAttribute("data-collapsed"), "true");
    assert.ok((await nav.boundingBox())!.width < 80, "collapsed to a narrow rail");
    assert.equal(await nav.getByRole("button", { name: "Delete Triage cleanup" }).count(), 0);
    await nav.getByRole("button", { name: "Triage cleanup", exact: true }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "Expand chat list" }).click();
    assert.equal(await nav.getAttribute("data-collapsed"), null, "the choice survives a reload, and expanding restores the list");
    assert.ok((await nav.boundingBox())!.width > 200);
    await nav.getByRole("button", { name: "Delete Triage cleanup" }).waitFor({ state: "attached" });
  } finally {
    await browser.close();
    await server.close();
  }
});

test("unread replies show per chat and as board totals, and looking at a chat clears them", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    // The page starts unfocused, so opening the first chat does not read it yet.
    await page.addInitScript(() => {
      (window as unknown as { focused: boolean }).focused = false;
      document.hasFocus = () => (window as unknown as { focused: boolean }).focused;
    });
    const list = [{ ...chat, topic: "First", unread: 1 }, { ...chat, id: "c2", topic: "Second", unread: 2 }];
    const views: string[] = [];
    const read = (id: string) => { list.find(item => item.id === id)!.unread = 0; };
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      const total = list.reduce((sum, item) => sum + item.unread, 0);
      if (path === "/api/boards") return route.fulfill({ json: [{ ...boards[0], chatUnread: total }] });
      if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      if (path === "/api/boards/b1/chats") return route.fulfill({ json: list });
      const match = path.match(/^\/api\/boards\/b1\/chats\/(c\d)(?:\/(events|view))?$/);
      if (match?.[2] === "events") {
        views.push(`${match[1]} open looking=${url.searchParams.get("looking")}`);
        if (url.searchParams.get("looking") === "1") read(match[1]);
        return route.fulfill({ contentType: "text/event-stream", body: ": idle\n\n" });
      }
      if (match?.[2] === "view") {
        const { looking } = route.request().postDataJSON() as { looking: boolean };
        views.push(`${match[1]} view looking=${looking}`);
        if (looking) read(match[1]);
        return route.fulfill({ json: { ok: true } });
      }
      if (match) return route.fulfill({ json: { chat: list.find(item => item.id === match[1]), messages: [], live: null } });
      await route.fulfill({ json: [] });
    });
    await page.goto(`${server.resolvedUrls!.local[0]}board/b1/chat`);
    const nav = page.getByRole("navigation", { name: "Chats" });
    const sidebarChat = page.getByRole("button", { name: /^Chat\b/ });
    const unreadOf = (label: string) => nav.locator("div", { has: page.getByRole("button", { name: label, exact: true }) }).locator("[data-unread]");
    await sidebarChat.locator("[data-chat-unread='3']").waitFor();
    await unreadOf("First").filter({ hasText: "1" }).waitFor();
    await unreadOf("Second").filter({ hasText: "2" }).waitFor();
    assert.deepEqual(views, ["c1 open looking=0"]);

    await page.evaluate(() => { (window as unknown as { focused: boolean }).focused = true; window.dispatchEvent(new Event("focus")); });
    await page.waitForFunction(() => !document.querySelector("nav[aria-label='Chats'] [data-unread='1']"));
    await sidebarChat.locator("[data-chat-unread='2']").waitFor();
    assert.deepEqual(views, ["c1 open looking=0", "c1 view looking=true"]);

    await nav.getByRole("button", { name: "Second", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("nav[aria-label='Chats'] [data-unread]"));
    await page.waitForFunction(() => !document.querySelector("[data-chat-unread]"));
    assert.deepEqual(views.slice(2), ["c2 open looking=1"]);

    // A turn that finishes in another chat shows up on the next poll of the board totals.
    list[0].unread = 1;
    await unreadOf("First").filter({ hasText: "1" }).waitFor();
    await sidebarChat.locator("[data-chat-unread='1']").waitFor();

    const row = page.getByRole("button", { name: /^b1/ });
    assert.equal(await row.locator("[data-chat-unread]").count(), 0, "an open repository shows the total on its Chat entry only");
    await row.click();
    await row.locator("[data-chat-unread='1']").waitFor();
    assert.equal(await sidebarChat.count(), 0, "a collapsed repository hides its Chat entry and shows the total on its row");
  } finally {
    await browser.close();
    await server.close();
  }
});
