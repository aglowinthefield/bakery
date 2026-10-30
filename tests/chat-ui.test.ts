import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Locator, type Page, type Route } from "playwright";
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

// Stands in for the browser's focus and EventSource: each stream requests its URL (so the route sees it), opens,
// and stays open until the test drops it with window.dropStreams(). Closing a stream tells the route, as a closed
// connection tells the server.
function controlledPage(focused: boolean) {
  const w = window as unknown as { focused: boolean; dropStreams: () => void; EventSource: unknown };
  w.focused = focused;
  document.hasFocus = () => w.focused;
  const streams = new Set<{ onopen?: () => void; onerror?: () => void }>();
  w.dropStreams = () => { for (const stream of [...streams]) { streams.delete(stream); stream.onerror?.(); } };
  w.EventSource = class {
    onopen?: () => void; onerror?: () => void; onmessage?: (event: { data: string }) => void;
    url: string;
    constructor(url: string) {
      this.url = url;
      streams.add(this);
      void fetch(url).then(() => { if (streams.has(this)) this.onopen?.(); });
    }
    close() { streams.delete(this); void fetch(`/api/test/closed?stream=${encodeURIComponent(this.url)}`); }
  };
}
const setFocus = (page: Page, focused: boolean) => page.evaluate(focused => {
  (window as unknown as { focused: boolean }).focused = focused;
  window.dispatchEvent(new Event(focused ? "focus" : "blur"));
}, focused);

/**
 * Serves a board whose chats carry unread counts the test can change, logging stream opens and view updates. Like the
 * server it keeps each open stream's view and the revision of its last update, so finishTurn() counts a turn only
 * when no view is looking. onView can answer a view update itself, for example to fail or delay it.
 */
async function unreadHarness(page: Page, list: { id: string; topic: string; unread: number }[]) {
  const views: string[] = [];
  const watching = new Map<string, { chatId: string; looking: boolean; revision: number }>();
  const read = (id: string) => { list.find(item => item.id === id)!.unread = 0; };
  const harness = {
    views,
    onView: undefined as undefined | ((looking: boolean, route: Route) => Promise<boolean>),
    finishTurn(id: string) {
      if (![...watching.values()].some(view => view.chatId === id && view.looking)) list.find(item => item.id === id)!.unread++;
    },
  };
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const total = list.reduce((sum, item) => sum + item.unread, 0);
    if (path === "/api/boards") return route.fulfill({ json: [{ ...boards[0], chatUnread: total }] });
    if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
    if (path === "/api/boards/b1/chats") return route.fulfill({ json: list.map(item => ({ ...chat, ...item })) });
    if (path === "/api/test/closed") {
      watching.delete(new URL(url.searchParams.get("stream")!, url).searchParams.get("viewer")!);
      return route.fulfill({ json: {} });
    }
    const match = path.match(/^\/api\/boards\/b1\/chats\/(c\d)(?:\/(events|view))?$/);
    if (match?.[2] === "events") {
      views.push(`${match[1]} open looking=${url.searchParams.get("looking")}`);
      watching.set(url.searchParams.get("viewer")!, { chatId: match[1], looking: url.searchParams.get("looking") === "1", revision: 0 });
      if (url.searchParams.get("looking") === "1") read(match[1]);
      return route.fulfill({ contentType: "text/event-stream", body: ": idle\n\n" });
    }
    if (match?.[2] === "view") {
      const { viewer, looking, revision } = route.request().postDataJSON() as { viewer: string; looking: boolean; revision: number };
      views.push(`${match[1]} view looking=${looking}`);
      if (harness.onView && await harness.onView(looking, route)) return;
      const view = watching.get(viewer);
      if (view && revision > view.revision) {
        Object.assign(view, { looking, revision });
        if (looking) read(match[1]);
      }
      return route.fulfill({ json: { ok: true, known: !!view } });
    }
    if (match) return route.fulfill({ json: { chat: { ...chat, ...list.find(item => item.id === match[1]) }, messages: [], live: null } });
    await route.fulfill({ json: [] });
  });
  const nav = page.getByRole("navigation", { name: "Chats" });
  const unreadOf = (label: string) => nav.locator("div", { has: page.getByRole("button", { name: label, exact: true }) }).locator("[data-unread]");
  return { ...harness, harness, nav, unreadOf };
}

test("unread replies show per chat and as board totals, and looking at a chat clears them", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    // The page starts unfocused, so opening the first chat does not read it yet.
    await page.addInitScript(controlledPage, false);
    const list = [{ id: "c1", topic: "First", unread: 1 }, { id: "c2", topic: "Second", unread: 2 }];
    const { views, nav, unreadOf } = await unreadHarness(page, list);
    await page.goto(`${server.resolvedUrls!.local[0]}board/b1/chat`);
    const sidebarChat = page.getByRole("button", { name: /^Chat\b/ });
    await sidebarChat.locator("[data-chat-unread='3']").waitFor();
    await unreadOf("First").filter({ hasText: "1" }).waitFor();
    await unreadOf("Second").filter({ hasText: "2" }).waitFor();
    assert.deepEqual(views, ["c1 open looking=0"]);

    await setFocus(page, true);
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

test("a stream that reconnects while the operator is away keeps the reply it missed unread", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript(controlledPage, true);
    const list = [{ id: "c1", topic: "First", unread: 0 }];
    const { views, unreadOf } = await unreadHarness(page, list);
    await page.goto(`${server.resolvedUrls!.local[0]}board/b1/chat`);
    await page.waitForFunction(() => document.querySelector("nav[aria-label='Chats'] button"));
    await waitUntil(() => views.length === 1);
    assert.deepEqual(views, ["c1 open looking=1"]);

    await setFocus(page, false);
    await waitUntil(() => views.length === 2);
    list[0].unread = 1; // a reply finished while the operator was away
    await page.evaluate(() => (window as unknown as { dropStreams: () => void }).dropStreams());
    await waitUntil(() => views.length === 3);
    assert.deepEqual(views, ["c1 open looking=1", "c1 view looking=false", "c1 open looking=0"], "the reconnect reports the current state");
    assert.equal(list[0].unread, 1);
    await unreadOf("First").filter({ hasText: "1" }).waitFor();
  } finally {
    await browser.close();
    await server.close();
  }
});

test("unread counts that move between chats show up even when the board's total stays the same", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript(controlledPage, true);
    const list = [{ id: "c1", topic: "First", unread: 0 }, { id: "c2", topic: "Second", unread: 1 }, { id: "c3", topic: "Third", unread: 0 }];
    const { unreadOf } = await unreadHarness(page, list);
    await page.goto(`${server.resolvedUrls!.local[0]}board/b1/chat`);
    await unreadOf("Second").filter({ hasText: "1" }).waitFor();
    // Another browser reads Second while a turn finishes in Third.
    list[1].unread = 0;
    list[2].unread = 1;
    await unreadOf("Third").filter({ hasText: "1" }).waitFor({ timeout: 10_000 });
    assert.equal(await unreadOf("Second").count(), 0);
    await page.getByRole("button", { name: /^Chat\b/ }).locator("[data-chat-unread='1']").waitFor();
  } finally {
    await browser.close();
    await server.close();
  }
});

test("a blur the server never received is recovered by reconnecting, so the next reply still counts", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript(controlledPage, true);
    const list = [{ id: "c1", topic: "First", unread: 0 }];
    const { harness, views, unreadOf } = await unreadHarness(page, list);
    await page.goto(`${server.resolvedUrls!.local[0]}board/b1/chat`);
    await waitUntil(() => views.length === 1);
    harness.onView = async (_looking, route) => { await route.fulfill({ status: 500, json: { error: "unavailable" } }); return true; };
    await setFocus(page, false);
    await waitUntil(() => views.length === 3);
    harness.onView = undefined;
    assert.deepEqual(views, ["c1 open looking=1", "c1 view looking=false", "c1 open looking=0"], "the failed blur reopens the stream with the current state");
    harness.finishTurn("c1");
    await unreadOf("First").filter({ hasText: "1" }).waitFor({ timeout: 10_000 });
  } finally {
    await browser.close();
    await server.close();
  }
});

test("a focus update delayed past the blur that followed it does not leave the chat looked at", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript(controlledPage, false);
    const list = [{ id: "c1", topic: "First", unread: 0 }];
    const { harness, views, unreadOf } = await unreadHarness(page, list);
    await page.goto(`${server.resolvedUrls!.local[0]}board/b1/chat`);
    await waitUntil(() => views.length === 1);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    harness.onView = async looking => { if (looking) await held; return false; };
    await setFocus(page, true);
    await waitUntil(() => views.length === 2);
    await setFocus(page, false);
    await waitUntil(() => views.length === 3);
    // Let the blur land first, then the focus that was sent before it.
    await page.waitForTimeout(200);
    release();
    await page.waitForTimeout(200);
    harness.finishTurn("c1");
    await unreadOf("First").filter({ hasText: "1" }).waitFor({ timeout: 10_000 });
    assert.deepEqual(views, ["c1 open looking=0", "c1 view looking=true", "c1 view looking=false"], "no reconnect was needed");
  } finally {
    await browser.close();
    await server.close();
  }
});

async function waitUntil(condition: () => boolean, timeout = 10_000) {
  for (const started = Date.now(); !condition(); await new Promise(resolve => setTimeout(resolve, 25)))
    if (Date.now() - started > timeout) throw new Error("timed out waiting for the condition");
}

type Harness = { page: Page; nav: Locator; discards: string[]; deletes: string[]; close: () => Promise<void> };
const fresh = { ...chat, id: "c2", title: "", createdAt: "2025-01-02T00:00:00Z", updatedAt: "2025-01-02T00:00:00Z" };

/** Opens the Chat tab with one populated chat (c1). New chat creates the empty c2. `onC2`/`onSend` let a test control those responses. */
async function openChat(opts: { onC2?: (route: Route) => Promise<void>; onSend?: (route: Route) => Promise<void>; discarded?: () => boolean } = {}): Promise<Harness> {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  const discards: string[] = [], deletes: string[] = [];
  let created = false, gone = false;
  const page = await (await browser.newContext()).newPage();
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/boards") return route.fulfill({ json: boards });
    if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
    if (path === "/api/boards/b1/chats") {
      if (request.method() === "POST") { created = true; return route.fulfill({ json: fresh }); }
      return route.fulfill({ json: created && !gone ? [fresh, chat] : [chat] });
    }
    if (path === "/api/boards/b1/chats/c1") return route.fulfill({ json: { chat, messages, live: null } });
    if (path === "/api/boards/b1/chats/c2/discard") { discards.push("c2"); const discarded = opts.discarded ? opts.discarded() : true; gone ||= discarded; return route.fulfill({ json: { discarded } }); }
    if (path === "/api/boards/b1/chats/c2/messages") return opts.onSend ? opts.onSend(route) : route.fulfill({ status: 202, json: {} });
    if (path === "/api/boards/b1/chats/c2") {
      if (request.method() === "DELETE") { deletes.push("c2"); return route.fulfill({ json: {} }); }
      return opts.onC2 ? opts.onC2(route) : route.fulfill({ json: { chat: fresh, messages: [], live: null } });
    }
    if (path.endsWith("/events")) return route.fulfill({ contentType: "text/event-stream", body: "" });
    await route.fulfill({ json: [] });
  });
  await page.goto(server.resolvedUrls!.local[0]);
  const row = page.getByRole("button", { name: "b1", exact: true });
  await row.waitFor();
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Chats" });
  await nav.getByRole("button", { name: "What is blocked?", exact: true }).waitFor();
  await page.locator("[data-role='agent']").getByText("Card B waits on A.").waitFor();
  return { page, nav, discards, deletes, close: async () => { await browser.close(); await server.close(); } };
}
const listed = async (h: Harness, want: number) => {
  await expectEventually(async () => (await h.nav.getByRole("button", { name: "Delete New chat" }).count()) === want);
  return want;
};
const switchBack = (h: Harness) => h.nav.getByRole("button", { name: "What is blocked?", exact: true }).click();

test("an empty chat is discarded when the user switches to another chat; chats with messages stay", async () => {
  const h = await openChat();
  try {
    await h.nav.getByRole("button", { name: "New chat" }).click();
    await h.page.getByRole("button", { name: "Delete New chat" }).waitFor();
    await h.page.waitForTimeout(300);
    assert.deepEqual(h.discards, [], "the empty chat is kept while it is open");
    await switchBack(h);
    await expectEventually(() => h.discards.length === 1);
    assert.equal(await listed(h, 0), 0, "the discarded chat leaves the list");
    assert.deepEqual(h.deletes, [], "cleanup never uses the explicit-delete endpoint");
    assert.equal(await h.nav.getByRole("button", { name: "What is blocked?", exact: true }).count(), 1, "a chat with messages is kept");
    await switchBack(h);
    await h.page.waitForTimeout(300);
    assert.deepEqual(h.discards, ["c2"], "leaving a populated chat asks for no cleanup");
  } finally { await h.close(); }
});

test("leaving an empty chat before its transcript loads still discards it", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await openChat({ onC2: async route => { await gate; await route.fulfill({ json: { chat: fresh, messages: [], live: null } }); } });
  try {
    await h.nav.getByRole("button", { name: "New chat" }).click();
    await h.page.getByRole("button", { name: "Delete New chat" }).waitFor();
    await switchBack(h);
    await expectEventually(() => h.discards.length === 1);
    release();
    assert.equal(await listed(h, 0), 0);
  } finally { release(); await h.close(); }
});

test("a chat whose first send failed is discarded on leaving; one whose send is pending is not until it settles", async () => {
  let fail!: () => void;
  const gate = new Promise<void>(resolve => { fail = resolve; });
  const h = await openChat({ onSend: async route => { await gate; await route.fulfill({ status: 500, json: { error: "boom" } }); } });
  try {
    await h.nav.getByRole("button", { name: "New chat" }).click();
    await h.page.getByRole("button", { name: "Delete New chat" }).waitFor();
    await h.page.getByRole("textbox").fill("hello");
    await h.page.getByRole("button", { name: "Send" }).click();
    await switchBack(h);
    await h.page.waitForTimeout(400);
    assert.deepEqual(h.discards, [], "no cleanup while the first send is in flight");
    fail();
    await expectEventually(() => h.discards.length === 1);
    assert.equal(await listed(h, 0), 0, "after the send failed the empty chat is discarded");
  } finally { fail(); await h.close(); }
});

test("a chat whose first send was saved is kept when the server refuses the discard", async () => {
  let saved!: () => void;
  const gate = new Promise<void>(resolve => { saved = resolve; });
  const h = await openChat({ discarded: () => false, onSend: async route => { await gate; await route.fulfill({ status: 202, json: {} }); } });
  try {
    await h.nav.getByRole("button", { name: "New chat" }).click();
    await h.page.getByRole("button", { name: "Delete New chat" }).waitFor();
    await h.page.getByRole("textbox").fill("hello");
    await h.page.getByRole("button", { name: "Send" }).click();
    await switchBack(h);
    saved();
    await expectEventually(() => h.discards.length === 1);
    assert.equal(await listed(h, 1), 1, "the server kept the chat, so it stays listed");
  } finally { saved(); await h.close(); }
});

async function expectEventually(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50 && !(await check()); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(await check(), "condition was not met in time");
}
