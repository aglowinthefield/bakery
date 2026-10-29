import ELK from "elkjs/lib/elk-api.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Card } from "../model.js";
import { activityText, buildGraph } from "./graph.js";
import { layoutGraph, layoutKey } from "./layout.js";
import { readLook } from "./look.js";
import { GraphScene, type SceneNode, webglAvailable } from "./scene.js";

const refreshMs = 15_000;

/** An ELK that lays out in a Web Worker, so a big board does not block the page. */
const createElk = () =>
  new ELK({
    workerFactory: () =>
      new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url)),
  });

const notice = (text: string) => (
  <p className="px-6 py-6 text-sm text-muted-foreground lg:px-10">{text}</p>
);

/** Per-board Visualizer: the dependency graph drawn with three.js. */
export function Visualizer({
  cards,
  loaded,
  onOpenCard,
}: {
  cards: Card[];
  /** False until the board's first fetch lands, so an unloaded board is not shown as empty. */
  loaded: boolean;
  onOpenCard: (id: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), refreshMs);
    return () => clearInterval(timer);
  }, []);
  const graph = useMemo(() => buildGraph(cards, { now }), [cards, now]);
  if (!loaded) return notice("Loading cards…");
  if (!cards.length) return notice("No cards on this board yet.");
  if (!webglAvailable())
    return (
      <div>
        {notice(
          "WebGL is not available in this browser, so the graph is shown as a list.",
        )}
        <CardList cards={cards} onOpenCard={onOpenCard} />
      </div>
    );
  return (
    <Canvas cards={cards} graph={graph} now={now} onOpenCard={onOpenCard} />
  );
}

function Canvas({
  cards,
  graph,
  now,
  onOpenCard,
}: {
  cards: Card[];
  graph: ReturnType<typeof buildGraph>;
  now: number;
  onOpenCard: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<GraphScene | null>(null);
  const openRef = useRef(onOpenCard);
  openRef.current = onOpenCard;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // The scene and its theme: created once, torn down when the view leaves.
  useEffect(() => {
    const host = hostRef.current;
    const labels = labelsRef.current;
    if (!host || !labels) return;
    let scene: GraphScene;
    try {
      scene = new GraphScene(host, labels, (id) => openRef.current(id));
    } catch {
      setFailed(true);
      return;
    }
    scene.setLook(readLook());
    const observer = new MutationObserver(() => scene.setLook(readLook()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "f" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog']",
        )
      )
        return;
      scene.fit();
    };
    window.addEventListener("keydown", onKeyDown);
    sceneRef.current = scene;
    setReady(true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
      setReady(false);
    };
  }, []);

  // Node and label content follow every refresh; the layout below does not.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!ready || !scene) return;
    const nodes: SceneNode[] = graph.nodes.map((node) => ({
      id: node.id,
      title: node.card.title,
      activity: activityText(node.card, node.state, cards, now),
      state: node.state,
      priority: node.card.priority ?? 0,
    }));
    scene.setGraph(nodes, graph.edges);
  }, [ready, graph, cards, now]);

  // Re-layout only when the node or edge set changes.
  const key = layoutKey(
    graph.nodes.map((node) => node.id),
    graph.edges,
  );
  const graphRef = useRef(graph);
  graphRef.current = graph;
  useEffect(() => {
    if (!ready) return;
    let stale = false;
    const elk = createElk();
    const { nodes, edges } = graphRef.current;
    layoutGraph(
      elk,
      nodes.map((node) => node.id),
      edges,
    )
      .then((positions) => {
        if (!stale) sceneRef.current?.setPositions(positions);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      })
      .finally(() => elk.terminateWorker());
    return () => {
      stale = true;
    };
  }, [ready, key]);

  if (failed)
    return (
      <div>
        {notice("The graph could not be drawn, so it is shown as a list.")}
        <CardList cards={cards} onOpenCard={onOpenCard} />
      </div>
    );
  return (
    <div
      className="relative h-[calc(100vh-125px)] min-h-[360px] overflow-hidden"
      aria-label="Card dependency graph"
    >
      <div
        ref={hostRef}
        data-visualizer-canvas
        className="absolute inset-0 cursor-grab touch-none"
      />
      <div
        ref={labelsRef}
        className="pointer-events-none absolute inset-0 overflow-hidden"
      />
    </div>
  );
}

function CardList({
  cards,
  onOpenCard,
}: {
  cards: Card[];
  onOpenCard: (id: string) => void;
}) {
  return (
    <ul aria-label="Cards" className="px-6 py-6 lg:px-10">
      {cards.map((card) => (
        <li key={card.id}>
          <button
            onClick={() => onOpenCard(card.id)}
            className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-sm hover:bg-accent/30"
          >
            <span className="truncate">{card.title}</span>
            <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
              {card.status}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
