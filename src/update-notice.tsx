import { useEffect, useState } from "react";
import { api } from "./api.js";

type WaitingCard = { id: string; title: string; repo: string };
type Updates = {
  commits: { sha: string; subject: string }[];
  installing: boolean;
  error: string | null;
};
type Status = {
  draining: boolean;
  activeRuns: number;
  cards?: WaitingCard[];
  updates?: Updates | null;
  version?: string;
  sha?: string | null;
  date?: string | null;
};

const runs = (count: number) => `${count} active run${count === 1 ? "" : "s"}`;

// Bottom-left notice for server updates: the pending commits as a changelog with a button to install them, then
// the wait for active runs to finish before the server restarts to load the new code.
export function UpdateNotice({
  onOpenCard,
  onOpenSettings,
}: {
  onOpenCard?: (card: WaitingCard) => void;
  onOpenSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [down, setDown] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  useEffect(() => {
    let restarting = false;
    const poll = () =>
      api<Status>("/status")
        .then((next) => {
          restarting = next.draining || !!next.updates?.installing;
          setStatus(next);
          setDown(false);
        })
        .catch(() => setDown(restarting));
    void poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, []);
  const updates = status?.updates;
  const pending =
    !down &&
    !status?.draining &&
    !updates?.installing &&
    (updates?.commits.length ?? 0) > 0;
  if (!down && !status?.draining && !updates?.installing && !pending)
    return null;
  const install = () => {
    setRequestError(null);
    api<Updates>("/update", { method: "POST" })
      .then((next) =>
        setStatus((previous) => previous && { ...previous, updates: next }),
      )
      .catch((error: Error) => setRequestError(error.message));
  };
  const count = updates?.commits.length ?? 0;
  const text = down
    ? "Restarting to load updates…"
    : status!.draining
      ? status!.activeRuns > 0
        ? `Update ready. Waiting for ${runs(status!.activeRuns)} to finish. New runs are paused.`
        : "Update ready. Restarting…"
      : updates!.installing
        ? "Installing update…"
        : `${count} update${count === 1 ? "" : "s"} available`;
  const cards = down || !status?.draining ? [] : (status.cards ?? []);
  const expandable = pending || cards.length > 0;
  const error = requestError ?? updates?.error;
  return (
    <div
      role="status"
      className="fixed bottom-3 left-3 z-50 lg:bottom-20 max-w-72 rounded-md border border-border bg-card text-xs text-muted-foreground shadow-md"
    >
      <button
        type="button"
        data-testid="update-notice-toggle"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        className="w-full px-3 py-2 text-left enabled:cursor-pointer enabled:hover:text-foreground"
      >
        <span className="mr-2 inline-block size-1.5 animate-pulse rounded-full bg-status-review align-middle" />
        {text}
      </button>
      {pending && error && (
        <p className="border-t border-border px-3 py-2 whitespace-pre-wrap text-destructive">
          Update failed: {error}
        </p>
      )}
      {open && pending && (
        <div
          data-testid="update-notice-changelog"
          className="border-t border-border"
        >
          <ul className="max-h-48 overflow-y-auto px-3 py-2">
            {updates!.commits.map((commit) => (
              <li key={commit.sha} className="truncate" title={commit.subject}>
                <span className="mr-2 font-mono opacity-60">{commit.sha}</span>
                {commit.subject}
              </li>
            ))}
          </ul>
          <div className="border-t border-border px-3 py-2">
            <button
              type="button"
              onClick={install}
              className="cursor-pointer rounded border border-border px-2 py-1 text-foreground hover:bg-accent"
            >
              Update and restart
            </button>
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="ml-2 cursor-pointer px-2 py-1 hover:text-foreground"
              >
                Details
              </button>
            )}
            <p className="mt-1">
              {status!.activeRuns > 0
                ? `Restarts after ${runs(status!.activeRuns)} finish.`
                : "Installs by itself while nothing is running."}
            </p>
          </div>
        </div>
      )}
      {open && cards.length > 0 && (
        <ul
          data-testid="update-notice-cards"
          className="border-t border-border px-1 py-1"
        >
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

/** Settings → Updates: the running version, then the pending commits with the same install action as the notice. */
export function UpdatesPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  useEffect(() => {
    const poll = () =>
      api<Status>("/status")
        .then((next) => {
          setStatus(next);
          setFailed(false);
        })
        .catch(() => setFailed(true));
    void poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, []);
  if (!status)
    return (
      <p className="text-sm text-muted-foreground">
        {failed
          ? "Bakery is not responding. It may be restarting."
          : "Loading…"}
      </p>
    );
  const updates = status.updates;
  const commits = updates?.commits ?? [];
  const error = requestError ?? updates?.error;
  const install = () => {
    setRequestError(null);
    api<Updates>("/update", { method: "POST" })
      .then((next) =>
        setStatus((previous) => previous && { ...previous, updates: next }),
      )
      .catch((requestFailure: Error) =>
        setRequestError(requestFailure.message),
      );
  };
  return (
    <div className="text-sm">
      <dl className="grid grid-cols-[7rem_1fr] gap-y-2">
        <dt className="text-muted-foreground">Version</dt>
        <dd data-testid="settings-version">{status.version ?? "unknown"}</dd>
        <dt className="text-muted-foreground">Commit</dt>
        <dd className="font-mono">
          {status.sha ?? "unknown"}
          {status.date && (
            <span className="ml-2 font-sans text-muted-foreground">
              {new Date(status.date).toLocaleDateString(undefined, {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
          )}
        </dd>
      </dl>
      <div className="mt-6 border-t border-border pt-5">
        {updates === null || updates === undefined ? (
          <p className="text-muted-foreground">
            This server was not started with npm start, so it does not install
            updates by itself.
          </p>
        ) : updates.installing || status.draining ? (
          <p>
            {status.draining && status.activeRuns > 0
              ? `Update ready. Waiting for ${runs(status.activeRuns)} to finish. New runs are paused.`
              : "Installing update…"}
          </p>
        ) : commits.length === 0 ? (
          <p data-testid="settings-up-to-date">Up to date.</p>
        ) : (
          <>
            <p className="font-medium">
              {commits.length} update{commits.length === 1 ? "" : "s"} available
            </p>
            <ul
              data-testid="settings-changelog"
              className="mt-3 max-h-72 overflow-y-auto"
            >
              {commits.map((commit) => (
                <li key={commit.sha} className="py-0.5">
                  <span className="mr-2 font-mono text-xs opacity-60">
                    {commit.sha}
                  </span>
                  {commit.subject}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={install}
              className="mt-4 cursor-pointer rounded border border-border px-3 py-1.5 hover:bg-accent"
            >
              Update and restart
            </button>
            <p className="mt-2 text-xs text-muted-foreground">
              {status.activeRuns > 0
                ? `Restarts after ${runs(status.activeRuns)} finish.`
                : "Installs by itself while nothing is running."}
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="mt-3 whitespace-pre-wrap text-destructive">
            Update failed: {error}
          </p>
        )}
      </div>
    </div>
  );
}
