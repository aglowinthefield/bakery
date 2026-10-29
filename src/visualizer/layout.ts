import type { ELK, ElkNode } from "elkjs/lib/elk-api.js";
import type { GraphEdge } from "./graph.js";

/** A node's circle center in layout space: x grows right, y grows down. */
export type Point = { x: number; y: number };

/**
 * The box elkjs reserves per node: the circle sits at the top and the DOM label
 * (title and activity line) hangs below it, so the box is as wide as a label.
 */
export const nodeBox = { width: 190, height: 84, circleY: 22 };

const layoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.spacing.nodeNode": "28",
  "elk.layered.spacing.nodeNodeBetweenLayers": "80",
  "elk.spacing.componentComponent": "56",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
};

/** Identifies a node and edge set; the layout only reruns when this changes. */
export function layoutKey(ids: string[], edges: GraphEdge[]): string {
  const nodes = [...ids].sort().join(",");
  const links = edges.map((edge) => `${edge.from}>${edge.to}`).sort();
  return `${nodes}|${links.join(",")}`;
}

/** Lays the graph out left to right. Pass an ELK backed by a worker so the page does not block. */
export async function layoutGraph(
  elk: ELK,
  ids: string[],
  edges: GraphEdge[],
): Promise<Map<string, Point>> {
  const graph: ElkNode = {
    id: "root",
    layoutOptions,
    children: ids.map((id) => ({
      id,
      width: nodeBox.width,
      height: nodeBox.height,
    })),
    edges: edges.map((edge, index) => ({
      id: `e${index}`,
      sources: [edge.from],
      targets: [edge.to],
    })),
  };
  const result = await elk.layout(graph);
  const positions = new Map<string, Point>();
  for (const child of result.children ?? [])
    positions.set(child.id, {
      x: (child.x ?? 0) + nodeBox.width / 2,
      y: (child.y ?? 0) + nodeBox.circleY,
    });
  return positions;
}
