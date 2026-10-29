import { useEffect, useState } from "react";
import type { DoneFilter, VisualState } from "./graph.js";
import { type Look, readLook } from "./look.js";

/** Short name of each drawing state, for the counts and the legend. */
export const stateNames: Record<VisualState, string> = {
  working: "Working",
  quiet: "Quiet",
  agent_review: "Agent reviewing",
  waiting: "Waiting",
  needs_review: "Needs review",
  failed: "Failed",
  interrupted: "Interrupted",
  done: "Done",
  ready: "Ready",
  blocked: "Blocked",
  triage: "Triage",
};

/** What each state looks like in the graph, as the legend explains it. */
const stateHints: Record<VisualState, string> = {
  working: "pulsing core, orbiting spark",
  quiet: "running, but silent too long",
  agent_review: "an agent is reviewing; spark orbits back",
  waiting: "waiting on GitHub or CI; sweeping arc",
  needs_review: "needs your review",
  failed: "flickers",
  interrupted: "dashed ring",
  done: "solid; edges release a pulse",
  ready: "queued; breathing ring",
  blocked: "waiting on a dependency; dashed ring and edges",
  triage: "not yet scheduled",
};

/** The order states are listed in, from most to least in motion. */
export const stateOrder: VisualState[] = [
  "working",
  "quiet",
  "agent_review",
  "waiting",
  "needs_review",
  "failed",
  "interrupted",
  "ready",
  "blocked",
  "triage",
  "done",
];

type Mark = "solid" | "ring" | "dash";
const marks: Record<VisualState, Mark> = {
  working: "solid",
  quiet: "solid",
  agent_review: "solid",
  waiting: "ring",
  needs_review: "ring",
  failed: "solid",
  interrupted: "dash",
  done: "solid",
  ready: "ring",
  blocked: "dash",
  triage: "ring",
};

/** The ring style a state is drawn with: filled, solid ring, or dashed ring. */
export const markOf = (state: VisualState): Mark => marks[state];

/** The active theme's colors, re-read when `data-theme` changes. */
export function useLook(): Look {
  const [look, setLook] = useState(() => readLook());
  useEffect(() => {
    const observer = new MutationObserver(() => setLook(readLook()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return look;
}

function Swatch({ state, look }: { state: VisualState; look: Look }) {
  const color = look.colors[state];
  const mark = markOf(state);
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{
        background: mark === "solid" ? color : "transparent",
        border:
          mark === "solid"
            ? "none"
            : `1.5px ${mark === "dash" ? "dashed" : "solid"} ${color}`,
      }}
    />
  );
}

const doneNames: Record<DoneFilter, string> = {
  all: "All",
  relevant: "Relevant",
  hide: "Hide",
};

/** The strip above the graph: how many cards are in each state, and the Done filter. */
export function Header({
  counts,
  look,
  done,
  onDone,
}: {
  counts: Partial<Record<VisualState, number>>;
  look: Look;
  done: DoneFilter;
  onDone: (done: DoneFilter) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-6 py-2.5 text-xs lg:px-10">
      <ul
        aria-label="Cards by state"
        className="flex flex-wrap items-center gap-x-4 gap-y-1"
      >
        {stateOrder
          .filter((state) => counts[state])
          .map((state) => (
            <li
              key={state}
              data-viz-count={state}
              className="flex items-center gap-1.5 text-muted-foreground"
            >
              <Swatch state={state} look={look} />
              <b className="font-semibold text-foreground tabular-nums">
                {counts[state]}
              </b>
              {stateNames[state].toLowerCase()}
            </li>
          ))}
      </ul>
      <div
        role="group"
        aria-label="Done cards"
        className="ml-auto flex items-center gap-1.5"
      >
        <span className="mr-0.5 text-muted-foreground">Done</span>
        {(Object.keys(doneNames) as DoneFilter[]).map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={done === name}
            onClick={() => onDone(name)}
            className={`cursor-pointer rounded px-2 py-0.5 ${done === name ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/40"}`}
          >
            {doneNames[name]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** What each state looks like, laid over the graph's lower right corner. */
export function Legend({ look }: { look: Look }) {
  return (
    <ul
      aria-label="Legend"
      className="pointer-events-none absolute right-3 bottom-3 grid gap-1 rounded-lg border bg-popover/85 px-3 py-2 text-xs backdrop-blur"
    >
      {stateOrder.map((state) => (
        <li key={state} className="flex items-center gap-2">
          <Swatch state={state} look={look} />
          <span className="text-foreground">{stateNames[state]}</span>
          <span className="text-muted-foreground">{stateHints[state]}</span>
        </li>
      ))}
    </ul>
  );
}
