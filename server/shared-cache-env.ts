import { join } from "node:path";
import { sharedCaches, type SharedCache } from "./shared-caches.js";

/** Environment for commands Bakery starts in a card worktree of `repo`, pointing each enabled tool at the main checkout's cache. */
export function sharedCacheEnv(repo: string, caches: readonly SharedCache[]): Record<string, string> {
  return Object.fromEntries(caches.flatMap(name => [[sharedCaches[name].env, join(repo, sharedCaches[name].dir)], ...Object.entries(sharedCaches[name].extraEnv)]));
}
