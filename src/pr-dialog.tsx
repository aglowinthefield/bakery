import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog";
import type { Card, PullRequestDraft } from "./model.js";
import { semanticTitleProblem } from "./pr-title.js";
import { PushProgressPanel, type PushProgress } from "./push-progress.js";

const field =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

/**
 * Approve on a github-pr board when no PR is open yet: Bakery drafts the title and body from the repository's
 * template and semantic-PR rules, and the operator edits them before anything is pushed.
 */
export function PullRequestDialog({
  boardId,
  card,
  fingerprint,
  open,
  busy,
  submitError,
  pushProgress,
  onOpenChange,
  onSubmit,
}: {
  boardId: string;
  card: Card;
  fingerprint: string;
  open: boolean;
  busy: boolean;
  /** Why the last Approve failed, shown here because the dialog covers the card's own error line. */
  submitError: string;
  /** The card's current or last push, so the pre-push hook's output shows here while the dialog covers the card. */
  pushProgress: PushProgress | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (title: string, body: string) => void;
}) {
  const [draft, setDraft] = useState<PullRequestDraft | null>(null);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [progress, setProgress] = useState<{
    startedAt: number;
    steps: { at: number; text: string }[];
  }>({ startedAt: 0, steps: [] });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!open || draft || error) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      api<typeof progress>(`/boards/${boardId}/cards/${card.id}/pr-draft`)
        .then(setProgress)
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [open, draft, error, boardId, card.id]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setDraft(null);
    setProgress({ startedAt: 0, steps: [] });
    setError("");
    api<PullRequestDraft>(`/boards/${boardId}/cards/${card.id}/pr-draft`, {
      method: "POST",
      body: JSON.stringify({ fingerprint }),
    })
      .then((result) => {
        if (!current) return;
        setDraft(result);
        setTitle(result.title);
        setBody(result.body);
      })
      .catch((err) => {
        if (current) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      current = false;
    };
  }, [open, boardId, card.id, fingerprint]);
  const titleProblem = !title.trim()
    ? "A title is required"
    : draft?.semantic
      ? semanticTitleProblem(title, draft.semantic)
      : "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,820px)]">
        <DialogTitle>Open pull request</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          Bakery commits unignored files on bakery/{card.id}, pushes that branch
          to origin, and runs gh pr create with this title and body. Nothing
          merges locally; the card is Done once the PR merges on GitHub.
        </DialogDescription>
        {error && <ErrorMessage error={error} />}
        {!draft && !error && (
          <div
            role="status"
            className="mt-4 grid gap-1 text-sm text-muted-foreground"
          >
            <div>
              Drafting the pull request…
              {progress.startedAt > 0 &&
                ` ${Math.max(0, Math.round((now - progress.startedAt) / 1000))}s`}
            </div>
            <ul className="grid gap-0.5 font-mono text-xs">
              {progress.steps.slice(-8).map((step, index, shown) => (
                <li
                  key={step.at + step.text}
                  className={
                    index === shown.length - 1 ? "text-foreground" : ""
                  }
                >
                  +{Math.round((step.at - progress.startedAt) / 1000)}s{" "}
                  {step.text}
                </li>
              ))}
            </ul>
          </div>
        )}
        {draft && (
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!titleProblem) onSubmit(title.trim(), body);
            }}
          >
            <div className="text-xs text-muted-foreground">
              {draft.source === "agent"
                ? `Drafted by the agent from ${[draft.templatePath, draft.semantic?.source].filter(Boolean).join(" and ")}. Review and edit before opening.`
                : draft.templatePath || draft.semantic
                  ? "Could not draft with the agent; edit the card text and template by hand."
                  : "This repository has no pull request template or semantic-PR check; the card title and description are used."}
            </div>
            {draft.problem && draft.source === "card" && (
              <div role="status" className="text-xs text-destructive">
                {draft.problem}
              </div>
            )}
            <label className="grid gap-1 text-sm">
              Title
              <input
                aria-label="Pull request title"
                value={title}
                maxLength={250}
                onChange={(event) => setTitle(event.target.value)}
                className={`${field} font-mono`}
              />
            </label>
            {draft.semantic && (
              <div className="text-xs text-muted-foreground">
                {draft.semantic.source} requires type(scope): subject. Types:{" "}
                {draft.semantic.types.join(", ")}.
                {draft.semantic.scopes.length > 0 &&
                  ` Scopes: ${draft.semantic.scopes.join(", ")}.`}
              </div>
            )}
            {titleProblem && (
              <div role="alert" className="text-xs text-destructive">
                {titleProblem}
              </div>
            )}
            <label className="grid gap-1 text-sm">
              Body
              <textarea
                aria-label="Pull request body"
                value={body}
                maxLength={20000}
                rows={16}
                onChange={(event) => setBody(event.target.value)}
                className={`${field} resize-y font-mono text-xs`}
              />
            </label>
            <div className="text-xs text-muted-foreground">
              Bakery appends “Opened by Bakery for card {card.id}” and the run
              summary.
            </div>
            {pushProgress &&
              (!pushProgress.finishedAt ||
                (submitError && pushProgress.error)) && (
                <PushProgressPanel progress={pushProgress} />
              )}
            {submitError && <ErrorMessage error={submitError} />}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !!titleProblem}>
                Approve and open PR
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Push failures carry a summary line, then the hook's own output, whose line breaks matter. */
function ErrorMessage({ error }: { error: string }) {
  const [summary, ...rest] = error.split("\n");
  const detail = rest.join("\n").trim();
  return (
    <div role="alert" className="mt-4 text-sm text-destructive">
      {detail ? (
        <>
          <p className="font-medium">{summary}</p>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
            {detail}
          </pre>
        </>
      ) : (
        error
      )}
    </div>
  );
}
