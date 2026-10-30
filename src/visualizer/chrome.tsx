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

const legendKey = "bakery-visualizer-legend";

/** What each state looks like, laid over the graph's lower right corner. It collapses to a small button, and stays above the shortcuts hint. */
export function Legend({ look }: { look: Look }) {
  const [open, setOpen] = useState(
    () => localStorage.getItem(legendKey) !== "closed",
  );
  const toggle = () => {
    localStorage.setItem(legendKey, open ? "closed" : "open");
    setOpen(!open);
  };
  return (
    <div className="absolute right-3 bottom-12 flex flex-col items-end gap-1">
      {open && (
        <ul
          aria-label="Legend"
          className="pointer-events-none grid gap-1 rounded-lg border bg-popover/85 px-3 py-2 text-xs backdrop-blur"
        >
          {stateOrder.map((state) => (
            <li key={state} className="flex items-center gap-2">
              <Swatch state={state} look={look} />
              <span className="text-foreground">{stateNames[state]}</span>
              <span className="text-muted-foreground">{stateHints[state]}</span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="cursor-pointer rounded-md border bg-popover/85 px-2 py-0.5 text-xs text-muted-foreground backdrop-blur hover:text-foreground"
      >
        {open ? "Hide legend" : "Legend"}
      </button>
    </div>
  );
}
