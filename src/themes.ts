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
  "default-system": {
    label: "Default (match system)",
    type: "system",
    light: "light",
    dark: "default",
  },
  hearth: { label: "Hearth", type: "dark" },
  "gruvbox-dark": { label: "Gruvbox Dark", type: "dark" },
  "gruvbox-light": { label: "Gruvbox Light", type: "light" },
  "gruvbox-system": {
    label: "Gruvbox (match system)",
    type: "system",
    light: "gruvbox-light",
    dark: "gruvbox-dark",
  },
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

// The settings dialog picks a family from a dropdown and a mode with radios.
// A mode a family has no palette for is left out; "system" needs both.
export const themeFamilies: readonly {
  id: string;
  label: string;
  light?: ThemeName;
  dark?: ThemeName;
  system?: ThemeName;
}[] = [
  {
    id: "default",
    label: "Default",
    light: "light",
    dark: "default",
    system: "default-system",
  },
  {
    id: "compline",
    label: "Compline",
    light: "compline-light",
    dark: "compline",
    system: "compline-system",
  },
  { id: "hearth", label: "Hearth", dark: "hearth" },
  {
    id: "gruvbox",
    label: "Gruvbox",
    light: "gruvbox-light",
    dark: "gruvbox-dark",
    system: "gruvbox-system",
  },
  { id: "nord", label: "Nord", dark: "nord" },
];
export type ThemeMode = "light" | "dark" | "system";
export const themeModes: readonly ThemeMode[] = ["light", "dark", "system"];
export function themeParts(value: ThemeName) {
  for (const family of themeFamilies)
    for (const mode of themeModes)
      if (family[mode] === value) return { family, mode };
  return { family: themeFamilies[0], mode: "dark" as ThemeMode };
}
