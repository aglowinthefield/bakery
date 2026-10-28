import { useEffect, useState } from "react";
import { api } from "./api.js";

type Status = { draining: boolean; activeRuns: number };

// Bottom-left notice while the server waits for active runs to finish before it restarts to load merged code.
export function UpdateNotice() {
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
  return (
    <div
      role="status"
      className="fixed bottom-3 left-3 z-50 lg:bottom-20 max-w-64 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow-md"
    >
      <span className="mr-2 inline-block size-1.5 animate-pulse rounded-full bg-status-review align-middle" />
      {text}
    </div>
  );
}
