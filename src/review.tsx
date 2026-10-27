import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  MessageSquarePlus,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { parsePatchFiles, type FileDiffOptions } from "@pierre/diffs";
import { FileDiff, type DiffLineAnnotation } from "@pierre/diffs/react";
import { Button } from "./components/ui/button";
import { parseDiff, type DiffLine } from "./diff-lines.js";
import {
  diffStats,
  rowForTarget,
  targetForRow,
  withFileHeader,
} from "./review-patch.js";

type DiffStyle = "unified" | "split";
const DIFF_STYLE_KEY = "bakery-diff-style";
function initialDiffStyle(): DiffStyle {
  try {
    return localStorage.getItem(DIFF_STYLE_KEY) === "split"
      ? "split"
      : "unified";
  } catch {
    return "unified";
  }
}
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
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(initialDiffStyle);
  const chooseDiffStyle = (next: DiffStyle) => {
    setDiffStyle(next);
    try {
      localStorage.setItem(DIFF_STYLE_KEY, next);
    } catch {
      // The choice still applies for this session.
    }
  };
  return (
    <section
      aria-label="Review diff"
      className="mt-8 border-t border-border pt-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[.14em] text-muted-foreground">
          Review diff
        </h3>
        <div className="flex items-center gap-2">
          <div
            role="radiogroup"
            aria-label="Diff layout"
            className="inline-flex rounded-md border border-border p-0.5 text-xs"
          >
            {(["unified", "split"] as const).map((style) => (
              <button
                key={style}
                type="button"
                role="radio"
                aria-checked={diffStyle === style}
                onClick={() => chooseDiffStyle(style)}
                className={`rounded px-2 py-0.5 capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${diffStyle === style ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {style}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            <RefreshCw size={13} /> Refresh diff
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Card changes since its shared commit with main. Press + beside a code
        line to annotate it. Comments stay on this exact diff; older comments
        are kept as history, not moved to new lines.
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
                  diffStyle={diffStyle}
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
  diffStyle,
  onAdd,
}: {
  file: ReviewDiff["files"][number];
  index: number;
  jump?: number;
  comments: ReviewComment[];
  busy: boolean;
  canComment: boolean;
  diffStyle: DiffStyle;
  onAdd: (path: string, line: number, body: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(true);
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
  const rows = useMemo(() => parseDiff(file.patch), [file.patch]);
  const stats = useMemo(() => diffStats(rows), [rows]);
  const codeRows = useMemo(
    () =>
      rows.flatMap((line, row) =>
        line.kind === "meta" ? [] : [{ line, row: row + 1 }],
      ),
    [rows],
  );
  const selected = selectedLine ? rows[selectedLine - 1] : undefined;
  const fileLine = selected && (selected.newLine ?? selected.oldLine);
  const commenting = selectedLine !== null && canComment;
  const form = commenting ? (
    <form
      className="m-2 space-y-2 rounded-md border border-border bg-card p-3 font-sans"
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
        <code className="mt-1 block truncate font-mono font-normal text-muted-foreground">
          {selected?.code}
        </code>
        <textarea
          required
          maxLength={1000}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setSelectedLine(null);
          }}
          rows={3}
          autoFocus
          placeholder="What should change?"
          className="mt-2 w-full resize-y rounded-md border border-border bg-background p-2 text-sm"
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
  ) : null;
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
          <span className="min-w-0 flex-1">{file.path}</span>
          {comments.length > 0 && (
            <span className="shrink-0 rounded bg-secondary px-2 py-0.5">
              {comments.length} note{comments.length === 1 ? "" : "s"}
            </span>
          )}
          {codeRows.length > 0 && (
            <span
              className="shrink-0 tabular-nums"
              aria-label={`${stats.additions} added, ${stats.deletions} removed`}
            >
              <span className="text-diff-add-foreground">
                +{stats.additions}
              </span>{" "}
              <span className="text-diff-remove-foreground">
                −{stats.deletions}
              </span>
            </span>
          )}
        </button>
      </h4>
      {open && (
        <div id={panelId} className="border-t border-border">
          {canComment && codeRows.length > 0 && (
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
              <MessageSquarePlus size={13} className="shrink-0" />
              <span className="hidden sm:inline">
                Hover a line and press + to comment, or
              </span>
              <select
                aria-label={`Comment on a line in ${file.path}`}
                value=""
                onChange={(event) => {
                  const row = Number(event.target.value);
                  if (row) setSelectedLine(row);
                }}
                className="min-w-0 max-w-full flex-1 truncate rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground sm:max-w-72 sm:flex-none"
              >
                <option value="">pick a line…</option>
                {codeRows.map(({ line, row }) => (
                  <option key={row} value={row}>
                    {`${line.prefix}${line.newLine ?? line.oldLine}  ${line.code.trim().slice(0, 60)}`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <DiffPatch
            path={file.path}
            patch={file.patch}
            rows={rows}
            comments={comments}
            diffStyle={diffStyle}
            selectedLine={commenting ? selectedLine : null}
            form={form}
            onSelect={canComment ? setSelectedLine : undefined}
          />
        </div>
      )}
    </div>
  );
}
type Note = { kind: "comment"; comment: ReviewComment } | { kind: "form" };
function useThemeType(): "light" | "dark" {
  const read = (): "light" | "dark" =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const [type, setType] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setType(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return type;
}
// Pierre renders inside shadow DOM; CSS variables cross that boundary, so the diff
// follows Bakery's palette instead of the library's default colors.
const diffSurface = {
  "--diffs-font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
  "--diffs-header-font-family": "inherit",
  "--diffs-font-size": "11.5px",
  "--diffs-line-height": "20px",
  "--diffs-light-bg": "var(--code-background)",
  "--diffs-dark-bg": "var(--code-background)",
  "--diffs-bg-addition-override": "var(--diff-add)",
  "--diffs-bg-deletion-override": "var(--diff-remove)",
  "--diffs-bg-addition-number-override": "var(--diff-add)",
  "--diffs-bg-deletion-number-override": "var(--diff-remove)",
  "--diffs-bg-separator-override": "var(--muted)",
  "--diffs-selection-color-override": "var(--primary)",
  "--diffs-bg-selection-override":
    "color-mix(in srgb, var(--primary) 12%, var(--code-background))",
  "--diffs-bg-selection-number-override":
    "color-mix(in srgb, var(--primary) 28%, var(--code-background))",
} as CSSProperties;
const diffCSS = `
  pre, [data-diff], [data-code] { background-color: var(--code-background); }
  [data-line-type="change-addition"], [data-line-type="change-addition"] [data-column-number] { background-color: var(--diff-add); }
  [data-line-type="change-deletion"], [data-line-type="change-deletion"] [data-column-number] { background-color: var(--diff-remove); }
`;
function DiffPatch({
  path,
  patch,
  rows,
  comments,
  diffStyle,
  selectedLine,
  form,
  onSelect,
}: {
  path: string;
  patch: string;
  rows: DiffLine[];
  comments: ReviewComment[];
  diffStyle: DiffStyle;
  selectedLine: number | null;
  form: ReactNode;
  onSelect?: (line: number) => void;
}) {
  const themeType = useThemeType();
  const fileDiff = useMemo(
    () => parsePatchFiles(withFileHeader(path, patch))[0]?.files[0],
    [path, patch],
  );
  const select = useRef(onSelect);
  select.current = onSelect;
  const commentable = onSelect !== undefined;
  const options = useMemo<FileDiffOptions<Note, undefined>>(
    () => ({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType,
      diffStyle,
      diffIndicators: "classic",
      hunkSeparators: "metadata",
      lineDiffType: "word-alt",
      overflow: "scroll",
      disableFileHeader: true,
      unsafeCSS: diffCSS,
      enableGutterUtility: commentable,
      lineHoverHighlight: commentable ? "both" : "disabled",
      onGutterUtilityClick: (range) => {
        const row = rowForTarget(rows, range.endSide ?? range.side, range.end);
        if (row) select.current?.(row);
      },
    }),
    [themeType, diffStyle, commentable, rows],
  );
  const target = selectedLine ? targetForRow(rows, selectedLine) : null;
  const selectedLines = useMemo(
    () =>
      target
        ? {
            start: target.lineNumber,
            end: target.lineNumber,
            side: target.side,
          }
        : null,
    [target?.side, target?.lineNumber],
  );
  const annotations = useMemo(() => {
    const notes: DiffLineAnnotation<Note>[] = [];
    for (const comment of comments) {
      const at = targetForRow(rows, comment.line);
      if (at) notes.push({ ...at, metadata: { kind: "comment", comment } });
    }
    if (target) notes.push({ ...target, metadata: { kind: "form" } });
    return notes;
  }, [comments, rows, target?.side, target?.lineNumber]);
  if (!fileDiff || !rows.some((line) => line.kind !== "meta")) {
    return (
      <p className="bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground">
        No text diff (binary file).
      </p>
    );
  }
  return (
    <div className="max-h-[32rem] overflow-auto bg-[var(--code-background)]">
      <FileDiff<Note>
        fileDiff={fileDiff}
        options={options}
        style={diffSurface}
        lineAnnotations={annotations}
        selectedLines={selectedLines}
        renderAnnotation={(annotation) =>
          annotation.metadata.kind === "form" ? (
            form
          ) : (
            <div className="border-l-2 border-primary bg-card px-3 py-1.5 font-sans text-xs text-foreground whitespace-pre-wrap break-words">
              <span className="font-medium text-primary">
                {annotation.metadata.comment.state === "draft"
                  ? "Draft"
                  : "Requested"}
                :{" "}
              </span>
              {annotation.metadata.comment.body}
            </div>
          )
        }
      />
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
