import { themeType } from "../themes.js";
import type { VisualState } from "./graph.js";

/** The Bakery CSS variables the Visualizer reads. */
export const lookVariables = [
  "--background",
  "--foreground",
  "--border",
  "--repo-sky",
  "--status-triage",
  "--status-ready",
  "--status-running",
  "--status-review",
  "--status-failed",
  "--status-interrupted",
  "--status-done",
  "--status-archived",
] as const;

export type Look = {
  light: boolean;
  background: string;
  foreground: string;
  grid: string;
  /** One CSS color per drawing state. */
  colors: Record<VisualState, string>;
};

/** Blends two `#rrggbb` colors; `t` is how much of `b` to use. */
export function mixHex(a: string, b: string, t: number): string {
  const parse = (hex: string) => {
    const value = hex.trim().replace("#", "");
    const full =
      value.length === 3
        ? [...value].map((ch) => ch + ch).join("")
        : value.slice(0, 6);
    const n = Number.parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const channel = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

/**
 * Maps drawing states to theme colors. `read` returns a CSS variable's value;
 * `theme` is the `data-theme` name, which decides light or dark compositing.
 */
export function buildLook(
  read: (name: (typeof lookVariables)[number]) => string,
  theme: string | undefined,
): Look {
  const running = read("--status-running");
  const failed = read("--status-failed");
  const triage = read("--status-triage");
  const interrupted = read("--status-interrupted");
  return {
    light: themeType(theme) === "light",
    background: read("--background"),
    foreground: read("--foreground"),
    grid: read("--border"),
    colors: {
      working: running,
      quiet: interrupted,
      agent_review: read("--status-archived"),
      waiting: read("--repo-sky") || running,
      needs_review: read("--status-review"),
      failed,
      interrupted,
      done: read("--status-done"),
      ready: read("--status-ready"),
      triage,
      blocked: mixHex(failed, triage, 0.35),
    },
  };
}

/** Reads the active theme from the document's computed style. */
export function readLook(root: HTMLElement = document.documentElement): Look {
  const style = getComputedStyle(root);
  return buildLook(
    (name) => style.getPropertyValue(name).trim() || "#888888",
    root.dataset.theme,
  );
}
