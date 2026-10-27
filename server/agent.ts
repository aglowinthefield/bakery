// Pi reports the provider and model on every assistant message. Bakery keeps only that label so the board
// can show which agent ran each phase (for example anthropic/claude-… versus openai-codex/gpt-…).
const part = (value: unknown) => typeof value === "string" ? value.replace(/[^\w.:@/+-]/g, "").slice(0, 80) : "";

export function agentLabel(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const { role, provider, model } = message as { role?: unknown; provider?: unknown; model?: unknown };
  if (role !== "assistant") return null;
  const label = [part(provider), part(model)].filter(Boolean).join("/");
  return label || null;
}

// A run can switch models (for example after a fallback). Keep each distinct label in first-use order.
export function addAgent(existing: string, label: string): string {
  const labels = existing ? existing.split(", ") : [];
  if (labels.includes(label) || labels.length >= 4) return existing;
  return [...labels, label].join(", ");
}

export function agentsInStream(stream: string): string {
  let agents = "";
  for (const line of stream.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: string; message?: unknown };
      if (event.type !== "message_start" && event.type !== "message_end") continue;
      const label = agentLabel(event.message);
      if (label) agents = addAgent(agents, label);
    } catch { /* The verdict parser reports malformed streams. */ }
  }
  return agents;
}

// Pi reports token usage and its provider-priced cost on each assistant message_end. Bakery sums them per
// attempt. Missing or malformed fields count as 0 so one odd event never poisons the attempt total.
export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cost: number };
const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

export function messageUsage(message: unknown): Usage | null {
  if (!message || typeof message !== "object") return null;
  const { role, usage } = message as { role?: unknown; usage?: unknown };
  if (role !== "assistant" || !usage || typeof usage !== "object") return null;
  const value = usage as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: unknown };
  const cost = value.cost && typeof value.cost === "object" ? (value.cost as { total?: unknown }).total : undefined;
  return {
    inputTokens: Math.round(amount(value.input)), outputTokens: Math.round(amount(value.output)),
    cacheReadTokens: Math.round(amount(value.cacheRead)), cacheWriteTokens: Math.round(amount(value.cacheWrite)), cost: amount(cost),
  };
}

export function usageInStream(stream: string): Usage {
  const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
  for (const line of stream.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: string; message?: unknown };
      if (event.type !== "message_end") continue;
      const usage = messageUsage(event.message);
      if (usage) for (const key of Object.keys(total) as (keyof Usage)[]) total[key] += usage[key];
    } catch { /* The verdict parser reports malformed streams. */ }
  }
  return total;
}
