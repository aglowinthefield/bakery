import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ago, listModels } from "./api.js";
import { Button } from "./components/ui/button.js";
import { type Board } from "./model.js";
import { repoName } from "./repo-appearance.js";
import { formatCost } from "./usage.js";
import { thinkingLevels } from "../server/agent-models.js";
import type {
  Colleague,
  Handoff,
  MemorySave,
  Room,
  RoomMessage,
  RunRecord,
  Round,
} from "../server/colleague-store.js";

type RoundView = Round & {
  runs: RunRecord[];
  cost: { total: number; screening: number; screens: number };
  cutoff: string | null;
};
type RoomDetail = {
  room: Room;
  colleagues: Colleague[];
  projects: { boardId: string; memory: boolean; name: string }[];
  messages: RoomMessage[];
  rounds: RoundView[];
  live: { runId: string; colleagueId: string; role: string; text: string }[];
  handoffs: (Handoff & {
    card: { id: string; title: string; status: string } | null;
  })[];
  saves: MemorySave[];
  running: boolean;
};

const field =
  "w-full rounded-md border border-border bg-background px-3 py-1.5 text-[14px]";
const label = "mb-1 block text-[12px] text-muted-foreground";

function ModelFields({
  model,
  thinking,
  onChange,
}: {
  model: string;
  thinking: string;
  onChange: (model: string, thinking: string) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    void listModels().then((result) => setModels(result.models));
  }, []);
  const id = useMemo(() => Math.random().toString(36).slice(2), []);
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className={label} htmlFor={`m-${id}`}>
          Model
        </label>
        <input
          id={`m-${id}`}
          list={`l-${id}`}
          className={field}
          value={model}
          placeholder="Default model"
          onChange={(event) => onChange(event.target.value, thinking)}
        />
        <datalist id={`l-${id}`}>
          {models.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      </div>
      <div>
        <label className={label} htmlFor={`t-${id}`}>
          Thinking
        </label>
        <select
          id={`t-${id}`}
          className={field}
          value={thinking}
          onChange={(event) => onChange(model, event.target.value)}
        >
          <option value="">Default</option>
          {thinkingLevels.map((level) => (
            <option key={level}>{level}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

function ProjectChecks({
  boards,
  value,
  onChange,
}: {
  boards: Board[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {boards.map((board) => (
        <label key={board.id} className="flex items-center gap-1.5 text-[13px]">
          <input
            type="checkbox"
            checked={value.includes(board.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, board.id]
                  : value.filter((id) => id !== board.id),
              )
            }
          />
          {repoName(board.repo)}
        </label>
      ))}
    </div>
  );
}

export function ColleaguesView({ boards }: { boards: Board[] }) {
  const [colleagues, setColleagues] = useState<Colleague[]>([]);
  const [editing, setEditing] = useState<Partial<Colleague> | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      api<Colleague[]>("/colleagues")
        .then(setColleagues)
        .catch((err) => setError(String(err.message ?? err))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const save = async () => {
    if (!editing) return;
    setError("");
    try {
      await api(editing.id ? `/colleagues/${editing.id}` : "/colleagues", {
        method: editing.id ? "PATCH" : "POST",
        body: JSON.stringify(editing),
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError(String((err as Error).message));
    }
  };
  return (
    <main className="page-fade min-w-0 flex-1">
      <header className="flex items-center justify-between border-b border-border px-6 py-4 lg:px-10">
        <div>
          <h1 className="text-[27px] font-semibold tracking-[-.05em]">
            Colleagues
          </h1>
          <p className="text-[13px] text-muted-foreground">
            Named colleagues keep their identity across repositories and models.
            A project association is context only, never extra access.
          </p>
        </div>
        <Button
          onClick={() =>
            setEditing({
              name: "",
              specialty: "",
              instructions: "",
              model: "",
              thinking: "",
              projectIds: [],
            } as Partial<Colleague>)
          }
        >
          New colleague
        </Button>
      </header>
      <div className="grid gap-6 px-6 py-6 lg:grid-cols-[1fr_420px] lg:px-10">
        <ul className="space-y-2" aria-label="Colleagues">
          {colleagues.length === 0 && (
            <li className="text-muted-foreground">No colleagues yet.</li>
          )}
          {colleagues.map((item) => (
            <li
              key={item.id}
              className="rounded-lg border border-border p-4"
              data-testid="colleague"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">{item.name}</div>
                  <div className="text-[13px] text-muted-foreground">
                    {item.specialty || "No specialty"} ·{" "}
                    {item.model || "default model"}
                    {item.thinking ? ` · ${item.thinking}` : ""}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setEditing(item)}>
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void api(`/colleagues/${item.id}`, {
                        method: "DELETE",
                      }).then(load)
                    }
                  >
                    Archive
                  </Button>
                </div>
              </div>
              <div className="mt-2 text-[12px] text-muted-foreground">
                Projects:{" "}
                {item.projectIds.length
                  ? item.projectIds
                      .map((id) => {
                        const board = boards.find((b) => b.id === id);
                        return board ? repoName(board.repo) : id;
                      })
                      .join(", ")
                  : "none"}
              </div>
            </li>
          ))}
        </ul>
        {editing && (
          <form
            className="space-y-3 rounded-lg border border-border p-4"
            aria-label="Colleague form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <h2 className="font-medium">
              {editing.id ? "Edit colleague" : "New colleague"}
            </h2>
            <div>
              <label className={label} htmlFor="c-name">
                Name
              </label>
              <input
                id="c-name"
                className={field}
                value={editing.name ?? ""}
                onChange={(event) =>
                  setEditing({ ...editing, name: event.target.value })
                }
              />
            </div>
            <div>
              <label className={label} htmlFor="c-spec">
                Specialty
              </label>
              <input
                id="c-spec"
                className={field}
                value={editing.specialty ?? ""}
                onChange={(event) =>
                  setEditing({ ...editing, specialty: event.target.value })
                }
              />
            </div>
            <div>
              <label className={label} htmlFor="c-ins">
                Instructions
              </label>
              <textarea
                id="c-ins"
                rows={4}
                className={field}
                value={editing.instructions ?? ""}
                onChange={(event) =>
                  setEditing({ ...editing, instructions: event.target.value })
                }
              />
            </div>
            <ModelFields
              model={editing.model ?? ""}
              thinking={editing.thinking ?? ""}
              onChange={(model, thinking) =>
                setEditing({
                  ...editing,
                  model,
                  thinking: thinking as Colleague["thinking"],
                })
              }
            />
            <div>
              <span className={label}>Associated projects</span>
              <ProjectChecks
                boards={boards}
                value={editing.projectIds ?? []}
                onChange={(projectIds) =>
                  setEditing({ ...editing, projectIds })
                }
              />
            </div>
            {error && (
              <p role="alert" className="text-[13px] text-red-500">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit">Save</Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}

function HandoffDialog({
  roomId,
  detail,
  boards,
  sources,
  onClose,
  onDone,
}: {
  roomId: string;
  detail: RoomDetail;
  boards: Board[];
  sources: RoomMessage[];
  onClose: () => void;
  onDone: () => void;
}) {
  const contextBoards = boards.filter((b) =>
    detail.projects.some((p) => p.boardId === b.id),
  );
  const origin = sources.find((m) => m.colleagueId)?.colleagueId ?? "";
  const [boardId, setBoardId] = useState(
    detail.room.executionBoardId ?? contextBoards[0]?.id ?? boards[0]?.id ?? "",
  );
  const [title, setTitle] = useState("");
  const [requirements, setRequirements] = useState("");
  const [assigneeId, setAssigneeId] = useState(origin);
  const [creation, setCreation] = useState("");
  const [picked, setPicked] = useState<string[]>(sources.map((m) => m.id));
  const [confirmPaid, setConfirmPaid] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState("");
  const key = useRef(crypto.randomUUID());
  const board = boards.find((b) => b.id === boardId);
  const pickup = !!(board as unknown as { autoPickupEnabled?: boolean })
    ?.autoPickupEnabled;
  const paid = creation === "queue" && pickup;
  const submit = async () => {
    setError("");
    try {
      const result = await api<{ card: { id: string; status: string } }>(
        `/rooms/${roomId}/handoffs`,
        {
          method: "POST",
          body: JSON.stringify({
            boardId,
            title,
            requirements,
            assigneeId: assigneeId || undefined,
            creation: creation || undefined,
            sourceMessageIds: picked,
            confirmPaid,
            idempotencyKey: key.current,
          }),
        },
      );
      setCreated(`Created card ${result.card.id} in ${result.card.status}.`);
      onDone();
    } catch (err) {
      setError(String((err as Error).message));
    }
  };
  return (
    <div
      role="dialog"
      aria-label="Hand off to a card"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <form
        className="max-h-[90vh] w-[560px] space-y-3 overflow-y-auto rounded-lg border border-border bg-background p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-[16px] font-medium">Hand off to a card</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="h-board">
              Target board
            </label>
            <select
              id="h-board"
              className={field}
              value={boardId}
              onChange={(event) => setBoardId(event.target.value)}
            >
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {repoName(b.repo)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="h-assignee">
              Assignee
            </label>
            <select
              id="h-assignee"
              className={field}
              value={assigneeId}
              onChange={(event) => setAssigneeId(event.target.value)}
            >
              <option value="">Board default worker</option>
              {detail.colleagues
                .filter((c) => detail.room.participantIds.includes(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <div>
          <label className={label} htmlFor="h-title">
            Title
          </label>
          <input
            id="h-title"
            className={field}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div>
          <label className={label} htmlFor="h-req">
            Essential requirements
          </label>
          <textarea
            id="h-req"
            rows={4}
            className={field}
            value={requirements}
            onChange={(event) => setRequirements(event.target.value)}
          />
          <p className="mt-1 text-[12px] text-muted-foreground">
            Unclear scope is sent back for clarification, not invented.
          </p>
        </div>
        {sources.length > 0 && (
          <fieldset>
            <legend className={label}>
              Source decisions written into the task
            </legend>
            {sources.map((m) => (
              <label key={m.id} className="flex gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={picked.includes(m.id)}
                  onChange={(event) =>
                    setPicked(
                      event.target.checked
                        ? [...picked, m.id]
                        : picked.filter((id) => id !== m.id),
                    )
                  }
                />
                <span className="line-clamp-2">{m.body}</span>
              </label>
            ))}
          </fieldset>
        )}
        <div>
          <label className={label} htmlFor="h-create">
            New card
          </label>
          <select
            id="h-create"
            className={field}
            value={creation}
            onChange={(event) => setCreation(event.target.value)}
          >
            <option value="">Board policy</option>
            <option value="triage">Create in Triage</option>
            <option value="ready">Create in Ready</option>
            <option value="queue">Create &amp; queue work</option>
          </select>
        </div>
        {(paid || (creation === "" && pickup)) && (
          <label className="flex gap-2 rounded-md border border-amber-500/50 p-2 text-[13px]">
            <input
              type="checkbox"
              checked={confirmPaid}
              onChange={(event) => setConfirmPaid(event.target.checked)}
            />
            This board picks up Ready cards automatically, so creating the card
            starts a paid agent run. I confirm.
          </label>
        )}
        {error && (
          <p role="alert" className="text-[13px] text-red-500">
            {error}
          </p>
        )}
        {created && <p className="text-[13px] text-emerald-500">{created}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={!!created}>
            Create card
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            {created ? "Close" : "Cancel"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function RoomForm({
  boards,
  colleagues,
  initialBoard,
  onCreated,
  onCancel,
}: {
  boards: Board[];
  colleagues: Colleague[];
  initialBoard: string | null;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [leadId, setLeadId] = useState("");
  const [projects, setProjects] = useState<string[]>(
    initialBoard ? [initialBoard] : [],
  );
  const [error, setError] = useState("");
  const toggle = (id: string, on: boolean) => {
    const next = on
      ? [...participantIds, id]
      : participantIds.filter((x) => x !== id);
    setParticipantIds(next);
    if (!next.includes(leadId)) setLeadId(next[0] ?? "");
  };
  const lead = participantIds.includes(leadId) ? leadId : participantIds[0];
  return (
    <form
      aria-label="New room"
      className="space-y-3 rounded-lg border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        void api<Room>("/rooms", {
          method: "POST",
          body: JSON.stringify({
            title,
            leadId: lead,
            participantIds,
            projects,
          }),
        })
          .then((room) => onCreated(room.id))
          .catch((err) => setError(String(err.message)));
      }}
    >
      <h2 className="font-medium">New room</h2>
      <div>
        <label className={label} htmlFor="r-title">
          Title
        </label>
        <input
          id="r-title"
          className={field}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div>
        <span className={label}>
          Participants (one makes a direct chat, several a group)
        </span>
        {colleagues.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={participantIds.includes(c.id)}
              onChange={(event) => toggle(c.id, event.target.checked)}
            />
            {c.name}
          </label>
        ))}
      </div>
      {participantIds.length > 1 && (
        <div>
          <label className={label} htmlFor="r-lead">
            Lead
          </label>
          <select
            id="r-lead"
            className={field}
            value={lead}
            onChange={(event) => setLeadId(event.target.value)}
          >
            {participantIds.map((id) => (
              <option key={id} value={id}>
                {colleagues.find((c) => c.id === id)?.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <span className={label}>
          Project context (no filesystem access is granted by this)
        </span>
        <ProjectChecks
          boards={boards}
          value={projects}
          onChange={setProjects}
        />
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-red-500">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!participantIds.length}>
          Create room
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function RoomsView({
  boards,
  boardFilter,
  onBoardFilter,
}: {
  boards: Board[];
  boardFilter: string | null;
  onBoardFilter: (id: string | null) => void;
}) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [colleagues, setColleagues] = useState<Colleague[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const loadRooms = useCallback(
    () =>
      api<Room[]>(
        `/rooms${boardFilter ? `?boardId=${encodeURIComponent(boardFilter)}` : ""}`,
      ).then(setRooms),
    [boardFilter],
  );
  useEffect(() => {
    void loadRooms();
    void api<Colleague[]>("/colleagues").then(setColleagues);
  }, [loadRooms]);
  return (
    <main className="page-fade min-w-0 flex-1">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4 lg:px-10">
        <h1 className="text-[27px] font-semibold tracking-[-.05em]">Rooms</h1>
        <div className="flex items-center gap-3">
          <select
            aria-label="Filter rooms by project"
            className={`${field} w-auto`}
            value={boardFilter ?? ""}
            onChange={(event) => onBoardFilter(event.target.value || null)}
          >
            <option value="">All rooms</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {repoName(b.repo)}
              </option>
            ))}
          </select>
          <Button onClick={() => setCreating(true)}>New room</Button>
        </div>
      </header>
      <div className="grid gap-6 px-6 py-6 lg:grid-cols-[260px_1fr] lg:px-10">
        <div className="space-y-3">
          <ul aria-label="Rooms" className="space-y-1">
            {rooms.length === 0 && (
              <li className="text-muted-foreground">No rooms here yet.</li>
            )}
            {rooms.map((room) => (
              <li key={room.id}>
                <button
                  className={`w-full rounded-md px-3 py-2 text-left text-[14px] ${openId === room.id ? "bg-accent/50" : "hover:bg-accent/30"}`}
                  onClick={() => {
                    setOpenId(room.id);
                    setCreating(false);
                  }}
                >
                  <div className="font-medium">{room.title || "Room"}</div>
                  <div className="text-[12px] text-muted-foreground">
                    {room.kind === "direct" ? "Direct" : "Group"} ·{" "}
                    {room.projects.length
                      ? room.projects
                          .map((p) => {
                            const b = boards.find((x) => x.id === p.boardId);
                            return b ? repoName(b.repo) : "";
                          })
                          .join(", ")
                      : "no project"}
                    {room.paused ? " · paused" : ""}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          {creating ? (
            <RoomForm
              boards={boards}
              colleagues={colleagues}
              initialBoard={boardFilter}
              onCancel={() => setCreating(false)}
              onCreated={(id) => {
                setCreating(false);
                setOpenId(id);
                void loadRooms();
              }}
            />
          ) : openId ? (
            <RoomPane
              key={openId}
              roomId={openId}
              boards={boards}
              onChanged={loadRooms}
            />
          ) : (
            <p className="text-muted-foreground">
              Pick a room or create one. Create colleagues first on the
              Colleagues page.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

function RoomPane({
  roomId,
  boards,
  onChanged,
}: {
  roomId: string;
  boards: Board[];
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(
    null,
  );
  const [handoff, setHandoff] = useState<RoomMessage[] | null>(null);
  const [contextRun, setContextRun] = useState<unknown>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const load = useCallback(
    () =>
      api<RoomDetail>(`/rooms/${roomId}`)
        .then(setDetail)
        .catch((err) => setError(String(err.message))),
    [roomId],
  );
  useEffect(() => {
    void load();
    const source = new EventSource(`/api/rooms/${roomId}/events`);
    source.onmessage = () => void load();
    const timer = setInterval(() => void load(), 4000);
    return () => {
      source.close();
      clearInterval(timer);
    };
  }, [roomId, load]);
  const call = async (path: string, method = "POST", body?: unknown) => {
    setError("");
    try {
      await api(`/rooms/${roomId}${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      await load();
      onChanged();
    } catch (err) {
      setError(String((err as Error).message));
    }
  };
  if (!detail)
    return <p className="text-muted-foreground">{error || "Loading…"}</p>;
  const { room } = detail;
  const name = (id: string | null) =>
    detail.colleagues.find((c) => c.id === id)?.name ?? "Colleague";
  const visible = detail.messages.filter((m) => m.state !== "removed");
  const queued = visible.filter((m) => m.state === "queued");
  const transcript = visible.filter((m) => m.state !== "queued");
  const lastRound = detail.rounds.at(-1);
  const saveFor = (id: string) =>
    detail.saves.filter((s) => s.messageId === id);
  const send = (ask: "normal" | "everyone") => {
    if (!draft.trim()) return;
    const body = draft;
    setDraft("");
    void call("/messages", "POST", { body, ask });
  };
  return (
    <section aria-label="Room" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold">{room.title || "Room"}</h2>
          <div className="text-[13px] text-muted-foreground">
            {room.kind === "direct" ? "Direct chat" : "Group room"} · Lead{" "}
            <select
              aria-label="Lead"
              className="rounded border border-border bg-background px-1"
              value={room.leadId}
              onChange={(e) =>
                void call("", "PATCH", { leadId: e.target.value })
              }
            >
              {room.participantIds.map((id) => (
                <option key={id} value={id}>
                  {name(id)}
                </option>
              ))}
            </select>{" "}
            · Participants {room.participantIds.map(name).join(", ")}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
            <label>
              Execution project{" "}
              <select
                aria-label="Execution project"
                className="rounded border border-border bg-background px-1"
                value={room.executionBoardId ?? ""}
                onChange={(e) =>
                  void call("", "PATCH", {
                    executionBoardId: e.target.value || null,
                  })
                }
              >
                <option value="">None (no tools)</option>
                {detail.projects.map((p) => (
                  <option key={p.boardId} value={p.boardId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={room.mode === "mention"}
                onChange={(e) =>
                  void call("", "PATCH", {
                    mode: e.target.checked ? "mention" : "lead",
                  })
                }
              />
              Quiet (mentions only, no interjections)
            </label>
          </div>
          <div className="mt-1 text-[12px] text-muted-foreground">
            Project context:{" "}
            {detail.projects.length
              ? detail.projects.map((p) => (
                  <label key={p.boardId} className="mr-3">
                    {p.name}{" "}
                    <input
                      type="checkbox"
                      aria-label={`Use ${p.name} memory`}
                      checked={p.memory}
                      onChange={(e) =>
                        void call("", "PATCH", {
                          projects: detail.projects.map((x) => ({
                            boardId: x.boardId,
                            memory:
                              x.boardId === p.boardId
                                ? e.target.checked
                                : x.memory,
                          })),
                        })
                      }
                    />
                    <span> memory</span>
                  </label>
                ))
              : "none"}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void call("/standup")}>
            Standup
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              setHandoff(transcript.filter((m) => selected.includes(m.id)))
            }
          >
            Hand off to card
          </Button>
        </div>
      </div>

      <ol
        aria-label="Transcript"
        className="max-h-[52vh] space-y-3 overflow-y-auto rounded-lg border border-border p-4"
      >
        {transcript.map((m) => (
          <li
            key={m.id}
            data-kind={m.kind}
            className={
              m.kind === "system"
                ? "text-[12px] text-muted-foreground"
                : m.kind === "error"
                  ? "text-[13px] text-red-500"
                  : ""
            }
          >
            {m.kind !== "system" && (
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <input
                  type="checkbox"
                  aria-label="Select for handoff"
                  checked={selected.includes(m.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, m.id]
                        : selected.filter((id) => id !== m.id),
                    )
                  }
                />
                <strong className="text-foreground">
                  {m.kind === "user" ? "You" : name(m.colleagueId)}
                </strong>
                {m.role === "interjection" && <span>interjection</span>}
                {m.interrupted && <span>interrupted</span>}
                {m.ask === "everyone" && <span>asked everyone</span>}
                <span>{ago(m.createdAt)}</span>
              </div>
            )}
            <div className="whitespace-pre-wrap text-[14px]">{m.body}</div>
            {m.kind === "colleague" && !m.interrupted && (
              <div className="mt-1 flex flex-wrap gap-2 text-[12px]">
                <button
                  className="underline"
                  onClick={() =>
                    void call("/remember", "POST", {
                      messageId: m.id,
                      scope: "project",
                      boardId:
                        room.executionBoardId ?? detail.projects[0]?.boardId,
                    })
                  }
                  disabled={!detail.projects.length}
                >
                  Remember
                </button>
                {saveFor(m.id).map((s) => (
                  <span key={s.id}>
                    {s.status === "saved" ? (
                      <span className="text-emerald-500">
                        Saved to {s.projectName}
                      </span>
                    ) : (
                      <span className="text-amber-500">
                        Not saved: {s.error}{" "}
                        <button
                          className="underline"
                          onClick={() => void call(`/remember/${s.id}/retry`)}
                        >
                          Retry
                        </button>
                      </span>
                    )}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
        {detail.live.map((l) => (
          <li key={l.runId} className="opacity-70" data-live>
            <div className="text-[12px] text-muted-foreground">
              <strong className="text-foreground">{name(l.colleagueId)}</strong>{" "}
              {l.role} · working…
            </div>
            <div className="whitespace-pre-wrap text-[14px]">{l.text}</div>
          </li>
        ))}
      </ol>

      {lastRound && (
        <div className="space-y-1 text-[12px] text-muted-foreground">
          <div>
            Round {lastRound.status} · cost {formatCost(lastRound.cost.total)}{" "}
            (screening {formatCost(lastRound.cost.screening)} across{" "}
            {lastRound.cost.screens} checks) · {lastRound.interjections}/2
            interjections
            {lastRound.cutoff ? ` · activity since ${lastRound.cutoff}` : ""}
          </div>
          {lastRound.runs
            .filter((r) => r.status === "failed" || r.status === "interrupted")
            .map((r) => (
              <div key={r.id} className="text-amber-500">
                {name(r.colleagueId)} {r.role} {r.status}: {r.error}{" "}
                <button
                  className="underline"
                  onClick={() => void call(`/runs/${r.id}/retry`)}
                >
                  Retry
                </button>
              </div>
            ))}
          {lastRound.runs
            .filter((r) => r.role !== "screen")
            .slice(0, 1)
            .map((r) => (
              <button
                key={r.id}
                className="underline"
                onClick={() =>
                  void api(`/rooms/${roomId}/context/${r.id}`).then(
                    setContextRun,
                  )
                }
              >
                Context used
              </button>
            ))}
          {lastRound.context.memory?.status === "unavailable" && (
            <div className="text-amber-500">
              Memory was unavailable; colleagues answered without it.
            </div>
          )}
        </div>
      )}
      {contextRun != null && (
        <pre
          aria-label="Context used"
          className="max-h-60 overflow-auto rounded-md border border-border p-3 text-[12px]"
        >
          {JSON.stringify(contextRun, null, 2)}
        </pre>
      )}

      {queued.length > 0 && (
        <div
          aria-label="Queue"
          className="space-y-1 rounded-lg border border-border p-3"
        >
          <div className="text-[12px] text-muted-foreground">
            Queued ({queued.length}){room.paused ? " · queue paused" : ""}
          </div>
          {queued.map((m) => (
            <div key={m.id} className="flex items-center gap-2 text-[13px]">
              {editing?.id === m.id ? (
                <>
                  <input
                    className={field}
                    value={editing.body}
                    onChange={(e) =>
                      setEditing({ id: m.id, body: e.target.value })
                    }
                  />
                  <Button
                    onClick={() => {
                      void call(`/messages/${m.id}`, "PATCH", {
                        body: editing.body,
                      });
                      setEditing(null);
                    }}
                  >
                    Save
                  </Button>
                </>
              ) : (
                <>
                  <span className="flex-1">{m.body}</span>
                  <button
                    className="underline"
                    onClick={() => setEditing({ id: m.id, body: m.body })}
                  >
                    Edit
                  </button>
                  <button
                    className="underline"
                    onClick={() => void call(`/messages/${m.id}`, "DELETE")}
                  >
                    Remove
                  </button>
                  <button
                    className="underline"
                    onClick={() =>
                      void call("/steer", "POST", { messageId: m.id })
                    }
                  >
                    Steer now
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {detail.handoffs.length > 0 && (
        <div className="text-[12px] text-muted-foreground">
          Linked cards:{" "}
          {detail.handoffs
            .map(
              (h) => `${h.card?.title ?? h.cardId} (${h.card?.status ?? "?"})`,
            )
            .join(" · ")}
        </div>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-red-500">
          {error}
        </p>
      )}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          send("normal");
        }}
      >
        <textarea
          aria-label="Message"
          rows={3}
          className={field}
          placeholder="Message the lead, or @mention a colleague"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send("normal");
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit">
            {detail.running ? "Queue message" : "Send"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => send("everyone")}
          >
            Ask everyone
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!detail.running}
            onClick={() => void call("/stop")}
          >
            Stop
          </Button>
          {room.paused && (
            <Button type="button" onClick={() => void call("/resume")}>
              Resume queue
            </Button>
          )}
        </div>
      </form>
      {handoff && (
        <HandoffDialog
          roomId={roomId}
          detail={detail}
          boards={boards}
          sources={handoff}
          onClose={() => setHandoff(null)}
          onDone={() => void load()}
        />
      )}
    </section>
  );
}
