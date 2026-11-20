import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** One memory as Impression's search returns it, cut down to what a room shows and cites. */
export type Memory = { id: string; scope: "user" | "project"; project: string | null; content: string; stale: boolean; warning: string | null; updatedAt: string | null };
export type MemoryProject = { key: string; name: string };
export type ImpressionConfig = { url: string; token: string };

/** Reads the same settings Impression's own clients use: IMPRESSION_URL/IMPRESSION_TOKEN, else ~/.config/impression/config.json. */
export function impressionConfig(env: NodeJS.ProcessEnv = process.env): ImpressionConfig | null {
  if (env.IMPRESSION_URL) return env.IMPRESSION_TOKEN === undefined ? null : { url: env.IMPRESSION_URL.replace(/\/+$/, ""), token: env.IMPRESSION_TOKEN };
  try {
    const file = JSON.parse(readFileSync(join(env.HOME ?? homedir(), ".config", "impression", "config.json"), "utf8")) as { url?: unknown; token?: unknown };
    if (typeof file.url === "string" && typeof file.token === "string" && file.url && file.token) return { url: file.url.replace(/\/+$/, ""), token: file.token };
  } catch { /* Not configured. */ }
  return null;
}

/** Normalises a git remote the way Impression does: host/owner/repo, lower-case host, no scheme, user or .git suffix. */
export function projectKeyFromRemote(remote: string): string | null {
  const text = remote.trim();
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(text);
  let host: string, path: string;
  if (scp) { host = scp[1]; path = scp[2]; }
  else {
    try { const url = new URL(text); host = url.hostname; path = url.pathname; } catch { return null; }
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return host && path ? `${host.toLowerCase()}/${path}` : null;
}

/** The project a repository is filed under in Impression. Explicit: callers pass the repository the operator chose. */
export function memoryProject(repo: string): MemoryProject {
  let remote = "";
  try { remote = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* No remote. */ }
  const key = projectKeyFromRemote(remote);
  if (key) return { key, name: key.split("/").at(-1)! };
  let root = repo;
  try { root = dirname(execFileSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); } catch { /* Not a checkout. */ }
  return { key: `path:${root}`, name: basename(root) };
}

export class ImpressionError extends Error {}

async function call(config: ImpressionConfig | null, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  if (!config) throw new ImpressionError("Impression is not configured (set IMPRESSION_URL and IMPRESSION_TOKEN, or ~/.config/impression/config.json)");
  let response: Response;
  try {
    response = await fetch(`${config.url}${path}`, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) { throw new ImpressionError(`Impression is unreachable: ${error instanceof Error ? error.message : String(error)}`); }
  const text = await response.text();
  if (!response.ok) throw new ImpressionError(`Impression answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  try { return JSON.parse(text); } catch { throw new ImpressionError("Impression sent a response that is not JSON"); }
}

/** Searches one explicit scope. Project searches never include user memories, matching Impression's exact project filter. */
export async function searchMemories(config: ImpressionConfig | null, query: string, target: { scope: "user" } | { scope: "project"; project: string }, limit = 5): Promise<{ degraded: boolean; memories: Memory[] }> {
  const payload = target.scope === "user" ? { query: query.slice(0, 2000), scope: "user", limit } : { query: query.slice(0, 2000), scope: "project", project: target.project, limit };
  const data = await call(config, "/api/search", payload, 8000) as { degraded?: unknown; results?: unknown };
  if (!Array.isArray(data.results)) throw new ImpressionError("Impression search returned no results list");
  const memories = data.results.flatMap((item: Record<string, unknown>) => typeof item?.id === "string" && typeof item.content === "string" ? [{
    id: item.id, scope: item.scope === "project" ? "project" as const : "user" as const, project: typeof item.project === "string" ? item.project : null,
    content: item.content.slice(0, 1500), stale: item.stale === true, warning: typeof item.warning === "string" ? item.warning : null,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
  }] : []);
  return { degraded: data.degraded === true, memories };
}

/** Saves one memory. Impression has no provenance field, so the source reference travels in the content. */
export async function saveMemory(config: ImpressionConfig | null, input: { scope: "user" | "project"; project?: MemoryProject; content: string }): Promise<{ id: string; outcome: string }> {
  const payload = { scope: input.scope, content: input.content.slice(0, 10_000), agent: "bakery", ...(input.scope === "project" ? { project: input.project } : {}) };
  const data = await call(config, "/api/memories", payload, 15_000) as { id?: unknown; outcome?: unknown; memory?: { id?: unknown } };
  const id = typeof data.id === "string" ? data.id : typeof data.memory?.id === "string" ? data.memory.id : null;
  if (!id) throw new ImpressionError("Impression did not confirm the save with a memory id");
  return { id, outcome: typeof data.outcome === "string" ? data.outcome : "created" };
}
