import { useEffect, useState } from "react";
import { api } from "./api.js";

type WaitingCard = { id: string; title: string; repo: string };
type Status = { draining: boolean; activeRuns: number; cards?: WaitingCard[] };

// Bottom-left notice while the server waits for active runs to finish before it restarts to load merged code.
export function UpdateNotice({ onOpenCard }: { onOpenCard?: (card: WaitingCard) => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    let wasDraining = false;
    const poll = () =>
      api<Status>("/status")
        .then((next) => {
          wasDraining = next.draining;
          setStatus(next);
          setDown(false);
        })
        .catch(() => setDown(wasDraining));
    void poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, []);
  if (!down && !status?.draining) return null;
  const text = down
    ? "Restarting to load updates…"
    : status!.activeRuns > 0
      ? `Update ready. Waiting for ${status!.activeRuns} active run${status!.activeRuns === 1 ? "" : "s"} to finish. New runs are paused.`
      : "Update ready. Restarting…";
  const cards = down ? [] : (status?.cards ?? []);
  return (
    <div
      role="status"
      className="fixed bottom-3 left-3 z-50 lg:bottom-20 max-w-64 rounded-md border border-border bg-card text-xs text-muted-foreground shadow-md"
    >
      <button
        type="button"
        data-testid="update-notice-toggle"
        aria-expanded={cards.length > 0 ? open : undefined}
        disabled={cards.length === 0}
        onClick={() => setOpen((value) => !value)}
        className="w-full px-3 py-2 text-left enabled:cursor-pointer enabled:hover:text-foreground"
      >
        <span className="mr-2 inline-block size-1.5 animate-pulse rounded-full bg-status-review align-middle" />
        {text}
      </button>
      {open && cards.length > 0 && (
        <ul data-testid="update-notice-cards" className="border-t border-border px-1 py-1">
          {cards.map((card) => (
            <li key={card.id}>
              <button
                type="button"
                onClick={() => onOpenCard?.(card)}
                className="block w-full truncate rounded px-2 py-1 text-left hover:bg-accent hover:text-foreground"
              >
                {card.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
