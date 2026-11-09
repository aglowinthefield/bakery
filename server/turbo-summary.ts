import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type CacheUsage = { tasks: number; hits: number; savedMs: number };

/**
 * What Turborepo's cache did for the turbo runs started in `worktree` at or after `sinceMs`. Turbo writes one summary
 * per run into .turbo/runs when TURBO_RUN_SUMMARY is set (see server/shared-caches.ts). Null when there are none,
 * so a run that never used turbo is not counted as a 0% hit rate.
 */
export function turboCacheUsage(worktree: string, sinceMs: number): CacheUsage | null {
  const dir = join(worktree, ".turbo", "runs");
  let files: string[];
  try { files = readdirSync(dir).filter(name => name.endsWith(".json")); } catch { return null; }
  const usage: CacheUsage = { tasks: 0, hits: 0, savedMs: 0 };
  let found = false;
  for (const name of files) {
    try {
      if (statSync(join(dir, name)).mtimeMs < sinceMs) continue;
      const summary = JSON.parse(readFileSync(join(dir, name), "utf8")) as { tasks?: { cache?: { status?: string; timeSaved?: number } }[] };
      found = true;
      for (const task of summary.tasks ?? []) {
        usage.tasks++;
        if (task.cache?.status === "HIT") { usage.hits++; usage.savedMs += task.cache.timeSaved ?? 0; }
      }
    } catch { /* A summary being written or not JSON is skipped; it only costs one run's sample. */ }
  }
  return found ? usage : null;
}
