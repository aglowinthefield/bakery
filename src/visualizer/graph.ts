import {
  type Card,
  type ReviewWait,
  cardActivity,
  quietAfterMs,
  reviewWaitLabels,
  waitingOn,
} from "../model.js";

export type VisualState =
  | "working"
  | "quiet"
  | "agent_review"
  | "waiting"
  | "needs_review"
  | "failed"
  | "interrupted"
  | "done"
  | "ready"
  | "blocked"
  | "triage";

export type DoneFilter = "all" | "relevant" | "hide";

/** What the agent is doing right now; the server does not put this on `Card`, so the caller supplies it. */
export type LiveActivity = { tool: string; turn: number; sinceMs: number };

export type GraphNode = { id: string; card: Card; state: VisualState };
export type GraphEdge = { from: string; to: string };

const finished = (card: Card) =>
  card.status === "done" || card.status === "archived";

/** The drawing state of a card. Quiet and waiting come from `cardActivity()`. */
export function visualState(
  card: Card,
  now = Date.now(),
  quietAfter = quietAfterMs,
): VisualState {
  switch (card.status) {
    case "running":
      return cardActivity(card, now, quietAfter) === "quiet"
        ? "quiet"
        : "working";
    case "review":
      if (card.reviewWait === "agent_review") return "agent_review";
      return card.reviewWait ? "waiting" : "needs_review";
    case "failed":
    case "interrupted":
    case "triage":
    case "ready":
      if (card.status === "failed" || card.status === "interrupted")
        return card.status;
      return card.blocked ? "blocked" : card.status;
    case "done":
    case "archived":
      return "done";
    default:
      return card.blocked ? "blocked" : "triage";
  }
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/** The one-line label under a node. `cards` is the board, for counting what a blocked card waits on. */
export function activityText(
  card: Card,
  state: VisualState,
  cards: Card[],
  now = Date.now(),
  live?: LiveActivity | null,
): string {
  switch (state) {
    case "working":
      return live
        ? `${live.tool} · turn ${live.turn} · ${ago(now - live.sinceMs)}`
        : `running · turn ${card.turns || 1}`;
    case "quiet":
      return card.lastActivityAt
        ? `quiet · ${ago(now - Date.parse(card.lastActivityAt))} silent`
        : "quiet";
    case "agent_review":
    case "waiting":
      return (
        reviewWaitLabels[card.reviewWait as ReviewWait]?.toLowerCase() ??
        "waiting"
      );
    case "needs_review":
      return "needs your review";
    case "failed":
      return `failed · attempt ${card.attempts}`;
    case "blocked":
      return `blocked by ${waitingOn(card, cards).length || "?"}`;
    case "ready":
      return "ready · queued";
    default:
      return state;
  }
}

/** Cards to draw under a done filter. "relevant" keeps finished cards only while an unfinished card depends on them. */
export function visibleCards(cards: Card[], done: DoneFilter = "relevant") {
  if (done === "all") return cards;
  const needed = new Set<string>();
  if (done === "relevant")
    for (const card of cards)
      if (!finished(card))
        for (const id of card.dependsOn ?? []) needed.add(id);
  return cards.filter(
    (card) => !finished(card) || (done === "relevant" && needed.has(card.id)),
  );
}

/**
 * A node's whole dependency chain: `id`, everything it depends on directly or
 * through others, and everything that depends on it the same way.
 */
export function dependencyChain(id: string, edges: GraphEdge[]): Set<string> {
  const chain = new Set([id]);
  const walk = (from: keyof GraphEdge, to: keyof GraphEdge) => {
    const stack = [id];
    while (stack.length) {
      const current = stack.pop();
      for (const edge of edges)
        if (edge[from] === current && !chain.has(edge[to])) {
          chain.add(edge[to]);
          stack.push(edge[to]);
        }
    }
  };
  walk("to", "from");
  walk("from", "to");
  return chain;
}

/** How many nodes are in each drawing state; states with none are left out. */
export function stateCounts(
  nodes: GraphNode[],
): Partial<Record<VisualState, number>> {
  const counts: Partial<Record<VisualState, number>> = {};
  for (const node of nodes) counts[node.state] = (counts[node.state] ?? 0) + 1;
  return counts;
}

/** Nodes and dependency edges (dependency → dependent). Edges to cards that are missing or filtered out are dropped. */
export function buildGraph(
  cards: Card[],
  options: { done?: DoneFilter; now?: number; quietAfterMs?: number } = {},
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const now = options.now ?? Date.now();
  const shown = visibleCards(cards, options.done ?? "relevant");
  const ids = new Set(shown.map((card) => card.id));
  const nodes = shown.map((card) => ({
    id: card.id,
    card,
    state: visualState(card, now, options.quietAfterMs),
  }));
  const edges: GraphEdge[] = [];
  for (const card of shown)
    for (const from of new Set(card.dependsOn ?? []))
      if (ids.has(from) && from !== card.id) edges.push({ from, to: card.id });
  return { nodes, edges };
}
