import { useEffect, useState } from "react";
import { GitPullRequest } from "lucide-react";
import { api, date } from "./api.js";
import { PullRequestDetails } from "./pull-request-details.js";
import {
  filterOptions,
  filterPullRequests,
  noFilters,
  sortPullRequests,
  sorts,
  type Filters,
  type PullRequest,
  type Sort,
} from "./pull-request-filter.js";

const decisions: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
};

const remembered = new Map<string, PullRequest[]>();
const select =
  "rounded-md border border-border bg-background px-2 py-1 text-xs";

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
  const [error, setError] = useState("");
  const [opened, setOpened] = useState<Set<number>>(
    () => new Set(highlight ? [highlight] : []),
  );

  const toggle = (number: number) =>
    setOpened((previous) => {
      const next = new Set(previous);
      if (!next.delete(number)) next.add(number);
      return next;
    });
  const [pulls, setPulls] = useState<PullRequest[] | null>(
    () => remembered.get(boardId) ?? null,
  );
  // Arriving from a card's PR badge opens that pull request and brings it into view.
  useEffect(() => {
    if (!highlight) return;
    setOpened((previous) => new Set(previous).add(highlight));
  }, [highlight]);
  useEffect(() => {
    if (highlight && pulls)
      document
        .querySelector(`[data-pr="${highlight}"]`)
        ?.scrollIntoView({ block: "start" });
  }, [highlight, pulls !== null]);
  const [filters, setFilters] = useState<Filters>(noFilters);
  const [sort, setSort] = useState<Sort>(() =>
    (localStorage.getItem("bakery-pr-sort") as Sort) in sorts
      ? (localStorage.getItem("bakery-pr-sort") as Sort)
      : "updated",
  );
  const set = (patch: Partial<Filters>) =>
    setFilters((previous) => ({ ...previous, ...patch }));
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
  const options = filterOptions(pulls ?? []);
  const shown = pulls
    ? sortPullRequests(filterPullRequests(pulls, filters), sort)
    : [];
  const filtered = JSON.stringify(filters) !== JSON.stringify(noFilters);
  return (
    <div className="px-6 py-6 lg:px-10">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search pull requests"
          placeholder="Search, or author:name label:bug is:conflicting"
          value={filters.query}
          onChange={(event) => set({ query: event.target.value })}
          className="min-w-64 flex-1 rounded-md border border-border bg-background px-3 py-1 text-xs"
        />
        <select
          aria-label="Author"
          className={select}
          value={filters.author}
          onChange={(e) => set({ author: e.target.value })}
        >
          <option value="">Author</option>
          {options.authors.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <select
          aria-label="Label"
          className={select}
          value={filters.label}
          onChange={(e) => set({ label: e.target.value })}
        >
          <option value="">Label</option>
          {options.labels.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <select
          aria-label="Assignee"
          className={select}
          value={filters.assignee}
          onChange={(e) => set({ assignee: e.target.value })}
        >
          <option value="">Assignee</option>
          <option value="none">Assigned to nobody</option>
          {options.assignees.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        {
          <>
            <select
              aria-label="Review"
              className={select}
              value={filters.review}
              onChange={(e) => set({ review: e.target.value })}
            >
              <option value="">Review</option>
              <option value="REVIEW_REQUIRED">Review required</option>
              <option value="APPROVED">Approved</option>
              <option value="CHANGES_REQUESTED">Changes requested</option>
              <option value="none">No reviews</option>
            </select>
            <select
              aria-label="Checks"
              className={select}
              value={filters.checks}
              onChange={(e) => set({ checks: e.target.value })}
            >
              <option value="">Checks</option>
              <option value="passing">Passing</option>
              <option value="failing">Failing</option>
              <option value="pending">Pending</option>
            </select>
            <select
              aria-label="Conflicts"
              className={select}
              value={filters.conflicts}
              onChange={(e) => set({ conflicts: e.target.value })}
            >
              <option value="">Conflicts</option>
              <option value="conflicting">Has conflicts</option>
              <option value="clean">No conflicts</option>
            </select>
            <select
              aria-label="Draft"
              className={select}
              value={filters.draft}
              onChange={(e) => set({ draft: e.target.value })}
            >
              <option value="">Draft or ready</option>
              <option value="ready">Ready for review</option>
              <option value="draft">Draft</option>
            </select>
          </>
        }
        <select
          aria-label="Card"
          className={select}
          value={filters.card}
          onChange={(e) => set({ card: e.target.value })}
        >
          <option value="">With or without card</option>
          <option value="with">Has a card</option>
          <option value="without">No card</option>
        </select>
        <select
          aria-label="Sort"
          className={select}
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as Sort);
            localStorage.setItem("bakery-pr-sort", e.target.value);
          }}
        >
          {Object.entries(sorts).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        {filtered && (
          <button
            onClick={() => setFilters(noFilters)}
            className="text-xs text-primary hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>
      {pulls && (
        <p className="mb-2 text-xs text-muted-foreground">
          {shown.length} of {pulls.length} open pull requests
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!error && !pulls && (
        <p className="text-sm text-muted-foreground">Loading pull requests…</p>
      )}
      {pulls && shown.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {filtered
            ? "No pull requests match these filters."
            : "No open pull requests."}
        </p>
      )}
      <ul aria-label="Pull requests" className="divide-y divide-border">
        {shown.map((pr) => (
          <li
            key={pr.number}
            data-pr={pr.number}
            aria-current={highlight === pr.number ? "true" : undefined}
            className={`border-l-2 ${pr.isDraft ? "border-l-transparent" : "border-l-emerald-500/60"} ${highlight === pr.number ? "bg-accent/50" : ""}`}
          >
            <div
              className={`flex items-center gap-3 px-2 py-3 hover:bg-accent/30 ${pr.isDraft ? "opacity-80" : ""}`}
            >
              <GitPullRequest
                size={15}
                aria-label={pr.isDraft ? "Draft" : "Open"}
                className={`shrink-0 ${pr.isDraft ? "text-muted-foreground" : "text-emerald-500"}`}
              />
              <button
                onClick={() => toggle(pr.number)}
                aria-expanded={opened.has(pr.number)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate font-medium">{pr.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  #{pr.number} · {pr.author?.login ?? "unknown"} ·{" "}
                  {pr.headRefName} · {`updated ${date(pr.updatedAt)}`}
                  {pr.additions !== undefined &&
                    ` · +${pr.additions} −${pr.deletions ?? 0}`}
                </span>
              </button>
              {(pr.labels ?? []).slice(0, 3).map((label) => (
                <button
                  key={label.name}
                  onClick={() => set({ label: label.name })}
                  title={`Filter by ${label.name}`}
                  className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50"
                >
                  {label.name}
                </button>
              ))}
              {pr.mergeable === "CONFLICTING" && (
                <button
                  onClick={() => set({ conflicts: "conflicting" })}
                  title="This branch has merge conflicts with main"
                  className="shrink-0 rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs text-red-500"
                >
                  Conflicts
                </button>
              )}
              {pr.isDraft && (
                <span className="shrink-0 rounded border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                  Draft
                </span>
              )}
              {pr.checks && (
                <span className="text-xs text-muted-foreground">
                  Checks {pr.checks}
                </span>
              )}
              {pr.reviewDecision && (
                <span className="text-xs text-muted-foreground">
                  {decisions[pr.reviewDecision] ?? pr.reviewDecision}
                </span>
              )}
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
                <span className="shrink-0 text-xs text-muted-foreground">
                  No card
                </span>
              )}
            </div>
            {opened.has(pr.number) && (
              <PullRequestDetails boardId={boardId} pr={pr} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
