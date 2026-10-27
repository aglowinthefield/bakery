import { useEffect, useState } from "react";
import { GitPullRequest } from "lucide-react";
import { api, date } from "./api.js";

type PullRequest = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  isDraft: boolean;
  updatedAt: string;
  author?: { login?: string } | null;
  additions?: number;
  deletions?: number;
  reviewDecision?: string | null;
  card?: { id: string; title: string; status: string; prChecks: string | null } | null;
};

const decisions: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
};

/** Open pull requests of one repository, read from GitHub through the server. */
export function PullRequests({
  boardId,
  highlight,
  onOpenCard,
}: {
  boardId: string;
  highlight?: number | null;
  onOpenCard: (cardId: string) => void;
}) {
  const [pulls, setPulls] = useState<PullRequest[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setPulls(null);
    setError("");
    api<PullRequest[]>(`/boards/${boardId}/pull-requests`)
      .then((next) => current && setPulls(next))
      .catch((err) => current && setError(String(err.message ?? err)));
    return () => {
      current = false;
    };
  }, [boardId]);
  return (
    <div className="px-6 py-6 lg:px-10">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!error && !pulls && <p className="text-sm text-muted-foreground">Loading pull requests…</p>}
      {pulls?.length === 0 && <p className="text-sm text-muted-foreground">No open pull requests.</p>}
      <ul aria-label="Open pull requests" className="divide-y divide-border">
        {pulls?.map((pr) => (
          <li
            key={pr.number}
            data-pr={pr.number}
            aria-current={highlight === pr.number ? "true" : undefined}
            className={`flex items-center gap-3 px-2 py-3 ${highlight === pr.number ? "bg-accent/50" : "hover:bg-accent/30"}`}
          >
            <GitPullRequest size={15} aria-hidden="true" className="shrink-0" />
            <a href={pr.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
              <span className="block truncate font-medium">{pr.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                #{pr.number} · {pr.author?.login ?? "unknown"} · {pr.headRefName} · updated {date(pr.updatedAt)}
                {pr.additions !== undefined && ` · +${pr.additions} −${pr.deletions ?? 0}`}
              </span>
            </a>
            {pr.isDraft && <span className="text-xs text-muted-foreground">Draft</span>}
            {pr.reviewDecision && <span className="text-xs text-muted-foreground">{decisions[pr.reviewDecision] ?? pr.reviewDecision}</span>}
            {pr.card ? (
              <button
                onClick={() => onOpenCard(pr.card!.id)}
                title={`Open card: ${pr.card.title}`}
                className="max-w-56 shrink-0 truncate rounded border border-border px-2 py-0.5 text-xs hover:bg-accent/50"
              >
                Card · {pr.card.status}
                {pr.card.prChecks ? ` · ${pr.card.prChecks}` : ""}
              </button>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">No card</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
