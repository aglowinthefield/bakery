import {
  CircleCheck,
  CircleX,
  LoaderCircle,
  MessageSquare,
  Timer,
} from "lucide-react";
import { date } from "./api.js";
import type { Card } from "./model.js";

/** Cards the sentinel makes and starts itself: a fix for a broken PR (timer) or a `/bakery` comment. Keep in step with `isSentinelJob` in server/board.ts. */
export const isSentinelJob = (card: Pick<Card, "idempotencyKey">) =>
  !!card.idempotencyKey && /^(sentinel|request):/.test(card.idempotencyKey);

const trigger = (card: Card) =>
  card.idempotencyKey?.startsWith("request:")
    ? { label: "PR comment", icon: MessageSquare }
    : { label: "Timer", icon: Timer };
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

/** Jobs the sentinel started from its timer or from `/bakery` PR comments, kept off the kanban so card workflows never hold them up. */
export function Sentinels({
  cards,
  loaded,
  onOpenCard,
}: {
  cards: Card[];
  loaded: boolean;
  onOpenCard: (cardId: string) => void;
}) {
  const jobs = cards
    .filter((card) => isSentinelJob(card) && card.status !== "archived")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const live = jobs.filter((card) => stateOf(card).live);
  const past = jobs.filter((card) => !stateOf(card).live).slice(0, 30);
  const row = (card: Card) => {
    const state = stateOf(card);
    const { label, icon: Icon } = trigger(card);
    return (
      <li key={card.id}>
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
            <Icon size={12} aria-hidden="true" /> {label}
          </span>
        </button>
      </li>
    );
  };
  return (
    <div className="px-6 py-6 lg:px-10">
      {!loaded && (
        <p className="text-sm text-muted-foreground">Loading sentinel jobs…</p>
      )}
      {loaded && jobs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No sentinel jobs yet. They appear when the timer finds a broken pull
          request or someone comments /bakery on one.
        </p>
      )}
      {live.length > 0 && (
        <>
          <h2 className="mb-1 text-sm font-medium">Active</h2>
          <ul
            aria-label="Active sentinel jobs"
            className="divide-y divide-border"
          >
            {live.map(row)}
          </ul>
        </>
      )}
      {past.length > 0 && (
        <>
          <h2 className="mb-1 mt-6 text-sm font-medium">Recent</h2>
          <ul
            aria-label="Recent sentinel jobs"
            className="divide-y divide-border"
          >
            {past.map(row)}
          </ul>
        </>
      )}
    </div>
  );
}
