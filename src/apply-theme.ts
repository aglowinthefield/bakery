import {
  isTheme,
  resolveTheme,
  themeVariants,
  type ThemeName,
} from "./themes.js";

// `data-theme` always holds a concrete palette name. A "match system" setting
// is resolved here and re-resolved when the operating system flips.
const query = "(prefers-color-scheme: light)";
let current: ThemeName = "default";
let watching = false;

function show() {
  const light = window.matchMedia(query).matches;
  document.documentElement.dataset.theme = resolveTheme(current, light);
}

// Settings from an older or partial server reply may lack a valid theme; show Default then.
export function applyTheme(value: ThemeName | undefined) {
  const theme = isTheme(value) ? value : "default";
  current = theme;
  show();
  const follows = themeVariants(theme).light !== themeVariants(theme).dark;
  if (follows && !watching) {
    watching = true;
    window.matchMedia(query).addEventListener("change", show);
  } else if (!follows && watching) {
    watching = false;
    window.matchMedia(query).removeEventListener("change", show);
  }
}
