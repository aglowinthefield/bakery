import {
  CircleCheck,
  CircleX,
  LoaderCircle,
  MessageSquare,
  Pause,
  Play,
  Timer,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, date } from "./api.js";
import type { Card, Sentinel, SentinelOverview, SentinelRun } from "./model.js";

/** Cards a sentinel made and starts itself. Keep in step with `isSentinelJob` in server/board.ts. */
export const isSentinelJob = (
  card: Pick<Card, "idempotencyKey" | "sentinelId">,
) =>
  !!card.sentinelId ||
  (!!card.idempotencyKey && /^(sentinel|request):/.test(card.idempotencyKey));

const stateOf = (card: Card) =>
  card.status === "running"
    ? { label: "Running", live: true }
    : card.status === "ready" || card.status === "triage"
      ? { label: "Starting", live: true }
      : card.status === "failed" || card.status === "interrupted"
        ? {
            label: card.status === "failed" ? "Failed" : "Interrupted",
            live: false,
          }
        : { label: "Finished", live: false };

const every = (ms: number) =>
  ms % 3_600_000 === 0
    ? `${ms / 3_600_000}h`
    : ms % 60_000 === 0
      ? `${ms / 60_000}m`
      : `${Math.round(ms / 1000)}s`;

function JobRow({
  card,
  sentinel,
  onOpenCard,
}: {
  card: Card;
  sentinel: Sentinel;
  onOpenCard: (cardId: string) => void;
}) {
  const state = stateOf(card);
  const Icon = sentinel.kind === "pr-requests" ? MessageSquare : Timer;
  return (
    <li>
      <button
        onClick={() => onOpenCard(card.id)}
        className="flex w-full items-center gap-3 px-2 py-3 text-left hover:bg-accent/30"
      >
        {card.status === "running" ? (
          <LoaderCircle
            size={15}
            aria-label="Running"
            className="shrink-0 animate-spin text-primary"
          />
        ) : card.status === "failed" || card.status === "interrupted" ? (
          <CircleX
            size={15}
            aria-label={state.label}
            className="shrink-0 text-red-500"
          />
        ) : (
          <CircleCheck
            size={15}
            aria-label={state.label}
            className={`shrink-0 ${state.live ? "text-muted-foreground" : "text-emerald-500"}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <span className="block truncate font-medium">{card.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {state.label} · updated {date(card.updatedAt)}
          </span>
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
          <Icon size={12} aria-hidden="true" />{" "}
          {sentinel.kind === "pr-requests" ? "PR comment" : "Timer"}
        </span>
      </button>
    </li>
  );
}

function RunRow({ run }: { run: SentinelRun }) {
  return (
    <li className="px-2 py-2 text-sm">
      <span className="font-medium capitalize">{run.status}</span>
      <span className="text-muted-foreground">
        {" "}
        · {date(run.startedAt)}
        {run.summary ? ` · ${run.summary}` : ""}
      </span>
      {run.error && <span className="block text-red-500">{run.error}</span>}
    </li>
  );
}

function SentinelPanel({
  overview,
  onChanged,
  onOpenCard,
}: {
  overview: SentinelOverview;
  onChanged: () => void;
  onOpenCard: (cardId: string) => void;
}) {
  const { sentinel, runs, jobs } = overview;
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState("");
  const act = async (path: string, init: RequestInit) => {
    setError("");
    try {
      await api(path, init);
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const doneCount = jobs.filter((card) => card.status === "done").length;
  const shown = jobs
    .filter(
      (card) =>
        card.status !== "archived" && (showDone || card.status !== "done"),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const live = shown.filter((card) => stateOf(card).live);
  const past = shown.filter((card) => !stateOf(card).live).slice(0, 30);
  return (
    <section
      aria-label={overview.name}
      className="mb-10 border-b border-border pb-8"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-medium">{overview.name}</h2>
        <span
          data-sentinel-state={sentinel.enabled ? "enabled" : "paused"}
          className={`rounded border px-2 py-0.5 text-xs ${sentinel.enabled ? "border-border text-muted-foreground" : "border-amber-500/50 text-amber-500"}`}
        >
          {sentinel.enabled
            ? overview.running
              ? "Running now"
              : "Enabled"
            : "Paused"}
        </span>
        <button
          className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-accent/30"
          onClick={() =>
            act(`/sentinels/${sentinel.id}`, {
              method: "PATCH",
              body: JSON.stringify({ enabled: !sentinel.enabled }),
            })
          }
        >
          {sentinel.enabled ? (
            <Pause size={12} aria-hidden="true" />
          ) : (
            <Play size={12} aria-hidden="true" />
          )}
          {sentinel.enabled ? "Pause" : "Resume"}
        </button>
        {sentinel.enabled && (
          <button
            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent/30"
            onClick={() =>
              act(`/sentinels/${sentinel.id}/run`, { method: "POST" })
            }
          >
            Run now
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Watches {sentinel.scope || "this board"} · every{" "}
        {every(sentinel.intervalMs)} ·{" "}
        {sentinel.enabled
          ? `next run ${date(sentinel.nextRunAt)}`
          : "no runs while paused"}
        {sentinel.lastRunAt ? ` · last run ${date(sentinel.lastRunAt)}` : ""}
      </p>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      {runs.length > 0 && (
        <>
          <h3 className="mb-1 mt-4 text-sm font-medium">Runs</h3>
          <ul
            aria-label={`${overview.name} runs`}
            className="divide-y divide-border"
          >
            {runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        </>
      )}
      {doneCount > 0 && (
        <label className="mb-2 mt-4 flex w-fit items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={showDone}
            onChange={(event) => setShowDone(event.target.checked)}
          />
          Show completed ({doneCount})
        </label>
      )}
      {live.length > 0 && (
        <>
          <h3 className="mb-1 mt-4 text-sm font-medium">Active</h3>
          <ul
            aria-label="Active sentinel jobs"
            className="divide-y divide-border"
          >
            {live.map((card) => (
              <JobRow
                key={card.id}
                card={card}
                sentinel={sentinel}
                onOpenCard={onOpenCard}
              />
            ))}
          </ul>
        </>
      )}
      {past.length > 0 && (
        <>
          <h3 className="mb-1 mt-4 text-sm font-medium">Recent</h3>
          <ul
            aria-label="Recent sentinel jobs"
            className="divide-y divide-border"
          >
            {past.map((card) => (
              <JobRow
                key={card.id}
                card={card}
                sentinel={sentinel}
                onOpenCard={onOpenCard}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * A board's sentinels: persistent monitors with their own schedule, pause switch and run history. The work they find
 * appears as job cards under each one, never in the kanban lanes.
 */
export function Sentinels({
  boardId,
  onOpenCard,
}: {
  boardId: string;
  onOpenCard: (cardId: string) => void;
}) {
  const [overview, setOverview] = useState<SentinelOverview[] | null>(null);
  const load = useCallback(async () => {
    try {
      setOverview(
        await api<SentinelOverview[]>(`/boards/${boardId}/sentinels`),
      );
    } catch {
      /* The next poll retries. */
    }
  }, [boardId]);
  useEffect(() => {
    setOverview(null);
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);
  return (
    <div className="px-6 py-6 lg:px-10">
      {overview === null && (
        <p className="text-sm text-muted-foreground">Loading sentinels…</p>
      )}
      {overview?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          This board has no sentinels. They watch boards that integrate through
          GitHub pull requests.
        </p>
      )}
      {overview?.map((item) => (
        <SentinelPanel
          key={item.sentinel.id}
          overview={item}
          onChanged={() => void load()}
          onOpenCard={onOpenCard}
        />
      ))}
    </div>
  );
}
