import { useEffect, useState } from "react";
import { ExternalLink, GitPullRequest } from "lucide-react";
import { api, date } from "./api.js";

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  isDraft: boolean;
  updatedAt: string;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
  checks?: string | null;
  card?: {
    id: string;
    title: string;
    status: string;
    prChecks: string | null;
  } | null;
};

const remembered = new Map<string, PullRequest[]>();
const chip: Record<string, string> = {
  passing: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
  failing: "border-red-500/40 bg-red-500/10 text-red-500",
  pending: "border-amber-500/40 bg-amber-500/10 text-amber-500",
};

/** Open pull requests of one repository: CI state and a button that queues the green ones on Trunk. */
export function PullRequests({
  boardId,
  highlight,
  onOpenCard,
}: {
  boardId: string;
  highlight?: number | null;
  onOpenCard: (cardId: string) => void;
}) {
  const [pulls, setPulls] = useState<PullRequest[] | null>(
    () => remembered.get(boardId) ?? null,
  );
  const [error, setError] = useState("");
  const [queued, setQueued] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<number | null>(null);

  // Opens from the last list seen, then follows the server's background refresh.
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    setPulls(remembered.get(boardId) ?? null);
    setError("");
    const load = () =>
      api<PullRequest[]>(`/boards/${boardId}/pull-requests`)
        .then((next) => {
          if (!current) return;
          remembered.set(boardId, next);
          setPulls(next);
          setError("");
        })
        .catch((err) => current && setError(String(err.message ?? err)))
        .finally(() => {
          if (current) timer = setTimeout(load, 15_000);
        });
    void load();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [boardId]);
  useEffect(() => {
    if (highlight && pulls)
      document
        .querySelector(`[data-pr="${highlight}"]`)
        ?.scrollIntoView({ block: "start" });
  }, [highlight, pulls !== null]);

  const queue = async (number: number) => {
    setBusy(number);
    setError("");
    try {
      await api(`/boards/${boardId}/pull-requests/${number}/merge`, {
        method: "POST",
        body: "{}",
      });
      setQueued((previous) => new Set(previous).add(number));
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="px-6 py-6 lg:px-10">
      {error && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {!error && !pulls && (
        <p className="text-sm text-muted-foreground">Loading pull requests…</p>
      )}
      {pulls && pulls.length === 0 && (
        <p className="text-sm text-muted-foreground">No open pull requests.</p>
      )}
      <ul aria-label="Pull requests" className="divide-y divide-border">
        {(pulls ?? []).map((pr) => {
          const conflicting = pr.mergeable === "CONFLICTING";
          const ready = pr.checks === "passing" && !conflicting && !pr.isDraft;
          return (
            <li
              key={pr.number}
              data-pr={pr.number}
              aria-current={highlight === pr.number ? "true" : undefined}
              className={`flex items-center gap-3 px-2 py-3 ${highlight === pr.number ? "bg-accent/50" : ""}`}
            >
              <GitPullRequest
                size={15}
                aria-label={pr.isDraft ? "Draft" : "Open"}
                className={`shrink-0 ${pr.isDraft ? "text-muted-foreground" : "text-emerald-500"}`}
              />
              <div className="min-w-0 flex-1">
                <span className="block truncate font-medium">{pr.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  #{pr.number} · {pr.headRefName} · updated {date(pr.updatedAt)}
                </span>
              </div>
              {pr.isDraft && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  Draft
                </span>
              )}
              {conflicting && (
                <span className="shrink-0 rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs text-red-500">
                  Conflicts
                </span>
              )}
              {pr.checks && (
                <span
                  className={`shrink-0 rounded border px-2 py-0.5 text-xs ${chip[pr.checks] ?? "border-border text-muted-foreground"}`}
                >
                  CI {pr.checks}
                </span>
              )}
              {pr.card && (
                <button
                  onClick={() => onOpenCard(pr.card!.id)}
                  title={`Open card: ${pr.card.title}`}
                  className="max-w-40 shrink-0 truncate rounded border border-border px-2 py-0.5 text-xs hover:bg-accent/50"
                >
                  Card · {pr.card.status}
                </button>
              )}
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                title="Open on GitHub"
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <ExternalLink size={14} aria-label="Open on GitHub" />
              </a>
              {queued.has(pr.number) ? (
                <span className="w-24 shrink-0 text-center text-xs text-muted-foreground">
                  Queued
                </span>
              ) : (
                <button
                  disabled={!ready || busy === pr.number}
                  onClick={() => void queue(pr.number)}
                  title={
                    ready
                      ? "Comments /trunk merge on the pull request"
                      : "Needs passing CI, no conflicts, not a draft"
                  }
                  className="w-24 shrink-0 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-40"
                >
                  {busy === pr.number ? "Queuing…" : "Queue merge"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
