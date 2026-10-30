import { useEffect, useState, type CSSProperties } from "react";
import {
  Check,
  Copy,
  Maximize2,
  Minimize2,
  Pencil,
  Square,
} from "lucide-react";
import { api } from "./api.js";
import { AgentBadge, AttemptList, CostBadge } from "./attempts.js";
import { CardHistory, type CardHistoryEntry } from "./card-history.js";
import { CardAttachments } from "./attachments.js";
import { DiscussionPanel } from "./discussion.js";
import { CardLinks, Markdown } from "./markdown-view.js";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog";
import { followUps } from "./follow-ups.js";
import { parsePlan, type Subtask } from "./plan.js";
import { MergeConflictPanel, ReviewPanel } from "./review.js";
import { PullRequestDialog } from "./pr-dialog.js";
import {
  PRIORITY_MAX,
  PRIORITY_MIN,
  parsePriorityInput,
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
  /** Shows a card the server just returned without waiting for the next poll. */
  onCardUpdated: (card: Card) => void;
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
  onCardUpdated,
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
  const [tab, setTab] = useState<
    "overview" | "reviews" | "attempts" | "discuss" | "details"
  >("overview");
  const [reply, setReply] = useState("");
  useEffect(() => {
    setTab("overview");
    setReply("");
  }, [cardId]);
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
  const [history, setHistory] = useState<CardHistoryEntry[]>([]);
  useEffect(() => setHistory([]), [cardId]);
  useEffect(() => setPushProgress(null), [cardId]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [prDialog, setPrDialog] = useState(false);
  // A PR draft already started for this diff (before a close or refresh): the button reopens it.
  const [draftStarted, setDraftStarted] = useState(false);
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
        const [attempts, approval, annotations, jobs, push, events] =
          await Promise.all([
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
            api<CardHistoryEntry[]>(
              `/boards/${boardId}/cards/${cardId}/history`,
            ),
          ]);
        if (current) {
          setHistory(events);
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
  const reviewFingerprint = currentReview?.fingerprint;
  useEffect(() => {
    setDraftStarted(false);
    if (!cardId || !reviewFingerprint || !boardId) return;
    let current = true;
    api<{ fingerprint: string | null }>(
      `/boards/${boardId}/cards/${cardId}/pr-draft`,
    )
      .then((job) => {
        if (current) setDraftStarted(job.fingerprint === reviewFingerprint);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [boardId, cardId, reviewFingerprint]);
  const currentComments = comments.filter((item) => item.cardId === cardId);
  const reviewEntries = [...runs]
    .sort((a, b) => b.attempt - a.attempt)
    .map((run) => ({
      attempt: run.attempt,
      job: autoJobs.find((job) => job.runId === run.id),
      requested: currentComments.filter(
        (item) => item.runId === run.id && item.state === "requested",
      ),
    }))
    .filter((item) => item.job || item.requested.length);
  // The diff lives in this tab, so a card in review has it even when no agent review ever ran.
  const hasReviews = reviewEntries.length > 0 || card?.status === "review";
  const hasAttempts = runs.length > 0;
  useEffect(() => {
    if (
      (tab === "reviews" && !hasReviews) ||
      (tab === "attempts" && !hasAttempts)
    )
      setTab("overview");
  }, [tab, hasReviews, hasAttempts]);
  const changesRequested =
    card?.status === "review" &&
    currentComments.some(
      (item) => item.runId === runs[0]?.id && item.state === "requested",
    );
  const reviewDecisionPending =
    card?.status === "review" &&
    !changesRequested &&
    !(mergeConflict && card.id === mergeConflict.cardId);
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
      const result = await fn();
      // Approve and similar calls return the changed card; show it now instead of after the next poll.
      if (
        result &&
        typeof result === "object" &&
        (result as Card).id === cardId &&
        "status" in result
      )
        onCardUpdated(result as Card);
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
    <CardLinks.Provider
      value={{
        open: onOpenCard,
        title: (id) => boardCards.find((item) => item.id === id)?.title,
      }}
    >
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
          <div className="flex items-start gap-2 pr-7">
            <DialogTitle className="text-xl font-semibold tracking-tight">
              {card?.title}
            </DialogTitle>
            {card && card.status !== "running" && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                disabled={busy}
                aria-label="Edit title and description"
                title="Edit title and description. Doesn't affect runs or reviews."
                onClick={() => onEdit(card)}
              >
                <Pencil size={14} />
              </Button>
            )}
          </div>
          <DialogDescription className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded bg-primary/10 px-2 py-1 uppercase tracking-wider text-primary">
              {card?.status}
            </span>{" "}
            <span title={card?.repo}>
              {card?.repo.split("/").filter(Boolean).pop()}
            </span>
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
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {card && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Priority
                  <input
                    aria-label="Card priority"
                    type="number"
                    min={PRIORITY_MIN}
                    max={PRIORITY_MAX}
                    step={1}
                    key={card.priority ?? 0}
                    defaultValue={card.priority ?? 0}
                    disabled={busy || card.status === "running"}
                    title={
                      card.status === "running"
                        ? "Priority cannot change while a run is active"
                        : "Higher priority Ready cards are picked up first (-100 to 100)"
                    }
                    onBlur={(event) => {
                      const priority = parsePriorityInput(event.target.value);
                      if (
                        priority === null ||
                        priority === (card.priority ?? 0)
                      ) {
                        event.target.value = String(card.priority ?? 0);
                        return;
                      }
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
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                  />
                </label>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setExpandedDetails((value) => !value)}
              >
                {expandedDetails ? (
                  <>
                    <Minimize2 size={13} /> Exit full screen
                  </>
                ) : (
                  <>
                    <Maximize2 size={13} /> Expand
                  </>
                )}
              </Button>
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
          {card && (
            <div
              role="tablist"
              aria-label="Card sections"
              className="mt-5 flex gap-1 border-b border-border"
            >
              {(
                [
                  ["overview", "Overview"],
                  ...(hasReviews
                    ? [
                        [
                          "reviews",
                          reviewEntries.length
                            ? `Reviews (${reviewEntries.length})`
                            : "Review",
                        ],
                      ]
                    : []),
                  ...(runs.length
                    ? [["attempts", `Attempts (${runs.length})`]]
                    : []),
                  ["discuss", "Discuss"],
                  ["details", "Details"],
                ] as [typeof tab, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`card-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls="card-tabpanel"
                  onClick={() => setTab(id)}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div
            role="tabpanel"
            id="card-tabpanel"
            aria-labelledby={`card-tab-${tab}`}
          >
            {tab === "overview" && (
              <>
                {card?.status === "review" &&
                  autoJobs.find(
                    (item) =>
                      item.runId === runs[0]?.id && item.state === "running",
                  )?.details && (
                    <section
                      aria-label="Agent review progress"
                      className="mt-6 rounded-md border border-border bg-accent/10 px-4 py-3 text-sm"
                    >
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Agent review
                      </div>
                      <p className="mt-1 whitespace-pre-line leading-6 text-foreground/80">
                        {
                          autoJobs.find(
                            (item) =>
                              item.runId === runs[0]?.id &&
                              item.state === "running",
                          )?.details
                        }
                      </p>
                    </section>
                  )}
                {card?.status === "running" &&
                  runs[0]?.status === "running" && (
                    <LiveStatus run={runs[0]} turns={card.turns} />
                  )}
                {card?.body?.trim() ? (
                  <details open className="group mt-6">
                    <summary className="cursor-pointer text-sm font-semibold">
                      Description
                    </summary>
                    <Markdown
                      source={card.body}
                      className="mt-2 text-sm leading-6 text-foreground/80"
                    />
                  </details>
                ) : (
                  <p className="mt-6 text-sm leading-6 text-foreground/80">
                    No description.
                  </p>
                )}
                {card && (
                  <CardAttachments
                    key={card.id}
                    boardId={boardId}
                    cardId={card.id}
                    count={card.attachmentCount ?? 0}
                    onError={(message) => {
                      setError(message);
                      onError(message);
                    }}
                  />
                )}
                {card &&
                  ["review", "done", "archived"].includes(card.status) &&
                  runs[0]?.status === "review" &&
                  runs[0].report && (
                    <RunReport
                      report={runs[0].report}
                      runId={runs[0].id}
                      addedFollowUps={boardCards.flatMap((item) => {
                        const prefix = `follow-up:${runs[0].id}:`;
                        return item.idempotencyKey?.startsWith(prefix)
                          ? [Number(item.idempotencyKey.slice(prefix.length))]
                          : [];
                      })}
                      planCreated={
                        !!card.createdCardIds ||
                        boardCards.some((item) =>
                          item.body.includes(
                            `Part of the plan from card ${card.id}:`,
                          ),
                        )
                      }
                      onCreatePlan={() =>
                        api(`/boards/${boardId}/cards/${card.id}/create-plan`, {
                          method: "POST",
                        }).then(
                          () => true,
                          () => false,
                        )
                      }
                      onAddFollowUp={(index, title, body) =>
                        api(`/boards/${boardId}/cards`, {
                          method: "POST",
                          body: JSON.stringify({
                            title,
                            body: `${body}\n\nFollow-up from card ${card.id}: ${card.title}`,
                            idempotencyKey: `follow-up:${runs[0].id}:${index}`,
                          }),
                        }).then(
                          () => true,
                          () => false,
                        )
                      }
                      scopeComments={currentComments.filter(
                        (item) => item.path === "" && item.runId === runs[0].id,
                      )}
                      onAddToScope={
                        card.status === "review" &&
                        currentReview &&
                        runs[0].status === "review" &&
                        !changesRequested &&
                        !approvalPending
                          ? (text) =>
                              api<ReviewComment>(
                                `/boards/${boardId}/cards/${card.id}/comments`,
                                {
                                  method: "POST",
                                  body: JSON.stringify({
                                    fingerprint: currentReview.fingerprint,
                                    path: "",
                                    line: 0,
                                    body: text,
                                  }),
                                },
                              ).then(
                                (saved) => {
                                  setComments((previous) => [
                                    ...previous,
                                    saved,
                                  ]);
                                  return true;
                                },
                                () => false,
                              )
                          : undefined
                      }
                      findingsOnly={
                        card.status === "review" &&
                        currentReview?.files.length === 0
                      }
                      onCopyError={() =>
                        setError(
                          "Could not copy the report. Select its text to copy it manually.",
                        )
                      }
                    />
                  )}
                {card?.status === "review" &&
                  currentReview &&
                  runs[0]?.status === "review" &&
                  runs[0].report &&
                  !changesRequested &&
                  !approvalPending && (
                    <form
                      className="mt-4 space-y-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const text = reply.trim();
                        if (!text) return;
                        void action(async () => {
                          await api<ReviewComment>(
                            `/boards/${boardId}/cards/${card.id}/comments`,
                            {
                              method: "POST",
                              body: JSON.stringify({
                                fingerprint: currentReview.fingerprint,
                                path: "",
                                line: 0,
                                body: text,
                              }),
                            },
                          );
                          await api(
                            `/boards/${boardId}/cards/${card.id}/request-changes`,
                            {
                              method: "POST",
                              body: JSON.stringify({
                                fingerprint: currentReview.fingerprint,
                              }),
                            },
                          );
                          await api(
                            `/boards/${boardId}/cards/${card.id}/start`,
                            {
                              method: "POST",
                            },
                          );
                          setReply("");
                        });
                      }}
                    >
                      <label className="block text-xs font-medium">
                        Reply to the agent
                        <textarea
                          maxLength={1000}
                          value={reply}
                          onChange={(event) => setReply(event.target.value)}
                          rows={3}
                          placeholder="Answer its question or say what to change. Pi runs again with your reply."
                          className="mt-2 w-full resize-y rounded-md border border-border bg-background p-2 text-sm"
                        />
                      </label>
                      <Button
                        size="sm"
                        type="submit"
                        disabled={
                          busy ||
                          !reply.trim() ||
                          !settings ||
                          currentComments.some(
                            (item) =>
                              item.runId === runs[0]?.id &&
                              item.state === "draft",
                          ) ||
                          autoJobs.some((item) => item.state === "running")
                        }
                      >
                        Send reply and run again
                      </Button>
                    </form>
                  )}
                {card?.status === "failed" && runs[0]?.error && (
                  <div
                    role="alert"
                    className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm"
                  >
                    <strong>Run failed</strong>
                    <p className="mt-1 text-destructive">{runs[0].error}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Inspect the latest attempt and its worktree below before
                      retrying. No changes were merged from this run.
                    </p>
                  </div>
                )}
              </>
            )}
            {tab === "reviews" && reviewEntries.length > 0 && (
              <ReviewHistory entries={reviewEntries} />
            )}
            {tab === "attempts" &&
              (runs.length > 0 ? (
                <AttemptList key={card?.id} runs={runs} card={card} />
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">
                  No attempts yet.
                </p>
              ))}
            {tab === "discuss" && card && (
              <DiscussionPanel
                key={card.id}
                boardId={boardId}
                cardId={card.id}
                onError={(message) => {
                  setError(message);
                  onError(message);
                }}
              />
            )}
            {tab === "details" && (
              <>
                {card && integration === "github-pr" && (
                  <PullRequestLink
                    onOpenPullRequest={
                      card.prState === "OPEN" ? onOpenPullRequest : undefined
                    }
                    card={card}
                    busy={busy}
                    onSave={(url) =>
                      action(() =>
                        api<Card>(
                          `/boards/${boardId}/cards/${card.id}/pull-request`,
                          {
                            method: "PUT",
                            body: JSON.stringify({ url }),
                          },
                        ),
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
                        api<Card>(
                          `/boards/${boardId}/cards/${card.id}/${path}`,
                          {
                            method,
                            body: input && JSON.stringify(input),
                          },
                        ),
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
                <CardHistory entries={history} />
                {card?.idempotencyKey && (
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>Idempotency key</span>
                    <code className="select-all break-all font-mono text-foreground">
                      {card.idempotencyKey}
                    </code>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="mt-6 flex flex-wrap gap-2 border-t border-border pt-5">
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
            {card?.startQueued && (
              <>
                <span
                  className="rounded border border-amber-500/50 px-2 py-1 text-xs text-amber-600"
                  data-testid="start-queued-badge"
                >
                  Queued, starts after restart
                </span>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    action(() =>
                      api(`/boards/${boardId}/cards/${card.id}/start`, {
                        method: "DELETE",
                      }),
                    )
                  }
                >
                  Cancel queued start
                </Button>
              </>
            )}
            {card &&
              !card.startQueued &&
              ["ready", "failed", "review"].includes(card.status) && (
                <Button
                  // In review the next step is a decision. Rerunning is secondary unless changes were
                  // requested or a conflict needs Pi.
                  variant={reviewDecisionPending ? "outline" : "default"}
                  className={reviewDecisionPending ? "order-last" : undefined}
                  disabled={
                    busy ||
                    !settings ||
                    (card.blocked && !card.attempts) ||
                    (card.status === "review" &&
                      (approvalPending ||
                        card.reviewWait === "github" ||
                        autoJobs.some(
                          (item) =>
                            item.cardId === card.id && item.state === "running",
                        ) ||
                        currentComments.some(
                          (item) =>
                            item.runId === runs[0]?.id &&
                            item.state === "draft",
                        )))
                  }
                  title={
                    card.blocked && !card.attempts
                      ? "Waiting on unfinished cards. Start this card after they are Done."
                      : undefined
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
                variant={reviewDecisionPending ? "default" : "outline"}
                disabled={
                  busy ||
                  !currentReview ||
                  changesRequested ||
                  // The open PR already holds this run's work; Approve returns once a newer run exists.
                  (integration === "github-pr" &&
                    card.prState === "OPEN" &&
                    !card.prOverrideUrl &&
                    !!card.reviewWait) ||
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
                    ? draftStarted
                      ? "Reopen PR draft"
                      : "Approve and open PR"
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
                pushProgress={pushProgress}
                onOpenChange={(open) => {
                  setPrDialog(open);
                  if (open) setDraftStarted(true);
                }}
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
                  Remove draft comments on older diffs before submitting
                  feedback.
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
            {(card?.status === "done" || card?.status === "failed") && (
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
                {card.status === "failed" ? "Move to Ready" : "Reopen"}
              </Button>
            )}
            {card?.status === "review" && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (
                    !window.confirm(
                      "Close this card without merging? Its worktree and branch stay, and Reopen brings it back.",
                    )
                  )
                    return;
                  void action(() =>
                    api(`/boards/${boardId}/cards/${card.id}/close`, {
                      method: "POST",
                      body: "{}",
                    }),
                  );
                }}
              >
                Close without merging
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
            {card?.status === "archived" && (card.attachmentCount ?? 0) > 0 && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Permanently delete all attachments of this card from disk? This cannot be undone, even if you restore the card.",
                    )
                  )
                    void action(() =>
                      api(`/boards/${boardId}/cards/purge-attachments`, {
                        method: "POST",
                        body: JSON.stringify({ cardIds: [card.id] }),
                      }),
                    );
                }}
              >
                Purge attachments
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
          {card?.status === "review" && tab === "reviews" && (
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
        </DialogContent>
      </Dialog>
    </CardLinks.Provider>
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
        <div
          role="status"
          className="mt-1 whitespace-pre-wrap text-destructive"
        >
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

/** The agent's latest sentence of narration, trimmed for a one-line status. */
export function latestNarration(report: string | null): string {
  const lines = (report ?? "")
    .split("\n")
    .map((line) => line.replace(/^[\s>*#-]+|[*_`]/g, "").trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? "";
  const sentences = last.split(/(?<=[.!?])\s+/);
  const text = sentences.filter(Boolean).at(-1) ?? last;
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

function LiveStatus({ run, turns }: { run: Run; turns: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(
    0,
    Math.round((now - Date.parse(run.startedAt)) / 1000),
  );
  const elapsed =
    seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${seconds}s`;
  const narration = latestNarration(run.report);
  return (
    <section
      aria-label="Live status"
      className="mt-6 rounded-md border border-border bg-accent/10 px-4 py-3 text-sm"
    >
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="font-semibold uppercase tracking-wider">
          Working now
        </span>
        <span>
          {elapsed} · {turns} {turns === 1 ? "turn" : "turns"}
        </span>
      </div>
      <p className="mt-1 leading-6 text-foreground/80">
        {narration || "Starting up…"}
      </p>
    </section>
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
  runId,
  onAddFollowUp,
  onCreatePlan,
  planCreated,
  scopeComments,
  onAddToScope,
  findingsOnly,
  onCopyError,
  addedFollowUps,
}: {
  report: string;
  runId: string;
  /** Follow-up indexes that already have a Triage card, so a reload still shows them as added. */
  addedFollowUps: number[];
  /** A card made from this card's plan already exists; a plan is turned into cards once per card. */
  planCreated: boolean;
  /** Creates one Triage card per subtask, dependencies wired, in order; resolves false when any failed (a retry skips cards already made). */
  onCreatePlan: () => Promise<boolean>;
  /** Creates a Triage card for follow-up `index`; resolves false when it could not. */
  onAddFollowUp: (
    index: number,
    title: string,
    body: string,
  ) => Promise<boolean>;
  /** This attempt's note comments, so a reload still shows follow-ups already added to scope. */
  scopeComments: ReviewComment[];
  /** Adds a follow-up as a note for the next run of this card; undefined when the card cannot take more changes now. */
  onAddToScope?: (text: string) => Promise<boolean>;
  findingsOnly: boolean;
  onCopyError: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [added, setAdded] = useState<number[]>([]);
  const [planMade, setPlanMade] = useState(false);
  const [planFailed, setPlanFailed] = useState(false);
  useEffect(() => {
    setAdded([]);
    setPlanMade(false);
    setPlanFailed(false);
  }, [runId]);
  const scopeText = (item: { title: string; body: string }) =>
    `Operator-approved scope addition: the operator added this item to this card, which is their explicit authorization for exactly the action described, including pushing to this card's branch or PR and attaching artifacts to its PR. It never authorizes merging, deploying or enabling auto-merge. Do it in this card: ${item.title}\n\n${item.body}`.slice(
      0,
      1000,
    );
  const isInScope = (item: { title: string; body: string }) =>
    scopeComments.some((comment) => comment.body === scopeText(item));
  const isAdded = (index: number) =>
    added.includes(index) || addedFollowUps.includes(index);
  const plan = parsePlan(report);
  const items = followUps(report);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <section
      aria-label={
        plan ? "Plan report" : findingsOnly ? "Findings" : "Agent report"
      }
      className="mt-6 rounded-md border border-border bg-accent/10 p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {plan
            ? "Plan (no code changes)"
            : findingsOnly
              ? "Findings"
              : "Agent report"}
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
      {plan && (
        <div className="mt-4 border-t border-border pt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Plan
          </h4>
          {"error" in plan ? (
            <p className="mt-2 text-sm text-destructive">{plan.error}</p>
          ) : (
            <>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                {plan.subtasks.map((task) => (
                  <li key={task.id}>
                    {task.title}
                    {task.dependsOn.length > 0 && (
                      <span className="text-muted-foreground">
                        {" "}
                        (after {task.dependsOn.join(", ")})
                      </span>
                    )}
                  </li>
                ))}
              </ol>
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                disabled={planMade || planCreated}
                onClick={() =>
                  void onCreatePlan().then((ok) => {
                    setPlanMade(ok);
                    setPlanFailed(!ok);
                  })
                }
              >
                {planMade || planCreated
                  ? "Cards already created from this card"
                  : `Create ${plan.subtasks.length} Triage cards`}
              </Button>
              {planFailed && (
                <p className="mt-2 text-xs text-destructive">
                  Could not create every card. Try again; cards already made are
                  kept.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {items.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Follow-ups
          </h4>
          <ul className="mt-2 space-y-2">
            {items.map((item, index) => (
              <li
                key={index}
                className="flex items-start justify-between gap-3 text-sm"
              >
                <span className="break-words">{item.title}</span>
                <span className="flex shrink-0 gap-2">
                  {onAddToScope && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isInScope(item) || isAdded(index)}
                      onClick={() => void onAddToScope(scopeText(item))}
                    >
                      {isInScope(item) ? "In scope" : "Add to scope"}
                    </Button>
                  )}
                  {!isInScope(item) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isAdded(index)}
                      onClick={() =>
                        void onAddFollowUp(index, item.title, item.body).then(
                          (ok) => {
                            if (ok)
                              setAdded((previous) => [...previous, index]);
                          },
                        )
                      }
                    >
                      {isAdded(index) ? "In Triage" : "Add to Triage"}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Each attempt's agent review and the changes a person requested, newest attempt first. */
function requestedChanges(
  job: AutoReviewJob,
): { path: string; line?: number; comment: string }[] {
  try {
    return job.changes ? JSON.parse(job.changes) : [];
  } catch {
    return [];
  }
}

function ReviewHistory({
  entries,
}: {
  entries: {
    attempt: number;
    job?: AutoReviewJob;
    requested: ReviewComment[];
  }[];
}) {
  if (!entries.length)
    return (
      <p className="mt-4 text-sm text-muted-foreground">No reviews yet.</p>
    );
  return (
    <ol className="mt-4 space-y-4 text-xs">
      {entries.map(({ attempt, job, requested }) => (
        <li key={attempt} className="rounded-md border border-border p-3">
          <div className="font-semibold">Attempt {attempt}</div>
          {job && (
            <div className="mt-2">
              <strong>
                Agent review:{" "}
                {job.state === "running"
                  ? "checking"
                  : job.state === "merged"
                    ? "merged locally"
                    : job.requeued
                      ? "interrupted by a restart, queued again"
                      : requestedChanges(job).length
                        ? "sent back to the implementer"
                        : "needs human review"}
              </strong>{" "}
              <AgentBadge
                phase="Review"
                agent={job.agent}
                pending={job.state === "running"}
              />{" "}
              <CostBadge usage={job} label="Review cost" />
              {job.details && (
                <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                  {job.details}
                </p>
              )}
            </div>
          )}
          {job &&
            requestedChanges(job).map((change, index) => (
              <p
                key={index}
                className="mt-2 whitespace-pre-wrap text-muted-foreground"
              >
                <span className="font-medium text-foreground/80">
                  Requested change on {change.path}
                  {change.line ? `:${change.line}` : ""}:
                </span>{" "}
                {change.comment}
              </p>
            ))}
          {requested.map((comment) => (
            <p
              key={comment.id}
              className="mt-2 whitespace-pre-wrap text-muted-foreground"
            >
              <span className="font-medium text-foreground/80">
                {comment.path
                  ? `Requested change on ${comment.path}:${comment.fileLine ?? comment.line}:`
                  : "Requested change:"}
              </span>{" "}
              {comment.body}
            </p>
          ))}
        </li>
      ))}
    </ol>
  );
}
