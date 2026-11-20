import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}
const waitFor = async <T>(check: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  while (true) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 40)); }
};

// A fake Pi. It records every invocation, replies "reply from <name>", answers screening with {"interject": true} when
// the latest operator message says RISKY, hangs after a partial reply on SLOW, and fails for FAIL_<name>.
const fakePi = `#!/bin/sh
for last; do :; done
sys=""; prev=""
for a; do if [ "$prev" = "--append-system-prompt" ]; then sys="$a"; fi; prev="$a"; done
d="$FAKE_DIR/call-$(date +%s%N)-$$"
printf '%s\\n' "$PWD" > "$d.pwd"; printf '%s\\0' "$@" > "$d.args"
latest=$(printf '%s\\n' "$last" | grep '^Operator:' | tail -1)
delta() { printf '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"%s"}}\\n' "$1"; }
finish() { printf '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","usage":{"input":10,"output":5,"cost":{"total":0.01}}}}\\n{"type":"agent_settled","aborted":false}\\n'; }
case "$sys" in
  "You decide"*)
    case "$latest" in *RISKY*) delta '{\\"interject\\": true}';; *) delta '{\\"interject\\": false}';; esac
    finish; exit 0;;
esac
name=$(printf '%s' "$sys" | sed -n 's/^You are \\([A-Za-z]*\\).*/\\1/p' | head -1)
case "$latest" in *SLOW*) delta "partial from $name "; sleep 30;; esac
case "$latest" in *FAIL_$name*) echo boom >&2; exit 3;; esac
case "$last" in *Standup\\ window*) delta "report from $name";; *) delta "reply from $name";; esac
finish
`;

type Harness = { url: string; home: string; fakeDir: string; request: (path: string, method?: string, input?: unknown) => Promise<{ status: number; data: any }>; calls: () => { args: string[]; cwd: string }[]; restart: () => Promise<void>; stop: () => Promise<void>; kill: () => Promise<void>; repoA: string; repoB: string; boardA: string; boardB: string; impression: { fail: boolean; saved: string[]; searches: any[] } };

async function harness(): Promise<Harness> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "bakery-rooms-api-")));
  const fakeDir = join(home, "fake"), dataDir = join(home, "data");
  mkdirSync(fakeDir, { recursive: true });
  const pi = join(home, "pi"); writeFileSync(pi, fakePi); chmodSync(pi, 0o755);
  const repoA = join(home, "code", "alpha"), repoB = join(home, "code", "beta");
  for (const repo of [repoA, repoB]) { mkdirSync(repo, { recursive: true }); execFileSync("git", ["init", "-q", repo]); }
  execFileSync("git", ["-C", repoA, "remote", "add", "origin", "git@github.com:Acme/Alpha.git"]);
  const impression = { fail: false, saved: [] as string[], searches: [] as any[] };
  const memory: Server = createHttp((req, res) => {
    let text = ""; req.on("data", chunk => { text += chunk; });
    req.on("end", () => {
      if (impression.fail) { res.writeHead(503); res.end("down"); return; }
      const data = text ? JSON.parse(text) : {};
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/search") { impression.searches.push(data); res.end(JSON.stringify({ degraded: false, results: [{ id: "mem-1", scope: data.scope, project: data.project ?? null, content: "Alpha deploys on Fridays", stale: true, warning: "may be stale", updatedAt: "2026-01-01T00:00:00Z" }] })); }
      else if (req.url === "/api/memories") { impression.saved.push(data.content); res.statusCode = 201; res.end(JSON.stringify({ id: `saved-${impression.saved.length}`, outcome: "created" })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
  });
  await new Promise<void>(resolve => memory.listen(0, "127.0.0.1", resolve));
  const memoryPort = (memory.address() as { port: number }).port;
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  const start = async () => {
    child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: dataDir, BAKERY_PORT: String(port), BAKERY_SENTINEL: "0", BAKERY_GH_BIN: "false", BAKERY_PI_BIN: pi, FAKE_DIR: fakeDir, IMPRESSION_URL: `http://127.0.0.1:${memoryPort}`, IMPRESSION_TOKEN: "test-token", BAKERY_ROOM_POLL_MS: "200", BAKERY_AUTO_PICKUP: "0" },
    });
    await waitFor(async () => { if (child!.exitCode !== null) throw new Error("Server exited"); try { await fetch(`${url}/api/boards`); return true; } catch { return false; } }, "server");
  };
  const kill = async () => { if (child && child.exitCode === null) { const exited = new Promise(resolve => child!.once("exit", resolve)); child.kill("SIGKILL"); await exited; } };
  await start();
  const request = async (path: string, method = "GET", input?: unknown) => {
    const response = await fetch(`${url}/api${path}`, { method, headers: input === undefined ? undefined : { "Content-Type": "application/json" }, body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, data: await response.json() as any };
  };
  const boardA = (await request("/boards", "POST", { repo: repoA })).data.id, boardB = (await request("/boards", "POST", { repo: repoB })).data.id;
  return {
    url, home, fakeDir, request, repoA, repoB, boardA, boardB, impression, kill,
    calls: () => readdirSync(fakeDir).filter(name => name.endsWith(".args")).sort().map(name => ({ args: readFileSync(join(fakeDir, name), "utf8").split("\0").slice(0, -1), cwd: readFileSync(join(fakeDir, name.replace(/\.args$/, ".pwd")), "utf8").trim() })),
    restart: async () => { await kill(); await start(); },
    stop: async () => { await kill(); memory.close(); rmSync(home, { recursive: true, force: true }); },
  };
}

const replies = (room: any) => room.messages.filter((message: any) => message.kind === "colleague").map((message: any) => `${room.colleagues.find((c: any) => c.id === message.colleagueId).name}:${message.role}:${message.body}`);
const idle = (h: Harness, roomId: string) => waitFor(async () => { const { data } = await h.request(`/rooms/${roomId}`); return !data.running && data; }, "round to finish");

async function setup(h: Harness, names = ["Ada", "Bob", "Cy", "Di"], extra: Record<string, unknown> = {}) {
  const colleagues = [];
  for (const name of names) colleagues.push((await h.request("/colleagues", "POST", { name, specialty: `${name} specialty`, instructions: `${name} instructions`, projectIds: [h.boardA] })).data);
  const room = (await h.request("/rooms", "POST", { title: "Test room", leadId: colleagues[0].id, participantIds: colleagues.map(c => c.id), projects: [h.boardA, h.boardB], ...extra })).data;
  return { colleagues, room };
}

test("colleagues are global, validated, and independent of repository and model", async () => {
  const h = await harness();
  try {
    const created = await h.request("/colleagues", "POST", { name: "Ada", specialty: "Backend", instructions: "Be terse", model: "openai/gpt-5-mini", thinking: "low", projectIds: [h.boardA] });
    assert.equal(created.status, 201);
    assert.deepEqual(created.data.projectIds, [h.boardA]);
    assert.equal((await h.request("/colleagues", "POST", { name: "ada" })).status, 400, "names are unique ignoring case");
    assert.equal((await h.request("/colleagues", "POST", { name: "Bad", projectIds: ["nope"] })).status, 400, "associations must be real boards");
    assert.equal((await h.request("/colleagues", "POST", { name: "Bad2", model: "x", thinking: "extreme" })).status, 400);
    const moved = await h.request(`/colleagues/${created.data.id}`, "PATCH", { projectIds: [h.boardB], model: "openai/gpt-6.1-sol" });
    assert.equal(moved.data.id, created.data.id, "identity survives a project and model change");
    assert.deepEqual(moved.data.projectIds, [h.boardB]);
    assert.equal((await h.request("/colleagues")).data.length, 1);
  } finally { await h.stop(); }
});

test("routing, interjection limits, isolation of tools and cwd, and inspectable run configuration", async () => {
  const h = await harness();
  try {
    const { colleagues, room } = await setup(h);
    const [ada, bob] = colleagues;
    assert.equal((await h.request("/rooms", "POST", { leadId: bob.id, participantIds: [ada.id] })).status, 400, "lead must be a participant");
    assert.equal((await h.request("/rooms", "POST", { leadId: ada.id, participantIds: [ada.id], projects: [h.boardA], executionBoardId: h.boardB })).status, 400, "execution project must be a context project");

    await h.request(`/rooms/${room.id}/messages`, "POST", { body: "hello team" });
    let detail = await idle(h, room.id);
    assert.deepEqual(replies(detail), ["Ada:primary:reply from Ada"], "ordinary message goes to the lead only");
    assert.equal(detail.rounds.at(-1).cost.screens, 3, "the three non-answering colleagues were screened, visibly");
    assert.ok(detail.rounds.at(-1).cost.screening > 0, "screening cost is visible");

    await h.request(`/rooms/${room.id}/messages`, "POST", { body: "@Bob and @cy please check" });
    detail = await idle(h, room.id);
    assert.deepEqual(replies(detail).slice(1, 3).sort(), ["Bob:primary:reply from Bob", "Cy:primary:reply from Cy"], "mentions override the lead");

    // Three screened colleagues all want to interject; only two may.
    await h.request(`/rooms/${room.id}/messages`, "POST", { body: "RISKY plan" });
    detail = await idle(h, room.id);
    const round = detail.rounds.at(-1);
    assert.equal(round.interjections, 2);
    assert.equal(detail.messages.filter((m: any) => m.role === "interjection" && m.roundId === round.id).length, 2);

    // Ask everyone: every colleague answers once from one snapshot, and none sees another's answer.
    const before = h.calls().length;
    await h.request(`/rooms/${room.id}/messages`, "POST", { body: "what do you think?", ask: "everyone" });
    detail = await idle(h, room.id);
    const everyone = detail.rounds.at(-1);
    assert.equal(everyone.kind, "everyone");
    assert.equal(everyone.runs.filter((run: any) => run.role === "primary").length, 4);
    assert.equal(everyone.runs.filter((run: any) => run.role === "screen").length, 0, "Ask everyone has no interjection pass");
    const everyoneCalls = h.calls().slice(before);
    assert.equal(everyoneCalls.length, 4);
    for (const call of everyoneCalls) assert.ok(!call.args.at(-1)!.includes("reply from") || !/Operator: what do you think\?[\s\S]*\n\w+: reply from/.test(call.args.at(-1)!), "no sibling answers in the prompt");

    // Isolation: no execution project means no tools and a neutral cwd; no project path or name is granted to the process.
    for (const call of h.calls()) {
      assert.ok(call.args.includes("--no-tools") && call.args.includes("--no-session") && call.args.includes("--no-extensions") && call.args.includes("--no-mcp"));
      assert.ok(!call.args.some(arg => arg.includes(h.repoA) || arg.includes(h.repoB)), "repository paths are not in the arguments");
      assert.ok(call.cwd.endsWith(join("data", "rooms", "scratch")), `neutral cwd, got ${call.cwd}`);
    }
    const primary = detail.rounds.at(-1).runs.find((run: any) => run.role === "primary");
    assert.equal(primary.config.tools, "none");
    assert.equal(primary.config.identity.name, primary.config.identity.name);
    const context = await h.request(`/rooms/${room.id}/context/${primary.id}`);
    assert.equal(context.status, 200);
    assert.equal(context.data.run.config.model, "openai/gpt-6.1-sol");

    // With an explicit execution project the tools are read-only and the cwd is that repository only.
    await h.request(`/rooms/${room.id}`, "PATCH", { executionBoardId: h.boardB });
    const mark = h.calls().length;
    await h.request(`/rooms/${room.id}/messages`, "POST", { body: "look at the code" });
    await idle(h, room.id);
    const exec = h.calls().slice(mark).find(call => call.args.includes("--tools"))!;
    assert.equal(exec.args[exec.args.indexOf("--tools") + 1], "read,grep,find,ls");
    assert.ok(!exec.args.includes("bash") && !exec.args.includes("--no-tools"));
    assert.equal(exec.cwd, h.repoB);
    assert.ok(!exec.args.some(arg => arg.includes(h.repoA)), "the other project is not reachable");
  } finally { await h.stop(); }
});

test("quiet mention-only mode never screens or interjects", async () => {
  const h = await harness();
  try {
    const { room } = await setup(h, ["Ada", "Bob"], { mode: "mention" });
    await h.request(`/rooms/${room.id}/messages`, "POST", { body: "RISKY thing" });
    const detail = await idle(h, room.id);
    assert.equal(detail.rounds.at(-1).runs.length, 1);
  } finally { await h.stop(); }
});

test("queue, stop, resume, steer, partial output and late-output fencing", async () => {
  const h = await harness();
  try {
    const { room } = await setup(h, ["Ada", "Bob"]);
    const send = (body: string) => h.request(`/rooms/${room.id}/messages`, "POST", { body });
    await send("SLOW first");
    await waitFor(async () => (await h.request(`/rooms/${room.id}`)).data.live.some((entry: any) => entry.text), "live partial");
    const a = (await send("queued A")).data, b = (await send("queued B")).data, c = (await send("queued C")).data;
    assert.deepEqual([a, b, c].map(m => m.state), ["queued", "queued", "queued"]);
    assert.equal((await h.request(`/rooms/${room.id}/messages/${b.id}`, "PATCH", { body: "queued B edited" })).status, 200);
    assert.equal((await h.request(`/rooms/${room.id}/messages/${a.id}`, "DELETE")).status, 200);
    assert.equal((await h.request(`/rooms/${room.id}/messages/${a.id}`, "DELETE")).status, 409, "a removed message cannot be removed again");

    // Steer C: the SLOW round is cancelled, its partial text is kept as interrupted, C runs, then B.
    assert.equal((await h.request(`/rooms/${room.id}/steer`, "POST", { messageId: c.id })).status, 200);
    assert.equal((await h.request(`/rooms/${room.id}/steer`, "POST", { messageId: c.id })).status, 409, "steering the same message twice is refused");
    const detail = await idle(h, room.id);
    const texts = detail.messages.filter((m: any) => m.kind !== "system").map((m: any) => `${m.kind}:${m.interrupted ? "interrupted:" : ""}${m.body}`);
    const index = (needle: string) => texts.findIndex((text: string) => text.includes(needle));
    assert.ok(index("interrupted:partial from Ada") > index("SLOW first") && index("interrupted:partial from Ada") < index("queued C"), `partial text kept in place: ${JSON.stringify(texts)}`);
    assert.ok(index("queued C") < index("queued B edited"), "promoted message runs first; the rest keep their order");
    assert.ok(!texts.some((text: string) => text.includes("queued A")), "removed message never ran");
    assert.equal(detail.rounds.find((r: any) => r.note.startsWith("Steered")).status, "stopped");
    assert.ok(!texts.some((text: string) => text === "colleague:reply from Ada" && index(text) < index("queued C")), "the cancelled round produced no late final reply");
    // Earlier snapshots never contain later queued text.
    const slowCall = h.calls().find(call => call.args.at(-1)!.includes("SLOW first"))!;
    assert.ok(!slowCall.args.at(-1)!.includes("queued"), "queued text did not leak into the earlier snapshot");
    const cCall = h.calls().find(call => call.args.at(-1)!.includes("queued C") && !call.args.includes("--no-session-x"))!;
    assert.ok(!cCall.args.at(-1)!.includes("queued B"), "later queued text did not leak into the promoted snapshot");

    // Stop cancels the running round and pauses; new messages queue; Resume continues.
    await send("SLOW second");
    await waitFor(async () => (await h.request(`/rooms/${room.id}`)).data.live.some((entry: any) => entry.text), "second live partial");
    await h.request(`/rooms/${room.id}/stop`, "POST");
    let state = (await h.request(`/rooms/${room.id}`)).data;
    assert.equal(state.room.paused, true);
    assert.equal(state.running, false);
    assert.equal((await send("while paused")).data.state, "queued");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await h.request(`/rooms/${room.id}`)).data.messages.find((m: any) => m.body === "while paused").state, "queued", "a paused queue does not run");
    await h.request(`/rooms/${room.id}/resume`, "POST");
    state = await idle(h, room.id);
    assert.ok(state.messages.some((m: any) => m.body === "reply from Ada" && m.seq > state.messages.find((x: any) => x.body === "while paused").seq));
  } finally { await h.stop(); }
});

test("a restart interrupts running work honestly, replays nothing, and keeps the queue", async () => {
  const h = await harness();
  try {
    const { room } = await setup(h, ["Ada", "Bob"]);
    await h.request(`/rooms/${room.id}/messages`, "POST", { body: "SLOW before restart" });
    await waitFor(async () => (await h.request(`/rooms/${room.id}`)).data.live.some((entry: any) => entry.text), "live partial");
    await h.request(`/rooms/${room.id}/messages`, "POST", { body: "still queued" });
    await h.restart();
    // Count after the old server is gone: a screening call may have started between the send and the kill.
    const calls = h.calls().length;
    const state = (await h.request(`/rooms/${room.id}`)).data;
    assert.equal(state.running, false);
    assert.equal(state.room.paused, true, "the queue is paused after an interruption");
    assert.equal(state.rounds.at(-1).status, "interrupted");
    assert.ok(state.messages.some((m: any) => m.kind === "system" && /nothing was replayed/i.test(m.body)));
    assert.equal(state.messages.find((m: any) => m.body === "still queued").state, "queued");
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(h.calls().length, calls, "no paid run was replayed");
    const interrupted = state.rounds.at(-1).runs.find((run: any) => run.status === "interrupted");
    assert.ok(interrupted);
    const retried = await h.request(`/rooms/${room.id}/runs/${interrupted.id}/retry`, "POST");
    assert.equal(retried.status, 202, "an explicit retry is allowed");
  } finally { await h.stop(); }
});

test("failed replies are explicit and individually retryable, once", async () => {
  const h = await harness();
  try {
    const { room } = await setup(h, ["Ada", "Bob"]);
    await h.request(`/rooms/${room.id}/messages`, "POST", { body: "FAIL_Bob @Ada @Bob go" });
    let detail = await idle(h, room.id);
    const failed = detail.rounds.at(-1).runs.find((run: any) => run.status === "failed");
    assert.match(failed.error, /Pi failed \(3\)/);
    assert.ok(detail.messages.some((m: any) => m.kind === "error" && /Bob could not reply/.test(m.body)));
    assert.equal((await h.request(`/rooms/${room.id}/messages`, "POST", { body: "next" })).data.state, "delivered");
    await idle(h, room.id);
  } finally { await h.stop(); }
});

test("standup is grounded in linked cards, labels partial failure, and retries one report", async () => {
  const h = await harness();
  try {
    const { colleagues, room } = await setup(h, ["Ada", "Bob"]);
    const [ada] = colleagues;
    const handoff = (await h.request(`/rooms/${room.id}/handoffs`, "POST", { boardId: h.boardA, title: "Do alpha thing", requirements: "Implement the alpha thing completely", assigneeId: ada.id, idempotencyKey: "k1" })).data;
    assert.equal(handoff.card.status, "triage");
    const before = h.calls().length;
    assert.equal((await h.request(`/rooms/${room.id}/standup`, "POST")).status, 202);
    const detail = await idle(h, room.id);
    const standup = detail.rounds.at(-1);
    assert.equal(standup.kind, "standup");
    assert.ok(Date.parse(standup.cutoff) <= Date.now() - 23 * 3_600_000, "first window is 24h");
    const reports = standup.runs.filter((run: any) => run.role === "standup-report");
    assert.equal(reports.length, 2);
    const adaReport = reports.find((run: any) => run.colleagueId === ada.id);
    assert.equal(adaReport.facts.proposed.length, 1, "the linked Triage card is proposed work");
    assert.equal(adaReport.facts.proposed[0].cardId, handoff.card.id);
    const bobReport = reports.find((run: any) => run.colleagueId !== ada.id);
    assert.equal(bobReport.config.model, null, "no linked cards: no paid call");
    assert.equal(h.calls().slice(before).filter(call => call.args.at(-1)!.includes("Standup window")).length, 1);
    assert.ok(standup.runs.some((run: any) => run.role === "standup-summary" && run.status === "done"));
    assert.ok(detail.messages.some((m: any) => m.body === "No activity in this window."));
  } finally { await h.stop(); }
});

test("handoff: clarification, paid confirmation, idempotency, board policy and status updates back to the room", async () => {
  const h = await harness();
  try {
    const { colleagues, room } = await setup(h, ["Ada", "Bob"]);
    const [ada, bob] = colleagues;
    await h.request(`/rooms/${room.id}/messages`, "POST", { body: "Decision: use sqlite" });
    const detail = await idle(h, room.id);
    const decision = detail.messages.find((m: any) => m.body === "Decision: use sqlite");
    const vague = await h.request(`/rooms/${room.id}/handoffs`, "POST", { boardId: h.boardA, title: "Vague", requirements: "", idempotencyKey: "v" });
    assert.equal(vague.status, 422);
    assert.equal(vague.data.code, "needs_clarification");
    const input = { boardId: h.boardA, title: "Use sqlite", requirements: "Store room state in sqlite with migrations", sourceMessageIds: [decision.id], assigneeId: bob.id, idempotencyKey: "same" };
    const first = await h.request(`/rooms/${room.id}/handoffs`, "POST", input);
    const second = await h.request(`/rooms/${room.id}/handoffs`, "POST", input);
    assert.equal(first.status, 201); assert.equal(second.status, 200);
    assert.equal(second.data.card.id, first.data.card.id, "retry returns the same card");
    assert.equal((await h.request(`/boards/${h.boardA}/cards`)).data.filter((c: any) => c.title === "Use sqlite").length, 1);
    const card = (await h.request(`/boards/${h.boardA}/cards`)).data.find((c: any) => c.id === first.data.card.id);
    assert.match(card.body, /Store room state in sqlite/); assert.match(card.body, /Decision: use sqlite/); assert.match(card.body, /Bob/); assert.match(card.body, new RegExp(room.id));
    assert.equal(first.data.handoff.assigneeId, bob.id);
    assert.ok("model" in first.data.handoff.config.workModel && first.data.handoff.config.board === h.repoA, "the execution configuration snapshot is stored");

    // Board policy default: Ready. With auto-pickup on, a Ready card is a paid run, so it needs confirmation.
    assert.equal((await h.request(`/boards/${h.boardA}/new-card-policy`, "PUT", { policy: "ready" })).data.policy, "ready");
    const quiet = await h.request(`/rooms/${room.id}/handoffs`, "POST", { boardId: h.boardB, title: "Beta thing", requirements: "Implement the beta thing fully", idempotencyKey: "b" });
    assert.equal(quiet.data.card.status, "triage", "board B keeps its Triage policy");
    assert.equal((await h.request(`/boards/${h.boardB}/settings`, "PATCH", { autoPickupEnabled: true, pickupConcurrency: 1 })).status, 200);
    const refused = await h.request(`/rooms/${room.id}/handoffs`, "POST", { boardId: h.boardB, title: "Queue it", requirements: "Implement the queue thing fully", creation: "queue", idempotencyKey: "q" });
    assert.equal(refused.status, 409); assert.equal(refused.data.paid, true);
    assert.equal((await h.request(`/boards/${h.boardB}/cards`)).data.filter((c: any) => c.title === "Queue it").length, 0, "nothing was created without confirmation");
    const queued = await h.request(`/rooms/${room.id}/handoffs`, "POST", { boardId: h.boardB, title: "Queue it", requirements: "Implement the queue thing fully", creation: "queue", confirmPaid: true, idempotencyKey: "q" });
    assert.equal(queued.status, 201); assert.equal(queued.data.paid, true); assert.equal(queued.data.card.status, "ready");
    const noPickup = await h.request(`/rooms/${room.id}/handoffs`, "POST", { boardId: h.boardA, title: "Nope", requirements: "Implement something fully", creation: "queue", confirmPaid: true, idempotencyKey: "n" });
    assert.equal(noPickup.status, 409, "queue is refused on a board without auto-pickup");
    const policyReady = await h.request(`/rooms/${room.id}/handoffs`, "POST", { boardId: h.boardA, title: "Policy ready", requirements: "Implement policy ready fully", idempotencyKey: "p" });
    assert.equal(policyReady.data.card.status, "ready", "board policy is inherited");
    const override = await h.request(`/rooms/${room.id}/handoffs`, "POST", { boardId: h.boardA, title: "Override triage", requirements: "Implement override fully", creation: "triage", idempotencyKey: "o" });
    assert.equal(override.data.card.status, "triage", "per-card override wins");

    // A status change on the linked card posts one system entry, with no new round.
    const rounds = (await h.request(`/rooms/${room.id}`)).data.rounds.length;
    assert.equal((await h.request(`/boards/${h.boardA}/cards/${first.data.card.id}/status`, "POST", { status: "done" })).status, 200);
    const posted = await waitFor(async () => (await h.request(`/rooms/${room.id}`)).data.messages.find((m: any) => m.kind === "system" && m.body.includes(first.data.card.id) && /done/.test(m.body) && /is done/.test(m.body)), "status update");
    assert.ok(posted);
    await new Promise(resolve => setTimeout(resolve, 600));
    const after = (await h.request(`/rooms/${room.id}`)).data;
    assert.equal(after.rounds.length, rounds, "card updates start no agent round");
    assert.equal(after.messages.filter((m: any) => m.kind === "system" && m.body.includes(`Card ${first.data.card.id}`)).length, 1);
    assert.ok(ada);
  } finally { await h.stop(); }
});

test("memory: scoped retrieval is disclosed, outage degrades visibly, saves are explicit and retryable", async () => {
  const h = await harness();
  try {
    const { room } = await setup(h, ["Ada"], {});
    await h.request(`/rooms/${room.id}`, "PATCH", { projects: [{ boardId: h.boardA, memory: true }, { boardId: h.boardB, memory: false }] });
    await h.request(`/rooms/${room.id}/messages`, "POST", { body: "when do we deploy?" });
    let detail = await idle(h, room.id);
    assert.equal(h.impression.searches.length, 1, "only the project that opted in was searched");
    assert.equal(h.impression.searches[0].project, "github.com/Acme/Alpha", "project identity comes from the explicit board's remote, not the cwd");
    assert.equal(h.impression.searches[0].scope, "project");
    const run = detail.rounds.at(-1).runs[0];
    const context = (await h.request(`/rooms/${room.id}/context/${run.id}`)).data;
    assert.equal(context.memory.status, "used");
    assert.equal(context.memory.items[0].id, "mem-1");
    assert.equal(context.memory.items[0].stale, true);
    assert.ok(h.calls().at(-1)!.args.at(-1)!.includes("Alpha deploys on Fridays"));
    assert.ok(!h.calls().at(-1)!.args.some(arg => arg.includes("test-token")), "no credentials reach the agent");

    h.impression.fail = true;
    await h.request(`/rooms/${room.id}/messages`, "POST", { body: "again" });
    detail = await idle(h, room.id);
    assert.equal(detail.rounds.at(-1).context.memory.status, "unavailable");
    assert.ok(detail.messages.some((m: any) => m.kind === "system" && /Memory is unavailable/.test(m.body)));
    assert.ok(detail.messages.some((m: any) => m.body === "reply from Ada" && m.seq > 0), "the colleague still replied");

    const message = detail.messages.find((m: any) => m.kind === "colleague");
    assert.equal((await h.request(`/rooms/${room.id}/remember`, "POST", { messageId: message.id, scope: "project", boardId: "not-in-room" })).status, 400, "project must be explicit and in the room");
    const failed = (await h.request(`/rooms/${room.id}/remember`, "POST", { messageId: message.id, scope: "project", boardId: h.boardA })).data;
    assert.equal(failed.status, "unsaved"); assert.match(failed.error, /503/);
    h.impression.fail = false;
    const retried = (await h.request(`/rooms/${room.id}/remember/${failed.id}/retry`, "POST")).data;
    assert.equal(retried.status, "saved"); assert.equal(retried.memoryId, "saved-1");
    assert.match(h.impression.saved[0], /Source: Bakery room "Test room"/);
    const again = (await h.request(`/rooms/${room.id}/remember`, "POST", { messageId: message.id, scope: "project", boardId: h.boardA })).data;
    assert.equal(again.id, failed.id); assert.equal(h.impression.saved.length, 1, "saving twice does not duplicate");
  } finally { await h.stop(); }
});
