#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";

const usage = `bakery-cli — local Bakery API client

Usage: bakery-cli boards [--json]
       bakery-cli cards [--board ID|PATH] [--json]
       bakery-cli create --title TITLE [--body BODY] [--board ID|PATH] [--json]
       bakery-cli ready CARD_ID [--board ID|PATH] [--yes]
       bakery-cli triage CARD_ID [--board ID|PATH]
       bakery-cli start CARD_ID... [--board ID|PATH] --yes
       bakery-cli runs CARD_ID [--board ID|PATH] [--json]
       bakery-cli conflicts [--board ID|PATH] [--json]
       bakery-cli pickup [on|off|reset] [--concurrency 1-4] [--limit 1-99] [--board ID|PATH] [--yes]

Set BAKERY_URL (or BAKERY_PORT) to use a different local server. --json prints full API data.
start runs Pi on Ready, Review or Failed cards (a retry reuses the card's worktree and Pi session).
--yes is required before start, enabling or resetting pickup, or moving a card to Ready on a pickup-enabled
board; each can start paid Pi runs. No command approves a merge.`;

function options(argv) {
  const result = { positionals: [], json: false, yes: false };
  const values = new Set(["board", "title", "body", "concurrency", "limit"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json" || arg === "--yes") result[arg.slice(2)] = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg.startsWith("--") && values.has(arg.slice(2))) {
      const key = arg.slice(2);
      if (key in result || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Supply exactly one value for ${arg}`);
      result[key] = argv[++i];
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else result.positionals.push(arg);
  }
  return result;
}

function serverUrl() {
  const url = new URL(process.env.BAKERY_URL ?? `http://127.0.0.1:${process.env.BAKERY_PORT ?? "4317"}`);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("BAKERY_URL must be a loopback HTTP origin (for example http://127.0.0.1:4317)");
  }
  return url;
}

async function request(origin, path, method = "GET", input) {
  let response;
  try {
    response = await fetch(new URL(path, origin), {
      method,
      headers: input === undefined ? undefined : { "Content-Type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new Error(`Cannot reach Bakery at ${origin.origin}: ${error instanceof Error ? error.message : error}`);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Bakery ${response.status}: ${data?.error ?? response.statusText}`);
  return data;
}

function selectBoard(boards, selector) {
  if (!selector && boards.length === 1) return boards[0];
  if (!selector) throw new Error(boards.length ? "More than one board; choose one with --board ID|PATH" : "No boards yet. Add a repository in Bakery first.");
  const path = selector.startsWith("~/") ? resolve(homedir(), selector.slice(2)) : resolve(selector);
  const matches = boards.filter(item => item.id === selector || item.repo === path);
  if (matches.length !== 1) throw new Error(`Board not found: ${selector}`);
  return matches[0];
}

function cardId(value) {
  if (!value || !/^[\w-]+$/.test(value)) throw new Error("A card ID (letters, numbers, - or _) is required");
  return value;
}

function print(data, json, lines) {
  if (json) console.log(JSON.stringify(data, null, 2));
  else for (const line of lines) console.log(line);
}

async function main() {
  const opts = options(process.argv.slice(2));
  const [command, ...args] = opts.positionals;
  if (opts.help || !command) { console.log(usage); return; }
  const expected = { boards: 0, cards: 0, create: 0, ready: 1, triage: 1, runs: 1, conflicts: 0 };
  if (!(command in expected) && command !== "pickup" && command !== "start") throw new Error(`Unknown command: ${command}\n${usage}`);
  if (command === "pickup" ? args.length > 1 || (args.length === 1 && !["on", "off", "reset"].includes(args[0])) : command === "start" ? !args.length : args.length !== expected[command]) throw new Error(`Invalid arguments for ${command}\n${usage}`);
  if (command !== "create" && (opts.title !== undefined || opts.body !== undefined)) throw new Error("--title and --body are only valid with create");
  if (command !== "pickup" && (opts.concurrency !== undefined || opts.limit !== undefined)) throw new Error("--concurrency and --limit are only valid with pickup");
  if (opts.yes && !(command === "ready" || command === "pickup" || command === "start")) throw new Error("--yes is only valid with ready, start or pickup");
  if (command === "start") {
    args.forEach(cardId);
    if (!opts.yes) throw new Error(`Starting ${args.length === 1 ? "a run" : `${args.length} runs`} uses paid Pi. Repeat with --yes to confirm.`);
  }
  const origin = serverUrl();
  const boards = await request(origin, "/api/boards");
  if (command === "boards") {
    if (opts.board) throw new Error("--board is not valid with boards");
    print(boards, opts.json, boards.map(item => `${item.id}\t${item.repo}\tpickup:${item.autoPickupEnabled ? "on" : "off"}\treview:${item.autoReviewEnabled ? "on" : "off"}${item.autoPickupError ? `\tpaused:${item.autoPickupError}` : ""}`));
    return;
  }
  const board = selectBoard(boards, opts.board);
  const path = `/api/boards/${encodeURIComponent(board.id)}`;
  if (command === "cards") {
    const cards = await request(origin, `${path}/cards`);
    print(cards, opts.json, cards.map(item => `${item.id}\t${item.status}\tattempts:${item.attempts ?? 0}\treview-rounds:${item.reviewRounds ?? 0}\t${item.title}`));
  } else if (command === "create") {
    if (!opts.title?.trim()) throw new Error("create requires --title TITLE");
    const card = await request(origin, `${path}/cards`, "POST", { title: opts.title, body: opts.body ?? "" });
    print(card, opts.json, [`${card.id}\t${card.status}\t${card.title}`]);
  } else if (command === "ready" || command === "triage") {
    if (command === "ready" && board.autoPickupEnabled && !opts.yes) throw new Error("Auto pickup is enabled: Ready may start paid Pi immediately. Repeat with --yes to confirm.");
    const card = await request(origin, `${path}/cards/${cardId(args[0])}/status`, "POST", { status: command });
    print(card, opts.json, [`${card.id}\t${card.status}\t${card.title ?? ""}`]);
  } else if (command === "start") {
    // Each card starts independently so one refusal does not block the others.
    const results = [];
    for (const id of args) {
      try { results.push({ cardId: id, run: await request(origin, `${path}/cards/${id}/start`, "POST") }); }
      catch (error) { results.push({ cardId: id, error: error instanceof Error ? error.message : String(error) }); }
    }
    print(results, opts.json, results.map(item => item.run ? `${item.cardId}\tattempt #${item.run.attempt}\t${item.run.status}` : `${item.cardId}\terror\t${item.error}`));
    if (results.some(item => item.error)) process.exitCode = 1;
  } else if (command === "runs") {
    const runs = await request(origin, `${path}/cards/${cardId(args[0])}/runs`);
    print(runs, opts.json, runs.map(run => `${run.id}\t${run.status}\t${run.startedBy ?? "manual"}\t${run.startedAt ?? ""}\t${run.agent || "-"}${run.error ? `\t${run.error}` : ""}`));
  } else if (command === "conflicts") {
    const conflicts = await request(origin, `${path}/conflicts`);
    print(conflicts, opts.json, conflicts.map(item => `${item.cardId}\t${item.details ?? ""}`));
  } else if (command === "pickup") {
    const summary = item => `Pickup ${item.autoPickupEnabled ? "on" : "off"}; concurrency ${item.pickupConcurrency}; ${item.autoPickupStarts ?? 0}/${item.pickupDailyLimit ?? 6} starts in 24h${item.autoPickupNextAt ? `; next slot ${item.autoPickupNextAt}` : ""}${item.autoPickupError ? `; paused: ${item.autoPickupError}` : ""}`;
    if (!args.length) { print(board, opts.json, [summary(board)]); return; }
    if (args[0] === "reset") {
      if (opts.concurrency !== undefined || opts.limit !== undefined) throw new Error("pickup reset does not accept --concurrency or --limit");
      if (!opts.yes) throw new Error("Resetting the limit can start paid Pi runs immediately. Repeat with --yes to confirm.");
      const updated = await request(origin, `${path}/auto-pickup/reset-limit`, "POST");
      print(updated, opts.json, [summary(updated)]);
      return;
    }
    if (args[0] === "on" && !opts.yes) throw new Error("Enabling pickup can start paid Pi runs immediately. Repeat with --yes to confirm.");
    const concurrency = opts.concurrency === undefined ? board.pickupConcurrency : Number(opts.concurrency);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Concurrency must be an integer from 1 to 4");
    const limit = opts.limit === undefined ? (board.pickupDailyLimit ?? 6) : Number(opts.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 99) throw new Error("Limit must be an integer from 1 to 99");
    if (args[0] === "on" && board.autoPickupEnabled && limit > board.pickupDailyLimit && !opts.yes)
      throw new Error("Raising the limit can start paid Pi runs immediately. Repeat with --yes to confirm.");
    const updated = await request(origin, `${path}/settings`, "PATCH", { autoPickupEnabled: args[0] === "on", pickupConcurrency: concurrency, pickupDailyLimit: limit });
    print(updated, opts.json, [summary(updated)]);
  }
}

main().catch(error => { console.error(`bakery-cli: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
