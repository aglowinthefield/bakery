import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Clock3 } from "lucide-react";
import { date } from "./api.js";
import { Button } from "./components/ui/button.js";
import type { Card, Run } from "./model.js";

// Shows which provider/model ran a phase, e.g. "Run: anthropic/claude-sonnet-4-5".
export function AgentBadge({
  phase,
  agent,
  pending = false,
}: {
  phase: string;
  agent: string;
  pending?: boolean;
}) {
  const text = agent || (pending ? "starting…" : "not recorded");
  return (
    <span
      title={`${phase} agent: ${agent || (pending ? "not reported yet" : "not recorded for this older run")}`}
      className="min-w-0 max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
    >
      {phase}: {text}
    </span>
  );
}

const OUTPUT_TAIL_LINES = 40;

export function errorPrompt(
  run: Run,
  card?: Pick<Card, "title" | "repo"> | null,
): string {
  const lines = [
    "A Bakery agent run failed. Investigate the failure and fix the cause.",
    "",
  ];
  if (card?.title) lines.push(`Card: ${card.title}`);
  if (card?.repo) lines.push(`Repo: ${card.repo}`);
  lines.push(`Attempt: #${run.attempt} (${run.status})`);
  if (run.worktree) lines.push(`Worktree: ${run.worktree}`);
  lines.push(`Started: ${run.startedAt}`);
  if (run.finishedAt) lines.push(`Finished: ${run.finishedAt}`);
  lines.push("", "Error:", "```", run.error ?? "", "```");
  const output = run.output.trim();
  if (output) {
    const tail = output.split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
    lines.push(
      "",
      `Last agent output (up to ${OUTPUT_TAIL_LINES} lines):`,
      "```",
      tail,
      "```",
    );
  }
  return lines.join("\n");
}

export function AttemptList({
  runs,
  card,
}: {
  runs: Run[];
  card?: Pick<Card, "title" | "repo"> | null;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [copyFeedback, setCopyFeedback] = useState<{
    runId: string;
    copied: boolean;
    kind: "path" | "error";
  } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    },
    [],
  );
  const copy = async (runId: string, text: string, kind: "path" | "error") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback({ runId, copied: true, kind });
    } catch {
      setCopyFeedback({ runId, copied: false, kind });
    }
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setCopyFeedback(null), 3000);
  };
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
                <AgentBadge
                  phase="Run"
                  agent={run.agent}
                  pending={run.status === "running"}
                />
                <span className="ml-auto flex items-center gap-1 text-muted-foreground">
                  <Clock3 size={12} /> {date(run.startedAt)}
                </span>
              </button>
              {open && (
                <div
                  id={`attempt-${run.id}`}
                  className="border-t border-border"
                >
                  {(run.worktree || run.error) && (
                    <div className="px-4 pt-3 text-[11px]">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="min-w-0 flex-1 font-mono text-muted-foreground [overflow-wrap:anywhere]">
                          {run.worktree ?? "No worktree"}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => {
                            if (run.error)
                              void copy(
                                run.id,
                                errorPrompt(run, card),
                                "error",
                              );
                            else if (run.worktree)
                              void copy(run.id, run.worktree, "path");
                          }}
                        >
                          {run.error ? "Copy error" : "Copy path"}
                        </Button>
                      </div>
                      {copyFeedback?.runId === run.id && (
                        <p
                          role={copyFeedback.copied ? "status" : "alert"}
                          className={`mt-1 ${copyFeedback.copied ? "text-primary" : "text-destructive"}`}
                        >
                          {copyFeedback.kind === "error"
                            ? copyFeedback.copied
                              ? "Error copied as agent prompt"
                              : "Could not copy error"
                            : copyFeedback.copied
                              ? "Path copied"
                              : "Could not copy path"}
                        </p>
                      )}
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
