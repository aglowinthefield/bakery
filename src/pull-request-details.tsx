import { useEffect, useState } from "react";
import {
  CircleCheck,
  CircleX,
  ExternalLink,
  GitBranch,
  LoaderCircle,
} from "lucide-react";
import { api, date } from "./api.js";
import { GithubMarkdown } from "./github-markdown.js";
import type { PullRequest } from "./pull-request-filter.js";

type Check = {
  name?: string;
  context?: string;
  workflowName?: string;
  conclusion?: string | null;
  state?: string | null;
  status?: string | null;
  detailsUrl?: string;
  targetUrl?: string;
};
type Detail = {
  body: string;
  baseRefName: string;
  mergeStateStatus?: string;
  changedFiles: number;
  files: {
    path: string;
    additions: number;
    deletions: number;
    changeType: string;
  }[];
  commits: {
    oid: string;
    messageHeadline: string;
    authors: { login?: string; name?: string }[];
    committedDate: string;
  }[];
  comments: { author?: { login?: string }; body: string; createdAt: string }[];
  latestReviews: {
    author?: { login?: string };
    state: string;
    body: string;
    submittedAt?: string;
  }[];
  statusCheckRollup: Check[];
};

const outcome = (check: Check) =>
  (check.conclusion || check.state || check.status || "").toUpperCase();
const failed = [
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
];
const done = ["SUCCESS", "NEUTRAL", "SKIPPED", "COMPLETED"];
const reviewLabels: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending",
};

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-[.14em] text-muted-foreground">
        {title}
        {count !== undefined && (
          <span className="ml-2 font-mono normal-case tracking-normal">
            {count}
          </span>
        )}
      </h2>
      {children}
    </section>
  );
}

/** The inline expansion under a pull request row: description, checks, reviews, files, commits and comments. */
export function PullRequestDetails({
  boardId,
  pr,
}: {
  boardId: string;
  pr: PullRequest;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setDetail(null);
    setError("");
    api<Detail>(`/boards/${boardId}/pull-requests/${pr.number}`)
      .then((next) => current && setDetail(next))
      .catch((err) => current && setError(String(err.message ?? err)));
    return () => {
      current = false;
    };
  }, [boardId, pr.number]);
  const checks = detail?.statusCheckRollup ?? [];
  return (
    <div className="border-t border-border bg-card/40 px-6 pb-6 pt-4">
      <div className="max-w-4xl">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {pr.mergeable === "CONFLICTING" && (
            <span className="rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-red-500">
              Conflicts with {detail?.baseRefName ?? "main"}
            </span>
          )}
          <span>opened {pr.createdAt ? date(pr.createdAt) : ""}</span>
          <span className="inline-flex items-center gap-1 font-mono">
            <GitBranch size={12} aria-hidden="true" />
            {pr.headRefName}
            {detail && ` → ${detail.baseRefName}`}
          </span>
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            Open on GitHub <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
        {error && (
          <p role="alert" className="mt-6 text-sm text-destructive">
            {error}
          </p>
        )}
        {!error && !detail && (
          <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle
              size={14}
              className="animate-spin"
              aria-hidden="true"
            />{" "}
            Loading details…
          </p>
        )}
        {detail && (
          <>
            <Section title="Description">
              {detail.body.trim() ? (
                <GithubMarkdown source={detail.body} />
              ) : (
                <p className="text-sm text-muted-foreground">No description.</p>
              )}
            </Section>
            {!!detail.latestReviews.length && (
              <Section title="Reviews" count={detail.latestReviews.length}>
                <ul className="space-y-1 text-sm">
                  {detail.latestReviews.map((review, index) => (
                    <li key={index}>
                      <span className="font-medium">
                        {review.author?.login}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        {reviewLabels[review.state] ??
                          review.state.toLowerCase()}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            <Section title="Checks" count={checks.length}>
              {checks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No checks.</p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {checks.map((check, index) => {
                    const result = outcome(check);
                    const url = check.detailsUrl || check.targetUrl;
                    const label = [
                      check.workflowName,
                      check.name || check.context,
                    ]
                      .filter(Boolean)
                      .join(" / ");
                    return (
                      <li
                        key={index}
                        className="flex items-center gap-2 py-1.5"
                      >
                        {failed.includes(result) ? (
                          <CircleX
                            size={14}
                            className="shrink-0 text-red-500"
                            aria-label="failed"
                          />
                        ) : done.includes(result) ? (
                          <CircleCheck
                            size={14}
                            className="shrink-0 text-emerald-500"
                            aria-label="passed"
                          />
                        ) : (
                          <LoaderCircle
                            size={14}
                            className="shrink-0 text-muted-foreground"
                            aria-label="pending"
                          />
                        )}
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate hover:underline"
                          >
                            {label}
                          </a>
                        ) : (
                          <span className="truncate">{label}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
            <Section title="Files changed" count={detail.changedFiles}>
              <ul className="divide-y divide-border font-mono text-xs">
                {detail.files.map((file) => (
                  <li
                    key={file.path}
                    className="flex items-center gap-3 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate">{file.path}</span>
                    <span className="text-emerald-500">+{file.additions}</span>
                    <span className="text-red-500">−{file.deletions}</span>
                  </li>
                ))}
              </ul>
              {detail.changedFiles > detail.files.length && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Showing the first {detail.files.length} files.
                </p>
              )}
            </Section>
            <Section title="Commits" count={detail.commits.length}>
              <ul className="divide-y divide-border text-sm">
                {detail.commits.map((commit) => (
                  <li
                    key={commit.oid}
                    className="flex items-center gap-3 py-1.5"
                  >
                    <span className="font-mono text-xs text-muted-foreground">
                      {commit.oid.slice(0, 7)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {commit.messageHeadline}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {commit.authors[0]?.login ?? commit.authors[0]?.name}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
            {!!detail.comments.length && (
              <Section title="Comments" count={detail.comments.length}>
                <ul className="space-y-4">
                  {detail.comments.map((comment, index) => (
                    <li
                      key={index}
                      className="rounded-lg border border-border p-3"
                    >
                      <div className="mb-1 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {comment.author?.login}
                        </span>{" "}
                        · {date(comment.createdAt)}
                      </div>
                      <GithubMarkdown source={comment.body} className="text-sm" />
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
