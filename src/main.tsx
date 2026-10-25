import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  GitBranch,
  LayoutGrid,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  XCircle,
} from "lucide-react";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog";
import "./style.css";
import "highlight.js/styles/github-dark.css";
import { api, date } from "./api.js";
import { CardDetails } from "./card-details.js";
import type {
  BakerySettings,
  Board,
  Card,
  MergeConflict,
  Status,
} from "./model.js";

const columns: {
  id: Status;
  label: string;
  description: string;
}[] = [
  {
    id: "triage",
    label: "Triage",
    description: "Awaiting approval for work",
  },
  {
    id: "ready",
    label: "Ready",
    description: "Can start a Pi run",
  },
  {
    id: "running",
    label: "Running",
    description: "Pi is working",
  },
  {
    id: "review",
    label: "Review",
    description: "Inspect, then approve and merge",
  },
  {
    id: "failed",
    label: "Failed",
    description: "Needs another attempt",
  },
  {
    id: "interrupted",
    label: "Interrupted",
    description: "Inspect the process",
  },
  {
    id: "done",
    label: "Done",
    description: "Merged or closed without a run",
  },
];
function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [settings, setSettings] = useState<BakerySettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [addingRepo, setAddingRepo] = useState(false);
  const [editingBoard, setEditingBoard] = useState<Board | null>(null);
  const [repoPath, setRepoPath] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [verificationDraft, setVerificationDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Card | null>(null);
  const [error, setError] = useState("");
  const [mergeConflicts, setMergeConflicts] = useState<MergeConflict[]>([]);
  const [busy, setBusy] = useState(false);
  const [manualCollapse, setManualCollapse] = useState<
    Record<string, Partial<Record<Status, boolean>>>
  >({});
  useEffect(() => {
    void api<Board[]>("/boards")
      .then((items) => {
        setBoards(items);
        setBoardId(
          items.find((item) => item.id === localStorage.getItem("bakery-board"))
            ?.id ??
            items[0]?.id ??
            null,
        );
      })
      .catch((err) => setError(String(err)));
    void api<BakerySettings>("/settings")
      .then(setSettings)
      .catch((err) => setError(String(err)));
  }, []);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((value) => value + 1);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!boardId) return;
      try {
        const [next, conflicts, nextBoards] = await Promise.all([
          api<Card[]>(`/boards/${boardId}/cards`),
          api<MergeConflict[]>(`/boards/${boardId}/conflicts`),
          api<Board[]>("/boards"),
        ]);
        if (!current) return;
        setCards(next);
        setMergeConflicts(conflicts);
        setBoards(nextBoards);
      } catch (err) {
        if (current) setError(String(err));
      } finally {
        if (current) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [boardId, refreshKey]);
  const currentBoard = boards.find((item) => item.id === boardId);
  const card = cards.find((item) => item.id === selected);
  const saveSettings = (patch: Partial<BakerySettings>) => {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    void action(async () => {
      try {
        setSettings(
          await api<BakerySettings>("/settings", {
            method: "PATCH",
            body: JSON.stringify(patch),
          }),
        );
      } catch (error) {
        setSettings(previous);
        throw error;
      }
    });
  };
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      refresh();
      return true;
    } catch (err) {
      const conflict =
        err instanceof Error && "conflict" in err
          ? (err.conflict as MergeConflict | undefined)
          : undefined;
      if (conflict)
        setMergeConflicts((previous) => [
          ...previous.filter((item) => item.cardId !== conflict.cardId),
          conflict,
        ]);
      else setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const removeBoard = (item: Board) => {
    if (
      !window.confirm(
        `Remove the board for ${item.repo}? Cards and worktrees remain on disk. Add this repository again to restore the board.`,
      )
    )
      return;
    void action(async () => {
      await api(`/boards/${item.id}`, { method: "DELETE" });
      const remaining = boards.filter((board) => board.id !== item.id);
      setBoards(remaining);
      if (boardId === item.id) {
        const next = remaining[0]?.id ?? null;
        setBoardId(next);
        if (next) localStorage.setItem("bakery-board", next);
        else localStorage.removeItem("bakery-board");
        setSelected(null);
        setCards([]);
        setMergeConflicts([]);
      }
      setEditingBoard(null);
      setRepoPath("");
    });
  };
  const active = cards.filter((item) => item.status === "running").length;
  const toggleLane = (status: Status, collapsed: boolean) => {
    if (!boardId) return;
    setManualCollapse((previous) => ({
      ...previous,
      [boardId]: { ...previous[boardId], [status]: !collapsed },
    }));
  };
  return (
    <div className="min-h-screen lg:flex">
      <aside className="flex flex-col border-b border-border bg-[#171a1e] lg:sticky lg:top-0 lg:h-screen lg:w-[228px] lg:shrink-0 lg:border-r lg:border-b-0">
        <div className="flex items-center gap-3 px-6 py-7">
          <div className="grid size-9 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <span className="text-xl leading-none">✳</span>
          </div>
          <span className="text-[18px] font-semibold tracking-[-.04em]">
            bakery<span className="text-primary">.</span>
          </span>
        </div>
        <div className="px-4 pt-5">
          <div className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[.18em] text-muted-foreground">
            Repositories
          </div>
          {boards.map((item) => (
            <div
              key={item.id}
              className={`flex items-center rounded-lg ${boardId === item.id ? "bg-accent/50" : "hover:bg-accent/30"}`}
            >
              <button
                onClick={() => {
                  setBoardId(item.id);
                  localStorage.setItem("bakery-board", item.id);
                  setSelected(null);
                  setCards([]);
                  setMergeConflicts([]);
                }}
                className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left text-sm"
                title={item.repo}
              >
                <LayoutGrid size={16} className="shrink-0 text-primary" />
                <span className="truncate">{item.repo.split("/").at(-1)}</span>
              </button>
              <button
                aria-label={`Edit ${item.repo}`}
                title="Edit repository path"
                className="mr-2 p-1 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setError("");
                  setRepoPath(item.repo);
                  setEditingBoard(item);
                }}
              >
                <Pencil size={13} />
              </button>
            </div>
          ))}
          <Button
            variant="ghost"
            className="mt-2 w-full justify-start"
            onClick={() => {
              setError("");
              setAddingRepo(true);
            }}
          >
            <Plus size={15} /> Add repository
          </Button>
          <Button
            variant="ghost"
            className="mt-2 w-full justify-start"
            onClick={() => {
              setError("");
              setVerificationDraft(currentBoard?.verificationCommand ?? "");
              setShowSettings(true);
            }}
          >
            <Settings2 size={15} /> Settings
          </Button>
        </div>
        <div className="mt-auto hidden border-t border-border px-6 py-5 lg:block">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-[#b8c4b8]" /> Local only{" "}
            <span className="ml-auto font-mono">v0.1</span>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-6 lg:px-10">
          <div>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[.18em] text-muted-foreground">
              Workspace / Board
            </div>
            <h1 className="text-[27px] font-semibold tracking-[-.05em]">
              {currentBoard
                ? currentBoard.repo.split("/").at(-1)
                : "Choose a repository"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {currentBoard
                ? currentBoard.repo
                : "Add a Git repository to create its board."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              aria-label="Refresh board"
              onClick={() => void refresh()}
            >
              <RefreshCw size={15} />
            </Button>
            <Button disabled={!boardId} onClick={() => setCreating(true)}>
              <Plus size={16} /> New card
            </Button>
          </div>
        </header>
        <div className="flex flex-wrap gap-x-7 gap-y-2 border-b border-border px-6 py-4 text-xs text-muted-foreground lg:px-10">
          <span>
            <strong className="mr-1 font-mono text-foreground">
              {cards.length}
            </strong>{" "}
            cards
          </span>
          <span>
            <strong className="mr-1 font-mono text-foreground">
              {cards.filter((c) => c.status === "triage").length}
            </strong>{" "}
            in triage
          </span>
          <span>
            <strong className="mr-1 font-mono text-foreground">
              {cards.filter((c) => c.status === "ready").length}
            </strong>{" "}
            ready
          </span>
          <span>
            <strong className="mr-1 font-mono text-foreground">{active}</strong>{" "}
            running
          </span>
          <span>
            <strong className="mr-1 font-mono text-foreground">
              {cards.filter((c) => c.status === "review").length}
            </strong>{" "}
            awaiting review
          </span>
          <label className="ml-auto flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              disabled={!currentBoard || busy}
              checked={currentBoard?.autoCollapseEmptySwimlanes ?? false}
              onChange={(event) => {
                const enabled = event.target.checked;
                if (!boardId) return;
                void action(async () => {
                  const updated = await api<Board>(
                    `/boards/${boardId}/settings`,
                    {
                      method: "PATCH",
                      body: JSON.stringify({
                        autoCollapseEmptySwimlanes: enabled,
                      }),
                    },
                  );
                  setBoards((previous) =>
                    previous.map((item) =>
                      item.id === updated.id ? updated : item,
                    ),
                  );
                  setManualCollapse((previous) => ({
                    ...previous,
                    [updated.id]: {},
                  }));
                });
              }}
              className="accent-primary"
            />{" "}
            Auto-collapse lanes without active cards
          </label>
          {currentBoard?.autoPickupEnabled && (
            <span className="text-primary">
              Auto pickup · {currentBoard.pickupConcurrency} at a time
            </span>
          )}
          <span className="hidden items-center gap-1.5 lg:flex">
            <CircleHelp size={13} /> Starting a run may use paid model tokens
          </span>
        </div>
        {currentBoard?.autoPickupError && (
          <div
            role="alert"
            className="mx-6 mt-5 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive lg:mx-10"
          >
            Auto pickup paused: {currentBoard.autoPickupError}. Inspect the run
            before re-enabling in Settings.
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="mx-6 mt-5 flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive lg:mx-10"
          >
            <XCircle size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0 break-words">
              <strong className="block">Action failed</strong>
              {error}
            </div>
            <button
              className="ml-auto"
              onClick={() => setError("")}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}
        {!selected && mergeConflicts.length > 0 && (
          <div
            role="alert"
            className="mx-6 mt-5 flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm lg:mx-10"
          >
            <XCircle size={16} className="text-destructive" />
            <span>
              {mergeConflicts.length}{" "}
              {mergeConflicts.length === 1 ? "card has" : "cards have"} merge
              conflicts. The card worktrees are still available.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelected(mergeConflicts[0].cardId)}
            >
              View conflicts
            </Button>
          </div>
        )}
        <div className="overflow-x-auto p-6 lg:p-10">
          <div className="flex min-h-[500px] min-w-max gap-4">
            {columns.map((column) => {
              const laneCards = cards.filter((c) => c.status === column.id);
              const collapsible = !laneCards.some((c) => c.status !== "done");
              const override = boardId
                ? manualCollapse[boardId]?.[column.id]
                : undefined;
              const collapsed =
                collapsible &&
                (override ?? currentBoard?.autoCollapseEmptySwimlanes ?? false);
              return (
                <section
                  key={column.id}
                  aria-label={`${column.label} lane`}
                  data-status={column.id}
                  className={`${collapsed ? "w-12" : "w-[280px]"} shrink-0`}
                >
                  {collapsed ? (
                    <button
                      type="button"
                      aria-label={`Expand ${column.label} lane`}
                      aria-expanded={false}
                      onClick={() => toggleLane(column.id, true)}
                      className="flex min-h-48 w-full flex-col items-center gap-3 rounded-lg border border-border bg-card px-2 py-3 text-sm hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronRight size={16} />
                      <span
                        aria-hidden="true"
                        className="lane-status-dot size-2.5 shrink-0 rounded-full"
                      />
                      <span className="[writing-mode:vertical-rl]">
                        {column.label}
                      </span>
                      <span className="rounded bg-secondary px-1 font-mono text-xs text-muted-foreground">
                        {laneCards.length}
                      </span>
                    </button>
                  ) : (
                    <>
                      <div className="mb-5 flex items-center gap-2 px-1">
                        <span
                          aria-hidden="true"
                          className="lane-status-dot size-2.5 shrink-0 rounded-full"
                        />
                        <h2 className="text-sm font-semibold">
                          {column.label}
                        </h2>
                        <span className="ml-auto rounded-md bg-secondary px-2 py-0.5 font-mono text-xs text-muted-foreground">
                          {laneCards.length}
                        </span>
                        {collapsible && (
                          <button
                            type="button"
                            aria-label={`Collapse ${column.label} lane`}
                            aria-expanded={true}
                            onClick={() => toggleLane(column.id, false)}
                            className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <ChevronDown size={16} />
                          </button>
                        )}
                      </div>
                      <div className="mb-4 px-1 text-xs text-muted-foreground">
                        {column.description}
                      </div>
                      <div className="space-y-3">
                        {laneCards.map((item) => (
                          <button
                            key={item.id}
                            onClick={() => {
                              setSelected(item.id);
                            }}
                            className="group w-full rounded-xl border border-border/80 bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <div className="mb-4 flex items-start justify-between gap-2">
                              <span className="rounded bg-primary/10 px-2 py-1 text-[10px] font-medium uppercase tracking-[.1em] text-primary">
                                Manual
                              </span>
                              <ArrowUpRight
                                size={15}
                                className="text-muted-foreground group-hover:text-primary"
                              />
                            </div>
                            <div className="text-[14px] font-medium leading-snug text-foreground">
                              {item.title}
                            </div>
                            <p className="mt-2 line-clamp-2 min-h-9 text-xs leading-relaxed text-muted-foreground">
                              {item.body || "No description yet."}
                            </p>
                            <div className="mt-5 flex items-center justify-between border-t border-border/70 pt-3 font-mono text-[10px] text-muted-foreground">
                              <span className="flex min-w-0 items-center gap-1 truncate">
                                <GitBranch size={11} className="shrink-0" />{" "}
                                {item.repo.split("/").at(-1)}
                              </span>
                              <span
                                className="flex items-center gap-1"
                                title={
                                  item.turnsIncomplete
                                    ? "Estimated from older transcripts; may be inaccurate. New turns are counted exactly."
                                    : "Completed Pi turns across all attempts"
                                }
                              >
                                <Clock3 size={11} />{" "}
                                {item.turnsIncomplete
                                  ? item.turns
                                    ? `~${item.turns}`
                                    : "?"
                                  : item.turns}
                              </span>
                              <span>{date(item.createdAt)}</span>
                            </div>
                          </button>
                        ))}
                        {laneCards.length === 0 && (
                          <div className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-xs text-muted-foreground">
                            Nothing here yet.
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </main>
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            These preferences are saved in Bakery's local database.
          </DialogDescription>
          <label className="mt-6 flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1 accent-primary"
              checked={settings?.confirmRunStart ?? false}
              disabled={!settings || busy}
              onChange={(event) =>
                saveSettings({ confirmRunStart: event.target.checked })
              }
            />
            <span>
              Confirm before starting a run
              <span className="mt-1 block text-xs text-muted-foreground">
                When off, Start Pi run launches immediately and may use paid
                model tokens.
              </span>
            </span>
          </label>
          <fieldset
            className="mt-6 border-t border-border pt-5 text-sm"
            disabled={!settings || busy}
          >
            <legend className="pt-5 font-medium">Card details layout</legend>
            <div className="mt-3 flex gap-5">
              {(["dialog", "side"] as const).map((layout) => (
                <label
                  key={layout}
                  className="flex cursor-pointer items-center gap-2"
                >
                  <input
                    type="radio"
                    name="card-details-layout"
                    checked={settings?.cardDetailsLayout === layout}
                    onChange={() => saveSettings({ cardDetailsLayout: layout })}
                    className="accent-primary"
                  />
                  {layout === "dialog" ? "Popup" : "Side panel"}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              The side panel stays wide for review. On small screens it opens
              full-screen.
            </p>
          </fieldset>
          <div className="mt-6 border-t border-border pt-5 text-sm">
            <div className="font-medium">
              Unattended review ·{" "}
              {currentBoard?.repo.split("/").at(-1) ?? "select a repository"}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              A tool-free Pi reviewer inspects new Review cards; the
              verification command runs first. At most 3 merges per 24 hours.
              Findings, errors, or changes require human review. Local merge
              only, never push. Auto-review alone does not start Ready cards;
              enable Auto pickup below.
            </p>
            <label className="mt-4 block text-xs">
              Verification command
              <input
                aria-label="Auto-review verification command"
                value={verificationDraft}
                onChange={(event) => setVerificationDraft(event.target.value)}
                disabled={busy}
                placeholder="npm test && npm run build"
                className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              />
            </label>
            <Button
              className="mt-3"
              variant={currentBoard?.autoReviewEnabled ? "outline" : "default"}
              disabled={
                !currentBoard ||
                busy ||
                (!currentBoard.autoReviewEnabled && !verificationDraft.trim())
              }
              onClick={() => {
                if (!currentBoard) return;
                const enable =
                  !currentBoard.autoReviewEnabled ||
                  verificationDraft.trim() !== currentBoard.verificationCommand;
                if (
                  enable &&
                  !window.confirm(
                    `Enable unattended agent review and up to 3 local merges per 24 hours for ${currentBoard.repo}? This may spend model tokens. Only new reviews after enabling are eligible.`,
                  )
                )
                  return;
                void action(async () => {
                  const updated = await api<Board>(
                    `/boards/${currentBoard.id}/settings`,
                    {
                      method: "PATCH",
                      body: JSON.stringify({
                        autoReviewEnabled: enable,
                        verificationCommand: verificationDraft,
                      }),
                    },
                  );
                  setBoards((previous) =>
                    previous.map((item) =>
                      item.id === updated.id ? updated : item,
                    ),
                  );
                });
              }}
            >
              {currentBoard?.autoReviewEnabled
                ? verificationDraft.trim() !== currentBoard.verificationCommand
                  ? "Save and re-enable"
                  : "Disable auto-review"
                : "Enable auto-review"}
            </Button>
            {currentBoard?.autoReviewEnabled && (
              <p className="mt-2 text-xs text-primary">
                Enabled since{" "}
                {currentBoard.autoReviewEnabledAt &&
                  date(currentBoard.autoReviewEnabledAt)}
                . New reviewed runs can merge without approval.
              </p>
            )}
          </div>
          <div className="mt-6 border-t border-border pt-5 text-sm">
            <div className="font-medium">
              Auto pickup ·{" "}
              {currentBoard?.repo.split("/").at(-1) ?? "select a repository"}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Automatically start Ready cards in creation order, up to the
              concurrency limit including manual runs. At most 6 automatic
              starts in any 24 hours. A failed automatic run or interrupted run
              pauses pickup. Starting Pi may spend model tokens. Turn off pickup
              to stop new starts; existing runs continue.
            </p>
            <label className="mt-4 flex items-center gap-2 text-xs">
              Concurrent runs{" "}
              <select
                aria-label="Auto pickup concurrency"
                value={currentBoard?.pickupConcurrency ?? 2}
                disabled={!currentBoard || busy}
                onChange={(event) => {
                  if (!currentBoard) return;
                  const limit = Number(event.target.value);
                  void action(async () => {
                    const updated = await api<Board>(
                      `/boards/${currentBoard.id}/settings`,
                      {
                        method: "PATCH",
                        body: JSON.stringify({
                          autoPickupEnabled: currentBoard.autoPickupEnabled,
                          pickupConcurrency: limit,
                        }),
                      },
                    );
                    setBoards((previous) =>
                      previous.map((item) =>
                        item.id === updated.id ? updated : item,
                      ),
                    );
                  });
                }}
                className="rounded-md border border-border bg-background px-2 py-1"
              >
                {[1, 2, 3, 4].map((limit) => (
                  <option key={limit} value={limit}>
                    {limit}
                  </option>
                ))}
              </select>
            </label>
            <Button
              className="mt-3"
              variant={currentBoard?.autoPickupEnabled ? "outline" : "default"}
              disabled={!currentBoard || busy}
              onClick={() => {
                if (!currentBoard) return;
                const enable = !currentBoard.autoPickupEnabled;
                if (
                  enable &&
                  !window.confirm(
                    `Enable automatic Pi pickup for ${currentBoard.repo}? Up to ${currentBoard.pickupConcurrency} paid Pi runs can start without another click, up to 6 per 24 hours. Ready cards may start immediately.`,
                  )
                )
                  return;
                void action(async () => {
                  const updated = await api<Board>(
                    `/boards/${currentBoard.id}/settings`,
                    {
                      method: "PATCH",
                      body: JSON.stringify({
                        autoPickupEnabled: enable,
                        pickupConcurrency: currentBoard.pickupConcurrency,
                      }),
                    },
                  );
                  setBoards((previous) =>
                    previous.map((item) =>
                      item.id === updated.id ? updated : item,
                    ),
                  );
                });
              }}
            >
              {currentBoard?.autoPickupEnabled
                ? "Disable auto pickup"
                : "Enable auto pickup"}
            </Button>
            {currentBoard?.autoPickupError && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                Paused: {currentBoard.autoPickupError}
              </p>
            )}
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={addingRepo || !!editingBoard}
        onOpenChange={(open) => {
          if (!open) {
            setAddingRepo(false);
            setEditingBoard(null);
            setRepoPath("");
          }
        }}
      >
        <DialogContent>
          <DialogTitle>
            {editingBoard ? "Edit repository path" : "Add repository"}
          </DialogTitle>
          <DialogDescription>
            {editingBoard
              ? "Cards can move to a different root only before their first run."
              : "Enter an existing Git repository root. Paths starting with ~/ are supported."}
          </DialogDescription>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <form
            className="mt-5 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void action(async () => {
                const item = await api<Board>(
                  editingBoard ? `/boards/${editingBoard.id}` : "/boards",
                  {
                    method: editingBoard ? "PATCH" : "POST",
                    body: JSON.stringify({ repo: repoPath }),
                  },
                );
                setBoards((previous) =>
                  [
                    ...previous.filter((board) => board.id !== item.id),
                    item,
                  ].sort((a, b) => a.repo.localeCompare(b.repo)),
                );
                setBoardId(item.id);
                localStorage.setItem("bakery-board", item.id);
                setCards([]);
                setSelected(null);
                setMergeConflicts([]);
                setRepoPath("");
                setAddingRepo(false);
                setEditingBoard(null);
              });
            }}
          >
            <input
              required
              aria-label="Repository root"
              value={repoPath}
              onChange={(event) => setRepoPath(event.target.value)}
              placeholder="~/code/project"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <Button disabled={busy} type="submit">
              {editingBoard ? "Save" : "Add"}
            </Button>
          </form>
          {editingBoard && (
            <div className="mt-8 border-t border-border pt-5">
              <div className="text-sm font-medium">Remove repository</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Hides this board. Cards, runs, and worktrees stay on disk. Add
                the repository again to restore them.
              </p>
              <Button
                variant="destructive"
                className="mt-4"
                disabled={busy}
                onClick={() => removeBoard(editingBoard)}
              >
                Remove repository from Bakery
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={creating || !!editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      >
        <DialogContent>
          <DialogTitle className="text-lg font-semibold tracking-tight">
            {editing ? "Edit card" : "New card"}
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            Work in {currentBoard && currentBoard.repo}.
          </DialogDescription>
          <CardForm
            key={editing?.id ?? "new"}
            initial={editing ?? undefined}
            onSubmit={(value) =>
              action(async () => {
                const saved = await api<Card>(
                  `/boards/${boardId}/cards${editing ? `/${editing.id}` : ""}`,
                  {
                    method: editing ? "PATCH" : "POST",
                    body: JSON.stringify(value),
                  },
                );
                setCreating(false);
                setEditing(null);
                setSelected(saved.id);
              })
            }
            busy={busy}
          />
        </DialogContent>
      </Dialog>
      {boardId && selected && (
        <CardDetails
          key={selected}
          boardId={boardId}
          card={card}
          settings={settings}
          conflict={mergeConflicts.find((item) => item.cardId === selected)}
          onClose={() => setSelected(null)}
          onEdit={(item) => {
            setEditing(item);
            setSelected(null);
          }}
          onRefresh={refresh}
          onError={setError}
          onConflict={(conflict) =>
            setMergeConflicts((previous) =>
              conflict
                ? [
                    ...previous.filter(
                      (item) => item.cardId !== conflict.cardId,
                    ),
                    conflict,
                  ]
                : previous.filter((item) => item.cardId !== selected),
            )
          }
        />
      )}
    </div>
  );
}
function CardForm({
  onSubmit,
  busy,
  initial,
}: {
  onSubmit: (value: { title: string; body: string }) => void;
  busy: boolean;
  initial?: Card;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ title, body });
  }
  const input =
    "w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary";
  return (
    <form onSubmit={submit} className="mt-6 space-y-5">
      <label className="block text-xs font-medium">
        Title
        <input
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          className={`mt-2 ${input}`}
        />
      </label>
      <label className="block text-xs font-medium">
        Description
        <textarea
          value={body}
          maxLength={16000}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Context, acceptance criteria, and anything the agent should know…"
          rows={5}
          className={`mt-2 resize-y ${input}`}
        />
      </label>
      <p className="text-xs leading-5 text-muted-foreground">
        This card uses the selected repository. New cards start in Triage. Move
        one to Ready before starting a run. Creating or moving a card does not
        start an agent.
      </p>
      <div className="flex justify-end">
        <Button disabled={busy} type="submit">
          {initial ? "Save changes" : "Create card"} <Plus size={15} />
        </Button>
      </div>
    </form>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
