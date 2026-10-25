import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRight, CircleHelp, Clock3, GitBranch, LayoutGrid, LoaderCircle, Pencil, Plus, RefreshCw, Settings2, Square, XCircle } from "lucide-react";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";
import "./style.css";

type Status = "ready" | "running" | "review" | "failed" | "interrupted" | "done";
type Board = { id: string; repo: string };
type BakerySettings = { confirmRunStart: boolean };
type Card = { id: string; title: string; body: string; repo: string; source: "manual"; status: Status; createdAt: string; updatedAt: string };
type Run = { id: string; attempt: number; status: Status; output: string; error: string | null; worktree: string | null; startedAt: string; finishedAt: string | null };
const columns: { id: Status; label: string; description: string; dot: string }[] = [
  { id: "ready", label: "Ready", description: "Waiting to be started", dot: "bg-primary" },
  { id: "running", label: "Running", description: "Pi is working", dot: "bg-[#b4bcc4]" },
  { id: "review", label: "Review", description: "Inspect the worktree", dot: "bg-[#b8c4b8]" },
  { id: "failed", label: "Failed", description: "Needs another attempt", dot: "bg-destructive" },
  { id: "interrupted", label: "Interrupted", description: "Inspect the process", dot: "bg-[#d4ccb4]" },
  { id: "done", label: "Done", description: "Closed manually", dot: "bg-muted-foreground" },
];
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, headers: options?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
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
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Card | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
        const next = await api<Card[]>(`/boards/${boardId}/cards`);
        if (!current) return;
        setCards(next);
        if (selected) {
          const attempts = await api<Run[]>(`/boards/${boardId}/cards/${selected}/runs`);
          if (current) setRuns(attempts);
        }
      } catch (err) { if (current) setError(String(err)); }
      finally { if (current) timer = setTimeout(() => void poll(), 2000); }
    };
    void poll();
    return () => { current = false; clearTimeout(timer); };
  }, [boardId, selected, refreshKey]);
  const currentBoard = boards.find(item => item.id === boardId);
  const card = cards.find((item) => item.id === selected);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await fn(); refresh(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
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
        setSelected(null); setRuns([]); setCards([]);
      }
      setEditingBoard(null); setRepoPath("");
    });
  };
  const active = cards.filter((item) => item.status === "running").length;
  return <div className="min-h-screen lg:flex">
    <aside className="flex flex-col border-b border-border bg-[#171a1e] lg:sticky lg:top-0 lg:h-screen lg:w-[228px] lg:shrink-0 lg:border-r lg:border-b-0">
      <div className="flex items-center gap-3 px-6 py-7"><div className="grid size-9 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary"><span className="text-xl leading-none">✳</span></div><span className="text-[18px] font-semibold tracking-[-.04em]">bakery<span className="text-primary">.</span></span></div>
      <div className="px-4 pt-5"><div className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[.18em] text-muted-foreground">Repositories</div>{boards.map(item => <div key={item.id} className={`flex items-center rounded-lg ${boardId === item.id ? "bg-accent/50" : "hover:bg-accent/30"}`}><button onClick={() => { setBoardId(item.id); localStorage.setItem("bakery-board", item.id); setSelected(null); setRuns([]); setCards([]); }} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left text-sm" title={item.repo}><LayoutGrid size={16} className="shrink-0 text-primary" /><span className="truncate">{item.repo.split("/").at(-1)}</span></button><button aria-label={`Edit ${item.repo}`} title="Edit repository path" className="mr-2 p-1 text-muted-foreground hover:text-foreground" onClick={() => { setError(""); setRepoPath(item.repo); setEditingBoard(item); }}><Pencil size={13} /></button></div>)}<Button variant="ghost" className="mt-2 w-full justify-start" onClick={() => { setError(""); setAddingRepo(true); }}><Plus size={15} /> Add repository</Button><Button variant="ghost" className="mt-2 w-full justify-start" onClick={() => { setError(""); setShowSettings(true); }}><Settings2 size={15} /> Settings</Button></div>
      <div className="mt-auto hidden border-t border-border px-6 py-5 lg:block"><div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="size-1.5 rounded-full bg-[#b8c4b8]" /> Local only <span className="ml-auto font-mono">v0.1</span></div></div>
    </aside>
    <main className="min-w-0 flex-1">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-6 lg:px-10"><div><div className="mb-2 text-[11px] font-medium uppercase tracking-[.18em] text-muted-foreground">Workspace / Board</div><h1 className="text-[27px] font-semibold tracking-[-.05em]">{currentBoard ? currentBoard.repo.split("/").at(-1) : "Choose a repository"}</h1><p className="mt-1 text-sm text-muted-foreground">{currentBoard ? currentBoard.repo : "Add a Git repository to create its board."}</p></div><div className="flex items-center gap-2"><Button variant="outline" size="icon" aria-label="Refresh board" onClick={() => void refresh()}><RefreshCw size={15} /></Button><Button disabled={!boardId} onClick={() => setCreating(true)}><Plus size={16} /> New card</Button></div></header>
      <div className="flex flex-wrap gap-x-7 gap-y-2 border-b border-border px-6 py-4 text-xs text-muted-foreground lg:px-10"><span><strong className="mr-1 font-mono text-foreground">{cards.length}</strong> cards</span><span><strong className="mr-1 font-mono text-foreground">{active}</strong> running</span><span><strong className="mr-1 font-mono text-foreground">{cards.filter(c => c.status === "review").length}</strong> awaiting review</span><span className="ml-auto hidden items-center gap-1.5 lg:flex"><CircleHelp size={13} /> Starting a run may use paid model tokens</span></div>
      {error && <div role="alert" className="mx-6 mt-5 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive lg:mx-10"><XCircle size={16} /> {error}<button className="ml-auto" onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
      <div className="overflow-x-auto p-6 lg:p-10"><div className="flex min-h-[500px] min-w-max gap-4">{columns.map((column) => <section key={column.id} className="w-[280px] shrink-0"><div className="mb-5 flex items-center gap-2 px-1"><span className={`size-2 rounded-full ${column.dot}`} /><h2 className="text-sm font-semibold">{column.label}</h2><span className="ml-auto rounded-md bg-secondary px-2 py-0.5 font-mono text-xs text-muted-foreground">{cards.filter(c => c.status === column.id).length}</span></div><div className="mb-4 px-1 text-xs text-muted-foreground">{column.description}</div><div className="space-y-3">{cards.filter(c => c.status === column.id).map((item) => <button key={item.id} onClick={() => { setSelected(item.id); setRuns([]); }} className="group w-full rounded-xl border border-border/80 bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><div className="mb-4 flex items-start justify-between gap-2"><span className="rounded bg-primary/10 px-2 py-1 text-[10px] font-medium uppercase tracking-[.1em] text-primary">Manual</span><ArrowUpRight size={15} className="text-muted-foreground group-hover:text-primary" /></div><div className="text-[14px] font-medium leading-snug text-foreground">{item.title}</div><p className="mt-2 line-clamp-2 min-h-9 text-xs leading-relaxed text-muted-foreground">{item.body || "No description yet."}</p><div className="mt-5 flex items-center justify-between border-t border-border/70 pt-3 font-mono text-[10px] text-muted-foreground"><span className="flex min-w-0 items-center gap-1 truncate"><GitBranch size={11} className="shrink-0" /> {item.repo.split("/").at(-1)}</span><span>{date(item.createdAt)}</span></div></button>)}{!cards.some(c => c.status === column.id) && <div className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-xs text-muted-foreground">Nothing here yet.</div>}</div></section>)}</div></div>
    </main>
    <Dialog open={showSettings} onOpenChange={setShowSettings}><DialogContent><DialogTitle>Settings</DialogTitle><DialogDescription>These preferences are saved in Bakery's local database.</DialogDescription><label className="mt-6 flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={settings?.confirmRunStart ?? false} disabled={!settings || busy} onChange={event => { const confirmRunStart = event.target.checked; const previous = settings; setSettings({ confirmRunStart }); void action(async () => { try { setSettings(await api<BakerySettings>("/settings", { method: "PATCH", body: JSON.stringify({ confirmRunStart }) })); } catch (error) { setSettings(previous); throw error; } }); }} /><span>Confirm before starting a run<span className="mt-1 block text-xs text-muted-foreground">When off, Start Pi run launches immediately and may use paid model tokens.</span></span></label>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}</DialogContent></Dialog>
    <Dialog open={addingRepo || !!editingBoard} onOpenChange={open => { if (!open) { setAddingRepo(false); setEditingBoard(null); setRepoPath(""); } }}><DialogContent><DialogTitle>{editingBoard ? "Edit repository path" : "Add repository"}</DialogTitle><DialogDescription>{editingBoard ? "Cards can move to a different root only before their first run." : "Enter an existing Git repository root. Paths starting with ~/ are supported."}</DialogDescription>{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}<form className="mt-5 flex gap-2" onSubmit={event => { event.preventDefault(); void action(async () => { const item = await api<Board>(editingBoard ? `/boards/${editingBoard.id}` : "/boards", { method: editingBoard ? "PATCH" : "POST", body: JSON.stringify({ repo: repoPath }) }); setBoards(previous => [...previous.filter(board => board.id !== item.id), item].sort((a, b) => a.repo.localeCompare(b.repo))); setBoardId(item.id); localStorage.setItem("bakery-board", item.id); setCards([]); setSelected(null); setRepoPath(""); setAddingRepo(false); setEditingBoard(null); }); }}><input required aria-label="Repository root" value={repoPath} onChange={event => setRepoPath(event.target.value)} placeholder="~/code/project" className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" /><Button disabled={busy} type="submit">{editingBoard ? "Save" : "Add"}</Button></form>{editingBoard && <div className="mt-8 border-t border-border pt-5"><div className="text-sm font-medium">Remove repository</div><p className="mt-1 text-xs text-muted-foreground">Hides this board. Cards, runs, and worktrees stay on disk. Add the repository again to restore them.</p><Button variant="destructive" className="mt-4" disabled={busy} onClick={() => removeBoard(editingBoard)}>Remove repository from Bakery</Button></div>}</DialogContent></Dialog>
    <Dialog open={creating || !!editing} onOpenChange={(open) => { if (!open) { setCreating(false); setEditing(null); } }}><DialogContent><DialogTitle className="text-lg font-semibold tracking-tight">{editing ? "Edit card" : "New card"}</DialogTitle><DialogDescription className="mt-1 text-sm text-muted-foreground">Work in {currentBoard && currentBoard.repo}.</DialogDescription><CardForm key={editing?.id ?? "new"} initial={editing ?? undefined} onSubmit={(value) => action(async () => { const saved = await api<Card>(`/boards/${boardId}/cards${editing ? `/${editing.id}` : ""}`, { method: editing ? "PATCH" : "POST", body: JSON.stringify(value) }); setCreating(false); setEditing(null); setSelected(saved.id); })} busy={busy} /></DialogContent></Dialog>
    <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}><DialogContent className="w-[min(94vw,750px)]"><DialogTitle className="pr-7 text-xl font-semibold tracking-tight">{card?.title}</DialogTitle><DialogDescription className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><span className="rounded bg-primary/10 px-2 py-1 uppercase tracking-wider text-primary">{card?.status}</span> Manual card · {card && card.repo}</DialogDescription><p className="mt-6 whitespace-pre-wrap text-sm leading-6 text-foreground/80">{card?.body || "No description."}</p><div className="mt-6 flex flex-wrap gap-2 border-t border-border pt-5">{card && card.status !== "running" && <Button variant="ghost" disabled={busy} onClick={() => { setEditing(card); setSelected(null); }}>Edit card</Button>}{card && ["ready", "failed", "review"].includes(card.status) && <Button disabled={busy || !settings} onClick={() => { if (settings?.confirmRunStart && !window.confirm("Start Pi on this card? This run may use paid model tokens and can edit its Git worktree.")) return; void action(() => api(`/boards/${boardId}/cards/${card.id}/start`, { method: "POST" })); }}><span className="text-base">✳</span> {runs.length ? "Run again" : "Start Pi run"}</Button>}{card?.status === "running" && runs[0] && <Button variant="destructive" disabled={busy} onClick={() => action(() => api(`/boards/${boardId}/cards/${card.id}/stop`, { method: "POST" }))}><Square size={13} /> Stop run</Button>}{card && ["review", "failed", "ready"].includes(card.status) && <Button variant="outline" disabled={busy} onClick={() => action(() => api(`/boards/${boardId}/cards/${card.id}/status`, { method: "POST", body: JSON.stringify({ status: "done" }) }))}>Mark done</Button>}{card?.status === "done" && <Button variant="outline" disabled={busy} onClick={() => action(() => api(`/boards/${boardId}/cards/${card.id}/status`, { method: "POST", body: JSON.stringify({ status: "ready" }) }))}>Reopen</Button>}</div>{card?.status === "interrupted" && <div className="mt-4 rounded-lg border border-primary/30 bg-primary/10 p-3 text-xs text-primary"><p>The server restarted during this run. Inspect its worktree and confirm the Pi process has stopped before releasing the card.</p><Button className="mt-3" size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm("I inspected the worktree and confirmed the old Pi process has stopped. Release this card for retry?")) void action(() => api(`/boards/${boardId}/cards/${card.id}/resolve`, { method: "POST", body: JSON.stringify({ acknowledged: true }) })); }}>Release for retry</Button></div>}{runs.length > 0 && <div className="mt-8"><h3 className="mb-4 text-xs font-semibold uppercase tracking-[.14em] text-muted-foreground">Attempts</h3><div className="space-y-4">{runs.map(run => <div key={run.id} className="overflow-hidden rounded-lg border border-border bg-background"><div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 text-xs"><span className="font-mono text-primary">#{run.attempt}</span><span className="capitalize">{run.status}</span><span className="ml-auto flex items-center gap-1 text-muted-foreground"><Clock3 size={12} /> {date(run.startedAt)}</span></div>{run.worktree && <div className="truncate px-4 pt-3 font-mono text-[11px] text-muted-foreground">{run.worktree}</div>}{run.error && <p className="px-4 pt-3 text-xs text-destructive">{run.error}</p>}<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-5 text-foreground/75">{run.output || (run.status === "running" ? "Waiting for Pi output…" : "No assistant output recorded.")}</pre></div>)}</div></div>}</DialogContent></Dialog>
  </div>;
}
function CardForm({ onSubmit, busy, initial }: { onSubmit: (value: { title: string; body: string }) => void; busy: boolean; initial?: Card }) {
  const [title, setTitle] = useState(initial?.title ?? ""); const [body, setBody] = useState(initial?.body ?? "");
  function submit(event: FormEvent) { event.preventDefault(); onSubmit({ title, body }); }
  const input = "w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary";
  return <form onSubmit={submit} className="mt-6 space-y-5"><label className="block text-xs font-medium">Title<input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs doing?" className={`mt-2 ${input}`} /></label><label className="block text-xs font-medium">Description<textarea value={body} maxLength={16000} onChange={e => setBody(e.target.value)} placeholder="Context, acceptance criteria, and anything the agent should know…" rows={5} className={`mt-2 resize-y ${input}`} /></label><p className="text-xs leading-5 text-muted-foreground">This card uses the selected repository. Creating it does not start an agent. Starting a run may use paid model tokens.</p><div className="flex justify-end"><Button disabled={busy} type="submit">{initial ? "Save changes" : "Create card"} <Plus size={15} /></Button></div></form>;
}
createRoot(document.getElementById("root")!).render(<App />);
