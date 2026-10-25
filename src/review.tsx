import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, XCircle } from "lucide-react";
import { Button } from "./components/ui/button";
import { highlightDiffCode } from "./review-diff.js";
import { parseDiff } from "./diff-lines.js";
import type { ReviewComment, ReviewDiff, MergeConflict } from "./model.js";

export function ReviewPanel({
  review,
  error,
  comments,
  runId,
  busy,
  onRefresh,
  onAdd,
  onDelete,
}: {
  review: ReviewDiff | null;
  error: string;
  comments: ReviewComment[];
  runId?: string;
  busy: boolean;
  onRefresh: () => void;
  onAdd: (path: string, line: number, body: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const [jump, setJump] = useState<{
    review: ReviewDiff;
    index: number;
    id: number;
  } | null>(null);
  return (
    <section
      aria-label="Review diff"
      className="mt-8 border-t border-border pt-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[.14em] text-muted-foreground">
          Review diff
        </h3>
        <Button size="sm" variant="ghost" onClick={onRefresh}>
          <RefreshCw size={13} /> Refresh diff
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Card changes since its shared commit with main. Select a code line to
        annotate it. Comments stay on this exact diff; older comments are kept
        as history, not moved to new lines.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          Could not load review diff: {error}
        </p>
      )}
      {!review && !error && (
        <p className="mt-3 text-xs text-muted-foreground">
          Loading review diff…
        </p>
      )}
      {review &&
        (review.files.length === 0 ? (
          <p className="mt-4 text-xs text-muted-foreground">
            No card changes to review.
          </p>
        ) : (
          <>
            <p className="mt-4 text-xs font-medium">
              Changed files ({review.files.length})
            </p>
            <ul className="mt-2 space-y-1 font-mono text-xs">
              {review.files.map((file, index) => (
                <li key={file.path} className="break-all">
                  <button
                    type="button"
                    onClick={() =>
                      setJump((previous) => ({
                        review,
                        index,
                        id: (previous?.id ?? 0) + 1,
                      }))
                    }
                    className="rounded text-left text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {file.path}
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-4 space-y-3">
              {review.files.map((file, index) => (
                <ReviewFile
                  key={`${review.fingerprint}:${file.path}`}
                  file={file}
                  index={index}
                  jump={
                    jump?.review === review && jump.index === index
                      ? jump.id
                      : undefined
                  }
                  comments={comments.filter(
                    (comment) =>
                      comment.path === file.path &&
                      comment.runId === runId &&
                      comment.fingerprint === review.fingerprint,
                  )}
                  busy={busy}
                  canComment={
                    !comments.some(
                      (comment) =>
                        comment.runId === runId &&
                        comment.state === "requested",
                    )
                  }
                  onAdd={onAdd}
                />
              ))}
            </div>
          </>
        ))}
      {comments.length > 0 && (
        <section
          aria-label="Review feedback"
          className="mt-6 border-t border-border pt-4"
        >
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Review feedback
          </h4>
          <ul className="mt-3 space-y-2">
            {comments.map((comment) => {
              const older =
                comment.runId !== runId ||
                comment.fingerprint !== review?.fingerprint;
              return (
                <li
                  key={comment.id}
                  className="rounded-md border border-border bg-background p-3 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2 font-mono text-muted-foreground">
                    <span className="break-all">
                      {comment.path}:
                      {comment.fileLine ?? `diff row ${comment.line}`}
                    </span>
                    <span>· {comment.state}</span>
                    {older && <span>· older diff (line may have moved)</span>}
                  </div>
                  <code
                    className="mt-2 block truncate text-muted-foreground"
                    title={comment.code}
                  >
                    {comment.code}
                  </code>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                    {comment.body}
                  </p>
                  {comment.state === "draft" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-2"
                      disabled={busy}
                      onClick={() => void onDelete(comment.id)}
                    >
                      Remove draft
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </section>
  );
}
function ReviewFile({
  file,
  index,
  jump,
  comments,
  busy,
  canComment,
  onAdd,
}: {
  file: ReviewDiff["files"][number];
  index: number;
  jump?: number;
  comments: ReviewComment[];
  busy: boolean;
  canComment: boolean;
  onAdd: (path: string, line: number, body: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(index === 0);
  const heading = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (jump !== undefined) setOpen(true);
  }, [jump]);
  useLayoutEffect(() => {
    if (jump === undefined || !open) return;
    heading.current?.scrollIntoView({ block: "start" });
    heading.current?.focus({ preventScroll: true });
  }, [jump, open]);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [text, setText] = useState("");
  const panelId = `review-file-${index}`;
  const selected = selectedLine && parseDiff(file.patch)[selectedLine - 1];
  const code = selected && selected.code;
  const fileLine = selected && (selected.newLine ?? selected.oldLine);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <h4>
        <button
          ref={heading}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((previous) => !previous)}
          className="flex w-full items-center gap-2 break-all px-4 py-3 text-left font-mono text-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? (
            <ChevronDown size={14} className="shrink-0" />
          ) : (
            <ChevronRight size={14} className="shrink-0" />
          )}
          {file.path}
          {comments.length > 0 && (
            <span className="ml-auto rounded bg-secondary px-2 py-0.5">
              {comments.length} note{comments.length === 1 ? "" : "s"}
            </span>
          )}
        </button>
      </h4>
      {open && (
        <div id={panelId}>
          <DiffPatch
            path={file.path}
            patch={file.patch}
            comments={comments}
            onSelect={canComment ? setSelectedLine : undefined}
          />
          {selectedLine !== null && canComment && (
            <form
              className="space-y-2 border-t border-border p-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!text.trim()) return;
                void onAdd(file.path, selectedLine, text).then((saved) => {
                  if (saved) {
                    setText("");
                    setSelectedLine(null);
                  }
                });
              }}
            >
              <label className="block text-xs font-medium">
                Comment on {file.path}:{fileLine ?? `diff row ${selectedLine}`}
                <code className="mt-1 block truncate font-normal text-muted-foreground">
                  {code}
                </code>
                <textarea
                  required
                  maxLength={1000}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  rows={3}
                  autoFocus
                  placeholder="What should change?"
                  className="mt-2 w-full resize-y rounded-md border border-border bg-card p-2 text-sm"
                />
              </label>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy || !text.trim()} type="submit">
                  Add comment
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => setSelectedLine(null)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
function DiffPatch({
  path,
  patch,
  comments,
  onSelect,
}: {
  path: string;
  patch: string;
  comments: ReviewComment[];
  onSelect?: (line: number) => void;
}) {
  const colors = {
    add: "bg-[var(--diff-add-background)] text-[var(--diff-add-foreground)]",
    remove:
      "bg-[var(--diff-remove-background)] text-[var(--diff-remove-foreground)]",
    context: "text-foreground/80",
    meta: "bg-[var(--diff-meta-background)] text-muted-foreground",
  };
  const parsed = parseDiff(patch);
  const lines = parsed.length
    ? parsed
    : [
        {
          kind: "meta" as const,
          code: "No text diff (binary file).",
          prefix: "",
        },
      ];
  return (
    <div className="max-h-96 overflow-auto border-t border-border bg-[var(--code-background)] font-mono text-[11px] leading-5 whitespace-pre">
      {lines.map((line, index) => (
        <div key={index}>
          <div
            data-change={line.kind}
            className={`flex min-w-full w-max ${colors[line.kind]}`}
          >
            {line.kind === "meta" ? (
              <span className="px-2">{line.code}</span>
            ) : (
              <>
                <button
                  type="button"
                  aria-label={`Comment on ${path} line ${line.newLine ?? line.oldLine ?? index + 1} (${line.kind})`}
                  disabled={!onSelect}
                  onClick={() => onSelect?.(index + 1)}
                  className="w-10 shrink-0 text-right text-muted-foreground hover:bg-primary/20 disabled:cursor-default"
                >
                  {line.newLine ?? line.oldLine ?? ""}
                </button>
                <span className="w-4 shrink-0 pl-1">{line.prefix}</span>
                <code
                  className="pr-4"
                  dangerouslySetInnerHTML={{
                    __html: highlightDiffCode(line.code, path),
                  }}
                />
              </>
            )}
          </div>
          {comments
            .filter((comment) => comment.line === index + 1)
            .map((comment) => (
              <div
                key={comment.id}
                className="min-w-full w-max border-l-2 border-primary bg-card px-3 py-1 text-foreground whitespace-normal"
              >
                <span className="text-primary">
                  {comment.state === "draft" ? "Draft" : "Requested"}:{" "}
                </span>
                {comment.body}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
export function MergeConflictPanel({
  conflict,
  onDismiss,
}: {
  conflict: MergeConflict;
  onDismiss: () => void;
}) {
  return (
    <section
      role="alert"
      aria-label="Merge conflict"
      className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"
    >
      <div className="flex items-start gap-3">
        <XCircle size={18} className="mt-0.5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">Merge blocked by conflicts</h3>
          <p className="mt-1 text-muted-foreground">
            Bakery has not merged these changes into main. The card worktree
            remains available.
          </p>
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss merge conflict"
          className="text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      </div>
      <div className="mt-4 pl-7">
        <p className="font-medium">
          Conflicting files ({conflict.files.length})
        </p>
        <ul className="mt-2 space-y-1 font-mono text-xs">
          {conflict.files.map((file) => (
            <li
              key={file}
              className="break-all rounded bg-background/70 px-2 py-1"
            >
              {file}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-muted-foreground">
          Choose Fix conflict with Pi to ask the agent to reconcile the card
          branch with current main. It can commit the resolution on that branch,
          but cannot merge into main. Review its changes before approving again.
          You can also resolve the branch yourself in its worktree.
        </p>
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Git details
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-3 font-mono">
            {conflict.details}
          </pre>
        </details>
      </div>
    </section>
  );
}
