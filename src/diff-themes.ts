// Syntax themes for the review diff. Each entry pairs a dark and a light Shiki
// theme so the diff keeps following Bakery's light/dark palette. "bakery" keeps
// Bakery's own code surface and add/remove colors; the others use the theme's.
export const diffThemes = {
  bakery: { label: "Bakery", dark: "pierre-dark", light: "pierre-light" },
  github: { label: "GitHub", dark: "github-dark", light: "github-light" },
  one: { label: "One", dark: "one-dark-pro", light: "one-light" },
  catppuccin: {
    label: "Catppuccin",
    dark: "catppuccin-mocha",
    light: "catppuccin-latte",
  },
  solarized: {
    label: "Solarized",
    dark: "solarized-dark",
    light: "solarized-light",
  },
  gruvbox: {
    label: "Gruvbox",
    dark: "gruvbox-dark-medium",
    light: "gruvbox-light-medium",
  },
  "rose-pine": {
    label: "Rosé Pine",
    dark: "rose-pine",
    light: "rose-pine-dawn",
  },
  vitesse: { label: "Vitesse", dark: "vitesse-dark", light: "vitesse-light" },
} as const;
export type DiffTheme = keyof typeof diffThemes;
export const DIFF_THEME_KEY = "bakery-diff-theme";

export function isDiffTheme(value: unknown): value is DiffTheme {
  return typeof value === "string" && Object.hasOwn(diffThemes, value);
}

export function initialDiffTheme(): DiffTheme {
  try {
    const saved = localStorage.getItem(DIFF_THEME_KEY);
    return isDiffTheme(saved) ? saved : "bakery";
  } catch {
    return "bakery";
  }
}
