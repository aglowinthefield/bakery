import { date } from "./api.js";
import type { Status } from "./model.js";

/** Mirrors `CardHistoryEntry` in server/card-history.ts. */
export type CardHistoryEntry = {
  at: string;
  from: Status | null;
  to: Status | null;
  text: string;
  detail?: string;
};

const label = (status: Status) => status[0].toUpperCase() + status.slice(1);

/** Collapsed list of everything that happened to a card, newest first, so "why is it in Review?" has an answer. */
export function CardHistory({ entries }: { entries: CardHistoryEntry[] }) {
  return (
    <details className="group mt-4" data-testid="card-history">
      <summary className="cursor-pointer text-sm font-semibold">
        History{entries.length ? ` (${entries.length})` : ""}
      </summary>
      <ol className="mt-2 space-y-3 border-l border-border pl-4">
        {[...entries].reverse().map((entry, index) => (
          <li key={`${entry.at}-${index}`} className="text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
              <time dateTime={entry.at}>{date(entry.at)}</time>
              {entry.to && (
                <span>
                  {entry.from ? `${label(entry.from)} → ` : ""}
                  {label(entry.to)}
                </span>
              )}
            </div>
            <p className="leading-6 text-foreground/90">{entry.text}</p>
            {entry.detail && (
              <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                {entry.detail.length > 600
                  ? `${entry.detail.slice(0, 600)}…`
                  : entry.detail}
              </p>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
