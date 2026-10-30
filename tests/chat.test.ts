import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Board } from "../server/board.js";
import { Chats, applyPiEvent, chatSystemPrompt, parseTopic, replyText, topicPrompt, writeTopic, type ChatEvent } from "../server/chat.js";
import type { ChatPart } from "../server/board.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakery-chat-"));
  const board = new Board(join(dir, "board.sqlite"));
  const repoBoard = board.addRepo(dir);
  return { dir, board, repoBoard, done: () => { board.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const fakePi = (dir: string, body: string) => { const path = join(dir, "pi"); writeFileSync(path, `#!/bin/sh\n${body}`); chmodSync(path, 0o755); return path; };
const settle = (chats: Chats, id: string) => new Promise<ChatEvent[]>(resolve => {
  const seen: ChatEvent[] = [];
  const off = chats.subscribe(id, event => { seen.push(event); if (event.type === "live" && event.live === null) { off(); resolve(seen); } });
});

test("Pi events fold into text and tool parts in order", () => {
  const parts: ChatPart[] = [];
  const events = [
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Let me " } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "check." } },
    { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "a\nb\n" }] } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Two files." } },
  ];
  for (const event of events) applyPiEvent(parts, event);
  assert.deepEqual(parts, [
    { type: "text", text: "Let me check." },
    { type: "tool", id: "t1", name: "bash", input: "ls", output: "a\nb\n", status: "done" },
    { type: "text", text: "Two files." },
  ]);
  assert.equal(replyText(parts), "Two files.");
});

test("the system prompt names the board, its CLI and its cards, busiest first", () => {
  const { board, repoBoard, dir, done } = fixture();
  try {
    const a = board.createCard({ title: "Alpha", body: "", repo: dir }), b = board.createCard({ title: "Beta", body: "", repo: dir, dependsOn: [a.id] });
    const prompt = chatSystemPrompt(repoBoard, board.listCards(dir), "node /x/bakery-cli.mjs");
    for (const text of [repoBoard.id, dir, "node /x/bakery-cli.mjs <command> --board", `${a.id} [triage] Alpha`, `${b.id} [triage] Beta (blocked; after ${a.id})`]) assert.ok(prompt.includes(text), text);
  } finally { done(); }
});

test("a chat turn streams parts, saves the reply, and keeps the session under the chat id", async () => {
  const { dir, board, repoBoard, done } = fixture();
  try {
    const pi = fakePi(dir, `echo "$@" > "${dir}/args"
echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello "}}'
echo '{"type":"tool_execution_start","toolCallId":"t","toolName":"bash","args":{"command":"cards"}}'
echo '{"type":"tool_execution_end","toolCallId":"t","toolName":"bash","isError":false,"result":{"content":[{"type":"text","text":"ok"}]}}'
echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"done"}}'
echo '{"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}'
echo '{"type":"agent_settled","aborted":false}'`);
    const chats = new Chats(board, { piBin: pi, sessionDir: join(dir, "sessions"), cli: "cli", env: process.env, models: () => [] });
    const chat = board.createChat(repoBoard.id);
    const finished = settle(chats, chat.id);
    chats.send(repoBoard, chat.id, "what is on the board?\nsecond line");
    assert.throws(() => chats.send(repoBoard, chat.id, "again"), /still answering/);
    const events = await finished;
    assert.ok(events.some(event => event.type === "live" && event.live?.parts.length), "live parts were streamed");
    const messages = board.listChatMessages(chat.id);
    assert.deepEqual(messages.map(item => [item.role, item.body]), [["user", "what is on the board?\nsecond line"], ["agent", "done"]]);
    assert.equal(messages[1].parts.length, 3);
    assert.equal(board.getChat(chat.id)?.title, "what is on the board?");
    const args = readFileSync(join(dir, "args"), "utf8");
    assert.ok(args.includes(`--session-id ${chat.id}`) && args.includes("--print") && args.includes("-- what is on the board?"));
    assert.equal(chats.live(chat.id), null);
  } finally { done(); }
});

test("a failed or stopped turn leaves an error message and keeps what streamed", async () => {
  const { dir, board, repoBoard, done } = fixture();
  try {
    const bad = fakePi(dir, `echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"partial"}}'\necho oops >&2\nexit 3`);
    const chats = new Chats(board, { piBin: bad, sessionDir: join(dir, "sessions"), cli: "cli", env: process.env, models: () => [] });
    const chat = board.createChat(repoBoard.id);
    let finished = settle(chats, chat.id);
    chats.send(repoBoard, chat.id, "hi");
    await finished;
    assert.deepEqual(board.listChatMessages(chat.id).map(item => [item.role, item.body]), [["user", "hi"], ["agent", "partial"], ["error", "Pi failed (3): oops"]]);

    const slow = fakePi(dir, "sleep 30");
    const stopping = new Chats(board, { piBin: slow, sessionDir: join(dir, "sessions"), cli: "cli", env: process.env, models: () => [] });
    const other = board.createChat(repoBoard.id);
    finished = settle(stopping, other.id);
    stopping.send(repoBoard, other.id, "go");
    stopping.stop(other.id);
    await finished;
    assert.deepEqual(board.listChatMessages(other.id).map(item => item.role), ["user", "error"]);
    assert.equal(board.listChatMessages(other.id)[1].body, "Stopped by the operator");
  } finally { done(); }
});

const okPi = (dir: string) => fakePi(dir, `echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"done"}}'
echo '{"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}'
echo '{"type":"agent_settled","aborted":false}'`);

test("a turn that finishes while nobody looks bumps the chat's unread count, once per turn", async () => {
  const { dir, board, repoBoard, done } = fixture();
  try {
    const chats = new Chats(board, { piBin: okPi(dir), sessionDir: join(dir, "sessions"), cli: "cli", env: process.env, models: () => [] });
    const chat = board.createChat(repoBoard.id);
    assert.equal(chat.unread, 0);
    chats.view(chat.id, "tab1", false);
    let finished = settle(chats, chat.id);
    chats.send(repoBoard, chat.id, "one");
    const events = await finished;
    assert.equal(board.getChat(chat.id)?.unread, 1);
    assert.ok(events.some(event => event.type === "chat" && event.chat.unread === 1), "subscribers hear the new count");
    finished = settle(chats, chat.id);
    chats.send(repoBoard, chat.id, "two");
    await finished;
    assert.equal(board.getChat(chat.id)?.unread, 2);
    assert.equal(board.listChats(repoBoard.id)[0].unread, 2);
  } finally { done(); }
});

test("a turn that finishes while a view is looking, or that the operator stopped, does not count", async () => {
  const { dir, board, repoBoard, done } = fixture();
  try {
    const chats = new Chats(board, { piBin: okPi(dir), sessionDir: join(dir, "sessions"), cli: "cli", env: process.env, models: () => [] });
    const chat = board.createChat(repoBoard.id);
    chats.view(chat.id, "away", false);
    chats.view(chat.id, "here", true);
    let finished = settle(chats, chat.id);
    chats.send(repoBoard, chat.id, "hi");
    await finished;
    assert.equal(board.getChat(chat.id)?.unread, 0, "one looking view is enough");
    chats.unview(chat.id, "here");
    finished = settle(chats, chat.id);
    chats.send(repoBoard, chat.id, "again");
    await finished;
    assert.equal(board.getChat(chat.id)?.unread, 1, "once that view closes, turns count again");

    const stopping = new Chats(board, { piBin: fakePi(dir, "sleep 30"), sessionDir: join(dir, "sessions"), cli: "cli", env: process.env, models: () => [] });
    const other = board.createChat(repoBoard.id);
    finished = settle(stopping, other.id);
    stopping.send(repoBoard, other.id, "go");
    stopping.stop(other.id);
    await finished;
    assert.equal(board.getChat(other.id)?.unread, 0);
  } finally { done(); }
});

test("looking at a chat clears its count and tells subscribers", async () => {
  const { dir, board, repoBoard, done } = fixture();
  try {
    const chats = new Chats(board, { piBin: okPi(dir), sessionDir: join(dir, "sessions"), cli: "cli", env: process.env, models: () => [] });
    const chat = board.createChat(repoBoard.id);
    board.bumpChatUnread(chat.id); board.bumpChatUnread(chat.id);
    const seen: ChatEvent[] = [];
    const off = chats.subscribe(chat.id, event => seen.push(event));
    chats.view(chat.id, "tab1", false);
    assert.equal(board.getChat(chat.id)?.unread, 2, "an open but unfocused view does not read it");
    chats.view(chat.id, "tab1", true);
    off();
    assert.equal(board.getChat(chat.id)?.unread, 0);
    assert.deepEqual(seen.map(event => event.type === "chat" && event.chat.unread), [0]);
    chats.view(chat.id, "tab1", true);
    assert.equal(seen.length, 1, "clearing an already read chat announces nothing");
  } finally { done(); }
});

test("each board's unread total sums its chats", () => {
  const { dir, board, repoBoard, done } = fixture();
  try {
    mkdirSync(join(dir, "other"));
    const otherBoard = board.addRepo(join(dir, "other"));
    const [a, b, c, d] = [board.createChat(repoBoard.id), board.createChat(repoBoard.id), board.createChat(repoBoard.id), board.createChat(otherBoard.id)];
    for (const id of [a.id, a.id, b.id, d.id]) board.bumpChatUnread(id);
    assert.deepEqual(board.chatUnreadCounts(), { [repoBoard.id]: 3, [otherBoard.id]: 1 });
    board.clearChatUnread(a.id);
    board.clearChatUnread(d.id);
    assert.deepEqual(board.chatUnreadCounts(), { [repoBoard.id]: 1 }, "boards with nothing unread are left out");
    assert.equal(board.getChat(c.id)?.unread, 0);
  } finally { done(); }
});

const reply = (text: string) => [
  JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } }),
  JSON.stringify({ type: "agent_settled", aborted: false }),
].join("\n");

test("a topic reply is cut to a few plain words", () => {
  assert.equal(parseTopic(reply("Flaky login test")), "Flaky login test");
  assert.equal(parseTopic(reply('"Plan the auth refactor."\nextra line')), "Plan the auth refactor");
  assert.equal(parseTopic(reply("Topic: one two three four five six seven eight")), "one two three four five six");
  assert.ok(parseTopic(reply("Supercalifragilisticexpialidocious-and-more-and-more-and-more")).length <= 48);
  assert.throws(() => parseTopic(reply('""')), /empty/);
  assert.ok(topicPrompt("fix the build").includes("<message>\nfix the build\n</message>"));
});

test("writeTopic asks Pi for one tool-free turn and returns the topic", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-topic-"));
  try {
    writeFileSync(join(dir, "reply"), reply("Board cleanup"));
    const pi = fakePi(dir, `echo "$@" > "${dir}/args"\ncat "${dir}/reply"`);
    assert.equal(await writeTopic(pi, dir, ["--model", "m"], "please tidy the board"), "Board cleanup");
    const args = readFileSync(join(dir, "args"), "utf8");
    for (const flag of ["--no-session", "--no-tools", "--model m", "please tidy the board"]) assert.ok(args.includes(flag), flag);
    await assert.rejects(writeTopic(fakePi(dir, "echo nope >&2\nexit 2"), dir, [], "x"), /Pi failed \(2\): nope/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the first message names the chat once, and a failed name is retried on the next message", async () => {
  const { dir, board, repoBoard, done } = fixture();
  try {
    const pi = fakePi(dir, `echo '{"type":"message_end","message":{"role":"assistant","stopReason":"stop"}}'\necho '{"type":"agent_settled","aborted":false}'`);
    const asked: string[] = [];
    let fail = true;
    const chats = new Chats(board, { piBin: pi, sessionDir: join(dir, "sessions"), cli: "cli", env: process.env, models: () => [],
      topic: async (_repoBoard, message) => { asked.push(message); if (fail) throw new Error("no model"); return "Blocked cards"; } });
    const warn = console.warn; console.warn = () => {};
    const chat = board.createChat(repoBoard.id);
    try {
      let finished = settle(chats, chat.id);
      chats.send(repoBoard, chat.id, "what is blocked?");
      await finished;
      assert.equal(board.getChat(chat.id)?.topic, "");
      fail = false;
      const named = new Promise<ChatEvent>(resolve => { const off = chats.subscribe(chat.id, event => { if (event.type === "chat") { off(); resolve(event); } }); });
      finished = settle(chats, chat.id);
      chats.send(repoBoard, chat.id, "and why?");
      const event = await named; await finished;
      assert.equal(event.type === "chat" && event.chat.topic, "Blocked cards");
      assert.equal(board.getChat(chat.id)?.topic, "Blocked cards");
      assert.equal(board.listChats(repoBoard.id)[0].topic, "Blocked cards");
      finished = settle(chats, chat.id);
      chats.send(repoBoard, chat.id, "thanks");
      await finished;
      assert.deepEqual(asked, ["what is blocked?", "and why?"], "a named chat is not named again");
    } finally { console.warn = warn; }
  } finally { done(); }
});

test("a database from before topics and unread counts gains them on its chats", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-chat-"));
  try {
    const old = new DatabaseSync(join(dir, "board.sqlite"));
    old.exec("CREATE TABLE chats (id TEXT PRIMARY KEY, boardId TEXT NOT NULL, title TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL); INSERT INTO chats VALUES ('c1', 'b1', 'Old chat', 't', 't')");
    old.close();
    const board = new Board(join(dir, "board.sqlite"));
    try {
      assert.equal(board.getChat("c1")?.topic, "");
      assert.equal(board.getChat("c1")?.unread, 0);
      assert.equal(board.setChatTopic("c1", "Old topic")?.topic, "Old topic");
    } finally { board.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deleting a chat removes its messages and its Pi session file", () => {
  const { dir, board, repoBoard, done } = fixture();
  try {
    const chats = new Chats(board, { piBin: "pi", sessionDir: join(dir, "sessions"), cli: "cli", env: process.env, models: () => [] });
    const chat = board.createChat(repoBoard.id);
    board.addChatMessage(chat.id, "user", "hello");
    writeFileSync(join(dir, "sessions", `2026-01-01T00-00-00Z_${chat.id}.jsonl`), "{}");
    chats.delete(chat.id);
    assert.equal(board.getChat(chat.id), undefined);
    assert.deepEqual(board.listChatMessages(chat.id), []);
    assert.equal(readdirSync(join(dir, "sessions")).length, 0);
  } finally { done(); }
});

test("the API reports each board's unread chat total, and a looking view clears it", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-chat-api-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const pi = okPi(home);
  const listener = createNetServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, BAKERY_DATA_DIR: join(home, "data"), BAKERY_PORT: String(port), BAKERY_PI_BIN: pi },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr?.on("data", chunk => { output += chunk.toString(); });
  const url = `http://127.0.0.1:${port}/api`;
  const request = async (path: string, method = "GET", input?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: input ? { "Content-Type": "application/json" } : undefined, body: input ? JSON.stringify(input) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const until = async (check: () => Promise<boolean>, what: string) => {
    const deadline = Date.now() + 10_000;
    while (!(await check())) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Timed out waiting for ${what}: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const stream = new AbortController();
  try {
    await until(() => fetch(`${url}/boards`).then(() => true, () => false), "the server");
    const repoBoard = (await request("/boards", "POST", { repo })).data;
    assert.equal((await request("/boards")).data[0].chatUnread, 0);
    const chat = (await request(`/boards/${repoBoard.id}/chats`, "POST", {})).data;
    const chatUrl = `/boards/${repoBoard.id}/chats/${chat.id}`;
    // An open but unfocused view: the turn still counts.
    const events = await fetch(`${url}${chatUrl}/events?viewer=tab1&looking=0`, { signal: stream.signal });
    assert.equal(events.status, 200);
    assert.equal((await request(`${chatUrl}/messages`, "POST", { message: "hello" })).status, 202);
    await until(async () => (await request("/boards")).data[0].chatUnread === 1, "the unread total");
    assert.equal((await request(`/boards/${repoBoard.id}/chats`)).data[0].unread, 1);
    assert.equal((await request(`${chatUrl}/view`, "POST", { viewer: "bad id!", looking: true })).status, 400);
    assert.equal((await request(`${chatUrl}/view`, "POST", { viewer: "tab1", looking: "yes" })).status, 400);
    assert.equal((await request(`${chatUrl}/view`, "POST", { viewer: "tab1", looking: true })).status, 200);
    assert.equal((await request("/boards")).data[0].chatUnread, 0);
    assert.equal((await request(`/boards/${repoBoard.id}/chats`)).data[0].unread, 0);
  } finally {
    stream.abort();
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    rmSync(home, { recursive: true, force: true });
  }
});

test("discardIfEmpty deletes only a chat with no saved message and no running reply", () => {
  const { dir, board, repoBoard, done } = fixture();
  try {
    const chats = new Chats(board, { piBin: "pi", sessionDir: join(dir, "sessions"), cli: "cli", env: process.env, models: () => [] });
    const empty = board.createChat(repoBoard.id), used = board.createChat(repoBoard.id);
    board.addChatMessage(used.id, "user", "hello");
    // A client with a stale view asks about the chat that gained a message elsewhere.
    assert.equal(chats.discardIfEmpty(used.id), false);
    assert.equal(board.listChatMessages(used.id).length, 1);
    assert.equal(chats.discardIfEmpty(empty.id), true);
    assert.equal(board.getChat(empty.id), undefined);
    assert.equal(chats.discardIfEmpty(empty.id), false, "an already-deleted chat is a no-op");
  } finally { done(); }
});
