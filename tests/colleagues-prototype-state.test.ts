import assert from "node:assert/strict";
import { test } from "node:test";
import { initialState, reduce, roomOf, type Action, type State } from "../src/prototype/colleagues/state.js";

const run = (state: State, ...actions: Action[]) => actions.reduce(reduce, state);
const room = (state: State) => state.rooms[0];
const silkRoom = () => run(initialState(), { type: "create-room", topic: "Ingestion quality", participants: ["ingest", "scout"], projects: ["silk"], lead: "ingest", mode: "interjections" });
const texts = (state: State, kind: string) => room(state).messages.filter(item => item.kind === kind).map(item => item.text);

test("an ordinary message gets a lead reply and one useful interjection", () => {
  const id = silkRoom().rooms[0].id;
  let state = run(silkRoom(), { type: "send", roomId: id, text: "How should we retry enrichment without duplicating media?", everyone: false });
  assert.equal(room(state).round?.pending.join(), "ingest");
  state = run(state, { type: "advance", roomId: id }, { type: "advance", roomId: id });
  assert.equal(room(state).round, null);
  assert.deepEqual(room(state).messages.map(item => `${item.kind}:${item.author}`), ["user:you", "reply:ingest", "interjection:scout"]);
});

test("agreement-only rooms stay quiet and mention-only skips screening", () => {
  const id = silkRoom().rooms[0].id;
  let state = run(silkRoom(), { type: "send", roomId: id, text: "Preserve the schema. No migration.", everyone: false }, { type: "advance", roomId: id }, { type: "advance", roomId: id });
  assert.equal(texts(state, "interjection").length, 0);
  assert.match(texts(state, "system")[0], /No important contributions/);
  state = run(silkRoom(), { type: "set-mode", roomId: id, mode: "mention-only" }, { type: "send", roomId: id, text: "How should we retry enrichment?", everyone: false }, { type: "advance", roomId: id });
  assert.equal(room(state).round, null);
});

test("Ask everyone replies once per participant with no interjection pass", () => {
  const id = silkRoom().rooms[0].id;
  const state = run(silkRoom(), { type: "send", roomId: id, text: "Status?", everyone: true }, { type: "advance", roomId: id }, { type: "advance", roomId: id });
  assert.deepEqual(room(state).messages.filter(item => item.kind === "reply").map(item => item.author), ["ingest", "scout"]);
  assert.equal(room(state).round, null);
});

test("steering promotes a queued message once and keeps the rest in order", () => {
  const id = silkRoom().rooms[0].id;
  let state = run(silkRoom(), { type: "send", roomId: id, text: "First question about retry", everyone: false });
  state = run(state, { type: "send", roomId: id, text: "Compare this with last week's failure.", everyone: false }, { type: "send", roomId: id, text: "Preserve the schema. No migration.", everyone: false }, { type: "send", roomId: id, text: "Third queued", everyone: false });
  assert.equal(room(state).queue.length, 3);
  const steered = room(state).queue[1].id;
  state = run(state, { type: "steer", roomId: id, itemId: steered });
  assert.deepEqual(room(state).queue.map(item => item.text), ["Compare this with last week's failure.", "Third queued"]);
  assert.equal(room(state).executions[steered], 1);
  assert.ok(Object.values(room(state).executions).every(count => count === 1));
  const interrupted = room(state).messages.filter(item => item.status === "interrupted");
  assert.equal(interrupted.length, 1);
  // The promoted message's input excludes everything still queued.
  assert.match(room(state).runLog.at(-1)!, /2 queued messages not included/);
  // Finishing drains the queue in order, never replaying the promoted message.
  for (let i = 0; i < 12; i++) state = run(state, { type: "advance", roomId: id });
  assert.ok(Object.values(room(state).executions).every(count => count === 1));
  assert.deepEqual(texts(state, "user"), ["First question about retry", "Preserve the schema. No migration.", "Compare this with last week's failure.", "Third queued"]);
});

test("Stop pauses the queue, late output is fenced, and Resume restarts it", () => {
  const id = silkRoom().rooms[0].id;
  let state = run(silkRoom(), { type: "send", roomId: id, text: "Retry question", everyone: false }, { type: "send", roomId: id, text: "Queued one", everyone: false }, { type: "stop", roomId: id });
  assert.equal(room(state).round, null);
  assert.equal(room(state).paused, true);
  state = run(state, { type: "send", roomId: id, text: "Sent while paused", everyone: false });
  assert.equal(room(state).queue.length, 2);
  assert.equal(room(state).round, null);
  const before = room(state).messages.length;
  state = run(state, { type: "late-output", roomId: id });
  assert.equal(texts(state, "reply").length, 1);
  assert.equal(room(state).messages.length, before + 1);
  state = run(state, { type: "resume", roomId: id });
  assert.equal(room(state).paused, false);
  assert.equal(room(state).round?.text, "Queued one");
});

test("standup partial failure is retryable and starts no round", () => {
  const id = silkRoom().rooms[0].id;
  let state = run(silkRoom(), { type: "standup", roomId: id });
  const standup = room(state).messages[0];
  assert.deepEqual(standup.standup?.reports.map(item => item.state), ["ok", "failed"]);
  assert.equal(room(state).round, null);
  state = run(state, { type: "retry-report", roomId: id, messageId: standup.id, colleagueId: "scout" });
  assert.ok(room(state).messages[0].standup?.reports.every(item => item.state === "ok"));
});

test("context excludes other projects and reports unavailable memory honestly", () => {
  const id = silkRoom().rooms[0].id;
  const send = { type: "send", roomId: id, text: "Retry enrichment", everyone: false } as const;
  let state = run(silkRoom(), send, { type: "advance", roomId: id });
  const memories = room(state).messages.find(item => item.kind === "reply")!.context!.memories!;
  assert.deepEqual(memories.map(item => item.id), ["imp_7f3a21", "imp_2c9e04", "imp_51d8b7"]);
  state = run(silkRoom(), { type: "toggle-memory" }, send, { type: "advance", roomId: id });
  assert.equal(room(state).messages.find(item => item.kind === "reply")!.context!.memories, null);
});

test("creating a card twice yields one simulated card", () => {
  const id = silkRoom().rooms[0].id;
  let state = run(silkRoom(), { type: "send", roomId: id, text: "Retry enrichment", everyone: false }, { type: "advance", roomId: id });
  const reply = room(state).messages.find(item => item.kind === "reply")!;
  state = run(state, { type: "open-handoff", roomId: id, messageId: reply.id });
  assert.equal(state.draft?.destination, "ready");
  state = run(state, { type: "edit-draft", patch: { destination: "triage" } }, { type: "create-card" }, { type: "create-card" });
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].destination, "triage");
  assert.equal(roomOf(state, id)!.messages.filter(item => item.kind === "card").length, 1);
});

test("reset returns to the fixture state", () => {
  assert.deepEqual(run(silkRoom(), { type: "reset" }), initialState());
});
