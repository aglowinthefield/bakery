import { useEffect, useRef, useState } from "react";

/** What Bakery is doing while it pushes a card to GitHub. Mirrors `PushProgress` in server/integration.ts. */
export type PushProgress = {
  step: string;
  log: string[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

/** The `push-progress` response as progress, or null when there is none (or it is not progress at all). */
export const asPushProgress = (value: unknown): PushProgress | null =>
  value &&
  typeof value === "object" &&
  typeof (value as PushProgress).step === "string" &&
  Array.isArray((value as PushProgress).log)
    ? (value as PushProgress)
    : null;

const seconds = (from: string, to: number) =>
  Math.max(0, Math.round((to - Date.parse(from)) / 1000));

/**
 * The current step and live output of a push, so Approve is not a silent spinner while the repository's pre-push
 * hooks run. After a failed push it keeps the full output, collapsed, next to the error.
 */
export function PushProgressPanel({ progress }: { progress: PushProgress }) {
  const [now, setNow] = useState(() => Date.now());
  const running = !progress.finishedAt;
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [progress.log.length, progress.log[progress.log.length - 1]]);
  const elapsed = seconds(
    progress.startedAt,
    running ? now : Date.parse(progress.finishedAt!),
  );
  const log = progress.log.length ? (
    <pre
      ref={logRef}
      className="mt-2 max-h-56 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap"
    >
      {progress.log.join("\n")}
    </pre>
  ) : null;
  if (running)
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-4 rounded-md border p-3 text-sm"
      >
        <div className="flex items-center gap-2">
          <span className="size-2 animate-pulse rounded-full bg-primary" />
          <span className="font-medium">{progress.step}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {elapsed}s
          </span>
        </div>
        {log}
      </div>
    );
  if (!progress.error || !log) return null;
  return (
    <details className="mt-2 rounded-md border p-3 text-sm">
      <summary className="cursor-pointer">
        Push output ({progress.step}, failed after {elapsed}s)
      </summary>
      {log}
    </details>
  );
}
