// Keep the persisted choices in one place for the API and the picker.
export const repoIcons = [
  "layout-grid", "rocket", "orbit", "flask-conical", "bot", "terminal",
  "blocks", "mountain", "waves", "flower-2", "sparkles", "zap",
  "puzzle", "compass", "gem", "ghost", "coffee", "trees",
  "telescope", "shapes", "bug", "palette", "origami", "globe-2",
] as const;
export type RepoIcon = (typeof repoIcons)[number];

export const repoColors = {
  violet: "#a78bfa",
  coral: "#fb7185",
  amber: "#fbbf24",
  lime: "#a3e635",
  mint: "#34d399",
  teal: "#2dd4bf",
  sky: "#38bdf8",
  blue: "#60a5fa",
  pink: "#f472b6",
  slate: "#94a3b8",
} as const;
export type RepoColor = keyof typeof repoColors;
