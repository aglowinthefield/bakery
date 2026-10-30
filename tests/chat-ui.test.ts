import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const boards = [{ id: "b1", repo: "/tmp/b1", remoteUrl: "", autoCollapseEmptySwimlanes: false }];
const chat = { id: "c1", boardId: "b1", title: "What is blocked?", model: "openai/gpt-6.1-sol", thinking: "low", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" };
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

test("the chat model picker shows the chat's model and saves a switch", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    const patches: unknown[] = [];
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === "/api/boards") return route.fulfill({ json: boards });
      if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      if (path === "/api/models") return route.fulfill({ json: { models: ["openai/gpt-6.1-sol", "anthropic/claude-sonnet-4-5"] } });
      if (path === "/api/boards/b1/chats") return route.fulfill({ json: [chat] });
      if (path === "/api/boards/b1/chats/c1" && request.method() === "PATCH") {
        const input = request.postDataJSON();
        patches.push(input);
        return route.fulfill({ json: { ...chat, ...input } });
      }
      if (path === "/api/boards/b1/chats/c1") return route.fulfill({ json: { chat, messages: [], live: null } });
      if (path === "/api/boards/b1/chats/c1/events") return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "live", live: null })}\n\n` });
      await route.fulfill({ json: [] });
    });
    await page.goto(`${server.resolvedUrls!.local[0]}board/b1/chat`);
    const model = page.getByLabel("Chat model"), thinking = page.getByLabel("Chat thinking");
    await model.waitFor();
    assert.equal(await model.inputValue(), "openai/gpt-6.1-sol");
    assert.equal(await thinking.inputValue(), "low");
    await thinking.selectOption("high");
    await model.fill("anthropic/claude-sonnet-4-5");
    await model.press("Enter");
    await thinking.selectOption("medium");
    await page.waitForTimeout(200);
    assert.deepEqual(patches, [
      { model: "openai/gpt-6.1-sol", thinking: "high" },
      { model: "anthropic/claude-sonnet-4-5", thinking: "high" },
      { model: "anthropic/claude-sonnet-4-5", thinking: "medium" },
    ]);
    assert.equal(await thinking.inputValue(), "medium");
  } finally {
    await browser.close();
    await server.close();
  }
});

test("quick model and thinking picks both persist, and Send waits for them to save", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    let saved = { ...chat }, patchesDone = 0;
    const patches: unknown[] = [], log: string[] = [];
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === "/api/boards") return route.fulfill({ json: boards });
      if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      if (path === "/api/models") return route.fulfill({ json: { models: ["anthropic/claude-sonnet-4-5"] } });
      if (path === "/api/boards/b1/chats") return route.fulfill({ json: [saved] });
      if (path === "/api/boards/b1/chats/c1" && request.method() === "PATCH") {
        const input = request.postDataJSON();
        patches.push(input); log.push("patch");
        await new Promise(resolve => setTimeout(resolve, 300));
        saved = { ...saved, ...input }; patchesDone++;
        return route.fulfill({ json: saved });
      }
      if (path === "/api/boards/b1/chats/c1/messages") { log.push(`message after ${patchesDone} saves`); return route.fulfill({ status: 202, json: {} }); }
      if (path === "/api/boards/b1/chats/c1") return route.fulfill({ json: { chat: saved, messages: [], live: null } });
      if (path === "/api/boards/b1/chats/c1/events") return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "live", live: null })}\n\n` });
      await route.fulfill({ json: [] });
    });
    await page.goto(`${server.resolvedUrls!.local[0]}board/b1/chat`);
    const model = page.getByLabel("Chat model"), thinking = page.getByLabel("Chat thinking");
    await model.waitFor();
    await thinking.selectOption("high");
    await model.fill("anthropic/claude-sonnet-4-5");
    await page.getByLabel("Message the agent").fill("hello");
    await page.getByRole("button", { name: "Send" }).click();
    for (let i = 0; i < 50 && !log.some(entry => entry.startsWith("message")); i++) await page.waitForTimeout(100);
    assert.deepEqual(log.at(-1), `message after ${patches.length} saves`);
    assert.deepEqual(patches.at(-1), { model: "anthropic/claude-sonnet-4-5", thinking: "high" }, "the newest choice is the last one saved");
    assert.equal(patchesDone, patches.length, "no save was still pending when the message was sent");
    assert.equal(await thinking.inputValue(), "high");
    await page.reload();
    await model.waitFor();
    assert.equal(await model.inputValue(), "anthropic/claude-sonnet-4-5");
    assert.equal(await thinking.inputValue(), "high");
  } finally {
    await browser.close();
    await server.close();
  }
});
