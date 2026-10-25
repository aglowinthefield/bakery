import { memo, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRight, ChevronDown, ChevronRight, CircleHelp, Clock3, GitBranch, LayoutGrid, LoaderCircle, Pencil, Plus, RefreshCw, Settings2, Square, XCircle } from "lucide-react";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";
import "./style.css";
import "highlight.js/styles/github-dark.css";
import { highlightDiffCode, parseDiff } from "./review-diff.js";

type Status = "triage" | "ready" | "running" | "review" | "failed" | "interrupted" | "done";
type Board = { id: string; repo: string; autoCollapseEmptySwimlanes: boolean };
type BakerySettings = { confirmRunStart: boolean };
type MergeConflict = { cardId: string; files: string[]; details: string };
type ReviewDiff = { cardId: string; fingerprint: string; files: { path: string; patch: string }[] };
type Card = { id: string; title: string; body: string; repo: string; source: "manual"; status: Status; createdAt: string; updatedAt: string; turns: number; turnsIncomplete: number };
type Run = { id: string; attempt: number; status: Status; output: string; error: string | null; worktree: string | null; startedAt: string; finishedAt: string | null };
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
  const [runs, setRuns] = useState<Run[]>([]);
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
        const [next, conflicts] = await Promise.all([
          api<Card[]>(`/boards/${boardId}/cards`),
          api<MergeConflict[]>(`/boards/${boardId}/conflicts`),
        ]);
        if (!current) return;
        setCards(next);
        setMergeConflicts(conflicts);
        if (selected) {
          const [attempts, approval] = await Promise.all([
            api<Run[]>(`/boards/${boardId}/cards/${selected}/runs`),
            api<{ pending: boolean }>(`/boards/${boardId}/cards/${selected}/approval`),
          ]);
          if (current) { setRuns(attempts); setApprovalPending(approval.pending); }
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
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await fn(); refresh(); } catch (err) {
      const conflict = err instanceof Error && "conflict" in err ? err.conflict as MergeConflict | undefined : undefined;
      if (conflict) setMergeConflicts(previous => [...previous.filter(item => item.cardId !== conflict.cardId), conflict]);
      else setError(err instanceof Error ? err.message : String(err));
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
      <div className="px-4 pt-5"><div className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[.18em] text-muted-foreground">Repositories</div>{boards.map(item => <div key={item.id} className={`flex items-center rounded-lg ${boardId === item.id ? "bg-accent/50" : "hover:bg-accent/30"}`}><button onClick={() => { setBoardId(item.id); localStorage.setItem("bakery-board", item.id); setSelected(null); setRuns([]); setCards([]); setMergeConflicts([]); }} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left text-sm" title={item.repo}><LayoutGrid size={16} className="shrink-0 text-primary" /><span className="truncate">{item.repo.split("/").at(-1)}</span></button><button aria-label={`Edit ${item.repo}`} title="Edit repository path" className="mr-2 p-1 text-muted-foreground hover:text-foreground" onClick={() => { setError(""); setRepoPath(item.repo); setEditingBoard(item); }}><Pencil size={13} /></button></div>)}<Button variant="ghost" className="mt-2 w-full justify-start" onClick={() => { setError(""); setAddingRepo(true); }}><Plus size={15} /> Add repository</Button><Button variant="ghost" className="mt-2 w-full justify-start" onClick={() => { setError(""); setShowSettings(true); }}><Settings2 size={15} /> Settings</Button></div>
      <div className="mt-auto hidden border-t border-border px-6 py-5 lg:block"><div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="size-1.5 rounded-full bg-[#b8c4b8]" /> Local only <span className="ml-auto font-mono">v0.1</span></div></div>
    </aside>
    <main className="min-w-0 flex-1">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-6 lg:px-10"><div><div className="mb-2 text-[11px] font-medium uppercase tracking-[.18em] text-muted-foreground">Workspace / Board</div><h1 className="text-[27px] font-semibold tracking-[-.05em]">{currentBoard ? currentBoard.repo.split("/").at(-1) : "Choose a repository"}</h1><p className="mt-1 text-sm text-muted-foreground">{currentBoard ? currentBoard.repo : "Add a Git repository to create its board."}</p></div><div className="flex items-center gap-2"><Button variant="outline" size="icon" aria-label="Refresh board" onClick={() => void refresh()}><RefreshCw size={15} /></Button><Button disabled={!boardId} onClick={() => setCreating(true)}><Plus size={16} /> New card</Button></div></header>
      <div className="flex flex-wrap gap-x-7 gap-y-2 border-b border-border px-6 py-4 text-xs text-muted-foreground lg:px-10"><span><strong className="mr-1 font-mono text-foreground">{cards.length}</strong> cards</span><span><strong className="mr-1 font-mono text-foreground">{cards.filter(c => c.status === "triage").length}</strong> in triage</span><span><strong className="mr-1 font-mono text-foreground">{cards.filter(c => c.status === "ready").length}</strong> ready</span><span><strong className="mr-1 font-mono text-foreground">{active}</strong> running</span><span><strong className="mr-1 font-mono text-foreground">{cards.filter(c => c.status === "review").length}</strong> awaiting review</span><label className="ml-auto flex cursor-pointer items-center gap-2"><input type="checkbox" disabled={!currentBoard || busy} checked={currentBoard?.autoCollapseEmptySwimlanes ?? false} onChange={event => { const enabled = event.target.checked; if (!boardId) return; void action(async () => { const updated = await api<Board>(`/boards/${boardId}/settings`, { method: "PATCH", body: JSON.stringify({ autoCollapseEmptySwimlanes: enabled }) }); setBoards(previous => previous.map(item => item.id === updated.id ? updated : item)); setManualCollapse(previous => ({ ...previous, [updated.id]: {} })); }); }} className="accent-primary" /> Auto-collapse lanes without active cards</label><span className="hidden items-center gap-1.5 lg:flex"><CircleHelp size={13} /> Starting a run may use paid model tokens</span></div>
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
    <Dialog open={showSettings} onOpenChange={setShowSettings}><DialogContent><DialogTitle>Settings</DialogTitle><DialogDescription>These preferences are saved in Bakery's local database.</DialogDescription><label className="mt-6 flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={settings?.confirmRunStart ?? false} disabled={!settings || busy} onChange={event => { const confirmRunStart = event.target.checked; const previous = settings; setSettings({ confirmRunStart }); void action(async () => { try { setSettings(await api<BakerySettings>("/settings", { method: "PATCH", body: JSON.stringify({ confirmRunStart }) })); } catch (error) { setSettings(previous); throw error; } }); }} /><span>Confirm before starting a run<span className="mt-1 block text-xs text-muted-foreground">When off, Start Pi run launches immediately and may use paid model tokens.</span></span></label>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}</DialogContent></Dialog>
    <Dialog open={addingRepo || !!editingBoard} onOpenChange={open => { if (!open) { setAddingRepo(false); setEditingBoard(null); setRepoPath(""); } }}><DialogContent><DialogTitle>{editingBoard ? "Edit repository path" : "Add repository"}</DialogTitle><DialogDescription>{editingBoard ? "Cards can move to a different root only before their first run." : "Enter an existing Git repository root. Paths starting with ~/ are supported."}</DialogDescription>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}<form className="mt-5 flex gap-2" onSubmit={event => { event.preventDefault(); void action(async () => { const item = await api<Board>(editingBoard ? `/boards/${editingBoard.id}` : "/boards", { method: editingBoard ? "PATCH" : "POST", body: JSON.stringify({ repo: repoPath }) }); setBoards(previous => [...previous.filter(board => board.id !== item.id), item].sort((a, b) => a.repo.localeCompare(b.repo))); setBoardId(item.id); localStorage.setItem("bakery-board", item.id); setCards([]); setSelected(null); setMergeConflicts([]); setRepoPath(""); setAddingRepo(false); setEditingBoard(null); }); }}><input required aria-label="Repository root" value={repoPath} onChange={event => setRepoPath(event.target.value)} placeholder="~/code/project" className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" /><Button disabled={busy} type="submit">{editingBoard ? "Save" : "Add"}</Button></form>{editingBoard && <div className="mt-8 border-t border-border pt-5"><div className="text-sm font-medium">Remove repository</div><p className="mt-1 text-xs text-muted-foreground">Hides this board. Cards, runs, and worktrees stay on disk. Add the repository again to restore them.</p><Button variant="destructive" className="mt-4" disabled={busy} onClick={() => removeBoard(editingBoard)}>Remove repository from Bakery</Button></div>}</DialogContent></Dialog>
    <Dialog open={creating || !!editing} onOpenChange={(open) => { if (!open) { setCreating(false); setEditing(null); } }}><DialogContent><DialogTitle className="text-lg font-semibold tracking-tight">{editing ? "Edit card" : "New card"}</DialogTitle><DialogDescription className="mt-1 text-sm text-muted-foreground">Work in {currentBoard && currentBoard.repo}.</DialogDescription><CardForm key={editing?.id ?? "new"} initial={editing ?? undefined} onSubmit={(value) => action(async () => { const saved = await api<Card>(`/boards/${boardId}/cards${editing ? `/${editing.id}` : ""}`, { method: editing ? "PATCH" : "POST", body: JSON.stringify(value) }); setCreating(false); setEditing(null); setSelected(saved.id); })} busy={busy} /></DialogContent></Dialog>
    <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}><DialogContent className="w-[min(94vw,750px)]"><DialogTitle className="pr-7 text-xl font-semibold tracking-tight">{card?.title}</DialogTitle><DialogDescription className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><span className="rounded bg-primary/10 px-2 py-1 uppercase tracking-wider text-primary">{card?.status}</span> Manual card · {card && card.repo}</DialogDescription><p className="mt-6 whitespace-pre-wrap text-sm leading-6 text-foreground/80">{card?.body || "No description."}</p>{mergeConflict && card?.id === mergeConflict.cardId && <MergeConflictPanel conflict={mergeConflict} onDismiss={() => void action(async () => { await api(`/boards/${boardId}/cards/${mergeConflict.cardId}/conflict`, { method: "DELETE" }); setMergeConflicts(previous => previous.filter(item => item.cardId !== mergeConflict.cardId)); })} />}<div className="mt-6 flex flex-wrap gap-2 border-t border-border pt-5">{card && card.status !== "running" && <Button variant="ghost" disabled={busy} onClick={() => { setEditing(card); setSelected(null); }}>Edit card</Button>}{card?.status === "triage" && <Button disabled={busy} onClick={() => action(() => api(`/boards/${boardId}/cards/${card.id}/status`, { method: "POST", body: JSON.stringify({ status: "ready" }) }))}>Move to Ready</Button>}{card?.status === "ready" && runs.length === 0 && <Button variant="outline" disabled={busy} onClick={() => action(() => api(`/boards/${boardId}/cards/${card.id}/status`, { method: "POST", body: JSON.stringify({ status: "triage" }) }))}>Move to Triage</Button>}{card && ["ready", "failed", "review"].includes(card.status) && <Button disabled={busy || !settings || (card.status === "review" && approvalPending)} onClick={() => { if (settings?.confirmRunStart && !window.confirm("Start Pi on this card? This run may use paid model tokens and can edit its Git worktree.")) return; void action(() => api(`/boards/${boardId}/cards/${card.id}/start`, { method: "POST" })); }}><span className="text-base">✳</span> {mergeConflict && ["review", "failed"].includes(card.status) ? "Fix conflict with Pi" : runs.length ? "Run again" : "Start Pi run"}</Button>}{card?.status === "running" && runs[0] && <Button variant="destructive" disabled={busy} onClick={() => action(() => api(`/boards/${boardId}/cards/${card.id}/stop`, { method: "POST" }))}><Square size={13} /> Stop run</Button>}{card?.status === "review" && <Button variant="outline" disabled={busy || !currentReview} onClick={() => { if (!currentReview || !window.confirm(`Approve the reviewed diff and merge into local main for ${card.repo}? This commits unignored files. Git refuses to overwrite conflicting local changes. Bakery checks Git conflicts and whitespace, but does not run tests or push.`)) return; setMergeConflicts(previous => previous.filter(item => item.cardId !== card.id)); void action(() => api(`/boards/${boardId}/cards/${card.id}/approve`, { method: "POST", body: JSON.stringify({ fingerprint: currentReview.fingerprint }) })); }}>Approve and merge</Button>}{card?.status === "review" && approvalPending && <Button variant="ghost" disabled={busy} onClick={() => { if (!window.confirm("Withdraw the pending approval? The card's Git commits and worktree remain. You can revise the card and try again.")) return; void action(() => api(`/boards/${boardId}/cards/${card.id}/withdraw`, { method: "POST" })); }}>Withdraw approval</Button>}{card && ["triage", "ready"].includes(card.status) && runs.length === 0 && <Button variant="outline" disabled={busy} onClick={() => action(() => api(`/boards/${boardId}/cards/${card.id}/status`, { method: "POST", body: JSON.stringify({ status: "done" }) }))}>Mark done</Button>}{card?.status === "done" && <Button variant="outline" disabled={busy} onClick={() => action(() => api(`/boards/${boardId}/cards/${card.id}/status`, { method: "POST", body: JSON.stringify({ status: "ready" }) }))}>Reopen</Button>}</div>{card?.status === "interrupted" && <div className="mt-4 rounded-lg border border-primary/30 bg-primary/10 p-3 text-xs text-primary"><p>The server restarted during this run. Inspect its worktree and confirm the Pi process has stopped before releasing the card.</p><Button className="mt-3" size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm("I inspected the worktree and confirmed the old Pi process has stopped. Release this card for retry?")) void action(() => api(`/boards/${boardId}/cards/${card.id}/resolve`, { method: "POST", body: JSON.stringify({ acknowledged: true }) })); }}>Release for retry</Button></div>}{card?.status === "review" && <ReviewPanel review={currentReview} error={reviewError} onRefresh={() => setReviewRefresh(value => value + 1)} />}{runs.length > 0 && <AttemptList key={selected} runs={runs} />}</DialogContent></Dialog>
  </div>;
}
function ReviewPanel({ review, error, onRefresh }: { review: ReviewDiff | null; error: string; onRefresh: () => void }) {
  return <section aria-label="Review diff" className="mt-8 border-t border-border pt-5">
    <div className="flex items-center justify-between gap-3"><h3 className="text-xs font-semibold uppercase tracking-[.14em] text-muted-foreground">Review diff</h3><Button size="sm" variant="ghost" onClick={onRefresh}><RefreshCw size={13} /> Refresh diff</Button></div>
    <p className="mt-2 text-xs text-muted-foreground">Card changes since its shared commit with main, including unignored worktree files. Refresh after editing; approval rejects changes made since this diff loaded.</p>
    {error && <p role="alert" className="mt-3 text-xs text-destructive">Could not load review diff: {error}</p>}
    {!review && !error && <p className="mt-3 text-xs text-muted-foreground">Loading review diff…</p>}
    {review && (review.files.length === 0 ? <p className="mt-4 text-xs text-muted-foreground">No differences from main.</p> : <>
      <p className="mt-4 text-xs font-medium">Changed files ({review.files.length})</p>
      <ul className="mt-2 space-y-1 font-mono text-xs">{review.files.map(file => <li key={file.path} className="break-all">{file.path}</li>)}</ul>
      <div className="mt-4 space-y-3">{review.files.map((file, index) => <ReviewFile key={file.path} file={file} index={index} />)}</div>
    </>)}
  </section>;
}
function ReviewFile({ file, index }: { file: ReviewDiff["files"][number]; index: number }) {
  const [open, setOpen] = useState(index === 0);
  const panelId = `review-file-${index}`;
  return <div className="overflow-hidden rounded-lg border border-border bg-background">
    <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(previous => !previous)} className="flex w-full items-center gap-2 break-all px-4 py-3 text-left font-mono text-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {open ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}{file.path}
    </button>
    {open && <div id={panelId}><DiffPatch path={file.path} patch={file.patch} /></div>}
  </div>;
}
const DiffPatch = memo(function DiffPatch({ path, patch }: { path: string; patch: string }) {
  const colors = { add: "bg-[#193529] text-[#b6e5c5]", remove: "bg-[#3b2528] text-[#f0b5b5]", context: "text-foreground/80", meta: "bg-[#282c34] text-muted-foreground" };
  const parsed = parseDiff(patch);
  const lines = parsed.length ? parsed : [{ kind: "meta" as const, code: "No text diff (binary file).", prefix: "" }];
  return <div className="max-h-96 overflow-auto border-t border-border bg-[#171a1e]">
    <pre className="m-0 min-w-max font-mono text-[11px] leading-5">{lines.map((line, index) => <div key={index} data-change={line.kind} className={`flex min-w-full w-max ${colors[line.kind]}`}>
      {line.kind !== "meta" && <><span className="sr-only">{line.kind === "add" ? "Added line" : line.kind === "remove" ? "Removed line" : "Unchanged line"}</span><span aria-hidden="true" className="w-6 shrink-0 pl-2">{line.prefix}</span></>}
      {line.kind === "meta" ? <span className="px-2">{line.code}</span> : <code className="pr-4" dangerouslySetInnerHTML={{ __html: highlightDiffCode(line.code, path) }} />}
    </div>)}</pre>
  </div>;
});
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
          <span className="capitalize">{run.status}</span>
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
