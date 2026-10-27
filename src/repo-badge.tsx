import type { CSSProperties } from "react";
import {
  Blocks,
  Bot,
  Bug,
  Coffee,
  Compass,
  FlaskConical,
  Gem,
  Ghost,
  Globe2,
  LayoutGrid,
  Mountain,
  Orbit,
  Origami,
  Palette,
  Puzzle,
  Rocket,
  Shapes,
  Sparkles,
  Telescope,
  Terminal,
  Trees,
  Waves,
  Zap,
  Flower2,
  type LucideIcon,
} from "lucide-react";
import type { Board } from "./model.js";
import { repoColors, type RepoIcon } from "./repo-appearance.js";

export const appearanceIcons: Record<RepoIcon, LucideIcon> = {
  "layout-grid": LayoutGrid,
  rocket: Rocket,
  orbit: Orbit,
  "flask-conical": FlaskConical,
  bot: Bot,
  terminal: Terminal,
  blocks: Blocks,
  mountain: Mountain,
  waves: Waves,
  "flower-2": Flower2,
  sparkles: Sparkles,
  zap: Zap,
  puzzle: Puzzle,
  compass: Compass,
  gem: Gem,
  ghost: Ghost,
  coffee: Coffee,
  trees: Trees,
  telescope: Telescope,
  shapes: Shapes,
  bug: Bug,
  palette: Palette,
  origami: Origami,
  "globe-2": Globe2,
};
export function RepoBadge({
  board,
  size = 16,
}: {
  board: Board;
  size?: number;
}) {
  const Icon = appearanceIcons[board.icon] ?? LayoutGrid;
  const color = repoColors[board.color] ?? repoColors.violet;
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
      <Icon size={size} aria-hidden="true" />
    </span>
  );
}
