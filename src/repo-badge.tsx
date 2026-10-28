import type { CSSProperties } from "react";
import type { Board } from "./model.js";
import { repoColors, repoIcons } from "./repo-appearance.js";

export function RepoBadge({
  board,
  size = 16,
}: {
  board: Board;
  size?: number;
}) {
  const icon = repoIcons.some((name) => name === board.icon)
    ? board.icon
    : repoIcons[0];
  const name = board.color in repoColors ? board.color : "violet";
  const color = `var(--repo-${name}, ${repoColors[name]})`;
  return (
    <span
      className="repo-badge grid size-8 shrink-0 place-items-center rounded-lg"
      style={
        {
          "--repo-color": color,
          backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
        } as CSSProperties
      }
    >
      <img
        src={`/icons/${icon}.png`}
        width={size}
        height={size}
        alt=""
        className="object-contain"
      />
    </span>
  );
}
