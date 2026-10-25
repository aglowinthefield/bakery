import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRight, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Copy, GitBranch, LayoutGrid, Maximize2, Minimize2, Pencil, Plus, RefreshCw, Settings2, Square, XCircle } from "lucide-react";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";
import "./style.css";
import "highlight.js/styles/github-dark.css";
import { highlightDiffCode } from "./review-diff.js";
import { parseDiff } from "./diff-lines.js";

type Status = "triage" | "ready" | "running" | "review" | "failed" | "interrupted" | "done";
type Board = { id: string; repo: string; autoCollapseEmptySwimlanes: boolean; autoReviewEnabled: boolean; verificationCommand: string; autoReviewEnabledAt: string | null; autoPickupEnabled: boolean; pickupConcurrency: number; autoPickupEnabledAt: string | null; autoPickupError: string };
type AutoReviewJob = { cardId: string; runId: string; state: "running" | "needs_human" | "merged"; details: string; fingerprint: string; startedAt: string; finishedAt: string | null };
type BakerySettings = { confirmRunStart: boolean; cardDetailsLayout: "dialog" | "side" };
type ReviewComment = { id: string; cardId: string; runId: string; fingerprint: string; path: string; line: number; fileLine: number | null; kind: "add" | "remove" | "context"; code: string; body: string; state: "draft" | "requested"; createdAt: string };
type MergeConflict = { cardId: string; files: string[]; details: string };
type ReviewDiff = { cardId: string; fingerprint: string; files: { path: string; patch: string }[] };
type Card = { id: string; title: string; body: string; repo: string; source: "manual"; status: Status; createdAt: string; updatedAt: string; turns: number; turnsIncomplete: number };
type Run = { id: string; attempt: number; status: Status; output: string; error: string | null; worktree: string | null; startedAt: string; finishedAt: string | null; startedBy: "manual" | "auto" };
const columns: { id: Status; label: string; description: string; dot: string }[] = [
  { id: "triage", label: "Triage", description: "Awaiting approval for work", dot: "bg-muted-foreground" },
  { id: "ready", label: "Ready", description: "Can start a Pi run", dot: "bg-primary" },
  { id: "running", label: "Running", description: "Pi is working", dot: "bg-[#b4bcc4]" },
  { id: "review", label: "Review", description: "Inspect, then approve and merge", dot: "bg-[#b8c4b8]" },
  { id: "failed", label: "Failed", description: "Needs another attempt", dot: "bg-destructive" },
  { id: "interrupted", label: "Interrupted", description: "Inspect the process", dot: "bg-[#d4ccb4]" },
  { id: "done", label: "Done", description: "Merged or closed without a run", dot: "bg-muted-foreground" },
];
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, headers: options?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await response.json();
  if (!response.ok) {
    const failure = new Error(data.error ?? `Request failed (${response.status})`) as Error & { conflict?: MergeConflict };
    if (data.code === "merge_conflict" && Array.isArray(data.files)) failure.conflict = data as MergeConflict;
    throw failure;
  }
  return data as T;
}
const date = (value: string) => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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
  const [copiedCardId, setCopiedCardId] = useState<string | null>(null);
  useEffect(() => {
    if (!copiedCardId) return;
    const timer = window.setTimeout(() => setCopiedCardId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedCardId]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [autoJobs, setAutoJobs] = useState<AutoReviewJob[]>([]);
  const [verificationDraft, setVerificationDraft] = useState("");
  const [expandedDetails, setExpandedDetails] = useState(false);
  const [sideWidth, setSideWidth] = useState(() => Number(localStorage.getItem("bakery-side-width")) || 900);
  const [smallScreen, setSmallScreen] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setSmallScreen(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [review, setReview] = useState<ReviewDiff | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [reviewRefresh, setReviewRefresh] = useState(0);
  const [approvalPending, setApprovalPending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Card | null>(null);
  const [error, setError] = useState("");
  const [mergeConflicts, setMergeConflicts] = useState<MergeConflict[]>([]);
  const [busy, setBusy] = useState(false);
  const [manualCollapse, setManualCollapse] = useState<Record<string, Partial<Record<Status, boolean>>>>({});
  useEffect(() => {
    void api<Board[]>("/boards").then(items => {
      setBoards(items);
      setBoardId(items.find(item => item.id === localStorage.getItem("bakery-board"))?.id ?? items[0]?.id ?? null);
    }).catch(err => setError(String(err)));
    void api<BakerySettings>("/settings").then(setSettings).catch(err => setError(String(err)));
  }, []);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(value => value + 1);
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
        if (selected) {
          const [attempts, approval, annotations, jobs] = await Promise.all([
            api<Run[]>(`/boards/${boardId}/cards/${selected}/runs`),
            api<{ pending: boolean }>(`/boards/${boardId}/cards/${selected}/approval`),
            api<ReviewComment[]>(`/boards/${boardId}/cards/${selected}/comments`),
            api<AutoReviewJob[]>(`/boards/${boardId}/cards/${selected}/auto-review`),
          ]);
          if (current) { setRuns(attempts); setApprovalPending(approval.pending); setComments(annotations); setAutoJobs(jobs); }
        }
      } catch (err) { if (current) setError(String(err)); }
      finally { if (current) timer = setTimeout(() => void poll(), 2000); }
    };
    void poll();
    return () => { current = false; clearTimeout(timer); };
  }, [boardId, selected, refreshKey]);
  const currentBoard = boards.find(item => item.id === boardId);
  const card = cards.find((item) => item.id === selected);
  const currentReview = review?.cardId === selected ? review : null;
  useEffect(() => {
    if (!boardId || !selected || card?.status !== "review") { setReview(null); setReviewError(""); return; }
    let active = true;
    setReview(null); setReviewError("");
    void api<Omit<ReviewDiff, "cardId">>(`/boards/${boardId}/cards/${selected}/review`)
      .then(diff => { if (active) setReview({ ...diff, cardId: selected }); })
      .catch(err => { if (active) setReviewError(err instanceof Error ? err.message : String(err)); });
    return () => { active = false; };
  }, [boardId, selected, card?.status, reviewRefresh]);
  const mergeConflict = mergeConflicts.find(item => item.cardId === selected);
  const currentComments = comments.filter(item => item.cardId === selected);
  const changesRequested = card?.status === "review" && currentComments.some(item => item.runId === runs[0]?.id && item.state === "requested");
  const side = settings?.cardDetailsLayout === "side";
  const saveSettings = (patch: Partial<BakerySettings>) => {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    void action(async () => {
      try { setSettings(await api<BakerySettings>("/settings", { method: "PATCH", body: JSON.stringify(patch) })); }
      catch (error) { setSettings(previous); throw error; }
    });
  };
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await fn(); refresh(); return true; } catch (err) {
      const conflict = err instanceof Error && "conflict" in err ? err.conflict as MergeConflict | undefined : undefined;
      if (conflict) setMergeConflicts(previous => [...previous.filter(item => item.cardId !== conflict.cardId), conflict]);
      else setError(err instanceof Error ? err.message : String(err));
      return false;
    }
    finally { setBusy(false); }
  };
  const removeBoard = (item: Board) => {
    if (!window.confirm(`Remove the board for ${item.repo}? Cards and worktrees remain on disk. Add this repository again to restore the board.`)) return;
    void action(async () => {
      await api(`/boards/${item.id}`, { method: "DELETE" });
      const remaining = boards.filter(board => board.id !== item.id);
      setBoards(remaining);
      if (boardId === item.id) {
        const next = remaining[0]?.id ?? null;
        setBoardId(next);
        if (next) localStorage.setItem("bakery-board", next);
        else localStorage.removeItem("bakery-board");
        setSelected(null); setRuns([]); setCards([]); setMergeConflicts([]);
      }
      setEditingBoard(null); setRepoPath("");
    });
  };
  const active = cards.filter((item) => item.status === "running").length;
  const toggleLane = (status: Status, collapsed: boolean) => {
    if (!boardId) return;
    setManualCollapse(previous => ({ ...previous, [boardId]: { ...previous[boardId], [status]: !collapsed } }));
  };
  return <div className="min-h-screen lg:flex">
    <aside className="flex flex-col border-b border-border bg-[#171a1e] lg:sticky lg:top-0 lg:h-screen lg:w-[228px] lg:shrink-0 lg:border-r lg:border-b-0">
      <div className="flex items-center gap-3 px-6 py-7"><div className="grid size-9 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary"><span className="text-xl leading-none">✳</span></div><span className="text-[18px] font-semibold tracking-[-.04em]">bakery<span className="text-primary">.</span></span></div>
      <div className="px-4 pt-5"><div className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[.18em] text-muted-foreground">Repositories</div>{boards.map(item => <div key={item.id} className={`flex items-center rounded-lg ${boardId === item.id ? "bg-accent/50" : "hover:bg-accent/30"}`}><button onClick={() => { setBoardId(item.id); localStorage.setItem("bakery-board", item.id); setSelected(null); setRuns([]); setCards([]); setMergeConflicts([]); }} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left text-sm" title={item.repo}><LayoutGrid size={16} className="shrink-0 text-primary" /><span className="truncate">{item.repo.split("/").at(-1)}</span></button><button aria-label={`Edit ${item.repo}`} title="Edit repository path" className="mr-2 p-1 text-muted-foreground hover:text-foreground" onClick={() => { setError(""); setRepoPath(item.repo); setEditingBoard(item); }}><Pencil size={13} /></button></div>)}<Button variant="ghost" className="mt-2 w-full justify-start" onClick={() => { setError(""); setAddingRepo(true); }}><Plus size={15} /> Add repository</Button><Button variant="ghost" className="mt-2 w-full justify-start" onClick={() => { setError(""); setVerificationDraft(currentBoard?.verificationCommand ?? ""); setShowSettings(true); }}><Settings2 size={15} /> Settings</Button></div>
      <div className="mt-auto hidden border-t border-border px-6 py-5 lg:block"><div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="size-1.5 rounded-full bg-[#b8c4b8]" /> Local only <span className="ml-auto font-mono">v0.1</span></div></div>
    </aside>
    <main className="min-w-0 flex-1">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-6 lg:px-10"><div><div className="mb-2 text-[11px] font-medium uppercase tracking-[.18em] text-muted-foreground">Workspace / Board</div><h1 className="text-[27px] font-semibold tracking-[-.05em]">{currentBoard ? currentBoard.repo.split("/").at(-1) : "Choose a repository"}</h1><p className="mt-1 text-sm text-muted-foreground">{currentBoard ? currentBoard.repo : "Add a Git repository to create its board."}</p></div><div className="flex items-center gap-2"><Button variant="outline" size="icon" aria-label="Refresh board" onClick={() => void refresh()}><RefreshCw size={15} /></Button><Button disabled={!boardId} onClick={() => setCreating(true)}><Plus size={16} /> New card</Button></div></header>
      <div className="flex flex-wrap gap-x-7 gap-y-2 border-b border-border px-6 py-4 text-xs text-muted-foreground lg:px-10"><span><strong className="mr-1 font-mono text-foreground">{cards.length}</strong> cards</span><span><strong className="mr-1 font-mono text-foreground">{cards.filter(c => c.status === "triage").length}</strong> in triage</span><span><strong className="mr-1 font-mono text-foreground">{cards.filter(c => c.status === "ready").length}</strong> ready</span><span><strong className="mr-1 font-mono text-foreground">{active}</strong> running</span><span><strong className="mr-1 font-mono text-foreground">{cards.filter(c => c.status === "review").length}</strong> awaiting review</span><label className="ml-auto flex cursor-pointer items-center gap-2"><input type="checkbox" disabled={!currentBoard || busy} checked={currentBoard?.autoCollapseEmptySwimlanes ?? false} onChange={event => { const enabled = event.target.checked; if (!boardId) return; void action(async () => { const updated = await api<Board>(`/boards/${boardId}/settings`, { method: "PATCH", body: JSON.stringify({ autoCollapseEmptySwimlanes: enabled }) }); setBoards(previous => previous.map(item => item.id === updated.id ? updated : item)); setManualCollapse(previous => ({ ...previous, [updated.id]: {} })); }); }} className="accent-primary" /> Auto-collapse lanes without active cards</label>{currentBoard?.autoPickupEnabled && <span className="text-primary">Auto pickup · {currentBoard.pickupConcurrency} at a time</span>}<span className="hidden items-center gap-1.5 lg:flex"><CircleHelp size={13} /> Starting a run may use paid model tokens</span></div>
      {currentBoard?.autoPickupError && <div role="alert" className="mx-6 mt-5 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive lg:mx-10">Auto pickup paused: {currentBoard.autoPickupError}. Inspect the run before re-enabling in Settings.</div>}
      {error && <div role="alert" className="mx-6 mt-5 flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive lg:mx-10"><XCircle size={16} className="mt-0.5 shrink-0" /><div className="min-w-0 break-words"><strong className="block">Action failed</strong>{error}</div><button className="ml-auto" onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
      {!selected && mergeConflicts.length > 0 && <div role="alert" className="mx-6 mt-5 flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm lg:mx-10"><XCircle size={16} className="text-destructive" /><span>{mergeConflicts.length} {mergeConflicts.length === 1 ? "card has" : "cards have"} merge conflicts. The card worktrees are still available.</span><Button variant="outline" size="sm" onClick={() => setSelected(mergeConflicts[0].cardId)}>View conflicts</Button></div>}
      <div className="overflow-x-auto p-6 lg:p-10"><div className="flex min-h-[500px] min-w-max gap-4">{columns.map((column) => {
        const laneCards = cards.filter(c => c.status === column.id);
        const collapsible = !laneCards.some(c => c.status !== "done");
        const override = boardId ? manualCollapse[boardId]?.[column.id] : undefined;
        const collapsed = collapsible && (override ?? currentBoard?.autoCollapseEmptySwimlanes ?? false);
        return <section key={column.id} aria-label={`${column.label} lane`} className={`${collapsed ? "w-12" : "w-[280px]"} shrink-0`}>
          {collapsed ? <button type="button" aria-label={`Expand ${column.label} lane`} aria-expanded={false} onClick={() => toggleLane(column.id, true)} className="flex min-h-48 w-full flex-col items-center gap-3 rounded-lg border border-border bg-card px-2 py-3 text-sm hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ChevronRight size={16} /><span className="[writing-mode:vertical-rl]">{column.label}</span><span className="rounded bg-secondary px-1 font-mono text-xs text-muted-foreground">{laneCards.length}</span></button> : <><div className="mb-5 flex items-center gap-2 px-1"><span className={`size-2 rounded-full ${column.dot}`} /><h2 className="text-sm font-semibold">{column.label}</h2><span className="ml-auto rounded-md bg-secondary px-2 py-0.5 font-mono text-xs text-muted-foreground">{laneCards.length}</span>{collapsible && <button type="button" aria-label={`Collapse ${column.label} lane`} aria-expanded={true} onClick={() => toggleLane(column.id, false)} className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ChevronDown size={16} /></button>}</div><div className="mb-4 px-1 text-xs text-muted-foreground">{column.description}</div><div className="space-y-3">{laneCards.map((item) => <button key={item.id} onClick={() => { setSelected(item.id); setRuns([]); }} className="group w-full rounded-xl border border-border/80 bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><div className="mb-4 flex items-start justify-between gap-2"><span className="rounded bg-primary/10 px-2 py-1 text-[10px] font-medium uppercase tracking-[.1em] text-primary">Manual</span><ArrowUpRight size={15} className="text-muted-foreground group-hover:text-primary" /></div><div className="text-[14px] font-medium leading-snug text-foreground">{item.title}</div><p className="mt-2 line-clamp-2 min-h-9 text-xs leading-relaxed text-muted-foreground">{item.body || "No description yet."}</p><div className="mt-5 flex items-center justify-between border-t border-border/70 pt-3 font-mono text-[10px] text-muted-foreground"><span className="flex min-w-0 items-center gap-1 truncate"><GitBranch size={11} className="shrink-0" /> {item.repo.split("/").at(-1)}</span><span className="flex items-center gap-1" title={item.turnsIncomplete ? "Estimated from older transcripts; may be inaccurate. New turns are counted exactly." : "Completed Pi turns across all attempts"}><Clock3 size={11} /> {item.turnsIncomplete ? item.turns ? `~${item.turns}` : "?" : item.turns}</span><span>{date(item.createdAt)}</span></div></button>)}{laneCards.length === 0 && <div className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-xs text-muted-foreground">Nothing here yet.</div>}</div></>}</section>;
      })}</div></div>
    </main>
    <Dialog open={showSettings} onOpenChange={setShowSettings}><DialogContent><DialogTitle>Settings</DialogTitle><DialogDescription>These preferences are saved in Bakery's local database.</DialogDescription><label className="mt-6 flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={settings?.confirmRunStart ?? false} disabled={!settings || busy} onChange={event => saveSettings({ confirmRunStart: event.target.checked })} /><span>Confirm before starting a run<span className="mt-1 block text-xs text-muted-foreground">When off, Start Pi run launches immediately and may use paid model tokens.</span></span></label><fieldset className="mt-6 border-t border-border pt-5 text-sm" disabled={!settings || busy}><legend className="pt-5 font-medium">Card details layout</legend><div className="mt-3 flex gap-5">{(["dialog", "side"] as const).map(layout => <label key={layout} className="flex cursor-pointer items-center gap-2"><input type="radio" name="card-details-layout" checked={settings?.cardDetailsLayout === layout} onChange={() => saveSettings({ cardDetailsLayout: layout })} className="accent-primary" />{layout === "dialog" ? "Popup" : "Side panel"}</label>)}</div><p className="mt-2 text-xs text-muted-foreground">The side panel stays wide for review. On small screens it opens full-screen.</p></fieldset><div className="mt-6 border-t border-border pt-5 text-sm"><div className="font-medium">Unattended review · {currentBoard?.repo.split("/").at(-1) ?? "select a repository"}</div><p className="mt-2 text-xs text-muted-foreground">A tool-free Pi reviewer inspects new Review cards; the verification command runs first. At most 3 merges per 24 hours. Findings, errors, or changes require human review. Local merge only, never push. Auto-review alone does not start Ready cards; enable Auto pickup below.</p><label className="mt-4 block text-xs">Verification command<input aria-label="Auto-review verification command" value={verificationDraft} onChange={event => setVerificationDraft(event.target.value)} disabled={busy} placeholder="npm test && npm run build" className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs" /></label><Button className="mt-3" variant={currentBoard?.autoReviewEnabled ? "outline" : "default"} disabled={!currentBoard || busy || (!currentBoard.autoReviewEnabled && !verificationDraft.trim())} onClick={() => { if (!currentBoard) return; const enable = !currentBoard.autoReviewEnabled || verificationDraft.trim() !== currentBoard.verificationCommand; if (enable && !window.confirm(`Enable unattended agent review and up to 3 local merges per 24 hours for ${currentBoard.repo}? This may spend model tokens. Only new reviews after enabling are eligible.`)) return; void action(async () => { const updated = await api<Board>(`/boards/${currentBoard.id}/settings`, { method: "PATCH", body: JSON.stringify({ autoReviewEnabled: enable, verificationCommand: verificationDraft }) }); setBoards(previous => previous.map(item => item.id === updated.id ? updated : item)); }); }}>{currentBoard?.autoReviewEnabled ? verificationDraft.trim() !== currentBoard.verificationCommand ? "Save and re-enable" : "Disable auto-review" : "Enable auto-review"}</Button>{currentBoard?.autoReviewEnabled && <p className="mt-2 text-xs text-primary">Enabled since {currentBoard.autoReviewEnabledAt && date(currentBoard.autoReviewEnabledAt)}. New reviewed runs can merge without approval.</p>}</div><div className="mt-6 border-t border-border pt-5 text-sm"><div className="font-medium">Auto pickup · {currentBoard?.repo.split("/").at(-1) ?? "select a repository"}</div><p className="mt-2 text-xs text-muted-foreground">Automatically start Ready cards in creation order, up to the concurrency limit including manual runs. At most 6 automatic starts in any 24 hours. A failed automatic run or interrupted run pauses pickup. Starting Pi may spend model tokens. Turn off pickup to stop new starts; existing runs continue.</p><label className="mt-4 flex items-center gap-2 text-xs">Concurrent runs <select aria-label="Auto pickup concurrency" value={currentBoard?.pickupConcurrency ?? 2} disabled={!currentBoard || busy} onChange={event => { if (!currentBoard) return; const limit = Number(event.target.value); void action(async () => { const updated = await api<Board>(`/boards/${currentBoard.id}/settings`, { method: "PATCH", body: JSON.stringify({ autoPickupEnabled: currentBoard.autoPickupEnabled, pickupConcurrency: limit }) }); setBoards(previous => previous.map(item => item.id === updated.id ? updated : item)); }); }} className="rounded-md border border-border bg-background px-2 py-1">{[1, 2, 3, 4].map(limit => <option key={limit} value={limit}>{limit}</option>)}</select></label><Button className="mt-3" variant={currentBoard?.autoPickupEnabled ? "outline" : "default"} disabled={!currentBoard || busy} onClick={() => { if (!currentBoard) return; const enable = !currentBoard.autoPickupEnabled; if (enable && !window.confirm(`Enable automatic Pi pickup for ${currentBoard.repo}? Up to ${currentBoard.pickupConcurrency} paid Pi runs can start without another click, up to 6 per 24 hours. Ready cards may start immediately.`)) return; void action(async () => { const updated = await api<Board>(`/boards/${currentBoard.id}/settings`, { method: "PATCH", body: JSON.stringify({ autoPickupEnabled: enable, pickupConcurrency: currentBoard.pickupConcurrency }) }); setBoards(previous => previous.map(item => item.id === updated.id ? updated : item)); }); }}>{currentBoard?.autoPickupEnabled ? "Disable auto pickup" : "Enable auto pickup"}</Button>{currentBoard?.autoPickupError && <p role="alert" className="mt-2 text-xs text-destructive">Paused: {currentBoard.autoPickupError}</p>}</div>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}</DialogContent></Dialog>
    <Dialog open={addingRepo || !!editingBoard} onOpenChange={open => { if (!open) { setAddingRepo(false); setEditingBoard(null); setRepoPath(""); } }}><DialogContent><DialogTitle>{editingBoard ? "Edit repository path" : "Add repository"}</DialogTitle><DialogDescription>{editingBoard ? "Cards can move to a different root only before their first run." : "Enter an existing Git repository root. Paths starting with ~/ are supported."}</DialogDescription>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}<form className="mt-5 flex gap-2" onSubmit={event => { event.preventDefault(); void action(async () => { const item = await api<Board>(editingBoard ? `/boards/${editingBoard.id}` : "/boards", { method: editingBoard ? "PATCH" : "POST", body: JSON.stringify({ repo: repoPath }) }); setBoards(previous => [...previous.filter(board => board.id !== item.id), item].sort((a, b) => a.repo.localeCompare(b.repo))); setBoardId(item.id); localStorage.setItem("bakery-board", item.id); setCards([]); setSelected(null); setMergeConflicts([]); setRepoPath(""); setAddingRepo(false); setEditingBoard(null); }); }}><input required aria-label="Repository root" value={repoPath} onChange={event => setRepoPath(event.target.value)} placeholder="~/code/project" className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" /><Button disabled={busy} type="submit">{editingBoard ? "Save" : "Add"}</Button></form>{editingBoard && <div className="mt-8 border-t border-border pt-5"><div className="text-sm font-medium">Remove repository</div><p className="mt-1 text-xs text-muted-foreground">Hides this board. Cards, runs, and worktrees stay on disk. Add the repository again to restore them.</p><Button variant="destructive" className="mt-4" disabled={busy} onClick={() => removeBoard(editingBoard)}>Remove repository from Bakery</Button></div>}</DialogContent></Dialog>
    <Dialog open={creating || !!editing} onOpenChange={(open) => { if (!open) { setCreating(false); setEditing(null); } }}><DialogContent><DialogTitle className="text-lg font-semibold tracking-tight">{editing ? "Edit card" : "New card"}</DialogTitle><DialogDescription className="mt-1 text-sm text-muted-foreground">Work in {currentBoard && currentBoard.repo}.</DialogDescription><CardForm key={editing?.id ?? "new"} initial={editing ?? undefined} onSubmit={(value) => action(async () => { const saved = await api<Card>(`/boards/${boardId}/cards${editing ? `/${editing.id}` : ""}`, { method: editing ? "PATCH" : "POST", body: JSON.stringify(value) }); setCreating(false); setEditing(null); setSelected(saved.id); })} busy={busy} /></DialogContent></Dialog>
    <Dialog open={!!selected} modal={!side || expandedDetails || smallScreen} onOpenChange={(open) => { if (!open) { setSelected(null); setExpandedDetails(false); } }}><DialogContent showOverlay={!side || expandedDetails || smallScreen} onInteractOutside={event => { if (side && !expandedDetails && !smallScreen) event.preventDefault(); }} overlayClassName={side ? "bg-black/25 backdrop-blur-none" : undefined} style={side && !expandedDetails ? { "--card-width": `${sideWidth}px` } as CSSProperties : undefined} className={expandedDetails ? "left-0 top-0 h-[100dvh] max-h-[100dvh] w-screen translate-x-0 translate-y-0 rounded-none" : side ? "right-0 left-auto top-0 h-[100dvh] max-h-[100dvh] w-screen translate-x-0 translate-y-0 rounded-none lg:w-[min(var(--card-width),95vw)]" : "w-[min(94vw,750px)]"}>{side && !expandedDetails && <div role="separator" aria-label="Resize card panel" aria-orientation="vertical" aria-valuenow={sideWidth} tabIndex={0} onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const width = Math.min(window.innerWidth - 80, Math.max(520, window.innerWidth - event.clientX)); setSideWidth(width); localStorage.setItem("bakery-side-width", String(width)); } }} onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); setSideWidth(previous => { const width = Math.min(window.innerWidth - 80, Math.max(520, previous + (event.key === "ArrowLeft" ? 32 : -32))); localStorage.setItem("bakery-side-width", String(width)); return width; }); }} className="absolute inset-y-0 left-0 hidden w-2 cursor-ew-resize bg-transparent hover:bg-primary/30 focus-visible:bg-primary/40 lg:block" />}<DialogTitle className="pr-7 text-xl font-semibold tracking-tight">{card?.title}</DialogTitle><DialogDescription className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><span className="rounded bg-primary/10 px-2 py-1 uppercase tracking-wider text-primary">{card?.status}</span> Manual card · {card && card.repo}</DialogDescription>{card && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>Card ID</span><code className="select-all font-mono text-foreground">{card.id}</code><Button size="sm" variant="ghost" aria-label="Copy card ID" onClick={() => { void navigator.clipboard.writeText(card.id).then(() => setCopiedCardId(card.id)).catch(() => setError("Could not copy the card ID. Select the ID above to copy it manually.")); }}>{copiedCardId === card.id ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy ID</>}</Button></div>}<Button size="sm" variant="ghost" className="mt-3" onClick={() => setExpandedDetails(value => !value)}>{expandedDetails ? <><Minimize2 size={13} /> Exit full screen</> : <><Maximize2 size={13} /> Expand review</>}</Button><p className="mt-6 whitespace-pre-wrap text-sm leading-6 text-foreground/80">{card?.body || "No description."}</p>{card?.status === "failed" && runs[0]?.error && <div role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm"><strong>Run failed</strong><p className="mt-1 text-destructive">{runs[0].error}</p><p className="mt-2 text-xs text-muted-foreground">Inspect the latest attempt and its worktree below before retrying. No changes were merged from this run.</p></div>}{autoJobs[0] && autoJobs[0].cardId === card?.id && <div className="mt-4 rounded-md border border-border bg-accent/20 p-3 text-xs"><strong>Agent review: {autoJobs[0].state === "running" ? "checking" : autoJobs[0].state === "merged" ? "merged locally" : "needs human review"}</strong>{autoJobs[0].details && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{autoJobs[0].details}</p>}</div>}{mergeConflict && card?.id === mergeConflict.cardId && <MergeConflictPanel conflict={mergeConflict} onDismiss={() => void action(async () => { await api(`/boards/${boardId}/cards/${mergeConflict.cardId}/conflict`, { method: "DELETE" }); setMergeConflicts(previous => previous.filter(item => item.cardId !== mergeConflict.cardId)); })} />}<div className="mt-6 flex flex-wrap gap-2 border-t border-border pt-5">{card && card.status !== "running" && <Button variant="ghost" disabled={busy} onClick={() => { setEditing(card); setSelected(null); }}>Edit card</Button>}{card?.status === "triage" && <Button disabled={busy} onClick={() => action(() => api(`/boards/${boardId}/cards/${card.id}/status`, { method: "POST", body: JSON.stringify({ status: "ready" }) }))}>Move to Ready</Button>}{card?.status === "ready" && runs.length === 0 && <Button variant="outline" disabled={busy} onClick={() => action(() => api(`/boards/${boardId}/cards/${card.id}/status`, { method: "POST", body: JSON.stringify({ status: "triage" }) }))}>Move to Triage</Button>}{card && ["ready", "failed", "review"].includes(card.status) && <Button disabled={busy || !settings || (card.status === "review" && (approvalPending || currentComments.some(item => item.runId === runs[0]?.id && item.state === "draft")))} onClick={() => { if (settings?.confirmRunStart && !window.confirm("Start Pi on this card? This run may use paid model tokens and can edit its Git worktree.")) return; void action(() => api(`/boards/${boardId}/cards/${card.id}/start`, { method: "POST" })); }}><span className="text-base">✳</span> {mergeConflict && ["review", "failed"].includes(card.status) ? "Fix conflict with Pi" : runs.length ? "Run again" : "Start Pi run"}</Button>}{card?.status === "running" && runs[0] && <Button variant="destructive" disabled={busy} onClick={() => action(() => api(`/boards/${boardId}/cards/${card.id}/stop`, { method: "POST" }))}><Square size={13} /> Stop run</Button>}{card?.status === "review" && <Button variant="outline" disabled={busy || !currentReview || changesRequested || autoJobs.some(item => item.runId === runs[0]?.id && item.state === "running") || currentComments.some(item => item.runId === runs[0]?.id && item.state === "draft")} onClick={() => { if (!currentReview || !window.confirm(`Approve the reviewed diff and merge into local main for ${card.repo}? This commits unignored files. Git refuses to overwrite conflicting local changes. Bakery checks Git conflicts and whitespace, but does not run tests or push.`)) return; setMergeConflicts(previous => previous.filter(item => item.cardId !== card.id)); void action(() => api(`/boards/${boardId}/cards/${card.id}/approve`, { method: "POST", body: JSON.stringify({ fingerprint: currentReview.fingerprint }) })); }}>Approve and merge</Button>}{card?.status === "review" && !changesRequested && <Button variant="outline" disabled={busy || !currentReview || approvalPending || currentComments.some(item => item.state === "draft" && item.runId === runs[0]?.id && item.fingerprint !== currentReview?.fingerprint) || !currentComments.some(item => item.state === "draft" && item.runId === runs[0]?.id && item.fingerprint === currentReview?.fingerprint)} onClick={() => { if (!currentReview) return; void action(async () => { setComments(await api<ReviewComment[]>(`/boards/${boardId}/cards/${card.id}/request-changes`, { method: "POST", body: JSON.stringify({ fingerprint: currentReview.fingerprint }) })); }); }}>Request changes</Button>}{changesRequested && <span className="self-center text-xs text-muted-foreground">Changes requested. Run again when ready; Pi will receive your feedback.</span>}{card?.status === "review" && currentReview && currentComments.some(item => item.runId === runs[0]?.id && item.state === "draft" && item.fingerprint !== currentReview.fingerprint) && <span className="self-center text-xs text-muted-foreground">Remove draft comments on older diffs before submitting feedback.</span>}{card?.status === "review" && approvalPending && <Button variant="ghost" disabled={busy} onClick={() => { if (!window.confirm("Withdraw the pending approval? The card's Git commits and worktree remain. You can revise the card and try again.")) return; void action(() => api(`/boards/${boardId}/cards/${card.id}/withdraw`, { method: "POST" })); }}>Withdraw approval</Button>}{card && ["triage", "ready"].includes(card.status) && runs.length === 0 && <Button variant="outline" disabled={busy} onClick={() => action(() => api(`/boards/${boardId}/cards/${card.id}/status`, { method: "POST", body: JSON.stringify({ status: "done" }) }))}>Mark done</Button>}{card?.status === "done" && <Button variant="outline" disabled={busy} onClick={() => action(() => api(`/boards/${boardId}/cards/${card.id}/status`, { method: "POST", body: JSON.stringify({ status: "ready" }) }))}>Reopen</Button>}</div>{card?.status === "interrupted" && <div className="mt-4 rounded-lg border border-primary/30 bg-primary/10 p-3 text-xs text-primary"><p>The server restarted during this run. Inspect its worktree and confirm the Pi process has stopped before releasing the card.</p><Button className="mt-3" size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm("I inspected the worktree and confirmed the old Pi process has stopped. Release this card for retry?")) void action(() => api(`/boards/${boardId}/cards/${card.id}/resolve`, { method: "POST", body: JSON.stringify({ acknowledged: true }) })); }}>Release for retry</Button></div>}{error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}{card?.status === "review" && <ReviewPanel review={currentReview} error={reviewError} comments={currentComments} runId={runs[0]?.id} busy={busy} onRefresh={() => setReviewRefresh(value => value + 1)} onAdd={(path, line, body) => action(async () => { const saved = await api<ReviewComment>(`/boards/${boardId}/cards/${card.id}/comments`, { method: "POST", body: JSON.stringify({ fingerprint: currentReview?.fingerprint, path, line, body }) }); setComments(previous => [...previous, saved]); })} onDelete={id => action(async () => { await api(`/boards/${boardId}/cards/${card.id}/comments/${id}`, { method: "DELETE" }); setComments(previous => previous.filter(item => item.id !== id)); })} />}{runs.length > 0 && <AttemptList key={selected} runs={runs} />}</DialogContent></Dialog>
  </div>;
}
function ReviewPanel({ review, error, comments, runId, busy, onRefresh, onAdd, onDelete }: {
  review: ReviewDiff | null; error: string; comments: ReviewComment[]; runId?: string; busy: boolean;
  onRefresh: () => void; onAdd: (path: string, line: number, body: string) => Promise<boolean>; onDelete: (id: string) => Promise<boolean>;
}) {
  const [jump, setJump] = useState<{ review: ReviewDiff; index: number; id: number } | null>(null);
  return <section aria-label="Review diff" className="mt-8 border-t border-border pt-5">
    <div className="flex items-center justify-between gap-3"><h3 className="text-xs font-semibold uppercase tracking-[.14em] text-muted-foreground">Review diff</h3><Button size="sm" variant="ghost" onClick={onRefresh}><RefreshCw size={13} /> Refresh diff</Button></div>
    <p className="mt-2 text-xs text-muted-foreground">Card changes since its shared commit with main. Select a code line to annotate it. Comments stay on this exact diff; older comments are kept as history, not moved to new lines.</p>
    {error && <p role="alert" className="mt-3 text-xs text-destructive">Could not load review diff: {error}</p>}
    {!review && !error && <p className="mt-3 text-xs text-muted-foreground">Loading review diff…</p>}
    {review && (review.files.length === 0 ? <p className="mt-4 text-xs text-muted-foreground">No card changes to review.</p> : <>
      <p className="mt-4 text-xs font-medium">Changed files ({review.files.length})</p>
      <ul className="mt-2 space-y-1 font-mono text-xs">{review.files.map((file, index) => <li key={file.path} className="break-all"><button type="button" onClick={() => setJump(previous => ({ review, index, id: (previous?.id ?? 0) + 1 }))} className="rounded text-left text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{file.path}</button></li>)}</ul>
      <div className="mt-4 space-y-3">{review.files.map((file, index) => <ReviewFile key={`${review.fingerprint}:${file.path}`} file={file} index={index} jump={jump?.review === review && jump.index === index ? jump.id : undefined} comments={comments.filter(comment => comment.path === file.path && comment.runId === runId && comment.fingerprint === review.fingerprint)} busy={busy} canComment={!comments.some(comment => comment.runId === runId && comment.state === "requested")} onAdd={onAdd} />)}</div>
    </>)}
    {comments.length > 0 && <section aria-label="Review feedback" className="mt-6 border-t border-border pt-4"><h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Review feedback</h4><ul className="mt-3 space-y-2">{comments.map(comment => {
      const older = comment.runId !== runId || comment.fingerprint !== review?.fingerprint;
      return <li key={comment.id} className="rounded-md border border-border bg-background p-3 text-xs"><div className="flex flex-wrap items-center gap-2 font-mono text-muted-foreground"><span className="break-all">{comment.path}:{comment.fileLine ?? `diff row ${comment.line}`}</span><span>· {comment.state}</span>{older && <span>· older diff (line may have moved)</span>}</div><code className="mt-2 block truncate text-muted-foreground" title={comment.code}>{comment.code}</code><p className="mt-2 whitespace-pre-wrap break-words text-sm">{comment.body}</p>{comment.state === "draft" && <Button size="sm" variant="ghost" className="mt-2" disabled={busy} onClick={() => void onDelete(comment.id)}>Remove draft</Button>}</li>;
    })}</ul></section>}
  </section>;
}
function ReviewFile({ file, index, jump, comments, busy, canComment, onAdd }: {
  file: ReviewDiff["files"][number]; index: number; jump?: number; comments: ReviewComment[]; busy: boolean; canComment: boolean;
  onAdd: (path: string, line: number, body: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(index === 0);
  const heading = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (jump !== undefined) setOpen(true); }, [jump]);
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
  return <div className="overflow-hidden rounded-lg border border-border bg-background">
    <h4><button ref={heading} type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(previous => !previous)} className="flex w-full items-center gap-2 break-all px-4 py-3 text-left font-mono text-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {open ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}{file.path}{comments.length > 0 && <span className="ml-auto rounded bg-secondary px-2 py-0.5">{comments.length} note{comments.length === 1 ? "" : "s"}</span>}
    </button></h4>
    {open && <div id={panelId}><DiffPatch path={file.path} patch={file.patch} comments={comments} onSelect={canComment ? setSelectedLine : undefined} />
      {selectedLine !== null && canComment && <form className="space-y-2 border-t border-border p-4" onSubmit={event => { event.preventDefault(); if (!text.trim()) return; void onAdd(file.path, selectedLine, text).then(saved => { if (saved) { setText(""); setSelectedLine(null); } }); }}><label className="block text-xs font-medium">Comment on {file.path}:{fileLine ?? `diff row ${selectedLine}`}<code className="mt-1 block truncate font-normal text-muted-foreground">{code}</code><textarea required maxLength={1000} value={text} onChange={event => setText(event.target.value)} rows={3} autoFocus placeholder="What should change?" className="mt-2 w-full resize-y rounded-md border border-border bg-card p-2 text-sm" /></label><div className="flex gap-2"><Button size="sm" disabled={busy || !text.trim()} type="submit">Add comment</Button><Button size="sm" variant="ghost" type="button" onClick={() => setSelectedLine(null)}>Cancel</Button></div></form>}
    </div>}
  </div>;
}
function DiffPatch({ path, patch, comments, onSelect }: { path: string; patch: string; comments: ReviewComment[]; onSelect?: (line: number) => void }) {
  const colors = { add: "bg-[#193529] text-[#b6e5c5]", remove: "bg-[#3b2528] text-[#f0b5b5]", context: "text-foreground/80", meta: "bg-[#282c34] text-muted-foreground" };
  const parsed = parseDiff(patch);
  const lines = parsed.length ? parsed : [{ kind: "meta" as const, code: "No text diff (binary file).", prefix: "" }];
  return <div className="max-h-96 overflow-auto border-t border-border bg-[#171a1e] font-mono text-[11px] leading-5 whitespace-pre">
    {lines.map((line, index) => <div key={index}><div data-change={line.kind} className={`flex min-w-full w-max ${colors[line.kind]}`}>
      {line.kind === "meta" ? <span className="px-2">{line.code}</span> : <><button type="button" aria-label={`Comment on ${path} line ${line.newLine ?? line.oldLine ?? index + 1} (${line.kind})`} disabled={!onSelect} onClick={() => onSelect?.(index + 1)} className="w-10 shrink-0 text-right text-muted-foreground hover:bg-primary/20 disabled:opacity-50">{line.newLine ?? line.oldLine ?? ""}</button><span className="w-4 shrink-0 pl-1">{line.prefix}</span><code className="pr-4" dangerouslySetInnerHTML={{ __html: highlightDiffCode(line.code, path) }} /></>}
    </div>{comments.filter(comment => comment.line === index + 1).map(comment => <div key={comment.id} className="min-w-full w-max border-l-2 border-primary bg-card px-3 py-1 text-foreground whitespace-normal"><span className="text-primary">{comment.state === "draft" ? "Draft" : "Requested"}: </span>{comment.body}</div>)}</div>)}
  </div>;
}
function AttemptList({ runs }: { runs: Run[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return <div className="mt-8">
    <h3 className="mb-4 text-xs font-semibold uppercase tracking-[.14em] text-muted-foreground">Attempts</h3>
    <div className="space-y-4">{runs.map((run, index) => {
      const open = expanded[run.id] ?? index === 0;
      return <div key={run.id} className="overflow-hidden rounded-lg border border-border bg-background">
        <button type="button" aria-expanded={open} aria-controls={`attempt-${run.id}`} onClick={() => setExpanded(previous => ({ ...previous, [run.id]: !(previous[run.id] ?? index === 0) }))} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left text-xs hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="font-mono text-primary">Attempt #{run.attempt}</span>
          <span className="capitalize">{run.status}</span>{run.startedBy === "auto" && <span className="rounded bg-primary/10 px-1 text-primary">Auto pickup</span>}
          <span className="ml-auto flex items-center gap-1 text-muted-foreground"><Clock3 size={12} /> {date(run.startedAt)}</span>
        </button>
        {open && <div id={`attempt-${run.id}`} className="border-t border-border">
          {run.worktree && <div className="truncate px-4 pt-3 font-mono text-[11px] text-muted-foreground">{run.worktree}</div>}
          {run.error && <p className="px-4 pt-3 text-xs text-destructive">{run.error}</p>}
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-5 text-foreground/75">{run.output || (run.status === "running" ? "Waiting for Pi output…" : "No assistant output recorded.")}</pre>
        </div>}
      </div>;
    })}</div>
  </div>;
}
function MergeConflictPanel({ conflict, onDismiss }: { conflict: MergeConflict; onDismiss: () => void }) {
  return <section role="alert" aria-label="Merge conflict" className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
    <div className="flex items-start gap-3"><XCircle size={18} className="mt-0.5 shrink-0 text-destructive" /><div className="min-w-0 flex-1"><h3 className="font-semibold">Merge blocked by conflicts</h3><p className="mt-1 text-muted-foreground">Bakery has not merged these changes into main. The card worktree remains available.</p></div><button onClick={onDismiss} aria-label="Dismiss merge conflict" className="text-muted-foreground hover:text-foreground">×</button></div>
    <div className="mt-4 pl-7"><p className="font-medium">Conflicting files ({conflict.files.length})</p><ul className="mt-2 space-y-1 font-mono text-xs">{conflict.files.map(file => <li key={file} className="break-all rounded bg-background/70 px-2 py-1">{file}</li>)}</ul><p className="mt-4 text-muted-foreground">Choose Fix conflict with Pi to ask the agent to reconcile the card branch with current main. It can commit the resolution on that branch, but cannot merge into main. Review its changes before approving again. You can also resolve the branch yourself in its worktree.</p><details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">Git details</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-3 font-mono">{conflict.details}</pre></details></div>
  </section>;
}
function CardForm({ onSubmit, busy, initial }: { onSubmit: (value: { title: string; body: string }) => void; busy: boolean; initial?: Card }) {
  const [title, setTitle] = useState(initial?.title ?? ""); const [body, setBody] = useState(initial?.body ?? "");
  function submit(event: FormEvent) { event.preventDefault(); onSubmit({ title, body }); }
  const input = "w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary";
  return <form onSubmit={submit} className="mt-6 space-y-5"><label className="block text-xs font-medium">Title<input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs doing?" className={`mt-2 ${input}`} /></label><label className="block text-xs font-medium">Description<textarea value={body} maxLength={16000} onChange={e => setBody(e.target.value)} placeholder="Context, acceptance criteria, and anything the agent should know…" rows={5} className={`mt-2 resize-y ${input}`} /></label><p className="text-xs leading-5 text-muted-foreground">This card uses the selected repository. New cards start in Triage. Move one to Ready before starting a run. Creating or moving a card does not start an agent.</p><div className="flex justify-end"><Button disabled={busy} type="submit">{initial ? "Save changes" : "Create card"} <Plus size={15} /></Button></div></form>;
}
createRoot(document.getElementById("root")!).render(<App />);
