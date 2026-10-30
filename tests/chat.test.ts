import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { Chats, applyPiEvent, chatSystemPrompt, replyText, type ChatEvent } from "../server/chat.js";
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
    assert.equal(readdirSyncSafe(join(dir, "sessions")).length, 0);
  } finally { done(); }
});
import { readdirSync } from "node:fs";
const readdirSyncSafe = (path: string) => readdirSync(path);
