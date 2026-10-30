#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { doctor, report } from "./doctor.mjs";

const usage = `bakery-cli — local Bakery API client

Usage: bakery-cli add TITLE... [--body BODY] [--priority -100..100|low|normal|high|urgent] [--board ID|PATH] [--json]
       bakery-cli doctor [--json]
       bakery-cli boards [--json]
       bakery-cli board [ID|PATH] [--integration local|github-pr] [--json]
       bakery-cli pr CARD_ID [URL|off] [--board ID|PATH] [--json]
       bakery-cli cards [--board ID|PATH] [--json]
       bakery-cli create --title TITLE [--body BODY] [--key KEY] [--priority -100..100|low|normal|high|urgent] [--after CARD_ID]... [--board ID|PATH] [--json]
       bakery-cli show CARD_ID [--board ID|PATH] [--json]
       bakery-cli depend CARD_ID --on CARD_ID... [--board ID|PATH] [--json]
       bakery-cli undepend CARD_ID --on CARD_ID... [--board ID|PATH] [--json]
       bakery-cli edit CARD_ID [--title TITLE] [--body BODY] [--board ID|PATH] [--json]
       bakery-cli archive CARD_ID... [--board ID|PATH] [--json]
       bakery-cli purge-attachments CARD_ID... --yes [--board ID|PATH] [--json]
       bakery-cli close CARD_ID [--board ID|PATH] [--json]
       bakery-cli restore CARD_ID [--board ID|PATH] [--json]
       bakery-cli stats [--board ID|PATH] [--json]
       bakery-cli ready CARD_ID [--board ID|PATH] [--yes]
       bakery-cli triage CARD_ID [--board ID|PATH]
       bakery-cli start CARD_ID... [--board ID|PATH] --yes
       bakery-cli runs CARD_ID [--board ID|PATH] [--json]
       bakery-cli conflicts [--board ID|PATH] [--json]
       bakery-cli pickup [on|off|reset] [--concurrency 1-4] [--limit 1-99] [--budget USD|off] [--board ID|PATH] [--yes]

doctor checks Node, git, pi, gh, worktrunk, the data directory, the server and each board, printing PASS, WARN or FAIL
per check; it exits 1 if any check fails. Against a remote BAKERY_URL it checks only the server and boards.
Set BAKERY_URL (or BAKERY_PORT) to use a different server (non-loopback needs BAKERY_ALLOW_REMOTE=1). --json prints full API data.
Without --board, commands use the board whose repository contains the current directory, or the only board.
add is quick capture: the words after it become the title of a new Triage card.
runs lists each attempt's tokens and cost ("—" when an older attempt has no record) and the card total,
including agent reviews; runs --json prints { cardId, total, runs, reviews }.
create --key KEY (up to 200 characters) is idempotent per board: if a card with that key exists, in any status,
it is printed instead of creating another.
start runs Pi on Ready, Review or Failed cards (a retry reuses the card's worktree and Pi session).
create --after CARD_ID (repeatable) makes the new card wait until each named card is Done or archived.
depend CARD_ID --on OTHER adds that dependency (repeat --on for several); undepend removes it. A card
waiting on an unfinished dependency is not picked up, and start refuses it until its dependencies are Done.
show prints a card with its dependencies, dependents, attempts and latest auto-review; edit changes its
title and/or description.
close moves a Review card to Done without merging; its worktree and branch stay.
archive accepts only Done cards and archives all or none; restore moves one archived card back to Done.
purge-attachments permanently deletes the attached files and records of archived cards, all or none. It cannot be
undone, even if the card is restored, so it needs --yes.
stats prints card counts per lane and the pickup state.
board prints a board's integration mode; --integration github-pr makes a card Done when its GitHub pull request
merges onto origin/main (needs gh and a GitHub remote link), --integration local merges on Approve.
pr links a card to a pull request URL instead of the bakery/CARD_ID branch lookup; off removes the link.
--yes is required before start, enabling or resetting pickup, or moving a card to Ready on a pickup-enabled
board; each can start paid Pi runs. No command approves a merge.`;

function options(argv) {
  const result = { positionals: [], json: false, yes: false, after: [], on: [] };
  // These may repeat; each occurrence adds one card ID.
  const lists = new Set(["after", "on"]);
  const values = new Set(["board", "title", "body", "key", "priority", "concurrency", "limit", "budget", "integration"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json" || arg === "--yes") result[arg.slice(2)] = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg.startsWith("--") && lists.has(arg.slice(2))) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Supply a card ID after ${arg}`);
      result[arg.slice(2)].push(argv[++i]);
    } else if (arg.startsWith("--") && values.has(arg.slice(2))) {
      const key = arg.slice(2);
      // Only --body may be empty, so edit can clear a description.
      const value = argv[i + 1];
      if (key in result || value === undefined || (!value && key !== "body") || value.startsWith("--")) throw new Error(`Supply exactly one value for ${arg}`);
      result[key] = argv[++i];
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else result.positionals.push(arg);
  }
  return result;
}

function serverUrl() {
  const url = new URL(process.env.BAKERY_URL ?? `http://127.0.0.1:${process.env.BAKERY_PORT ?? "4317"}`);
  if (url.protocol !== "http:" || (process.env.BAKERY_ALLOW_REMOTE !== "1" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("BAKERY_URL must be a loopback HTTP origin (for example http://127.0.0.1:4317); set BAKERY_ALLOW_REMOTE=1 to allow another host");
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
  // The innermost repository containing the current directory wins, so nested repositories pick themselves.
  const cwd = process.cwd();
  const here = boards.filter(item => cwd === item.repo || cwd.startsWith(item.repo + sep)).sort((a, b) => b.repo.length - a.repo.length)[0];
  if (!selector && here) return here;
  if (!selector && boards.length === 1) return boards[0];
  if (!selector) throw new Error(boards.length ? "More than one board; choose one with --board ID|PATH" : "No boards yet. Add a repository in Bakery first.");
  const path = /^~[\\/]/.test(selector) ? resolve(homedir(), selector.slice(2)) : resolve(selector);
  const matches = boards.filter(item => item.id === selector || item.repo === path);
  if (matches.length !== 1) throw new Error(`Board not found: ${selector}`);
  return matches[0];
}

function cardId(value) {
  if (!value || !/^[\w-]+$/.test(value)) throw new Error("A card ID (letters, numbers, - or _) is required");
  return value;
}

const usageKeys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost"];
// Older attempts have null usage: they are unknown, not free.
function usageTotal(items) {
  const recorded = items.filter(item => typeof item.cost === "number");
  const total = Object.fromEntries(usageKeys.map(key => [key, recorded.length ? recorded.reduce((sum, item) => sum + (item[key] ?? 0), 0) : null]));
  return { ...total, incomplete: recorded.length < items.length };
}
// Mirrors server/board.ts cardPriorities; the API returns the stored integer.
const priorities = { low: -10, normal: 0, high: 50, urgent: 100 };
const priorityValue = value => Object.hasOwn(priorities, value) ? priorities[value] : /^-?\d+$/.test(String(value)) && Math.abs(Number(value)) <= 100 ? Number(value) : null;
const priorityName = value => Object.keys(priorities).find(key => priorities[key] === (value ?? 0)) ?? String(value ?? 0);
const money = cost => typeof cost !== "number" ? "—" : cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
const lanes = ["triage", "ready", "running", "review", "failed", "interrupted", "done", "archived"];
const pickupSummary = item => `Pickup ${item.autoPickupEnabled ? "on" : "off"}; concurrency ${item.pickupConcurrency}; ${item.autoPickupStarts ?? 0}/${item.pickupDailyLimit ?? 6} starts in 24h${item.autoPickupNextAt ? `; next slot ${item.autoPickupNextAt}` : ""}; ${money(item.cost24h ?? 0)} spent in 24h${typeof item.pickupCostBudget === "number" ? ` of ${money(item.pickupCostBudget)} budget${item.autoPickupBudgetReached ? " (waiting: budget reached)" : ""}` : ""}${item.autoPickupError ? `; paused: ${item.autoPickupError}` : ""}`;
const cardLine = card => `${card.id}\t${card.status}\t${card.title ?? ""}`;

// The API has no single-card GET, so find the card in its board's list.
async function findCard(origin, path, id) {
  const card = (await request(origin, `${path}/cards`)).find(item => item.id === id);
  if (!card) throw new Error(`Card not found on this board: ${id}`);
  return card;
}

const usageText = item => typeof item.cost !== "number" ? "—"
  : `${money(item.cost)} (${item.inputTokens ?? 0} in, ${item.outputTokens ?? 0} out, ${item.cacheReadTokens ?? 0} cache read, ${item.cacheWriteTokens ?? 0} cache write)`;

function print(data, json, lines) {
  if (json) console.log(JSON.stringify(data, null, 2));
  else for (const line of lines) console.log(line);
}

async function main() {
  const opts = options(process.argv.slice(2));
  const [command, ...args] = opts.positionals;
  if (opts.help || !command) { console.log(usage); return; }
  const expected = { doctor: 0, board: 0, pr: 1, boards: 0, cards: 0, create: 0, ready: 1, triage: 1, runs: 1, conflicts: 0, show: 1, edit: 1, restore: 1, close: 1, stats: 0, depend: 1, undepend: 1 };
  const variadic = ["start", "archive", "add", "purge-attachments"];
  if (!(command in expected) && command !== "pickup" && !variadic.includes(command)) throw new Error(`Unknown command: ${command}\n${usage}`);
  if (command === "board" && args.length > 1 || command === "pr" && args.length > 2) throw new Error(`Invalid arguments for ${command}\n${usage}`);
  if (command === "board" ? false : command === "pr" ? !args.length : command === "pickup" ? args.length > 1 || (args.length === 1 && !["on", "off", "reset"].includes(args[0])) : variadic.includes(command) ? !args.length && command !== "add" : args.length !== expected[command]) throw new Error(`Invalid arguments for ${command}\n${usage}`);
  if (command === "add" && opts.title !== undefined) throw new Error("add takes its title as words, not --title");
  if (!["create", "edit", "add"].includes(command) && (opts.title !== undefined || opts.body !== undefined)) throw new Error("--title and --body are only valid with create, add or edit");
  if (command !== "create" && command !== "add" && (opts.key !== undefined || opts.priority !== undefined)) throw new Error("--key and --priority are only valid with create or add");
  if (opts.priority !== undefined && priorityValue(opts.priority) === null) throw new Error("Priority must be a whole number from -100 to 100, or low, normal, high, or urgent");
  if (command === "edit" && opts.title === undefined && opts.body === undefined) throw new Error("edit requires --title TITLE and/or --body BODY");
  if (command === "edit" && opts.title !== undefined && !opts.title.trim()) throw new Error("--title cannot be empty");
  if (opts.integration !== undefined && command !== "board") throw new Error("--integration is only valid with board");
  if (opts.integration !== undefined && !["local", "github-pr"].includes(opts.integration)) throw new Error("Integration must be local or github-pr");
  if (command === "board" && args.length && opts.board) throw new Error("Name the board once, as ID|PATH or with --board");
  if (command === "pr") cardId(args[0]);
  if (["show", "edit", "archive", "purge-attachments", "close", "restore", "depend", "undepend"].includes(command)) args.forEach(cardId);
  if (opts.after.length && command !== "create") throw new Error("--after is only valid with create");
  if (opts.on.length && command !== "depend" && command !== "undepend") throw new Error("--on is only valid with depend or undepend");
  if ((command === "depend" || command === "undepend") && !opts.on.length) throw new Error(`${command} requires --on CARD_ID`);
  [...opts.after, ...opts.on].forEach(cardId);
  if (command !== "pickup" && (opts.concurrency !== undefined || opts.limit !== undefined || opts.budget !== undefined)) throw new Error("--concurrency, --limit and --budget are only valid with pickup");
  if (opts.yes && !(command === "ready" || command === "pickup" || command === "start" || command === "purge-attachments")) throw new Error("--yes is only valid with ready, start, pickup or purge-attachments");
  if (command === "purge-attachments" && !opts.yes) throw new Error("Purging deletes the attached files from disk and cannot be undone, even if the card is restored. Repeat with --yes to confirm.");
  if (command === "start") {
    args.forEach(cardId);
    if (!opts.yes) throw new Error(`Starting ${args.length === 1 ? "a run" : `${args.length} runs`} uses paid Pi. Repeat with --yes to confirm.`);
  }
  const origin = serverUrl();
  if (command === "doctor") {
    if (opts.board) throw new Error("--board is not valid with doctor");
    const checks = await doctor({ origin, local: ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname), fetchBoards: () => request(origin, "/api/boards") });
    print(checks, opts.json, report(checks));
    if (checks.some(check => check.status === "fail")) process.exitCode = 1;
    return;
  }
  const boards = await request(origin, "/api/boards");
  if (command === "boards") {
    if (opts.board) throw new Error("--board is not valid with boards");
    print(boards, opts.json, boards.map(item => `${item.id}\t${item.repo}\tpickup:${item.autoPickupEnabled ? "on" : "off"}\treview:${item.autoReviewEnabled ? "on" : "off"}${item.autoPickupError ? `\tpaused:${item.autoPickupError}` : ""}`));
    return;
  }
  const board = selectBoard(boards, command === "board" && args.length ? args[0] : opts.board);
  const path = `/api/boards/${encodeURIComponent(board.id)}`;
  if (command === "cards") {
    const cards = await request(origin, `${path}/cards`);
    print(cards, opts.json, cards.map(item => `${item.id}\t${item.status}\tpriority:${priorityName(item.priority)}\tattempts:${item.attempts ?? 0}\treview-rounds:${item.reviewRounds ?? 0}\t${item.title}`));
  } else if (command === "create" || command === "add") {
    if (command === "add") opts.title = args.join(" ");
    if (!opts.title?.trim()) throw new Error(command === "add" ? "add requires a title" : "create requires --title TITLE");
    if (opts.key !== undefined && (!opts.key.trim() || opts.key.length > 200)) throw new Error("--key must be 1 to 200 characters");
    const input = { title: opts.title, body: opts.body ?? "" };
    if (opts.priority !== undefined) input.priority = Object.hasOwn(priorities, opts.priority) ? opts.priority : Number(opts.priority);
    if (opts.key !== undefined) input.idempotencyKey = opts.key;
    if (opts.after.length) input.dependsOn = opts.after;
    const card = await request(origin, `${path}/cards`, "POST", input);
    print(card, opts.json, [`${card.id}\t${card.status}\tpriority:${priorityName(card.priority)}\t${card.title}${card.dependsOn?.length ? `\tafter:${card.dependsOn.join(",")}` : ""}`]);
  } else if (command === "depend" || command === "undepend") {
    const id = args[0];
    let card;
    for (const other of opts.on) {
      card = command === "depend"
        ? await request(origin, `${path}/cards/${id}/dependencies`, "POST", { dependsOn: other })
        : await request(origin, `${path}/cards/${id}/dependencies/${other}`, "DELETE");
    }
    print(card, opts.json, [`${cardLine(card)}\tdepends on:${card.dependsOn?.length ? card.dependsOn.join(",") : "none"}${card.blocked ? "\tblocked" : ""}`]);
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
    const id = cardId(args[0]);
    const runs = await request(origin, `${path}/cards/${id}/runs`);
    const reviews = await request(origin, `${path}/cards/${id}/auto-review`);
    const total = usageTotal([...runs, ...reviews]);
    print({ cardId: id, total, runs, reviews }, opts.json, [
      ...runs.map(run => `${run.id}\t${run.status}\t${run.startedBy ?? "manual"}\t${run.startedAt ?? ""}\t${run.agent || "-"}\t${usageText(run)}${run.error ? `\t${run.error}` : ""}`),
      ...reviews.map(job => `review ${job.runId}\t${job.state}\t${job.agent || "-"}\t${usageText(job)}`),
      `total\t${total.cost === null ? "—" : usageText(total)}${total.incomplete && total.cost !== null ? "\t(older attempts not recorded)" : ""}`,
    ]);
  } else if (command === "show") {
    const id = args[0];
    const card = await findCard(origin, path, id);
    const runs = await request(origin, `${path}/cards/${id}/runs`);
    const reviews = await request(origin, `${path}/cards/${id}/auto-review`);
    const dependencies = await request(origin, `${path}/cards/${id}/dependencies`);
    const review = reviews[0] ?? null;
    const refs = (label, items) => items.length ? items.map(item => `${label}\t${item.id}\t${item.status}\t${item.title}`) : [`${label}\tnone`];
    print({ card, runs, review, dependencies }, opts.json, [
      `${card.title}`,
      `id\t${card.id}`, `status\t${card.status}${card.blocked ? " (blocked: waiting on dependencies)" : ""}`, `repo\t${card.repo ?? board.repo}`,
      ...refs("depends on", dependencies.dependsOn), ...refs("dependent", dependencies.dependents),
      "", ...(card.body?.trim() ? card.body.split("\n") : ["(no description)"]), "",
      `attempts\t${runs.length}`,
      ...runs.map(run => `#${run.attempt}\t${run.status}\t${run.agent || "-"}${run.error ? `\t${run.error}` : ""}`),
      `auto-review\t${review ? `${review.state}${review.details ? `\t${review.details}` : ""}` : "none"}`,
    ]);
  } else if (command === "edit") {
    const id = args[0];
    // PATCH needs both fields, so keep whichever one was not supplied.
    const current = opts.title === undefined || opts.body === undefined ? await findCard(origin, path, id) : {};
    const card = await request(origin, `${path}/cards/${id}`, "PATCH", { title: opts.title ?? current.title, body: opts.body ?? current.body ?? "" });
    print(card, opts.json, [cardLine(card)]);
  } else if (command === "close") {
    const card = await request(origin, `${path}/cards/${args[0]}/close`, "POST", {});
    print(card, opts.json, [cardLine(card)]);
  } else if (command === "archive" || command === "restore") {
    const cards = await request(origin, `${path}/cards/${command === "archive" ? "archive" : "unarchive"}`, "POST", { cardIds: args });
    print(cards, opts.json, cards.map(cardLine));
  } else if (command === "purge-attachments") {
    const purged = await request(origin, `${path}/cards/purge-attachments`, "POST", { cardIds: args });
    print(purged, opts.json, purged.map(item => `${item.cardId}\tpurged ${item.files} file${item.files === 1 ? "" : "s"}, ${item.bytes} bytes`));
  } else if (command === "stats") {
    const counts = Object.fromEntries(lanes.map(lane => [lane, board.cardCounts?.[lane] ?? 0]));
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const pickup = Object.fromEntries(["autoPickupEnabled", "pickupConcurrency", "pickupDailyLimit", "autoPickupStarts", "autoPickupNextAt", "cost24h", "pickupCostBudget", "autoPickupBudgetReached", "autoPickupError"]
      .filter(key => key in board).map(key => [key, board[key]]));
    print({ boardId: board.id, repo: board.repo, counts, total, pickup }, opts.json, [
      ...lanes.map(lane => `${lane}\t${counts[lane]}`), `total\t${total}`, pickupSummary(board),
    ]);
  } else if (command === "board") {
    const updated = opts.integration === undefined ? board : await request(origin, `${path}/settings`, "PATCH", { integration: opts.integration });
    print(updated, opts.json, [`${updated.id}\t${updated.repo}\tintegration:${updated.integration ?? "local"}${updated.remoteUrl ? `\tremote:${updated.remoteUrl}` : ""}${updated.integrationError ? `\terror:${updated.integrationError}` : ""}`]);
  } else if (command === "pr") {
    const card = args.length === 1 ? await findCard(origin, path, args[0])
      : await request(origin, `${path}/cards/${encodeURIComponent(args[0])}/pull-request`, "PUT", { url: args[1] === "off" ? "" : args[1] });
    print(card, opts.json, [`${card.id}\t${card.prUrl ?? "no pull request"}${card.prOverrideUrl ? "\t(linked)" : ""}${card.prState ? `\t${card.prState.toLowerCase()}` : ""}${card.prChecks ? `\tchecks:${card.prChecks}` : ""}${card.prError ? `\t${card.prError}` : ""}`]);
  } else if (command === "conflicts") {
    const conflicts = await request(origin, `${path}/conflicts`);
    print(conflicts, opts.json, conflicts.map(item => `${item.cardId}\t${item.details ?? ""}`));
  } else if (command === "pickup") {
    const summary = pickupSummary;
    if (!args.length) { print(board, opts.json, [summary(board)]); return; }
    if (args[0] === "reset") {
      if (opts.concurrency !== undefined || opts.limit !== undefined || opts.budget !== undefined) throw new Error("pickup reset does not accept --concurrency, --limit or --budget");
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
    const input = { autoPickupEnabled: args[0] === "on", pickupConcurrency: concurrency, pickupDailyLimit: limit };
    if (opts.budget !== undefined) {
      const budget = opts.budget === "off" ? null : Number(opts.budget.replace(/^\$/, ""));
      if (budget !== null && (!Number.isFinite(budget) || budget < 0.01 || budget > 10000)) throw new Error("Budget must be off or a USD amount from 0.01 to 10000");
      input.pickupCostBudget = budget;
    }
    const updated = await request(origin, `${path}/settings`, "PATCH", input);
    print(updated, opts.json, [summary(updated)]);
  }
}

main().catch(error => { console.error(`bakery-cli: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
