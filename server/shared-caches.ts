// No Node imports: the board settings page reads this table in the browser.
/**
 * Build caches a board can share across its card worktrees. Every card worktree starts with an empty cache, so
 * without sharing each run rebuilds what main and earlier runs already built. A shared cache points the tool at the
 * main checkout's own cache directory, so card runs, agent reviews, push hooks and the operator's builds reuse one.
 * Adding a tool is one row: its environment variable and its cache directory relative to the repository root.
 */
export const sharedCaches = {
  turbo: { label: "Turborepo", env: "TURBO_CACHE_DIR", dir: ".turbo/cache" },
} as const satisfies Record<string, { label: string; env: string; dir: string }>;
export type SharedCache = keyof typeof sharedCaches;

/** The known caches in `value`, deduplicated and in table order. Anything else is an error, so a typo is not silently ignored. */
export function validateSharedCaches(value: unknown): SharedCache[] {
  if (!Array.isArray(value)) throw new Error("sharedCaches must be an array of cache names");
  for (const item of value) if (typeof item !== "string" || !Object.hasOwn(sharedCaches, item))
    throw new Error(`Unknown shared cache ${JSON.stringify(item)}; known caches are ${Object.keys(sharedCaches).join(", ")}`);
  return (Object.keys(sharedCaches) as SharedCache[]).filter(name => value.includes(name));
}
