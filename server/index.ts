import { isTheme, themeNames, type ThemeName } from "../src/themes.js";
import { command } from "./platform.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, closeSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, extname, isAbsolute, resolve, sep } from "node:path";
import { Board, parsePriority } from "./board.js";
import { buildStats } from "./stats.js";
import { Worker } from "./worker.js";
import { Integration, IntegrationConflictError } from "./integration.js";
import { OriginMain } from "./origin-main.js";
import { AutoReview } from "./auto-review.js";
import { AutoPickup } from "./auto-pickup.js";
import { draftPullRequest } from "./pr-draft.js";
import { PullRequestFeed } from "./pull-request-feed.js";
import { GitHub, GitHubSync, boardGithubRepo, detectGithubIntegration } from "./github.js";
import { acquireLock } from "./lock.js";
import { parseDiff } from "../src/diff-lines.js";
import { parseModelList, piModelArgs, validateAgentModels } from "./agent-models.js";

const dataDir = process.env.BAKERY_DATA_DIR ?? join(homedir(), ".local", "share", "bakery");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
// Exclusive ownership of the local board; a lock left by a dead server is taken over.
const lockPath = join(dataDir, "server.lock");
const lock = acquireLock(lockPath);
let board: Board;
try { board = new Board(join(dataDir, "bakery.sqlite")); board.recoverInterruptedRuns(); board.recoverAutoReviews(); }
catch (error) { closeSync(lock); unlinkSync(lockPath); throw error; }
const piBin = process.env.BAKERY_PI_BIN ?? "pi";
// Worktrunk hooks run in new card worktrees when `wt` is installed. Set BAKERY_WT_BIN="" to turn them off.
const worker = new Worker(board, dataDir, piBin, process.env.BAKERY_WT_BIN ?? "wt");
const integration = new Integration(board, dataDir);
const autoReview = new AutoReview(board, integration, piBin);
// Local boards: whether each Done card's merge is on origin/main, read from the last fetch.
const originMain = new OriginMain(board);
const autoPickup = new AutoPickup(board, worker);
// github-pr boards: `gh` resolves from PATH unless BAKERY_GH_BIN names it. BAKERY_GITHUB_SYNC_MS sets the per-board interval.
const github = new GitHub(process.env.BAKERY_GH_BIN || "gh");
const pullFeed = new PullRequestFeed(board, github);
const githubSync = new GitHubSync(board, dataDir, github, process.env.BAKERY_WT_BIN ?? "wt", Number(process.env.BAKERY_GITHUB_SYNC_MS) || 60_000,
  card => worker.start(card),
  card => integration.openPullRequest(card, integration.review(card).fingerprint, github, undefined, true));
const port = Number(process.env.BAKERY_PORT ?? 4317);
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
const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host?.split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "bakery.localhost") { send(res, 403, { error: "Local access only" }); return; }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin && !["http://127.0.0.1:5173", "http://localhost:5173", `http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://bakery.localhost:${port}`].includes(origin)) { send(res, 403, { error: "Origin rejected" }); return; }
    }
    if (path === "/api/status" && req.method === "GET") { send(res, 200, { draining: draining.on, activeRuns: draining.on ? worker.activeCount + (autoReview.active ? 1 : 0) : 0 }); return; }
    if (path === "/api/settings" && req.method === "GET") { send(res, 200, board.getSettings()); return; }
    if (path === "/api/settings" && req.method === "PATCH") {
      const input = await body(req);
      if (!("confirmRunStart" in input) && !("notifyOnReview" in input) && !("cardDetailsLayout" in input) && !("theme" in input) && !("density" in input) && !("agentModels" in input)) throw new Error("Specify a setting to update");
      if ("confirmRunStart" in input && typeof input.confirmRunStart !== "boolean") throw new Error("confirmRunStart must be a boolean");
      if ("notifyOnReview" in input && typeof input.notifyOnReview !== "boolean") throw new Error("notifyOnReview must be a boolean");
      if ("cardDetailsLayout" in input && input.cardDetailsLayout !== "dialog" && input.cardDetailsLayout !== "side") throw new Error("cardDetailsLayout must be dialog or side");
      if ("theme" in input && !isTheme(input.theme)) throw new Error(`theme must be one of: ${themeNames.join(", ")}`);
      if ("density" in input && input.density !== "compact" && input.density !== "default" && input.density !== "cozy") throw new Error("density must be compact, default, or cozy");
      send(res, 200, board.updateSettings({
        confirmRunStart: "confirmRunStart" in input ? input.confirmRunStart as boolean : undefined,
        notifyOnReview: "notifyOnReview" in input ? input.notifyOnReview as boolean : undefined,
        cardDetailsLayout: "cardDetailsLayout" in input ? input.cardDetailsLayout as "dialog" | "side" : undefined,
        theme: "theme" in input ? input.theme as ThemeName : undefined,
        density: "density" in input ? input.density as "compact" | "default" | "cozy" : undefined,
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
      send(res, 200, board.listCards().filter(card => repos.has(card.repo) && card.status !== "archived")); return;
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
    const pullRoute = path.match(/^\/api\/boards\/([\w-]+)\/pull-requests\/(\d{1,9})$/);
    if (pullRoute && req.method === "GET") {
      const repoBoard = board.getBoard(pullRoute[1]);
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      send(res, 200, await github.pullRequestDetail(boardGithubRepo(repoBoard), Number(pullRoute[2]))); return;
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
    const route = path.match(/^\/api\/boards\/([\w-]+)\/cards(?:\/([\w-]+)(?:\/(start|status|runs|resolve|stop|review|approve|approval|withdraw|conflict|comments|request-changes|auto-review|push-progress|dependencies|pull-request|publish|pr-draft|accept-findings|close))?)?$/);
    if (route) {
      const repoBoard = board.getBoard(route[1]), id = route[2], action = route[3];
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      if (!id) {
        if (req.method === "GET") { send(res, 200, originMain.annotate(repoBoard, board.listCards(repoBoard.repo))); return; }
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
        if (req.method === "GET" && action === "comments") { send(res, 200, board.listReviewComments(id)); return; }
        if (req.method === "POST" && action === "comments") {
          const input = await body(req);
          if (typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint) ||
            typeof input.path !== "string" || !Number.isSafeInteger(input.line) || typeof input.body !== "string" ||
            !input.body.trim() || input.body.length > 1000) throw new Error("Invalid review comment");
          const diff = integration.review(item);
          if (diff.fingerprint !== input.fingerprint) throw new Error("Work changed since review; refresh the diff before commenting");
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
        if (req.method === "POST" && action === "start") { send(res, 202, worker.start(item)); return; }
        if (req.method === "POST" && action === "pr-draft") {
          const { fingerprint } = await body(req);
          if (repoBoard.integration !== "github-pr") throw new Error("This board merges locally; it opens no pull request");
          const diff = integration.review(item), run = board.listRuns(id)[0];
          if (typeof fingerprint !== "string" || diff.fingerprint !== fingerprint) throw new Error("Work changed since review; refresh the diff before approving");
          const patch = diff.files.map(file => `File: ${file.path}\n${file.patch}`).join("\n");
          send(res, 200, await draftPullRequest({ card: item, run, worktree: run.worktree!, patch, piBin, models: piModelArgs(board.agentModelFor(item.repo, "draft")) })); return;
        }
        if (req.method === "POST" && action === "approve") {
          const { fingerprint, title, body: prBody } = await body(req);
          if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Open the review diff before approving");
          if (repoBoard.integration === "github-pr") {
            if ((title !== undefined || prBody !== undefined) && (typeof title !== "string" || !title.trim() || title.length > 250 || typeof prBody !== "string" || prBody.length > 20_000))
              throw new Error("Pull request title (up to 250 characters) and body (up to 20,000) are required");
            const card = await integration.openPullRequest(item, fingerprint, github, typeof title === "string" ? { title, body: prBody as string } : undefined);
            void githubSync.syncBoard(repoBoard.id);
            send(res, 200, card); return;
          }
          send(res, 200, integration.approve(item, fingerprint)); return;
        }
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
    send(res, /not found/i.test(message) ? 404 : 400, { error: message });
  }
});
server.on("error", (error) => { board.close(); closeSync(lock); unlinkSync(lockPath); console.error(error); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => { console.log(`Bakery listening on http://127.0.0.1:${port}`); autoReview.start(); autoPickup.start(); githubSync.start(); pullFeed.start();
  // Boards whose GitHub main was never checked (added before this check existed, or gh was unavailable) are checked
  // once per start. This only records protection, which stops local Approve; it never changes a board's mode.
  for (const item of board.listBoards().filter(item => item.githubMainProtected === null && item.remoteUrl))
    void detectGithubIntegration(board, item.id, github, false).catch(error => console.error(`GitHub main check for ${item.repo}: ${error}`));
});
// Set once the dev supervisor asks for a drain. /api/status reports it so the UI can say a restart is coming.
const draining = { on: false };
const shutdown = (signal: "SIGINT" | "SIGTERM") => { server.close(); autoPickup.shutdown(); githubSync.shutdown(); pullFeed.shutdown(); void Promise.all([worker.shutdown(`server received ${signal}`), autoReview.shutdown()]).then(() => { board.close(); closeSync(lock); unlinkSync(lockPath); if (process.connected) process.disconnect(); }); };
// The dev supervisor (scripts/dev-server.mjs) asks for a drain before reloading code, so
// integrating one card into this checkout does not kill other cards' Pi runs.
process.on("message", (message: unknown) => {
  if ((message as { type?: unknown } | null)?.type !== "drain") return;
  draining.on = true;
  autoPickup.shutdown();
  // Agent reviews count too: a restart would kill the reviewer mid-review.
  process.send?.({ type: "draining", activeRuns: worker.activeCount + (autoReview.active ? 1 : 0) });
  void Promise.all([worker.drain(), autoReview.drain()]).then(() => process.send?.({ type: "drained" }));
});
process.once("SIGINT", () => shutdown("SIGINT")); process.once("SIGTERM", () => shutdown("SIGTERM"));
