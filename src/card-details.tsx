import { useEffect, useState, type CSSProperties } from "react";
import { Check, Copy, Maximize2, Minimize2, Square } from "lucide-react";
import { api } from "./api.js";
import { AttemptList } from "./attempts.js";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog";
import { MergeConflictPanel, ReviewPanel } from "./review.js";
import type {
  AutoReviewJob,
  BakerySettings,
  Card,
  MergeConflict,
  ReviewComment,
  ReviewDiff,
  Run,
} from "./model.js";

type Props = {
  boardId: string;
  card: Card | undefined;
  settings: BakerySettings | null;
  conflict: MergeConflict | undefined;
  onClose: () => void;
  onEdit: (card: Card) => void;
  onRefresh: () => void;
  onError: (message: string) => void;
  onConflict: (conflict: MergeConflict | null) => void;
};

export function CardDetails({
  boardId,
  card,
  settings,
  conflict: mergeConflict,
  onClose,
  onEdit,
  onRefresh,
  onError,
  onConflict,
}: Props) {
  const cardId = card?.id;
  const [runs, setRuns] = useState<Run[]>([]);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [autoJobs, setAutoJobs] = useState<AutoReviewJob[]>([]);
  const [copiedCardId, setCopiedCardId] = useState<string | null>(null);
  const [expandedDetails, setExpandedDetails] = useState(false);
  const [sideWidth, setSideWidth] = useState(
    () => Number(localStorage.getItem("bakery-side-width")) || 900,
  );
  const [smallScreen, setSmallScreen] = useState(
    () => window.matchMedia("(max-width: 1023px)").matches,
  );
  const [review, setReview] = useState<ReviewDiff | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [reviewRefresh, setReviewRefresh] = useState(0);
  const [approvalPending, setApprovalPending] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const refresh = () => {
    setReload((value) => value + 1);
    onRefresh();
  };
  useEffect(() => {
    if (!copiedCardId) return;
    const timer = window.setTimeout(() => setCopiedCardId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedCardId]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setSmallScreen(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!cardId) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [attempts, approval, annotations, jobs] = await Promise.all([
          api<Run[]>(`/boards/${boardId}/cards/${cardId}/runs`),
          api<{ pending: boolean }>(
            `/boards/${boardId}/cards/${cardId}/approval`,
          ),
          api<ReviewComment[]>(`/boards/${boardId}/cards/${cardId}/comments`),
          api<AutoReviewJob[]>(
            `/boards/${boardId}/cards/${cardId}/auto-review`,
          ),
        ]);
        if (current) {
          setRuns(attempts);
          setApprovalPending(approval.pending);
          setComments(annotations);
          setAutoJobs(jobs);
        }
      } catch (err) {
        if (current) {
          setError(String(err));
          onError(String(err));
        }
      } finally {
        if (current) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [boardId, cardId, reload]);
  useEffect(() => {
    if (!cardId || card?.status !== "review") {
      setReview(null);
      setReviewError("");
      return;
    }
    let active = true;
    setReview(null);
    setReviewError("");
    void api<Omit<ReviewDiff, "cardId">>(
      `/boards/${boardId}/cards/${cardId}/review`,
    )
      .then((diff) => {
        if (active) setReview({ ...diff, cardId });
      })
      .catch((err) => {
        if (active)
          setReviewError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [boardId, cardId, card?.status, reviewRefresh]);
  const currentReview = review?.cardId === cardId ? review : null;
  const currentComments = comments.filter((item) => item.cardId === cardId);
  const changesRequested =
    card?.status === "review" &&
    currentComments.some(
      (item) => item.runId === runs[0]?.id && item.state === "requested",
    );
  const side = settings?.cardDetailsLayout === "side";
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    onError("");
    try {
      await fn();
      refresh();
      return true;
    } catch (err) {
      const conflict =
        err instanceof Error && "conflict" in err
          ? (err.conflict as MergeConflict | undefined)
          : undefined;
      if (conflict) onConflict(conflict);
      else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        onError(message);
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={true}
      modal={!side || expandedDetails || smallScreen}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          setExpandedDetails(false);
        }
      }}
    >
      <DialogContent
        showOverlay={!side || expandedDetails || smallScreen}
        overlayClassName={side ? "bg-black/25 backdrop-blur-none" : undefined}
        style={
          side && !expandedDetails
            ? ({ "--card-width": `${sideWidth}px` } as CSSProperties)
            : undefined
        }
        className={
          expandedDetails
            ? "left-0 top-0 h-[100dvh] max-h-[100dvh] w-screen translate-x-0 translate-y-0 rounded-none"
            : side
              ? "right-0 left-auto top-0 h-[100dvh] max-h-[100dvh] w-screen translate-x-0 translate-y-0 rounded-none lg:w-[min(var(--card-width),95vw)]"
              : "w-[min(94vw,750px)]"
        }
      >
        {side && !expandedDetails && (
          <div
            role="separator"
            aria-label="Resize card panel"
            aria-orientation="vertical"
            aria-valuenow={sideWidth}
            tabIndex={0}
            onPointerDown={(event) =>
              event.currentTarget.setPointerCapture(event.pointerId)
            }
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                const width = Math.min(
                  window.innerWidth - 80,
                  Math.max(520, window.innerWidth - event.clientX),
                );
                setSideWidth(width);
                localStorage.setItem("bakery-side-width", String(width));
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                return;
              event.preventDefault();
              setSideWidth((previous) => {
                const width = Math.min(
                  window.innerWidth - 80,
                  Math.max(
                    520,
                    previous + (event.key === "ArrowLeft" ? 32 : -32),
                  ),
                );
                localStorage.setItem("bakery-side-width", String(width));
                return width;
              });
            }}
            className="absolute inset-y-0 left-0 hidden w-2 cursor-ew-resize bg-transparent hover:bg-primary/30 focus-visible:bg-primary/40 lg:block"
          />
        )}
        <DialogTitle className="pr-7 text-xl font-semibold tracking-tight">
          {card?.title}
        </DialogTitle>
        <DialogDescription className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded bg-primary/10 px-2 py-1 uppercase tracking-wider text-primary">
            {card?.status}
          </span>{" "}
          Manual card · {card && card.repo}
        </DialogDescription>
        {card && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Card ID</span>
            <code className="select-all font-mono text-foreground">
              {card.id}
            </code>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Copy card ID"
              onClick={() => {
                void navigator.clipboard
                  .writeText(card.id)
                  .then(() => setCopiedCardId(card.id))
                  .catch(() =>
                    setError(
                      "Could not copy the card ID. Select the ID above to copy it manually.",
                    ),
                  );
              }}
            >
              {copiedCardId === card.id ? (
                <>
                  <Check size={13} /> Copied
                </>
              ) : (
                <>
                  <Copy size={13} /> Copy ID
                </>
              )}
            </Button>
          </div>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="mt-3"
          onClick={() => setExpandedDetails((value) => !value)}
        >
          {expandedDetails ? (
            <>
              <Minimize2 size={13} /> Exit full screen
            </>
          ) : (
            <>
              <Maximize2 size={13} /> Expand review
            </>
          )}
        </Button>
        <p className="mt-6 whitespace-pre-wrap text-sm leading-6 text-foreground/80">
          {card?.body || "No description."}
        </p>
        {card?.status === "failed" && runs[0]?.error && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm"
          >
            <strong>Run failed</strong>
            <p className="mt-1 text-destructive">{runs[0].error}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Inspect the latest attempt and its worktree below before retrying.
              No changes were merged from this run.
            </p>
          </div>
        )}
        {autoJobs[0] && autoJobs[0].cardId === card?.id && (
          <div className="mt-4 rounded-md border border-border bg-accent/20 p-3 text-xs">
            <strong>
              Agent review:{" "}
              {autoJobs[0].state === "running"
                ? "checking"
                : autoJobs[0].state === "merged"
                  ? "merged locally"
                  : "needs human review"}
            </strong>
            {autoJobs[0].details && (
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                {autoJobs[0].details}
              </p>
            )}
          </div>
        )}
        {mergeConflict && card?.id === mergeConflict.cardId && (
          <MergeConflictPanel
            conflict={mergeConflict}
            onDismiss={() =>
              void action(async () => {
                await api(
                  `/boards/${boardId}/cards/${mergeConflict.cardId}/conflict`,
                  { method: "DELETE" },
                );
                onConflict(null);
              })
            }
          />
        )}
        <div className="mt-6 flex flex-wrap gap-2 border-t border-border pt-5">
          {card && card.status !== "running" && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                onEdit(card);
              }}
            >
              Edit card
            </Button>
          )}
          {card?.status === "triage" && (
            <Button
              disabled={busy}
              onClick={() =>
                action(() =>
                  api(`/boards/${boardId}/cards/${card.id}/status`, {
                    method: "POST",
                    body: JSON.stringify({ status: "ready" }),
                  }),
                )
              }
            >
              Move to Ready
            </Button>
          )}
          {card?.status === "ready" && runs.length === 0 && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                action(() =>
                  api(`/boards/${boardId}/cards/${card.id}/status`, {
                    method: "POST",
                    body: JSON.stringify({ status: "triage" }),
                  }),
                )
              }
            >
              Move to Triage
            </Button>
          )}
          {card && ["ready", "failed", "review"].includes(card.status) && (
            <Button
              disabled={
                busy ||
                !settings ||
                (card.status === "review" &&
                  (approvalPending ||
                    autoJobs.some(
                      (item) =>
                        item.cardId === card.id && item.state === "running",
                    ) ||
                    currentComments.some(
                      (item) =>
                        item.runId === runs[0]?.id && item.state === "draft",
                    )))
              }
              onClick={() => {
                if (
                  settings?.confirmRunStart &&
                  !window.confirm(
                    "Start Pi on this card? This run may use paid model tokens and can edit its Git worktree.",
                  )
                )
                  return;
                void action(() =>
                  api(`/boards/${boardId}/cards/${card.id}/start`, {
                    method: "POST",
                  }),
                );
              }}
            >
              <span className="text-base">✳</span>{" "}
              {mergeConflict && ["review", "failed"].includes(card.status)
                ? "Fix conflict with Pi"
                : runs.length
                  ? "Run again"
                  : "Start Pi run"}
            </Button>
          )}
          {card?.status === "running" && runs[0] && (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                action(() =>
                  api(`/boards/${boardId}/cards/${card.id}/stop`, {
                    method: "POST",
                  }),
                )
              }
            >
              <Square size={13} /> Stop run
            </Button>
          )}
          {card?.status === "review" && (
            <Button
              variant="outline"
              disabled={
                busy ||
                !currentReview ||
                changesRequested ||
                autoJobs.some(
                  (item) =>
                    item.runId === runs[0]?.id && item.state === "running",
                ) ||
                currentComments.some(
                  (item) =>
                    item.runId === runs[0]?.id && item.state === "draft",
                )
              }
              onClick={() => {
                if (
                  !currentReview ||
                  !window.confirm(
                    `Approve the reviewed diff and merge into local main for ${card.repo}? This commits unignored files. Git refuses to overwrite conflicting local changes. Bakery checks Git conflicts and whitespace, but does not run tests or push.`,
                  )
                )
                  return;
                onConflict(null);
                void action(() =>
                  api(`/boards/${boardId}/cards/${card.id}/approve`, {
                    method: "POST",
                    body: JSON.stringify({
                      fingerprint: currentReview.fingerprint,
                    }),
                  }),
                );
              }}
            >
              Approve and merge
            </Button>
          )}
          {card?.status === "review" && !changesRequested && (
            <Button
              variant="outline"
              disabled={
                busy ||
                !currentReview ||
                approvalPending ||
                currentComments.some(
                  (item) =>
                    item.state === "draft" &&
                    item.runId === runs[0]?.id &&
                    item.fingerprint !== currentReview?.fingerprint,
                ) ||
                !currentComments.some(
                  (item) =>
                    item.state === "draft" &&
                    item.runId === runs[0]?.id &&
                    item.fingerprint === currentReview?.fingerprint,
                )
              }
              onClick={() => {
                if (!currentReview) return;
                void action(async () => {
                  setComments(
                    await api<ReviewComment[]>(
                      `/boards/${boardId}/cards/${card.id}/request-changes`,
                      {
                        method: "POST",
                        body: JSON.stringify({
                          fingerprint: currentReview.fingerprint,
                        }),
                      },
                    ),
                  );
                });
              }}
            >
              Request changes
            </Button>
          )}
          {changesRequested && (
            <span className="self-center text-xs text-muted-foreground">
              Changes requested. Run again when ready; Pi will receive your
              feedback.
            </span>
          )}
          {card?.status === "review" &&
            currentReview &&
            currentComments.some(
              (item) =>
                item.runId === runs[0]?.id &&
                item.state === "draft" &&
                item.fingerprint !== currentReview.fingerprint,
            ) && (
              <span className="self-center text-xs text-muted-foreground">
                Remove draft comments on older diffs before submitting feedback.
              </span>
            )}
          {card?.status === "review" && approvalPending && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    "Withdraw the pending approval? The card's Git commits and worktree remain. You can revise the card and try again.",
                  )
                )
                  return;
                void action(() =>
                  api(`/boards/${boardId}/cards/${card.id}/withdraw`, {
                    method: "POST",
                  }),
                );
              }}
            >
              Withdraw approval
            </Button>
          )}
          {card &&
            ["triage", "ready"].includes(card.status) &&
            runs.length === 0 && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  action(() =>
                    api(`/boards/${boardId}/cards/${card.id}/status`, {
                      method: "POST",
                      body: JSON.stringify({ status: "done" }),
                    }),
                  )
                }
              >
                Mark done
              </Button>
            )}
          {card?.status === "done" && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                action(() =>
                  api(`/boards/${boardId}/cards/${card.id}/status`, {
                    method: "POST",
                    body: JSON.stringify({ status: "ready" }),
                  }),
                )
              }
            >
              Reopen
            </Button>
          )}
          {card?.status === "done" && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                action(() =>
                  api(`/boards/${boardId}/cards/archive`, {
                    method: "POST",
                    body: JSON.stringify({ cardIds: [card.id] }),
                  }),
                )
              }
            >
              Archive
            </Button>
          )}
          {card?.status === "archived" && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                action(() =>
                  api(`/boards/${boardId}/cards/unarchive`, {
                    method: "POST",
                    body: JSON.stringify({ cardIds: [card.id] }),
                  }),
                )
              }
            >
              Restore to Done
            </Button>
          )}
        </div>
        {card?.status === "interrupted" && (
          <div className="mt-4 rounded-lg border border-primary/30 bg-primary/10 p-3 text-xs text-primary">
            <p>
              The server restarted during this run. Inspect its worktree and
              confirm the Pi process has stopped before releasing the card.
            </p>
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "I inspected the worktree and confirmed the old Pi process has stopped. Release this card for retry?",
                  )
                )
                  void action(() =>
                    api(`/boards/${boardId}/cards/${card.id}/resolve`, {
                      method: "POST",
                      body: JSON.stringify({ acknowledged: true }),
                    }),
                  );
              }}
            >
              Release for retry
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {card?.status === "review" && (
          <ReviewPanel
            review={currentReview}
            error={reviewError}
            comments={currentComments}
            runId={runs[0]?.id}
            busy={busy}
            onRefresh={() => setReviewRefresh((value) => value + 1)}
            onAdd={(path, line, body) =>
              action(async () => {
                const saved = await api<ReviewComment>(
                  `/boards/${boardId}/cards/${card.id}/comments`,
                  {
                    method: "POST",
                    body: JSON.stringify({
                      fingerprint: currentReview?.fingerprint,
                      path,
                      line,
                      body,
                    }),
                  },
                );
                setComments((previous) => [...previous, saved]);
              })
            }
            onDelete={(id) =>
              action(async () => {
                await api(
                  `/boards/${boardId}/cards/${card.id}/comments/${id}`,
                  { method: "DELETE" },
                );
                setComments((previous) =>
                  previous.filter((item) => item.id !== id),
                );
              })
            }
          />
        )}
        {runs.length > 0 && <AttemptList key={card?.id} runs={runs} />}
      </DialogContent>
    </Dialog>
  );
}
