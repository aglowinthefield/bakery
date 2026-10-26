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
