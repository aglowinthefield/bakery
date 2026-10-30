export type RouteView =
  | "today"
  | "board"
  | "pulls"
  | "visualizer"
  | "chat"
  | "stats"
  | "logs"
  | "settings";
export const settingsSections = [
  "general",
  "appearance",
  "models",
  "updates",
] as const;
export type SettingsSection = (typeof settingsSections)[number];
export interface Route {
  view: RouteView;
  boardId: string | null;
  cardId: string | null;
  /** Only on the settings view: which category is open. */
  section?: SettingsSection;
}

/**
 * The URL path for a screen: /today, /stats, /logs, /settings/:section, /board/:id, /board/:id/pulls, /board/:id/visualizer, /board/:id/chat, /board/:id/card/:cardId.
 * `/` is not a screen: it opens whichever screen was viewed last, so a new tab picks up where you were.
 */
export function formatRoute({ view, boardId, cardId, section }: Route): string {
  if (view === "settings") return `/settings/${section ?? "general"}`;
  if (view === "today" || view === "stats" || view === "logs")
    return `/${view}`;
  if (!boardId) return "/";
  const base = `/board/${encodeURIComponent(boardId)}`;
  if (view === "pulls" || view === "visualizer" || view === "chat")
    return `${base}/${view}`;
  return cardId ? `${base}/card/${encodeURIComponent(cardId)}` : base;
}

/** Inverse of formatRoute; null for paths Bakery does not own. */
export function parseRoute(path: string): Route | null {
  const parts = path.split("/").filter(Boolean).map(safeDecode);
  if (parts.length === 0) return null;
  if (
    (parts[0] === "today" || parts[0] === "stats" || parts[0] === "logs") &&
    parts.length === 1
  )
    return { view: parts[0], boardId: null, cardId: null };
  if (parts[0] === "settings" && parts.length <= 2) {
    const section = settingsSections.find(
      (item) => item === (parts[1] ?? "general"),
    );
    return section
      ? { view: "settings", boardId: null, cardId: null, section }
      : null;
  }
  if (parts[0] !== "board" || !parts[1]) return null;
  const boardId = parts[1];
  if (parts.length === 2) return { view: "board", boardId, cardId: null };
  if (
    parts.length === 3 &&
    (parts[2] === "pulls" || parts[2] === "visualizer" || parts[2] === "chat")
  )
    return { view: parts[2], boardId, cardId: null };
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
