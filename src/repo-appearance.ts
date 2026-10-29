// Keep the persisted choices in one place for the API and the picker.
export const repoIcons = [
  "sprinkle_donut", "baguette", "bread_loaf", "cake_slice",
  "cherry_pie", "choc_cookie", "cinnamon_roll", "croissant",
  "cupcake", "fried_egg", "green_teapot", "hot_coffee",
  "iced_latte", "jam_jar", "milk_bottle", "wheat_bundle",
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

/** Theme-aware CSS color for a repo color, falling back to the default hex. */
export const repoColorVar = (name: RepoColor) =>
  `var(--repo-${name}, ${repoColors[name]})`;

/** The soft background a repo badge sits on. */
export const repoTint = (color: string) =>
  `color-mix(in srgb, ${color} 16%, transparent)`;

/** Last folder of a repository path, whether the server is on POSIX or Windows. */
export const repoName = (repo: string) => repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;
