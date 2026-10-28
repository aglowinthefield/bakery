export type RouteView = "today" | "board" | "pulls" | "stats";
export interface Route {
  view: RouteView;
  boardId: string | null;
  cardId: string | null;
}

/** The URL path for a screen: / (Today), /stats, /board/:id, /board/:id/pulls, /board/:id/card/:cardId. */
export function formatRoute({ view, boardId, cardId }: Route): string {
  if (view === "today") return "/";
  if (view === "stats" || !boardId) return view === "stats" ? "/stats" : "/";
  const base = `/board/${encodeURIComponent(boardId)}`;
  if (view === "pulls") return `${base}/pulls`;
  return cardId ? `${base}/card/${encodeURIComponent(cardId)}` : base;
}

/** Inverse of formatRoute; null for paths Bakery does not own. */
export function parseRoute(path: string): Route | null {
  const parts = path.split("/").filter(Boolean).map(safeDecode);
  if (parts.length === 0) return { view: "today", boardId: null, cardId: null };
  if (parts[0] === "stats" && parts.length === 1)
    return { view: "stats", boardId: null, cardId: null };
  if (parts[0] !== "board" || !parts[1]) return null;
  const boardId = parts[1];
  if (parts.length === 2) return { view: "board", boardId, cardId: null };
  if (parts.length === 3 && parts[2] === "pulls")
    return { view: "pulls", boardId, cardId: null };
  if (parts.length === 4 && parts[2] === "card" && parts[3])
    return { view: "board", boardId, cardId: parts[3] };
  return null;
}

function safeDecode(part: string) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
