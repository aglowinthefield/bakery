import { isTheme, themeNames, type ThemeName } from "../src/themes.js";
import { command } from "./platform.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, closeSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { join, extname, isAbsolute, resolve, sep } from "node:path";
import { Board, parsePriority, type Card } from "./board.js";
import { buildStats } from "./stats.js";
import { Worker } from "./worker.js";
import { Integration, IntegrationConflictError, PushHookError } from "./integration.js";
import { OriginMain } from "./origin-main.js";
import { AutoReview } from "./auto-review.js";
import { AutoPickup } from "./auto-pickup.js";
import { discuss, discussionPrompt } from "./discuss.js";
import { Chats } from "./chat.js";
import { draftPullRequest } from "./pr-draft.js";
import { attachmentPath, attachmentsPrompt, removeAttachmentFiles, removeCardAttachmentFiles, safeFileName, storeUpload, sweepOrphanAttachments } from "./attachments.js";

/** One PR draft job per card, kept after it settles so a closed or refreshed dialog rejoins it instead of starting over. */
const draftJobs = new Map<string, { fingerprint: string; progress: { startedAt: number; steps: { at: number; text: string }[] }; result: Promise<unknown> }>();
import { PullRequestFeed } from "./pull-request-feed.js";
import { cardHistory } from "./card-history.js";
import { GitHub, GitHubSync, boardGithubRepo, detectGithubIntegration } from "./github.js";
import { acquireLock } from "./lock.js";
import { parseDiff } from "../src/diff-lines.js";
import { parseModelList, piModelArgs, validateAgentModels } from "./agent-models.js";
import { LogBuffer } from "./logs.js";
import { Updates, installScript, promoteStagedUi } from "./updates.js";

// The Logs view reads this process's console output from here.
const logs = new LogBuffer();
logs.captureConsole();

const dataDir = process.env.BAKERY_DATA_DIR ?? join(homedir(), ".local", "share", "bakery");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
// Exclusive ownership of the local board; a lock left by a dead server is taken over.
const lockPath = join(dataDir, "server.lock");
const lock = acquireLock(lockPath);
if (promoteStagedUi(process.cwd())) console.log("Serving the UI built by the last update.");
let board: Board;
try { board = new Board(join(dataDir, "bakery.sqlite")); board.recoverInterruptedRuns(); board.recoverAutoReviews(); sweepOrphanAttachments(dataDir, board.allAttachmentKeys()); }
catch (error) { closeSync(lock); unlinkSync(lockPath); throw error; }
const piBin = process.env.BAKERY_PI_BIN ?? "pi";
/** Cards whose discussion reply is being written; one at a time per card. */
const discussing = new Set<string>();
// Worktrunk hooks run in new card worktrees when `wt` is installed. Set BAKERY_WT_BIN="" to turn them off.
const port = Number(process.env.BAKERY_PORT ?? 4317);
const bindHost = process.env.BAKERY_HOST || "127.0.0.1";
// The chat agent drives the board through bakery-cli, so it needs an address this server answers on.
const cliHost = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
const chats = new Chats(board, {
  piBin, sessionDir: join(dataDir, "chat-sessions"), cli: `node ${join(import.meta.dirname, "..", "scripts", "bakery-cli.mjs")}`,
  env: { ...process.env, BAKERY_URL: `http://${cliHost.includes(":") ? `[${cliHost}]` : cliHost}:${port}`, BAKERY_ALLOW_REMOTE: "1" },
  models: repo => piModelArgs(board.agentModelFor(repo, "work")),
});
const worker = new Worker(board, dataDir, piBin, process.env.BAKERY_WT_BIN ?? "wt");
const integration = new Integration(board, dataDir);
const autoReview = new AutoReview(board, integration, piBin, card => worker.start(card, "manual", "to apply the agent reviewer's requested changes"));
// Local boards: whether each Done card's merge is on origin/main, read from the last fetch.
const originMain = new OriginMain(board);
const autoPickup = new AutoPickup(board, worker);
// Only a hosted server (npm start) updates itself. Under the dev supervisor the checkout is someone's working copy.
const updates = process.send ? null : new Updates(process.cwd(), installScript(process.cwd()), () => startDrain(() => shutdown("SIGTERM")));
let updateTimer: NodeJS.Timeout | undefined;
// github-pr boards: `gh` resolves from PATH unless BAKERY_GH_BIN names it. BAKERY_GITHUB_SYNC_MS sets the per-board interval.
const github = new GitHub(process.env.BAKERY_GH_BIN || "gh");
const pullFeed = new PullRequestFeed(board, github);
const githubSync = new GitHubSync(board, dataDir, github, process.env.BAKERY_WT_BIN ?? "wt", Number(process.env.BAKERY_GITHUB_SYNC_MS) || 60_000,
  card => worker.start(card, "manual", "to fix failing CI on the pull request"),
  card => sendBackRefusedPush(card, () => integration.openPullRequest(card, integration.review(card).fingerprint, github, undefined, true)));
/**
 * Runs a push. When the repository's pre-push hook refuses it, the hook's output goes back to the card's coding agent
 * as a new run, like failed CI, and the card (now running) is returned. At the run limit the output waits for a free
 * slot, and the push error says so. If the run cannot start for another reason, the push error stands.
 */
async function sendBackRefusedPush(card: Card, push: () => Promise<Card>): Promise<Card> {
  try {
    const pushed = await push();
    // Pushed after all (the operator fixed it by hand, say): an earlier refusal still waiting for a slot is stale.
    if (board.getCiFeedback(card.id)?.source === "push") board.clearCiFeedback(card.id);
    return pushed;
  }
  catch (error) {
    if (!(error instanceof PushHookError)) throw error;
    board.recordPushFailure(card.id, error.sha, error.output);
    const previous = board.listRuns(card.id)[0];
    let started: boolean;
    try { started = worker.startHookFix(board.getCard(card.id)!); }
    catch (startError) {
      throw new Error(`${error.message}\n\nBakery could not send it back to the agent: ${startError instanceof Error ? startError.message : String(startError)}`);
    }
    if (!started) {
      board.noteCard(card.id, "The pre-push hook refused the push. Its output goes to the agent once a run can start (the repository is at its run limit, or Bakery is restarting)");
      throw new Error(`${error.message}\n\nBakery cannot start a run yet (the repository is at its run limit, or Bakery is restarting), so it sends this to the agent as soon as one can start.`);
    }
    if (previous) board.append(previous.id, `\n[Bakery] The pre-push hook refused the push. Sent back to the agent with its output.\n`);
    return board.getCard(card.id)!;
  }
}
// Remote hosting: BAKERY_HOST sets the bind address; BAKERY_ALLOWED_HOSTS lists extra hostnames (no port) accepted in Host and Origin.
const extraHosts = (process.env.BAKERY_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
// Listing models can take seconds (Pi may refresh provider catalogs), so successes are cached
// and concurrent requests share one child. Failures are not cached; the UI just offers no suggestions.
let modelCache: { models: string[]; at: number } | undefined, modelRequest: Promise<{ models: string[]; error?: string }> | undefined;
function listModels(): Promise<{ models: string[]; error?: string }> {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000) return Promise.resolve({ models: modelCache.models });
  return modelRequest ??= new Promise<{ models: string[]; error?: string }>(resolve => {
    execFile(...command(piBin, ["--list-models"]), { timeout: 20_000, maxBuffer: 4_000_000, encoding: "utf8" }, (error, stdout) => {
      modelRequest = undefined;
      if (error) { resolve({ models: [], error: `Could not list Pi models: ${error.killed ? "timed out" : error.message.split("\n")[0].slice(0, 300)}` }); return; }
      modelCache = { models: parseModelList(stdout), at: Date.now() };
      resolve({ models: modelCache.models });
    });
  });
}
function send(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(payload));
}
async function body(req: IncomingMessage) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("Expected JSON");
  let text = "";
  for await (const chunk of req) { text += chunk; if (text.length > 32_000) throw new Error("Request too large"); }
  return JSON.parse(text || "{}") as Record<string, unknown>;
}
function fields(value: Record<string, unknown>) {
  const title = value.title, description = value.body;
  if (typeof title !== "string" || !title.trim() || title.length > 200 || typeof description !== "string" || description.length > 16000) throw new Error("Title and description are required");
  // Omitted priority keeps the card's current one on edit and means Normal on create.
  return { title: title.trim(), body: description, ...("priority" in value ? { priority: parsePriority(value.priority) } : {}) };
}
function idempotencyKey(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("Idempotency key must be 1 to 200 characters");
  return value;
}
function dependencyIds(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50 || !value.every(id => typeof id === "string" && /^[\w-]+$/.test(id))) throw new Error("dependsOn must be an array of card IDs");
  return value as string[];
}
function repoRoot(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Repository path is required");
  const input = value.trim();
  const path = input === "~" ? homedir() : /^~[\\/]/.test(input) ? join(homedir(), input.slice(2)) : input;
  if (!isAbsolute(path)) throw new Error("Repository path must be absolute or start with ~/");
  let root: string;
  try {
    root = realpathSync(path);
    const gitRoot = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (realpathSync(gitRoot) !== root) throw new Error("Not a Git repository root");
  } catch { throw new Error(`Repository path is not an existing Git repository root: ${input}`); }
  return root;
}
function extraOrigin(origin: string): boolean {
  try { const u = new URL(origin); return (u.protocol === "http:" || u.protocol === "https:") && extraHosts.includes(u.hostname.toLowerCase()); } catch { return false; }
}
const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host?.split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "bakery.localhost" && !extraHosts.includes(host?.toLowerCase() ?? "")) { send(res, 403, { error: "Local access only" }); return; }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin && !extraOrigin(origin) && !["http://127.0.0.1:5173", "http://localhost:5173", `http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://bakery.localhost:${port}`].includes(origin)) { send(res, 403, { error: "Origin rejected" }); return; }
    }
    if (path === "/api/status" && req.method === "GET") {
      // The cards behind the runs still going, so the update notice can say what it is waiting for.
      const cardIds = new Set<string>();
      if (draining.on) {
        for (const runId of worker.activeRunIds) { const run = board.getRun(runId); if (run) cardIds.add(run.cardId); }
        if (autoReview.activeCardId) cardIds.add(autoReview.activeCardId);
      }
      const cards = [...cardIds].flatMap(id => { const card = board.getCard(id); return card ? [{ id: card.id, title: card.title, repo: card.repo }] : []; });
      send(res, 200, { hostname: hostname().split(".")[0], draining: draining.on, activeRuns: worker.activeCount + (autoReview.active ? 1 : 0), cards, updates: updates?.state ?? null });
      return;
    }
    if (path === "/api/update" && req.method === "POST") {
      if (!updates) throw new Error("Only a server started with npm start installs updates");
      void updates.apply();
      send(res, 202, updates.state); return;
    }
    if (path === "/api/logs" && req.method === "GET") {
      const after = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("after") ?? 0);
      if (!Number.isInteger(after) || after < 0) throw new Error("after must be a whole number");
      send(res, 200, { startedAt: logs.startedAt, entries: logs.since(after) }); return;
    }
    if (path === "/api/settings" && req.method === "GET") { send(res, 200, board.getSettings()); return; }
    if (path === "/api/settings" && req.method === "PATCH") {
      const input = await body(req);
      if (!("confirmRunStart" in input) && !("notifyOnReview" in input) && !("cardDetailsLayout" in input) && !("theme" in input) && !("density" in input) && !("showCardModels" in input) && !("agentModels" in input)) throw new Error("Specify a setting to update");
      if ("confirmRunStart" in input && typeof input.confirmRunStart !== "boolean") throw new Error("confirmRunStart must be a boolean");
      if ("notifyOnReview" in input && typeof input.notifyOnReview !== "boolean") throw new Error("notifyOnReview must be a boolean");
      if ("cardDetailsLayout" in input && input.cardDetailsLayout !== "dialog" && input.cardDetailsLayout !== "side") throw new Error("cardDetailsLayout must be dialog or side");
      if ("theme" in input && !isTheme(input.theme)) throw new Error(`theme must be one of: ${themeNames.join(", ")}`);
      if ("density" in input && input.density !== "compact" && input.density !== "default" && input.density !== "cozy") throw new Error("density must be compact, default, or cozy");
      if ("showCardModels" in input && typeof input.showCardModels !== "boolean") throw new Error("showCardModels must be a boolean");
      send(res, 200, board.updateSettings({
        confirmRunStart: "confirmRunStart" in input ? input.confirmRunStart as boolean : undefined,
        notifyOnReview: "notifyOnReview" in input ? input.notifyOnReview as boolean : undefined,
        cardDetailsLayout: "cardDetailsLayout" in input ? input.cardDetailsLayout as "dialog" | "side" : undefined,
        theme: "theme" in input ? input.theme as ThemeName : undefined,
        density: "density" in input ? input.density as "compact" | "default" | "cozy" : undefined,
        showCardModels: "showCardModels" in input ? input.showCardModels as boolean : undefined,
        agentModels: "agentModels" in input ? validateAgentModels(input.agentModels) : undefined,
      })); return;
    }
    if (path === "/api/models" && req.method === "GET") { send(res, 200, await listModels()); return; }
    if (path === "/api/path-suggestions" && req.method === "GET") {
      const input = new URL(req.url ?? "/", "http://localhost").searchParams.get("path") ?? "";
      if (input.length > 1024) throw new Error("Path is too long");
      if (!/^(\/|~[\\/]|[A-Za-z]:[\\/])/.test(input)) { send(res, 200, []); return; }
      const slash = Math.max(input.lastIndexOf("/"), process.platform === "win32" ? input.lastIndexOf("\\") : -1);
      const separator = input[slash];
      const parent = input.slice(0, slash + 1);
      const prefix = input.slice(slash + 1);
      const directory = /^~[\\/]/.test(parent) ? join(homedir(), parent.slice(2)) : parent;
      let suggestions: string[] = [];
      try {
        suggestions = readdirSync(directory, { withFileTypes: true })
          .filter(entry => {
            if (!entry.name.startsWith(prefix) || (!prefix.startsWith(".") && entry.name.startsWith("."))) return false;
            if (entry.isDirectory()) return true;
            try { return entry.isSymbolicLink() && statSync(join(directory, entry.name)).isDirectory(); }
            catch { return false; }
          })
          .map(entry => parent + entry.name + separator)
          .sort((a, b) => a.localeCompare(b))
          .slice(0, 20);
      } catch { /* Missing or unreadable directories have no suggestions. */ }
      send(res, 200, suggestions); return;
    }
    if (path === "/api/repository-root" && req.method === "GET") {
      send(res, 200, { root: repoRoot(new URL(req.url ?? "/", "http://localhost").searchParams.get("path")) }); return;
    }
    if (path === "/api/boards" && req.method === "GET") { const counts = board.cardCounts(); send(res, 200, board.listBoards().map(item => ({ ...item, cardCounts: counts[item.repo] ?? {} }))); return; }
    if (path === "/api/cards" && req.method === "GET") {
      // Every visible board's cards, for the Today view. Removed boards and archived cards stay out.
      const repos = new Set(board.listBoards().map(item => item.repo));
      send(res, 200, worker.withLive(board.listCards().filter(card => repos.has(card.repo) && card.status !== "archived"))); return;
    }
    if (path === "/api/stats" && req.method === "GET") {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const range = params.get("days") ?? "30";
      const days = range === "all" ? null : Number(range);
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new Error("days must be a whole number from 1 to 3650, or all");
      const repo = params.get("repo");
      const visible = new Set(board.listBoards().map(item => item.repo));
      if (repo && !visible.has(repo)) { send(res, 404, { error: "Board not found" }); return; }
      const input = board.statsInput();
      // Removed boards stay out, like the Today view.
      send(res, 200, buildStats({ runs: input.runs.filter(item => visible.has(item.repo)), reviews: input.reviews.filter(item => visible.has(item.repo)), cards: input.cards.filter(item => visible.has(item.repo)) }, { days, repo })); return;
    }
    if (path === "/api/boards" && req.method === "POST") {
      const root = repoRoot((await body(req)).repo);
      if (board.listBoards().some(item => item.repo === root)) throw new Error("Repository already has a board");
      const added = board.addRepo(root);
      send(res, 201, (await detectGithubIntegration(board, added.id, github, true)) ?? added); return;
    }
    const boardRoute = path.match(/^\/api\/boards\/([\w-]+)$/);
    if (boardRoute) {
      const item = board.getBoard(boardRoute[1]);
      if (!item) { send(res, 404, { error: "Board not found" }); return; }
      if (req.method === "PATCH") { send(res, 200, board.renameBoard(item.id, repoRoot((await body(req)).repo))); return; }
      if (req.method === "DELETE") { board.archiveBoard(item.id); send(res, 200, { ok: true }); return; }
    }
    const pullMergeRoute = path.match(/^\/api\/boards\/([\w-]+)\/pull-requests\/(\d{1,9})\/merge$/);
    if (pullMergeRoute && req.method === "POST") {
      const repoBoard = board.getBoard(pullMergeRoute[1]);
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      // Trunk's merge queue is driven by this comment.
      await github.comment(boardGithubRepo(repoBoard), Number(pullMergeRoute[2]), "/trunk merge");
      send(res, 200, { ok: true }); return;
    }
    const pullsRoute = path.match(/^\/api\/boards\/([\w-]+)\/pull-requests$/);
    if (pullsRoute && req.method === "GET") {
      const repoBoard = board.getBoard(pullsRoute[1]);
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      // Served from the background feed; only the first view of a repository waits for GitHub.
      const stored = pullFeed.get(repoBoard.id);
      if (!stored) await pullFeed.refresh(repoBoard.id);
      else if (Date.now() - stored.at > 15_000) void pullFeed.refresh(repoBoard.id).catch(() => {});
      const pulls = pullFeed.get(repoBoard.id)?.pulls ?? [];
      // Each PR carries the card it belongs to, so the page can link back to the board.
      const cards = board.listCards(repoBoard.repo).filter(card => card.prNumber && card.status !== "archived");
      send(res, 200, pulls.map(pr => {
        const card = cards.find(item => item.prNumber === pr.number);
        return { ...pr, card: card ? { id: card.id, title: card.title, status: card.status, prChecks: card.prChecks ?? null } : null };
      })); return;
    }
    const pickupResetRoute = path.match(/^\/api\/boards\/([\w-]+)\/auto-pickup\/reset-limit$/);
    if (pickupResetRoute && req.method === "POST") {
      const repoBoard = board.getBoard(pickupResetRoute[1]);
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      send(res, 200, board.resetAutoPickupLimit(repoBoard.id)); return;
    }
    const syncRoute = path.match(/^\/api\/boards\/([\w-]+)\/sync$/);
    if (syncRoute && req.method === "POST") {
      const repoBoard = board.getBoard(syncRoute[1]);
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      if (repoBoard.integration !== "github-pr") { send(res, 400, { error: "Only pull-request boards sync with GitHub" }); return; }
      await githubSync.syncBoard(repoBoard.id);
      send(res, 200, board.getBoard(repoBoard.id)); return;
    }
    const settingsRoute = path.match(/^\/api\/boards\/([\w-]+)\/settings$/);
    if (settingsRoute && req.method === "PATCH") {
      const repoBoard = board.getBoard(settingsRoute[1]);
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      const input = await body(req);
      if ("icon" in input || "color" in input) {
        if (Object.keys(input).some(key => key !== "icon" && key !== "color")) throw new Error("Update appearance separately from other board settings");
        if (typeof input.icon !== "string" || typeof input.color !== "string") throw new Error("Specify icon and color together");
        send(res, 200, board.setAppearance(repoBoard.id, input.icon, input.color)); return;
      }
      if ("agentModels" in input) {
        if (Object.keys(input).length !== 1) throw new Error("Update agentModels separately from other board settings");
        send(res, 200, board.setAgentModels(repoBoard.id, input.agentModels)); return;
      }
      if ("integration" in input) {
        if (Object.keys(input).length !== 1) throw new Error("Update integration separately from other board settings");
        const updated = board.setIntegration(repoBoard.id, input.integration);
        if (updated.integration === "github-pr") void githubSync.syncBoard(updated.id);
        send(res, 200, updated); return;
      }
      if ("remoteUrl" in input) {
        if (Object.keys(input).length !== 1 || typeof input.remoteUrl !== "string") throw new Error("Update remoteUrl as a string, separately from other board settings");
        const updated = board.setRemoteUrl(repoBoard.id, input.remoteUrl);
        // A new GitHub remote picks the integration mode from whether its main only accepts pull requests.
        const detected = updated.githubMainProtected === null ? await detectGithubIntegration(board, updated.id, github, true) : updated;
        if (detected?.integration === "github-pr" && repoBoard.integration !== "github-pr") void githubSync.syncBoard(updated.id);
        send(res, 200, detected ?? updated); return;
      }
      if ("autoPickupEnabled" in input || "pickupConcurrency" in input || "pickupDailyLimit" in input || "pickupCostBudget" in input) {
        if (typeof input.autoPickupEnabled !== "boolean" || !Number.isSafeInteger(input.pickupConcurrency) ||
          ("pickupDailyLimit" in input && !Number.isSafeInteger(input.pickupDailyLimit)) ||
          ("pickupCostBudget" in input && input.pickupCostBudget !== null && typeof input.pickupCostBudget !== "number"))
          throw new Error("Specify autoPickupEnabled and pickupConcurrency together, with an optional integer pickupDailyLimit and an optional pickupCostBudget (USD or null for off)");
        send(res, 200, board.setAutoPickup(repoBoard.id, input.autoPickupEnabled, Number(input.pickupConcurrency),
          "pickupDailyLimit" in input ? Number(input.pickupDailyLimit) : undefined,
          "pickupCostBudget" in input ? input.pickupCostBudget as number | null : undefined)); return;
      }
      if ("pushMainAfterMerge" in input) {
        if (Object.keys(input).length !== 1 || typeof input.pushMainAfterMerge !== "boolean") throw new Error("Update pushMainAfterMerge as a boolean, separately from other board settings");
        send(res, 200, board.setPushMainAfterMerge(repoBoard.id, input.pushMainAfterMerge)); return;
      }
      if ("autoReviewMergeLimit" in input) {
        if (Object.keys(input).length !== 1 || !Number.isSafeInteger(input.autoReviewMergeLimit)) throw new Error("Update autoReviewMergeLimit as an integer (0 for no limit), separately from other board settings");
        send(res, 200, board.setAutoReviewMergeLimit(repoBoard.id, Number(input.autoReviewMergeLimit))); return;
      }
      if ("autoReviewEnabled" in input || "verificationCommand" in input) {
        if (typeof input.autoReviewEnabled !== "boolean" || typeof input.verificationCommand !== "string") throw new Error("Specify autoReviewEnabled and verificationCommand together");
        send(res, 200, board.setAutoReview(repoBoard.id, input.autoReviewEnabled, input.verificationCommand)); return;
      }
      if (typeof input.autoCollapseEmptySwimlanes !== "boolean") throw new Error("Auto collapse empty swimlanes must be a boolean");
      send(res, 200, board.setAutoCollapseEmptySwimlanes(repoBoard.id, input.autoCollapseEmptySwimlanes)); return;
    }
    // Done cards Bakery merged into local main whose work is not on origin/main, offered as "Publish as PR".
    const localMergesRoute = path.match(/^\/api\/boards\/([\w-]+)\/local-merges$/);
    if (localMergesRoute && req.method === "GET") {
      const repoBoard = board.getBoard(localMergesRoute[1]);
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      send(res, 200, await integration.localMerges(repoBoard.repo)); return;
    }
    const mainResetRoute = path.match(/^\/api\/boards\/([\w-]+)\/main\/reset$/);
    if (mainResetRoute && req.method === "POST") {
      const repoBoard = board.getBoard(mainResetRoute[1]);
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      const { tip } = await body(req);
      if (typeof tip !== "string" || !/^[a-f0-9]{40,64}$/.test(tip)) throw new Error("Confirm the local main commit to reset (tip)");
      const main = await integration.resetLocalMain(repoBoard.repo, tip);
      if (repoBoard.integration === "github-pr") void githubSync.syncBoard(repoBoard.id);
      send(res, 200, { main }); return;
    }
    const conflictsRoute = path.match(/^\/api\/boards\/([\w-]+)\/conflicts$/);
    if (conflictsRoute && req.method === "GET") {
      const repoBoard = board.getBoard(conflictsRoute[1]);
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      send(res, 200, board.listMergeFailures(repoBoard.repo)); return;
    }
    // Attachments stream as the raw request body (name in ?name=, type in Content-Type), never through JSON.
    const attachmentRoute = path.match(/^\/api\/boards\/([\w-]+)\/cards\/([\w-]+)\/attachments(?:\/([\w-]+))?$/);
    if (attachmentRoute) {
      const repoBoard = board.getBoard(attachmentRoute[1]), card = board.getCard(attachmentRoute[2]);
      if (!repoBoard || card?.repo !== repoBoard.repo) { send(res, 404, { error: "Card not found on this board" }); return; }
      const attachmentId = attachmentRoute[3];
      if (!attachmentId && req.method === "GET") { send(res, 200, board.listAttachments(card.id)); return; }
      if (!attachmentId && req.method === "POST") {
        const name = new URL(req.url ?? "/", "http://localhost").searchParams.get("name") ?? "";
        if (!name.trim() || name.length > 255) throw new Error("Name the file with ?name= (up to 255 characters)");
        const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() || "application/octet-stream";
        if (!/^[\w.+-]+\/[\w.+-]+$/.test(type)) throw new Error("Content-Type must be a media type such as image/png");
        const id = randomUUID(), cleanName = safeFileName(name);
        const size = await storeUpload(req, attachmentPath(dataDir, { cardId: card.id, id, name: cleanName }));
        try { send(res, 201, board.addAttachment({ id, cardId: card.id, name: cleanName, type, size })); }
        catch (error) { removeAttachmentFiles(dataDir, { cardId: card.id, id }); throw error; }
        return;
      }
      const attachment = attachmentId ? board.getAttachment(card.id, attachmentId) : undefined;
      if (!attachment) { send(res, 404, { error: "Attachment not found" }); return; }
      if (req.method === "GET") {
        const file = attachmentPath(dataDir, attachment);
        if (!existsSync(file)) { send(res, 404, { error: "The attachment's file is missing from disk" }); return; }
        // Only raster images render inline; anything else (SVG, HTML) downloads so an upload cannot run script on this origin.
        const inline = /^image\/(png|jpeg|gif|webp)$/.test(attachment.type);
        res.writeHead(200, { "Content-Type": inline ? attachment.type : "application/octet-stream", "Content-Length": attachment.size, "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox" });
        createReadStream(file).on("error", () => res.destroy()).pipe(res);
        return;
      }
      if (req.method === "DELETE") { board.deleteAttachment(card.id, attachment.id); removeAttachmentFiles(dataDir, attachment); send(res, 200, { ok: true }); return; }
    }
    const commentRoute = path.match(/^\/api\/boards\/([\w-]+)\/cards\/([\w-]+)\/comments\/([\w-]+)$/);
    if (commentRoute && req.method === "DELETE") {
      const repoBoard = board.getBoard(commentRoute[1]), card = board.getCard(commentRoute[2]);
      if (!repoBoard || card?.repo !== repoBoard.repo) { send(res, 404, { error: "Card not found on this board" }); return; }
      board.deleteReviewComment(card.id, commentRoute[3]); send(res, 200, { ok: true }); return;
    }
    const dependencyRoute = path.match(/^\/api\/boards\/([\w-]+)\/cards\/([\w-]+)\/dependencies\/([\w-]+)$/);
    if (dependencyRoute && req.method === "DELETE") {
      const repoBoard = board.getBoard(dependencyRoute[1]), card = board.getCard(dependencyRoute[2]);
      if (!repoBoard || card?.repo !== repoBoard.repo) { send(res, 404, { error: "Card not found on this board" }); return; }
      send(res, 200, board.removeDependency(card.id, dependencyRoute[3])); return;
    }
    const archiveRoute = path.match(/^\/api\/boards\/([\w-]+)\/cards\/(archive|unarchive)$/);
    if (archiveRoute && req.method === "POST") {
      const repoBoard = board.getBoard(archiveRoute[1]);
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      const { cardIds } = await body(req);
      if (!Array.isArray(cardIds) || !cardIds.every(id => typeof id === "string")) throw new Error("cardIds must be an array of card IDs");
      send(res, 200, board.setArchived(repoBoard.repo, cardIds as string[], archiveRoute[2] === "archive")); return;
    }
    const purgeRoute = path.match(/^\/api\/boards\/([\w-]+)\/cards\/purge-attachments$/);
    if (purgeRoute && req.method === "POST") {
      const repoBoard = board.getBoard(purgeRoute[1]);
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      const { cardIds } = await body(req);
      if (!Array.isArray(cardIds) || !cardIds.every(id => typeof id === "string")) throw new Error("cardIds must be an array of card IDs");
      const purged = board.purgeAttachments(repoBoard.repo, cardIds as string[]);
      for (const item of purged) removeCardAttachmentFiles(dataDir, item.cardId);
      send(res, 200, purged); return;
    }
    const chatRoute = path.match(/^\/api\/boards\/([\w-]+)\/chats(?:\/([\w-]+)(?:\/(messages|stop|events))?)?$/);
    if (chatRoute) {
      const repoBoard = board.getBoard(chatRoute[1]), chatId = chatRoute[2], action = chatRoute[3];
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      if (!chatId) {
        if (req.method === "GET") { send(res, 200, board.listChats(repoBoard.id).map(chat => ({ ...chat, pending: chats.live(chat.id) !== null }))); return; }
        if (req.method === "POST") { send(res, 201, board.createChat(repoBoard.id)); return; }
      } else {
        const chat = board.getChat(chatId);
        if (!chat || chat.boardId !== repoBoard.id) { send(res, 404, { error: "Chat not found on this board" }); return; }
        if (req.method === "GET" && !action) { send(res, 200, { chat, messages: board.listChatMessages(chatId), live: chats.live(chatId) }); return; }
        if (req.method === "DELETE" && !action) { chats.delete(chatId); send(res, 200, { ok: true }); return; }
        if (req.method === "POST" && action === "messages") {
          const { message } = await body(req);
          if (typeof message !== "string" || !message.trim() || message.length > 16000) throw new Error("Write a message of up to 16000 characters");
          send(res, 202, chats.send(repoBoard, chatId, message.trim())); return;
        }
        if (req.method === "POST" && action === "stop") { chats.stop(chatId); send(res, 200, { ok: true }); return; }
        // Server-sent events: the live reply as it is written, and each message once saved.
        if (req.method === "GET" && action === "events") {
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
          const write = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
          write({ type: "live", live: chats.live(chatId) });
          const unsubscribe = chats.subscribe(chatId, write), ping = setInterval(() => res.write(": ping\n\n"), 20_000);
          req.once("close", () => { unsubscribe(); clearInterval(ping); });
          return;
        }
      }
    }
    const route = path.match(/^\/api\/boards\/([\w-]+)\/cards(?:\/([\w-]+)(?:\/(start|status|runs|resolve|stop|review|approve|approval|withdraw|conflict|comments|request-changes|auto-review|push-progress|dependencies|pull-request|publish|pr-draft|accept-findings|create-plan|close|discussion|history))?)?$/);
    if (route) {
      const repoBoard = board.getBoard(route[1]), id = route[2], action = route[3];
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      if (!id) {
        if (req.method === "GET") { send(res, 200, worker.withLive(originMain.annotate(repoBoard, board.listCards(repoBoard.repo)))); return; }
        if (req.method === "POST") {
          const input = await body(req), card = fields(input), key = idempotencyKey(input.idempotencyKey);
          // A repeated key returns the board's existing card unchanged, whatever its status.
          const existing = key === null ? undefined : board.getCardByIdempotencyKey(repoBoard.repo, key);
          if (existing) { send(res, 200, existing); return; }
          send(res, 201, board.createCard({ ...card, repo: repoBoard.repo, idempotencyKey: key, dependsOn: dependencyIds(input.dependsOn) })); return;
        }
      } else {
        const item = board.getCard(id);
        if (!item || item.repo !== repoBoard.repo) { send(res, 404, { error: "Card not found on this board" }); return; }
        if (req.method === "GET" && action === "runs") { send(res, 200, board.listRuns(id)); return; }
        if (req.method === "GET" && action === "auto-review") { send(res, 200, board.listAutoReviewJobs(id)); return; }
        if (req.method === "GET" && action === "history") { send(res, 200, cardHistory(item, board.listCardEvents(id), board.listRuns(id), board.listAutoReviewJobs(id))); return; }
        if (req.method === "GET" && action === "push-progress") { send(res, 200, integration.pushProgress(id)); return; }
        if (req.method === "GET" && action === "approval") { send(res, 200, { pending: !!board.getApproval(id) }); return; }
        if (req.method === "GET" && action === "review") {
          if (new URL(req.url ?? "/", "http://localhost").searchParams.has("fingerprint")) { send(res, 200, { fingerprint: integration.reviewFingerprint(item) }); return; }
          send(res, 200, integration.review(item)); return;
        }
        if (req.method === "GET" && action === "dependencies") { send(res, 200, board.listDependencies(id)); return; }
        if (req.method === "POST" && action === "dependencies") {
          const { dependsOn } = await body(req);
          if (typeof dependsOn !== "string" || !/^[\w-]+$/.test(dependsOn)) throw new Error("dependsOn must be a card ID");
          send(res, 200, board.addDependency(id, dependsOn)); return;
        }
        if (req.method === "GET" && action === "discussion") { send(res, 200, { messages: board.listDiscussion(id), pending: discussing.has(id) }); return; }
        if (req.method === "POST" && action === "discussion") {
          const { message, attachmentIds = [] } = await body(req);
          if (!Array.isArray(attachmentIds) || attachmentIds.length > 50 || !attachmentIds.every(value => typeof value === "string" && /^[\w-]+$/.test(value))) throw new Error("attachmentIds must be an array of attachment IDs");
          if (typeof message !== "string" || (!message.trim() && !attachmentIds.length) || message.length > 4000) throw new Error("Write a message of up to 4000 characters, or attach a file");
          if (discussing.has(id)) throw new Error("The agent is still answering the previous message");
          const history = board.listDiscussion(id), run = board.listRuns(id)[0];
          const saved = board.addDiscussionMessage(id, "user", message.trim(), attachmentIds as string[]);
          const files = attachmentsPrompt(dataDir, board.listAttachments(id));
          discussing.add(id);
          void discuss({ prompt: discussionPrompt(item, run, history, message.trim() || "(see the attached files)", files), cwd: run?.worktree ?? item.repo, piBin, models: piModelArgs(board.agentModelFor(item.repo, "work")) })
            .then(reply => board.addDiscussionMessage(id, "agent", reply), error => board.addDiscussionMessage(id, "error", error instanceof Error ? error.message : String(error)))
            .finally(() => discussing.delete(id));
          send(res, 202, saved); return;
        }
        if (req.method === "GET" && action === "comments") { send(res, 200, board.listReviewComments(id)); return; }
        if (req.method === "POST" && action === "comments") {
          const input = await body(req);
          if (typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint) ||
            typeof input.path !== "string" || !Number.isSafeInteger(input.line) || typeof input.body !== "string" ||
            !input.body.trim() || input.body.length > 1000) throw new Error("Invalid review comment");
          const diff = integration.review(item);
          if (diff.fingerprint !== input.fingerprint) throw new Error("Work changed since review; refresh the diff before commenting");
          if (input.path === "") { send(res, 201, board.addReviewComment(id, board.listRuns(id)[0].id, diff.fingerprint, "", 0, "context", "", input.body)); return; }
          const line = parseDiff(diff.files.find(file => file.path === input.path)?.patch ?? "")[Number(input.line) - 1];
          if (!line || line.kind === "meta") throw new Error("Comment on a code line in the current diff");
          const run = board.listRuns(id)[0];
          send(res, 201, board.addReviewComment(id, run.id, diff.fingerprint, input.path, Number(input.line), line.kind, line.code, input.body, line.newLine ?? line.oldLine ?? null)); return;
        }
        if (req.method === "POST" && action === "request-changes") {
          const { fingerprint } = await body(req);
          if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Open the review diff before requesting changes");
          const diff = integration.review(item);
          if (diff.fingerprint !== fingerprint) throw new Error("Work changed since review; refresh the diff before requesting changes");
          send(res, 200, board.requestChanges(id, board.listRuns(id)[0].id, fingerprint)); return;
        }
        if (req.method === "DELETE" && action === "conflict") { board.clearMergeFailure(id); send(res, 200, { ok: true }); return; }
        if (req.method === "PATCH" && !action) { send(res, 200, board.updateCard(id, { ...fields(await body(req)), repo: repoBoard.repo })); return; }
        if (req.method === "POST" && action === "start") {
          if (item.reviewWait === "github") throw new Error("Waiting on GitHub CI; run again once the checks finish");
          // During a restart drain, remember the start and replay it once the new server is up.
          if (draining.on) { board.queueStart(id); send(res, 202, { queued: true, cardId: id }); return; }
          send(res, 202, worker.start(item)); return;
        }
        if (req.method === "DELETE" && action === "start") { send(res, 200, { cancelled: board.cancelQueuedStart(id) }); return; }
        if (req.method === "GET" && action === "pr-draft") { const job = draftJobs.get(id); send(res, 200, { ...(job?.progress ?? { startedAt: 0, steps: [] }), fingerprint: job?.fingerprint ?? null }); return; }
        if (req.method === "POST" && action === "pr-draft") {
          const { fingerprint } = await body(req);
          if (repoBoard.integration !== "github-pr") throw new Error("This board merges locally; it opens no pull request");
          const diff = integration.review(item), run = board.listRuns(id)[0];
          if (typeof fingerprint !== "string" || diff.fingerprint !== fingerprint) throw new Error("Work changed since review; refresh the diff before approving");
          let job = draftJobs.get(id);
          if (!job || job.fingerprint !== fingerprint) {
            const patch = diff.files.map(file => `File: ${file.path}\n${file.patch}`).join("\n");
            const progress = { startedAt: Date.now(), steps: [] as { at: number; text: string }[] };
            const onProgress = (text: string) => { progress.steps.push({ at: Date.now(), text }); if (progress.steps.length > 200) progress.steps.shift(); };
            const result = draftPullRequest({ card: item, run, worktree: run.worktree!, patch, piBin, models: piModelArgs(board.agentModelFor(item.repo, "draft")), onProgress });
            job = { fingerprint, progress, result };
            draftJobs.set(id, job);
            const started = job;
            result.catch(() => { if (draftJobs.get(id) === started) draftJobs.delete(id); });
          }
          send(res, 200, await job.result); return;
        }
        if (req.method === "POST" && action === "approve") {
          const { fingerprint, title, body: prBody } = await body(req);
          if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Open the review diff before approving");
          if (repoBoard.integration === "github-pr") {
            if ((title !== undefined || prBody !== undefined) && (typeof title !== "string" || !title.trim() || title.length > 250 || typeof prBody !== "string" || prBody.length > 20_000))
              throw new Error("Pull request title (up to 250 characters) and body (up to 20,000) are required");
            const card = await sendBackRefusedPush(item, () => integration.openPullRequest(item, fingerprint, github, typeof title === "string" ? { title, body: prBody as string } : undefined));
            draftJobs.delete(id);
            void githubSync.syncBoard(repoBoard.id);
            send(res, 200, card); return;
          }
          send(res, 200, integration.approve(item, fingerprint)); return;
        }
        if (req.method === "POST" && action === "create-plan") { send(res, 201, board.createPlanCards(id)); return; }
        if (req.method === "POST" && action === "accept-findings") {
          const { fingerprint } = await body(req);
          if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Open the review before accepting findings");
          send(res, 200, integration.acceptFindings(item, fingerprint)); return;
        }
        if (req.method === "POST" && action === "publish") {
          const result = await integration.publishLocalMerge(item, github);
          void githubSync.syncBoard(repoBoard.id);
          send(res, 200, result); return;
        }
        if (req.method === "PUT" && action === "pull-request") {
          const { url } = await body(req);
          if (typeof url !== "string") throw new Error("url must be a pull request link, or empty to use the bakery/<card> branch");
          const card = board.setPullRequestOverride(id, url);
          if (repoBoard.integration === "github-pr") void githubSync.syncBoard(repoBoard.id);
          send(res, 200, card); return;
        }
        if (req.method === "POST" && action === "withdraw") { send(res, 200, integration.withdraw(item)); return; }
        if (req.method === "POST" && action === "resolve") {
          if ((await body(req)).acknowledged !== true) throw new Error("Confirm that you inspected the interrupted worktree");
          send(res, 200, board.resolveInterrupted(id)); return;
        }
        if (req.method === "POST" && action === "close") { send(res, 200, board.closeReview(id)); return; }
        if (req.method === "POST" && action === "status") {
          const { status } = await body(req);
          if (status !== "triage" && status !== "ready" && status !== "done") throw new Error("Status must be triage, ready, or done");
          send(res, 200, board.setStatus(id, status)); return;
        }
        if (req.method === "POST" && action === "stop") {
          const run = board.listRuns(id)[0];
          if (!run) throw new Error("No run to stop");
          worker.stop(run.id); send(res, 202, { ok: true }); return;
        }
      }
    }
    if (path.startsWith("/api/")) { send(res, 404, { error: "Not found" }); return; }
    if (req.method !== "GET") { send(res, 405, { error: "Method not allowed" }); return; }
    // Dev runs the UI on Vite (5173); a built dist here goes stale and looks like the app. Serve it only on request.
    if (process.env.BAKERY_SERVE_UI !== "1") { send(res, 404, { error: "This is the Bakery API. Open the UI on http://127.0.0.1:5173, or set BAKERY_SERVE_UI=1 to serve the built dist here." }); return; }
    const dist = resolve("dist");
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    const target = file.startsWith(dist + sep) && existsSync(file) ? file : join(dist, "index.html");
    if (!existsSync(target)) { send(res, 404, { error: "Run npm run dev or npm run build" }); return; }
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    res.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    res.end(readFileSync(target));
  } catch (error) {
    if (error instanceof IntegrationConflictError) {
      send(res, 409, { code: error.code, error: error.message, cardId: error.cardId, files: error.files, details: error.details });
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = /not found/i.test(message) ? 404 : 400;
    console.debug(`${req.method} ${req.url} -> ${status}: ${message}`);
    send(res, status, { error: message });
  }
});
server.on("error", (error) => { board.close(); closeSync(lock); unlinkSync(lockPath); console.error(error); process.exitCode = 1; });
server.listen(port, bindHost, () => { console.log(`Bakery listening on http://${bindHost}:${port}`); process.send?.({ type: "listening" }); autoReview.start(); autoPickup.start(); githubSync.start(); pullFeed.start();
  if (updates) {
    updates.refresh();
    updateTimer = setInterval(() => updates.refresh(), 30_000);
  }
  // Starts queued while the previous server drained for a restart.
  for (const cardId of board.takeQueuedStarts()) {
    const card = board.getCard(cardId);
    if (!card || ["triage", "running", "done", "archived"].includes(card.status)) continue;
    try { worker.start(card, "manual", "from a start queued during the last restart"); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      board.noteCard(cardId, `A start queued during the last restart could not run: ${message}`);
      console.error(`Queued start for card ${cardId} failed: ${message}`);
    }
  }
  // Boards whose GitHub main was never checked (added before this check existed, or gh was unavailable) are checked
  // once per start. This only records protection, which stops local Approve; it never changes a board's mode.
  for (const item of board.listBoards().filter(item => item.githubMainProtected === null && item.remoteUrl))
    void detectGithubIntegration(board, item.id, github, false).catch(error => console.error(`GitHub main check for ${item.repo}: ${error}`));
});
// Set once the dev supervisor asks for a drain. /api/status reports it so the UI can say a restart is coming.
const draining = { on: false };
const shutdown = (signal: "SIGINT" | "SIGTERM") => { server.close(); clearInterval(updateTimer); autoPickup.shutdown(); githubSync.shutdown(); pullFeed.shutdown(); chats.shutdown(); void Promise.all([worker.shutdown(`server received ${signal}`), autoReview.shutdown()]).then(() => { board.close(); closeSync(lock); unlinkSync(lockPath); if (process.connected) process.disconnect(); }); };
// The dev supervisor (scripts/dev-server.mjs) asks for a drain before reloading code, so
// integrating one card into this checkout does not kill other cards' Pi runs.
const startDrain = (onDrained: () => void) => {
  if (draining.on) return;
  draining.on = true;
  autoPickup.shutdown();
  // Agent reviews count too: a restart would kill the reviewer mid-review.
  process.send?.({ type: "draining", activeRuns: worker.activeCount + (autoReview.active ? 1 : 0) });
  void Promise.all([worker.drain(), autoReview.drain()]).then(onDrained);
};
process.on("message", (message: unknown) => {
  if ((message as { type?: unknown } | null)?.type !== "drain") return;
  startDrain(() => process.send?.({ type: "drained" }));
});
// Without the supervisor (npm start under systemd), SIGUSR2 drains and then exits so the service manager restarts
// the server with whatever is on disk. scripts/update.sh sends it after pulling.
process.on("SIGUSR2", () => { console.log("Update requested: draining active runs, then exiting."); startDrain(() => shutdown("SIGTERM")); });
process.once("SIGINT", () => shutdown("SIGINT")); process.once("SIGTERM", () => shutdown("SIGTERM"));
