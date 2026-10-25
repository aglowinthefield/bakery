import { useState } from "react";
import { ChevronDown, ChevronRight, Clock3 } from "lucide-react";
import { date } from "./api.js";
import type { Run } from "./model.js";

export function AttemptList({ runs }: { runs: Run[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <div className="mt-8">
      <h3 className="mb-4 text-xs font-semibold uppercase tracking-[.14em] text-muted-foreground">
        Attempts
      </h3>
      <div className="space-y-4">
        {runs.map((run, index) => {
          const open = expanded[run.id] ?? index === 0;
          return (
            <div
              key={run.id}
              className="overflow-hidden rounded-lg border border-border bg-background"
            >
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`attempt-${run.id}`}
                onClick={() =>
                  setExpanded((previous) => ({
                    ...previous,
                    [run.id]: !(previous[run.id] ?? index === 0),
                  }))
                }
                className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left text-xs hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="font-mono text-primary">
                  Attempt #{run.attempt}
                </span>
                <span className="capitalize">{run.status}</span>
                {run.startedBy === "auto" && (
                  <span className="rounded bg-primary/10 px-1 text-primary">
                    Auto pickup
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1 text-muted-foreground">
                  <Clock3 size={12} /> {date(run.startedAt)}
                </span>
              </button>
              {open && (
                <div
                  id={`attempt-${run.id}`}
                  className="border-t border-border"
                >
                  {run.worktree && (
                    <div className="truncate px-4 pt-3 font-mono text-[11px] text-muted-foreground">
                      {run.worktree}
                    </div>
                  )}
                  {run.error && (
                    <p className="px-4 pt-3 text-xs text-destructive">
                      {run.error}
                    </p>
                  )}
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-5 text-foreground/75">
                    {run.output ||
                      (run.status === "running"
                        ? "Waiting for Pi output…"
                        : "No assistant output recorded.")}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
