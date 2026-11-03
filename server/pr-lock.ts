/** A lock lasts this long unless its holder releases it first. */
export const lockTtlMs = 30 * 60_000;

/** What a lock comment says. `startedAt` is UTC (ISO 8601); `releasedAt` is set once the holder is done. */
export type PrLock = { holder: string; startedAt: string; releasedAt?: string };
export type LockStatus = "active" | "released" | "expired";

const marker = /<!-- bakery-lock (\{.*?\}) -->/;

/** The comment text for a lock. The JSON marker is what Bakery reads back; the rest is for people. */
export function lockBody(lock: PrLock): string {
  const json = JSON.stringify(lock.releasedAt ? lock : { holder: lock.holder, startedAt: lock.startedAt });
  const text = lock.releasedAt
    ? `Bakery lock released by \`${lock.holder}\` at ${lock.releasedAt} (UTC).`
    : `Bakery lock: \`${lock.holder}\` is working on this pull request since ${lock.startedAt} (UTC). The lock lasts ${lockTtlMs / 60_000} minutes unless released earlier.`;
  return `${text}\n\n<!-- bakery-lock ${json} -->`;
}

/** The lock in a comment body, or undefined when the comment is not a Bakery lock. */
export function parseLock(body: string): PrLock | undefined {
  const raw = marker.exec(body)?.[1];
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<PrLock>;
    if (typeof value.holder !== "string" || typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) return undefined;
    return { holder: value.holder, startedAt: value.startedAt, ...(typeof value.releasedAt === "string" ? { releasedAt: value.releasedAt } : {}) };
  } catch { return undefined; }
}

export function lockStatus(lock: PrLock, at = Date.now()): LockStatus {
  if (lock.releasedAt) return "released";
  return at - Date.parse(lock.startedAt) < lockTtlMs ? "active" : "expired";
}
