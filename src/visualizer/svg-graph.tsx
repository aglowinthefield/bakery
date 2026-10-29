import { useMemo, useState } from "react";
import { markOf } from "./chrome.js";
import { dependencyChain, type GraphEdge, type VisualState } from "./graph.js";
import { nodeBox, type Point } from "./layout.js";
import type { Look } from "./look.js";

export type SvgNode = {
  id: string;
  title: string;
  /** The line under the title. */
  activity: string;
  state: VisualState;
  priority: number;
};

const RADIUS = 22;
const PAD = 40;
const DIM_NODE = 0.25;
const DIM_EDGE = 0.15;

const radiusOf = (priority: number) =>
  RADIUS * (1 + 0.1 * Math.max(0, priority));

/**
 * The graph as plain SVG, for browsers without WebGL. It uses the same layout as
 * the animated view and the same state colors and labels, but nothing moves.
 */
export function SvgGraph({
  nodes,
  edges,
  positions,
  look,
  onOpenCard,
}: {
  nodes: SvgNode[];
  edges: GraphEdge[];
  positions: Map<string, Point>;
  look: Look;
  onOpenCard: (id: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const chain = useMemo(
    () => (hovered ? dependencyChain(hovered, edges) : null),
    [hovered, edges],
  );
  const placed = nodes.filter((node) => positions.has(node.id));
  const byId = new Map(placed.map((node) => [node.id, node]));
  if (!placed.length) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of placed) {
    const at = positions.get(node.id) as Point;
    minX = Math.min(minX, at.x - nodeBox.width / 2);
    maxX = Math.max(maxX, at.x + nodeBox.width / 2);
    minY = Math.min(minY, at.y - RADIUS * 1.5);
    maxY = Math.max(maxY, at.y + nodeBox.height - nodeBox.circleY);
  }
  const width = maxX - minX + PAD * 2;
  const height = maxY - minY + PAD * 2;

  return (
    <div className="absolute inset-0 overflow-auto">
      <svg
        role="group"
        aria-label="Card dependency graph"
        data-visualizer-svg
        width={width}
        height={height}
        viewBox={`${minX - PAD} ${minY - PAD} ${width} ${height}`}
        className="mx-auto block"
        style={{ minWidth: width }}
      >
        <defs>
          {(Object.keys(look.colors) as VisualState[]).map((state) => (
            <marker
              key={state}
              id={`viz-arrow-${state}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0 0 L10 5 L0 10 z" fill={look.colors[state]} />
            </marker>
          ))}
        </defs>
        {edges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          const a = positions.get(edge.from);
          const b = positions.get(edge.to);
          if (!from || !to || !a || !b) return null;
          const x0 = a.x + radiusOf(from.priority) + 3;
          const x1 = b.x - radiusOf(to.priority) - 9;
          const k = Math.max(60, Math.abs(x1 - x0) * 0.5);
          const satisfied = from.state === "done";
          const related =
            !chain || (chain.has(edge.from) && chain.has(edge.to));
          return (
            <path
              key={`${edge.from}>${edge.to}`}
              data-viz-edge={`${edge.from}>${edge.to}`}
              d={`M${x0} ${a.y} C${x0 + k} ${a.y} ${x1 - k} ${b.y} ${x1} ${b.y}`}
              fill="none"
              stroke={look.colors[from.state]}
              strokeWidth={2}
              strokeDasharray={satisfied ? undefined : "6 5"}
              markerEnd={`url(#viz-arrow-${from.state})`}
              opacity={related ? 0.85 : DIM_EDGE}
            />
          );
        })}
        {placed.map((node) => {
          const at = positions.get(node.id) as Point;
          const r = radiusOf(node.priority);
          const color = look.colors[node.state];
          const mark = markOf(node.state);
          const dim = chain && !chain.has(node.id);
          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={`${node.title}, ${node.activity}`}
              data-viz-node={node.id}
              opacity={dim ? DIM_NODE : 1}
              className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-[3]"
              onPointerEnter={() => setHovered(node.id)}
              onPointerLeave={() => setHovered(null)}
              onFocus={() => setHovered(node.id)}
              onBlur={() => setHovered(null)}
              onClick={() => onOpenCard(node.id)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onOpenCard(node.id);
              }}
            >
              <circle
                cx={at.x}
                cy={at.y}
                r={r}
                fill={mark === "solid" ? color : look.background}
                fillOpacity={mark === "solid" ? 0.35 : 1}
                stroke={color}
                strokeWidth={2}
                strokeDasharray={mark === "dash" ? "5 4" : undefined}
              />
              <text
                x={at.x}
                y={at.y + r + 16}
                textAnchor="middle"
                fontSize={12}
                fontWeight={600}
                fill={look.foreground}
              >
                {clip(node.title)}
              </text>
              <text
                x={at.x}
                y={at.y + r + 30}
                textAnchor="middle"
                fontSize={10.5}
                fontFamily="ui-monospace, monospace"
                fill={color}
              >
                {node.activity}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Keeps a title inside its label box, as the animated view's CSS ellipsis does. */
const clip = (title: string, max = 28) =>
  title.length > max ? `${title.slice(0, max - 1)}…` : title;
