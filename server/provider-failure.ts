/**
 * What kind of provider failure a Pi run ended with, so Bakery can tell a rejected conversation history (which fails
 * the same way every time it is resumed) from a passing outage, billing, auth, or any other rejected request.
 *
 * - `invalid-history`: HTTP 400 that points into the `messages` array (for example `messages.103: role 'system' must
 *   precede ...` or `messages.32.content.0: tool_addition ... unknown tool`). The saved Pi session replays the same
 *   array, so resuming it fails again. Only this kind is recovered in a fresh session.
 * - `output-blocked`: Anthropic's reverse-engineering classifier; the worker has its own once-only retry for it.
 * - `billing`, `auth`: need a person; never retried automatically.
 * - `invalid-request`: any other HTTP 400/404/413/422. Cause unknown, so not retried automatically.
 * - `rate-limit`, `transient`: 429, 5xx, overloaded and network errors. An ordinary retry is expected to work.
 * - `unknown`: no recognizable provider status.
 */
export type ProviderFailureKind = "invalid-history" | "output-blocked" | "billing" | "auth" | "invalid-request" | "rate-limit" | "transient" | "unknown";

export const PROVIDER_FAILURE_KINDS: readonly ProviderFailureKind[] = ["invalid-history", "output-blocked", "billing", "auth", "invalid-request", "rate-limit", "transient", "unknown"];

export function isProviderFailureKind(value: unknown): value is ProviderFailureKind {
  return typeof value === "string" && (PROVIDER_FAILURE_KINDS as readonly string[]).includes(value);
}

/** The HTTP status Pi's error text names: a leading `400 {...}`, `(HTTP 400)`, `API error (503)` or `status 429`. */
function httpStatus(text: string): number | null {
  const match = text.match(/^\s*(\d{3})\b|\(HTTP (\d{3})\)|\((\d{3})\)|\bstatus[ :=]+(\d{3})\b/);
  const status = match && Number(match[1] ?? match[2] ?? match[3] ?? match[4]);
  return status || null;
}

export function classifyProviderFailure(text: string | null | undefined): ProviderFailureKind {
  if (!text) return "unknown";
  const status = httpStatus(text);
  if (/reverse engineering or duplicating model outputs/i.test(text)) return "output-blocked";
  if (status === 402 || /credit balance|billing|payment required|insufficient[_ ](quota|funds)|exceeded your current quota/i.test(text)) return "billing";
  if (status === 401 || status === 403 || /authentication_error|permission_error|invalid[ _-]?(x-)?api[ _-]?key|unauthorized|oauth token (has )?expired/i.test(text)) return "auth";
  if (status === 429 || /rate[_ ]limit/i.test(text)) return "rate-limit";
  if (status !== null && status >= 500 || /overloaded|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|timed? ?out|tunnel destination/i.test(text)) return "transient";
  if (status === 400 && /invalid_request_error/.test(text) && /"message":"messages\.\d+|tool_reference_unresolved|role 'system' must precede/i.test(text)) return "invalid-history";
  if (status !== null && status >= 400 || /invalid_request_error/.test(text)) return "invalid-request";
  return "unknown";
}

/** Short operator-facing name for a kind, used in the run's error text. */
export function describeProviderFailure(kind: ProviderFailureKind): string {
  switch (kind) {
    case "invalid-history": return "the provider rejected this session's saved message history; resuming it fails the same way";
    case "output-blocked": return "the provider blocked the request as output duplication";
    case "billing": return "billing or quota problem; needs a person";
    case "auth": return "authentication problem; needs a person";
    case "invalid-request": return "the provider rejected the request as invalid; cause unknown";
    case "rate-limit": return "rate limited";
    case "transient": return "temporary provider or network error";
    default: return "provider error";
  }
}
