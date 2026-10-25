import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, extname, isAbsolute, resolve } from "node:path";
import { Board } from "./board.js";
import { Worker } from "./worker.js";
import { Integration, IntegrationConflictError } from "./integration.js";

const dataDir = process.env.BAKERY_DATA_DIR ?? join(homedir(), ".local", "share", "bakery");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
// Exclusive, fail-closed ownership of the local board. Inspect a stale lock before removing it.
const lockPath = join(dataDir, "server.lock");
let lock: number;
try { lock = openSync(lockPath, "wx", 0o600); writeSync(lock, `${process.pid}\n`); }
catch { throw new Error(`Bakery already owns ${dataDir}, or has a stale lock at ${lockPath}. Check the recorded PID before removing it.`); }
let board: Board;
try { board = new Board(join(dataDir, "bakery.sqlite")); }
catch (error) { closeSync(lock); unlinkSync(lockPath); throw error; }
const worker = new Worker(board, dataDir, process.env.BAKERY_PI_BIN ?? "pi");
const integration = new Integration(board, dataDir);
const port = Number(process.env.BAKERY_PORT ?? 4317);
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
  return { title: title.trim(), body: description };
}
function repoRoot(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Repository path is required");
  const input = value.trim();
  const path = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
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
    if (host !== "127.0.0.1" && host !== "localhost") { send(res, 403, { error: "Local access only" }); return; }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin && !["http://127.0.0.1:5173", "http://localhost:5173", `http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) { send(res, 403, { error: "Origin rejected" }); return; }
    }
    if (path === "/api/settings" && req.method === "GET") { send(res, 200, board.getSettings()); return; }
    if (path === "/api/settings" && req.method === "PATCH") {
      const { confirmRunStart } = await body(req);
      if (typeof confirmRunStart !== "boolean") throw new Error("confirmRunStart must be a boolean");
      send(res, 200, board.updateSettings({ confirmRunStart })); return;
    }
    if (path === "/api/boards" && req.method === "GET") { send(res, 200, board.listBoards()); return; }
    if (path === "/api/boards" && req.method === "POST") {
      const root = repoRoot((await body(req)).repo);
      if (board.listBoards().some(item => item.repo === root)) throw new Error("Repository already has a board");
      send(res, 201, board.addRepo(root)); return;
    }
    const boardRoute = path.match(/^\/api\/boards\/([\w-]+)$/);
    if (boardRoute) {
      const item = board.getBoard(boardRoute[1]);
      if (!item) { send(res, 404, { error: "Board not found" }); return; }
      if (req.method === "PATCH") { send(res, 200, board.renameBoard(item.id, repoRoot((await body(req)).repo))); return; }
      if (req.method === "DELETE") { board.archiveBoard(item.id); send(res, 200, { ok: true }); return; }
    }
    const settingsRoute = path.match(/^\/api\/boards\/([\w-]+)\/settings$/);
    if (settingsRoute && req.method === "PATCH") {
      if (!board.getBoard(settingsRoute[1])) { send(res, 404, { error: "Board not found" }); return; }
      const { autoCollapseEmptySwimlanes } = await body(req);
      if (typeof autoCollapseEmptySwimlanes !== "boolean") throw new Error("Auto collapse empty swimlanes must be a boolean");
      send(res, 200, board.setAutoCollapseEmptySwimlanes(settingsRoute[1], autoCollapseEmptySwimlanes)); return;
    }
    const conflictsRoute = path.match(/^\/api\/boards\/([\w-]+)\/conflicts$/);
    if (conflictsRoute && req.method === "GET") {
      const repoBoard = board.getBoard(conflictsRoute[1]);
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      send(res, 200, board.listMergeFailures(repoBoard.repo)); return;
    }
    const route = path.match(/^\/api\/boards\/([\w-]+)\/cards(?:\/([\w-]+)(?:\/(start|status|runs|resolve|stop|approve|approval|withdraw|conflict))?)?$/);
    if (route) {
      const repoBoard = board.getBoard(route[1]), id = route[2], action = route[3];
      if (!repoBoard) { send(res, 404, { error: "Board not found" }); return; }
      if (!id) {
        if (req.method === "GET") { send(res, 200, board.listCards(repoBoard.repo)); return; }
        if (req.method === "POST") { send(res, 201, board.createCard({ ...fields(await body(req)), repo: repoBoard.repo })); return; }
      } else {
        const item = board.getCard(id);
        if (!item || item.repo !== repoBoard.repo) { send(res, 404, { error: "Card not found on this board" }); return; }
        if (req.method === "GET" && action === "runs") { send(res, 200, board.listRuns(id)); return; }
        if (req.method === "GET" && action === "approval") { send(res, 200, { pending: !!board.getApproval(id) }); return; }
        if (req.method === "DELETE" && action === "conflict") { board.clearMergeFailure(id); send(res, 200, { ok: true }); return; }
        if (req.method === "PATCH" && !action) { send(res, 200, board.updateCard(id, { ...fields(await body(req)), repo: repoBoard.repo })); return; }
        if (req.method === "POST" && action === "start") { send(res, 202, worker.start(item)); return; }
        if (req.method === "POST" && action === "approve") { send(res, 200, integration.approve(item)); return; }
        if (req.method === "POST" && action === "withdraw") { send(res, 200, integration.withdraw(item)); return; }
        if (req.method === "POST" && action === "resolve") {
          if ((await body(req)).acknowledged !== true) throw new Error("Confirm that you inspected the interrupted worktree");
          send(res, 200, board.resolveInterrupted(id)); return;
        }
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
    const target = file.startsWith(dist + "/") && existsSync(file) ? file : join(dist, "index.html");
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
server.listen(port, "127.0.0.1", () => console.log(`Bakery listening on http://127.0.0.1:${port}`));
const shutdown = () => { server.close(); void worker.shutdown().then(() => { board.close(); closeSync(lock); unlinkSync(lockPath); }); };
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
