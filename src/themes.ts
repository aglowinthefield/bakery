// One list of themes for the server, the settings dialog and the review diff.
// To add a theme: add an entry here and a `:root[data-theme="<name>"]` block in
// src/theme-palettes.css (copy an existing one; every variable is required).
export const themes = {
  default: { label: "Default", type: "dark" },
  compline: { label: "Compline", type: "dark" },
  light: { label: "Light", type: "light" },
  hearth: { label: "Hearth", type: "dark" },
  "gruvbox-dark": { label: "Gruvbox Dark", type: "dark" },
  "gruvbox-light": { label: "Gruvbox Light", type: "light" },
  nord: { label: "Nord", type: "dark" },
} as const;
export type ThemeName = keyof typeof themes;
export const themeNames = Object.keys(themes) as ThemeName[];
export function isTheme(value: unknown): value is ThemeName {
  return typeof value === "string" && Object.hasOwn(themes, value);
}
export function themeType(value: string | undefined): "light" | "dark" {
  return isTheme(value) ? themes[value].type : "dark";
}
