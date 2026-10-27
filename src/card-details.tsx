import { useEffect, useState, type CSSProperties } from "react";
import { Check, Copy, Maximize2, Minimize2, Square } from "lucide-react";
import { api } from "./api.js";
import { AgentBadge, AttemptList, CostBadge } from "./attempts.js";
import { Markdown } from "./markdown-view.js";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog";
import { MergeConflictPanel, ReviewPanel } from "./review.js";
import { PullRequestDialog } from "./pr-dialog.js";
import {
  priorities,
  type AutoReviewJob,
  type BakerySettings,
  type Card,
  type MergeConflict,
  type Priority,
  type ReviewComment,
  type ReviewDiff,
  type Run,
  type Status,
} from "./model.js";
import { MainReset, type MainRecovery } from "./local-merges.js";
import {
  asPushProgress,
  PushProgressPanel,
  type PushProgress,
} from "./push-progress.js";

type Props = {
  boardId: string;
  /** The board's integration mode; github-pr approves by opening a pull request. */
  integration?: "local" | "github-pr";
  card: Card | undefined;
  /** The cards on this card's board that the page has loaded, for naming and choosing dependencies. */
  boardCards: Card[];
  onOpenCard: (id: string) => void;
  /** Opens the repository's Pull requests page on this card's PR; absent when the remote has none. */
  onOpenPullRequest?: () => void;
  settings: BakerySettings | null;
  conflict: MergeConflict | undefined;
  onClose: () => void;
  onEdit: (card: Card) => void;
  onRefresh: () => void;
  onError: (message: string) => void;
  onConflict: (conflict: MergeConflict | null) => void;
  /** Set while reviewing cards one at a time from Today. */
  queue?: { position: number; total: number; onNext: () => void };
};

export function CardDetails({
  boardId,
  integration = "local",
  card,
  boardCards,
  onOpenCard,
  onOpenPullRequest,
  settings,
  conflict: mergeConflict,
  onClose,
  onEdit,
  onRefresh,
  onError,
  onConflict,
  queue,
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
  const [mainRecovery, setMainRecovery] = useState<MainRecovery | null>(null);
  useEffect(() => setMainRecovery(null), [cardId]);
  const [approvalPending, setApprovalPending] = useState(false);
  const [pushProgress, setPushProgress] = useState<PushProgress | null>(null);
  useEffect(() => setPushProgress(null), [cardId]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [prDialog, setPrDialog] = useState(false);
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
        const [attempts, approval, annotations, jobs, push] = await Promise.all(
          [
            api<Run[]>(`/boards/${boardId}/cards/${cardId}/runs`),
            api<{ pending: boolean }>(
              `/boards/${boardId}/cards/${cardId}/approval`,
            ),
            api<ReviewComment[]>(`/boards/${boardId}/cards/${cardId}/comments`),
            api<AutoReviewJob[]>(
              `/boards/${boardId}/cards/${cardId}/auto-review`,
            ),
            api<PushProgress | null>(
              `/boards/${boardId}/cards/${cardId}/push-progress`,
            ),
          ],
        );
        if (current) {
          setPushProgress(asPushProgress(push));
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
  // The diff is a snapshot. Watch its fingerprint so a change in the worktree or main is announced
  // instead of surfacing later as a failed Approve. Never reload on its own: a comment may be half typed.
  const [reviewStale, setReviewStale] = useState(false);
  const loadedFingerprint =
    review && review.cardId === cardId ? review.fingerprint : null;
  useEffect(() => {
    setReviewStale(false);
    if (!cardId || !loadedFingerprint) return;
    let active = true;
    const timer = setInterval(() => {
      void api<{ fingerprint: string }>(
        `/boards/${boardId}/cards/${cardId}/review?fingerprint`,
      )
        .then((next) => {
          if (active && next.fingerprint !== loadedFingerprint)
            setReviewStale(true);
        })
        .catch(() => {});
    }, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [boardId, cardId, loadedFingerprint]);
  const currentReview = review?.cardId === cardId ? review : null;
  const currentComments = comments.filter((item) => item.cardId === cardId);
  const changesRequested =
    card?.status === "review" &&
    currentComments.some(
      (item) => item.runId === runs[0]?.id && item.state === "requested",
    );
  // While a push runs (Approve, or an automatic CI fix), follow its output more often than the 2s board poll.
  const pushing = !!pushProgress && !pushProgress.finishedAt;
  useEffect(() => {
    if (!cardId || !(busy || pushing)) return;
    let current = true;
    const timer = window.setInterval(() => {
      void api<PushProgress | null>(
        `/boards/${boardId}/cards/${cardId}/push-progress`,
      )
        .then((value) => {
          if (current) setPushProgress(asPushProgress(value));
        })
        .catch(() => {});
    }, 700);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [boardId, cardId, busy, pushing]);
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
        {queue && (
          <div className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-accent/30 px-3 py-2 text-xs">
            <span
              role="status"
              aria-label="Review queue"
              className="text-muted-foreground"
            >
              Reviewing{" "}
              <strong className="font-mono text-foreground">
                {queue.position} of {queue.total}
              </strong>
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={queue.onNext}
            >
              {queue.position < queue.total ? "Next card" : "Finish"}
            </Button>
          </div>
        )}
        {card && (
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            Priority
            <select
              aria-label="Card priority"
              value={card.priority ?? 0}
              disabled={busy || card.status === "running"}
              title={
                card.status === "running"
                  ? "Priority cannot change while a run is active"
                  : "Higher priority Ready cards are picked up first"
              }
              onChange={(event) => {
                const priority = Number(event.target.value) as Priority;
                void action(() =>
                  api<Card>(`/boards/${boardId}/cards/${card.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({
                      title: card.title,
                      body: card.body,
                      priority,
                    }),
                  }),
                );
              }}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            >
              {priorities.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {card &&
          integration === "github-pr" &&
          card.status === "done" &&
          card.locallyMerged && (
            <div className="mt-4 rounded-md border border-border p-3 text-xs">
              <p>
                Bakery merged this card into local main, not through a pull
                request. Publish as PR pushes the approved work to bakery/
                {card.id}, opens a pull request, and moves the card back to
                Review until the PR merges.
              </p>
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    const result = await api<{ main: MainRecovery | null }>(
                      `/boards/${boardId}/cards/${card.id}/publish`,
                      { method: "POST" },
                    );
                    setMainRecovery(result.main);
                  })
                }
              >
                Publish as PR
              </Button>
            </div>
          )}
        {card && mainRecovery && (
          <MainReset
            boardId={boardId}
            main={mainRecovery}
            onError={(message) => {
              setError(message);
              onError(message);
            }}
            onReset={(main) => {
              setMainRecovery(main);
              refresh();
            }}
          />
        )}
        {card && integration === "github-pr" && (
          <PullRequestLink
            onOpenPullRequest={card.prState === "OPEN" ? onOpenPullRequest : undefined}
            card={card}
            busy={busy}
            onSave={(url) =>
              action(() =>
                api<Card>(`/boards/${boardId}/cards/${card.id}/pull-request`, {
                  method: "PUT",
                  body: JSON.stringify({ url }),
                }),
              )
            }
          />
        )}
        {card && (
          <Dependencies
            card={card}
            boardCards={boardCards}
            busy={busy}
            onOpenCard={onOpenCard}
            onChange={(path, method, input) =>
              void action(() =>
                api<Card>(`/boards/${boardId}/cards/${card.id}/${path}`, {
                  method,
                  body: input && JSON.stringify(input),
                }),
              )
            }
          />
        )}
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
        {card?.idempotencyKey && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Idempotency key</span>
            <code className="select-all break-all font-mono text-foreground">
              {card.idempotencyKey}
            </code>
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
        {card?.body?.trim() ? (
          <Markdown
            source={card.body}
            className="mt-6 text-sm leading-6 text-foreground/80"
          />
        ) : (
          <p className="mt-6 text-sm leading-6 text-foreground/80">
            No description.
          </p>
        )}
        {card &&
          ["review", "done", "archived"].includes(card.status) &&
          runs[0]?.status === "review" &&
          runs[0].report && (
            <RunReport
              report={runs[0].report}
              findingsOnly={
                card.status === "review" && currentReview?.files.length === 0
              }
              onCopyError={() =>
                setError(
                  "Could not copy the report. Select its text to copy it manually.",
                )
              }
            />
          )}
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
                  : autoJobs[0].requeued
                    ? "interrupted by a restart, queued again"
                    : "needs human review"}
            </strong>{" "}
            <AgentBadge
              phase="Review"
              agent={autoJobs[0].agent}
              pending={autoJobs[0].state === "running"}
            />{" "}
            <CostBadge usage={autoJobs[0]} label="Review cost" />
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
          {card?.status === "review" && currentReview?.files.length === 0 && (
            <Button
              variant="outline"
              disabled={
                busy ||
                approvalPending ||
                autoJobs.some(
                  (item) =>
                    item.runId === runs[0]?.id && item.state === "running",
                )
              }
              onClick={() => {
                if (
                  !window.confirm(
                    "Accept this run's report and move the card to Done? The run changed no files, so nothing is merged or pushed.",
                  )
                )
                  return;
                void action(() =>
                  api(`/boards/${boardId}/cards/${card.id}/accept-findings`, {
                    method: "POST",
                    body: JSON.stringify({
                      fingerprint: currentReview.fingerprint,
                    }),
                  }),
                );
              }}
            >
              <Check size={13} /> Accept findings
            </Button>
          )}
          {card?.status === "review" && currentReview?.files.length !== 0 && (
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
                // A new PR's title and body are drafted from the repository's rules and edited in a dialog.
                if (
                  currentReview &&
                  integration === "github-pr" &&
                  card.prState !== "OPEN"
                ) {
                  setError("");
                  setPrDialog(true);
                  return;
                }
                if (
                  !currentReview ||
                  !window.confirm(
                    integration === "github-pr" && card.prState === "OPEN"
                      ? `Approve the reviewed diff and push it to pull request #${card.prNumber}? Bakery commits unignored files on bakery/${card.id} and pushes that branch to origin, which updates the open PR. The card is Done once the PR merges on GitHub.`
                      : integration === "github-pr"
                        ? `Approve the reviewed diff and open a pull request for ${card.repo}? Bakery commits unignored files on bakery/${card.id}, pushes that branch to origin, and runs gh pr create. Nothing merges locally; the card is Done once the PR merges on GitHub.`
                        : `Approve the reviewed diff and merge into local main for ${card.repo}? This commits unignored files. Git refuses to overwrite conflicting local changes. Bakery checks Git conflicts and whitespace, but does not run tests or push.`,
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
              {integration === "github-pr" && card.prState === "OPEN"
                ? `Approve and update PR #${card.prNumber}`
                : integration === "github-pr"
                  ? "Approve and open PR"
                  : "Approve and merge into local main"}
            </Button>
          )}
          {card?.status === "review" && currentReview && (
            <PullRequestDialog
              boardId={boardId}
              card={card}
              fingerprint={currentReview.fingerprint}
              open={prDialog}
              busy={busy}
              submitError={error}
              onOpenChange={setPrDialog}
              onSubmit={(title, body) => {
                onConflict(null);
                void action(() =>
                  api(`/boards/${boardId}/cards/${card.id}/approve`, {
                    method: "POST",
                    body: JSON.stringify({
                      fingerprint: currentReview.fingerprint,
                      title,
                      body,
                    }),
                  }),
                ).then((ok) => {
                  if (ok) setPrDialog(false);
                });
              }}
            />
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
        {pushProgress &&
          (pushing || (pushProgress.error && card?.status === "review")) && (
            <PushProgressPanel progress={pushProgress} />
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
            stale={reviewStale}
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
        {runs.length > 0 && (
          <AttemptList key={card?.id} runs={runs} card={card} />
        )}
      </DialogContent>
    </Dialog>
  );
}

const statusLabel = (status: Status) =>
  status === "done" || status === "archived" ? "finished" : status;
/** Lists the cards this one waits on (each opens that card), lets you add or remove one, and names the cards waiting on it. */
/** github-pr boards: the card's pull request, its state and checks, and an optional link that overrides the branch lookup. */
function PullRequestLink({
  card,
  busy,
  onSave,
  onOpenPullRequest,
}: {
  onOpenPullRequest?: () => void;
  card: Card;
  busy: boolean;
  onSave: (url: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(card.prOverrideUrl ?? "");
  const state = card.prState
    ? { OPEN: "open", CLOSED: "closed", MERGED: "merged" }[card.prState]
    : undefined;
  return (
    <div className="mt-3 text-xs text-muted-foreground">
      <div>
        Pull request:{" "}
        {card.prUrl ? (
          <a
            href={card.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-2 hover:underline"
          >
            #{card.prNumber}
          </a>
        ) : (
          `none yet (looks for bakery/${card.id})`
        )}
        {onOpenPullRequest && (
          <>
            {" \u00b7 "}
            <button
              onClick={onOpenPullRequest}
              className="text-primary underline-offset-2 hover:underline"
            >
              View in Pull requests
            </button>
          </>
        )}
        {state && ` \u00b7 ${state}`}
        {card.prChecks && ` \u00b7 checks ${card.prChecks}`}
        {!!card.ciReworks &&
          ` \u00b7 sent back for CI ${card.ciReworks} time${card.ciReworks === 1 ? "" : "s"}`}
      </div>
      {card.prError && (
        <div role="status" className="mt-1 text-destructive">
          {card.prError}
        </div>
      )}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(draft.trim());
        }}
      >
        <input
          type="url"
          aria-label="Pull request link"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={busy}
          placeholder="https://github.com/owner/repo/pull/123 (optional)"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={busy || draft.trim() === (card.prOverrideUrl ?? "")}
        >
          {draft.trim() || !card.prOverrideUrl ? "Link PR" : "Unlink"}
        </Button>
      </form>
    </div>
  );
}

function Dependencies({
  card,
  boardCards,
  busy,
  onOpenCard,
  onChange,
}: {
  card: Card;
  boardCards: Card[];
  busy: boolean;
  onOpenCard: (id: string) => void;
  onChange: (
    path: string,
    method: "POST" | "DELETE",
    input?: { dependsOn: string },
  ) => void;
}) {
  const dependsOn = card.dependsOn ?? [];
  // Today leaves archived cards out of its list; a dependency it cannot name is one of those.
  const parents = dependsOn.map(
    (id) =>
      boardCards.find((item) => item.id === id) ?? {
        id,
        title: id,
        status: "archived" as const,
      },
  );
  const dependents = boardCards.filter((item) =>
    item.dependsOn?.includes(card.id),
  );
  const choices = boardCards.filter(
    (item) =>
      item.id !== card.id &&
      item.status !== "archived" &&
      !dependsOn.includes(item.id),
  );
  const link = (item: { id: string; title: string; status: Status }) => (
    <button
      type="button"
      className="truncate text-left text-foreground underline-offset-2 hover:text-primary hover:underline"
      onClick={() => onOpenCard(item.id)}
    >
      {item.title}
    </button>
  );
  return (
    <section
      aria-label="Dependencies"
      className="mt-2 space-y-1 text-xs text-muted-foreground"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {card.blocked
            ? "Waits until these are Done:"
            : dependsOn.length
              ? "Depends on:"
              : "No dependencies"}
        </span>
        <select
          aria-label="Add dependency"
          value=""
          disabled={busy || !choices.length}
          onChange={(event) =>
            event.target.value &&
            onChange("dependencies", "POST", { dependsOn: event.target.value })
          }
          className="ml-auto max-w-56 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
        >
          <option value="">Add dependency…</option>
          {choices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </div>
      {parents.length > 0 && (
        <ul className="space-y-1">
          {parents.map((item) => (
            <li
              key={item.id}
              data-testid="dependency"
              className="flex items-center gap-2"
            >
              {link(item)}
              <span className="font-mono text-[10px] uppercase">
                {statusLabel(item.status)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                aria-label={`Remove dependency on ${item.title}`}
                disabled={busy}
                onClick={() => onChange(`dependencies/${item.id}`, "DELETE")}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {dependents.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span>Needed by:</span>
          {dependents.map((item) => (
            <span key={item.id}>{link(item)}</span>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The run's final message, rendered as markdown. A run that changed no files (a research card) has nothing else
 * to review, so its report is labelled as the card's findings.
 */
function RunReport({
  report,
  findingsOnly,
  onCopyError,
}: {
  report: string;
  findingsOnly: boolean;
  onCopyError: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <section
      aria-label={findingsOnly ? "Findings" : "Agent report"}
      className="mt-6 rounded-md border border-border bg-accent/10 p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {findingsOnly ? "Findings" : "Agent report"}
        </h3>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Copy report as markdown"
          onClick={() => {
            void navigator.clipboard
              .writeText(report)
              .then(() => setCopied(true))
              .catch(onCopyError);
          }}
        >
          {copied ? (
            <>
              <Check size={13} /> Copied
            </>
          ) : (
            <>
              <Copy size={13} /> Copy markdown
            </>
          )}
        </Button>
      </div>
      {findingsOnly && (
        <p className="mt-1 text-xs text-muted-foreground">
          This run changed no files. Its final message is the result.
        </p>
      )}
      <Markdown
        source={report}
        className="mt-3 text-sm leading-6 text-foreground/80"
      />
    </section>
  );
}
