// One list of themes for the server, the settings dialog and the review diff.
// To add a theme: add an entry here and a `:root[data-theme="<name>"]` block in
// src/theme-palettes.css (copy an existing one; every variable is required).
// A "system" entry has no palette of its own: it names a light and a dark theme
// and the page shows whichever matches the operating system's setting.
export const themes = {
  default: { label: "Default", type: "dark" },
  compline: { label: "Compline Dark", type: "dark" },
  "compline-light": { label: "Compline Light", type: "light" },
  "compline-system": {
    label: "Compline (match system)",
    type: "system",
    light: "compline-light",
    dark: "compline",
  },
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
// The theme whose palette is shown for a setting: a system entry becomes its
// light or dark theme, every other theme is itself.
export function themeVariants(value: ThemeName): {
  light: ThemeName;
  dark: ThemeName;
} {
  const theme = themes[value];
  return theme.type === "system"
    ? { light: theme.light, dark: theme.dark }
    : { light: value, dark: value };
}
export function resolveTheme(value: ThemeName, prefersLight: boolean) {
  return themeVariants(value)[prefersLight ? "light" : "dark"];
}
export function themeType(value: string | undefined): "light" | "dark" {
  if (!isTheme(value)) return "dark";
  const theme = themes[value];
  return theme.type === "system" ? "dark" : theme.type;
}
