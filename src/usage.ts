// Token and cost fields are null for attempts recorded before Bakery tracked usage.
// Those show "—": unknown, not free.
export type UsageFields = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  cost?: number | null;
};

export function formatCost(cost: number | null | undefined): string {
  if (typeof cost !== "number") return "—";
  if (cost > 0 && cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

const count = (value: number | null | undefined) =>
  (value ?? 0).toLocaleString("en-US");

export function usageTitle(usage: UsageFields): string {
  if (typeof usage.cost !== "number")
    return "Usage not recorded for this older attempt";
  return `${count(usage.inputTokens)} input, ${count(usage.outputTokens)} output, ${count(usage.cacheReadTokens)} cache read, ${count(usage.cacheWriteTokens)} cache write tokens · $${usage.cost.toFixed(4)}`;
}
