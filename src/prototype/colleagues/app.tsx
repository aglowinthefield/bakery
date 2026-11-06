// Colleagues and rooms prototype. Fixture data only: this module never calls Bakery's API.
import { useReducer, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { BrandIcon } from "../../brand-icon";
import { assumptions, projects, suggestions, type Colleague } from "./fixtures";
import {
  colleagueOf,
  handoffConsequence,
  handoffLabel,
  initialState,
  mentionedIds,
  project,
  reduce,
  respondentsFor,
  roomOf,
  type Action,
  type Message,
  type Room,
  type State,
} from "./state";

type Dispatch = (action: Action) => void;

const field =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground";
const label =
  "mb-1 block text-xs uppercase tracking-wide text-muted-foreground";
const panel = "rounded-lg border border-border bg-card p-4";

export function PrototypeApp() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const view = state.view;
  const active =
    view.name === "room" || view.name === "handoff"
      ? "rooms"
      : view.name === "new-room"
        ? "rooms"
        : view.name;
  const nav = (
    name: "rooms" | "colleagues" | "assumptions",
    text: string,
    count?: number,
  ) => (
    <button
      onClick={() => dispatch({ type: "view", view: { name } })}
      aria-current={active === name ? "page" : undefined}
      className={`mb-1 flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left text-[length:var(--text-sidebar)] ${active === name ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/30 hover:text-foreground"}`}
    >
      {text}
      {count ? (
        <span className="ml-auto font-mono text-[length:var(--text-sidebar-meta)] text-muted-foreground">
          {count}
        </span>
      ) : null}
    </button>
  );
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div
        role="status"
        className="flex flex-wrap items-center gap-3 border-b border-border bg-accent px-5 py-2 text-xs text-accent-foreground"
      >
        <strong>Prototype / fixture data</strong>
        <span>
          Fictional colleagues. Nothing here starts an agent, creates a card,
          writes a memory, or touches the board. State lives in this tab only.
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => dispatch({ type: "reset" })}
        >
          Reset prototype
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex flex-col border-b border-border bg-sidebar lg:w-[228px] lg:shrink-0 lg:border-r lg:border-b-0">
          <div className="flex items-center gap-3 px-5 py-5">
            <BrandIcon />
            <span className="text-[18px] font-semibold tracking-[-.04em]">
              bakery<span className="text-primary">.</span>
            </span>
          </div>
          <nav aria-label="Prototype navigation" className="px-2">
            <a
              href="/"
              className="mb-4 flex w-full items-center rounded-md px-3 py-1.5 text-[length:var(--text-sidebar)] text-muted-foreground hover:bg-accent/30 hover:text-foreground"
            >
              ← Back to Bakery
            </a>
            {nav("rooms", "Rooms", state.rooms.length)}
            {nav("colleagues", "Colleagues")}
            {nav("assumptions", "Prototype assumptions")}
            <div className="mb-1 mt-4 px-3 text-[length:var(--text-sidebar-heading)] uppercase tracking-wide text-muted-foreground/80">
              Projects (fixture)
            </div>
            {projects.map((item) => (
              <div
                key={item.id}
                className="px-3 py-1.5 text-[length:var(--text-sidebar)] text-muted-foreground"
              >
                {item.name}
                <span className="ml-2 text-[length:var(--text-sidebar-meta)]">
                  {item.newCards === "ready"
                    ? "Ready default"
                    : "Triage default"}
                </span>
              </div>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 px-8 py-6">
          {view.name === "colleagues" && (
            <Colleagues state={state} dispatch={dispatch} />
          )}
          {view.name === "rooms" && <Rooms state={state} dispatch={dispatch} />}
          {view.name === "new-room" && (
            <NewRoom
              state={state}
              dispatch={dispatch}
              colleagueId={view.colleagueId}
            />
          )}
          {view.name === "room" && roomOf(state, view.roomId) && (
            <RoomView
              state={state}
              room={roomOf(state, view.roomId)!}
              dispatch={dispatch}
            />
          )}
          {view.name === "handoff" && state.draft && (
            <Handoff state={state} dispatch={dispatch} />
          )}
          {view.name === "assumptions" && <Assumptions />}
        </main>
      </div>
    </div>
  );
}

function Heading({
  eyebrow,
  title,
  children,
  sub,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
  sub?: string;
}) {
  return (
    <header className="mb-6 flex items-start gap-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {eyebrow}
        </div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
      </div>
      <div className="ml-auto flex flex-wrap gap-2">{children}</div>
    </header>
  );
}

const Chip = ({ children }: { children: ReactNode }) => (
  <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
    {children}
  </span>
);
const projectNames = (ids: string[]) =>
  ids.map((id) => project(id)?.name ?? id);

function Colleagues({ state, dispatch }: { state: State; dispatch: Dispatch }) {
  const [editing, setEditing] = useState<Colleague | "new" | null>(null);
  return (
    <section aria-label="Colleagues">
      <Heading
        eyebrow="Workspace"
        title="Colleagues"
        sub="Persistent specialists. Available wherever you work."
      >
        <Button onClick={() => setEditing("new")}>+ New colleague</Button>
        <Button
          variant="outline"
          onClick={() => dispatch({ type: "view", view: { name: "new-room" } })}
        >
          New room
        </Button>
      </Heading>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {state.colleagues.map((item) => (
          <article
            key={item.id}
            aria-label={item.name}
            className={`${panel} flex flex-col gap-2`}
          >
            <div className="flex size-10 items-center justify-center rounded-lg bg-accent text-lg">
              {item.name[0]}
            </div>
            <h2 className="font-semibold">{item.name}</h2>
            <div className="text-sm">{item.specialty}</div>
            <p className="text-xs text-muted-foreground">{item.summary}</p>
            <div className="flex flex-wrap gap-1">
              {item.projects.length === 0 ? (
                <Chip>No projects</Chip>
              ) : (
                projectNames(item.projects).map((name) => (
                  <Chip key={name}>{name}</Chip>
                ))
              )}
            </div>
            <div className="mt-auto flex gap-2 pt-3">
              <Button
                size="sm"
                onClick={() =>
                  dispatch({ type: "open-direct", colleagueId: item.id })
                }
              >
                Start chat
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  dispatch({
                    type: "view",
                    view: { name: "new-room", colleagueId: item.id },
                  })
                }
              >
                Group room
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => setEditing(item)}
              >
                Edit
              </Button>
            </div>
          </article>
        ))}
      </div>
      <div className={`${panel} mt-4`}>
        <h2 className="font-semibold">
          A specialty is a focus, not a boundary.
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Colleagues can join multiple projects. Each room and run has its own
          explicit context. Project association grants no repository or tool
          access.
        </p>
      </div>
      {editing && (
        <ColleagueForm
          key={editing === "new" ? "new" : editing.id}
          item={editing === "new" ? null : editing}
          close={() => setEditing(null)}
          dispatch={dispatch}
        />
      )}
    </section>
  );
}

function ColleagueForm({
  item,
  close,
  dispatch,
}: {
  item: Colleague | null;
  close: () => void;
  dispatch: Dispatch;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [specialty, setSpecialty] = useState(item?.specialty ?? "");
  const [instructions, setInstructions] = useState(item?.instructions ?? "");
  const [picked, setPicked] = useState<string[]>(item?.projects ?? []);
  return (
    <form
      aria-label={item ? `Edit ${item.name}` : "New colleague"}
      className={`${panel} mt-4 space-y-3`}
      onSubmit={(event) => {
        event.preventDefault();
        dispatch({
          type: "save-colleague",
          id: item?.id,
          name,
          specialty,
          instructions,
          projects: picked,
        });
      }}
    >
      <h2 className="font-semibold">
        {item ? `Edit ${item.name}` : "New colleague"}
      </h2>
      <div className="grid gap-3 md:grid-cols-2">
        <label>
          <span className={label}>Name</span>
          <input
            className={field}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          <span className={label}>Specialty</span>
          <input
            className={field}
            value={specialty}
            onChange={(event) => setSpecialty(event.target.value)}
          />
        </label>
      </div>
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Instructions, model and projects
        </summary>
        <label className="mt-2 block">
          <span className={label}>Instructions</span>
          <textarea
            className={field}
            rows={3}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        <div className="mt-2 text-xs text-muted-foreground">
          Model defaults: {item?.model ?? "fixture-medium · thinking low"}{" "}
          (read-only in this prototype)
        </div>
        <fieldset className="mt-2">
          <legend className={label}>Projects (optional)</legend>
          {projects.map((entry) => (
            <label key={entry.id} className="mr-4 text-sm">
              <input
                type="checkbox"
                className="mr-1"
                checked={picked.includes(entry.id)}
                onChange={() =>
                  setPicked(
                    picked.includes(entry.id)
                      ? picked.filter((id) => id !== entry.id)
                      : [...picked, entry.id],
                  )
                }
              />
              {entry.name}
            </label>
          ))}
        </fieldset>
      </details>
      <div className="flex gap-2">
        <Button type="submit" disabled={!name.trim() || !specialty.trim()}>
          Save fixture colleague
        </Button>
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Rooms({ state, dispatch }: { state: State; dispatch: Dispatch }) {
  return (
    <section aria-label="Rooms">
      <Heading
        eyebrow="Workspace"
        title="Rooms"
        sub="Persistent conversations with explicit project context."
      >
        <Button
          onClick={() => dispatch({ type: "view", view: { name: "new-room" } })}
        >
          New room
        </Button>
      </Heading>
      {state.rooms.length === 0 && (
        <p className={`${panel} text-sm text-muted-foreground`}>
          No fixture rooms yet. Start a chat from Colleagues or create a room.
        </p>
      )}
      <ul className="space-y-2">
        {state.rooms.map((room) => (
          <li key={room.id}>
            <button
              className={`${panel} w-full text-left hover:bg-accent/30`}
              onClick={() =>
                dispatch({
                  type: "view",
                  view: { name: "room", roomId: room.id },
                })
              }
            >
              <div className="font-semibold">{room.topic}</div>
              <div className="text-xs text-muted-foreground">
                {room.participants.length === 1 ? "Direct" : "Group"} ·{" "}
                {room.participants
                  .map((id) => colleagueOf(state, id)?.name)
                  .join(", ")}{" "}
                ·{" "}
                {room.projects.length
                  ? projectNames(room.projects).join(", ")
                  : "No project"}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NewRoom({
  state,
  dispatch,
  colleagueId,
}: {
  state: State;
  dispatch: Dispatch;
  colleagueId?: string;
}) {
  const [topic, setTopic] = useState("");
  const [people, setPeople] = useState<string[]>(
    colleagueId ? [colleagueId] : [],
  );
  const [picked, setPicked] = useState<string[]>(() =>
    colleagueId
      ? (colleagueOf(state, colleagueId)?.projects.slice(0, 1) ?? [])
      : [],
  );
  const [lead, setLead] = useState(colleagueId ?? "");
  const [mode, setMode] = useState<Room["mode"]>("interjections");
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
  const leadId = people.includes(lead) ? lead : (people[0] ?? "");
  return (
    <section aria-label="New room">
      <Heading eyebrow="Rooms" title="New room" />
      <form
        className={`${panel} max-w-2xl space-y-4`}
        onSubmit={(event) => {
          event.preventDefault();
          dispatch({
            type: "create-room",
            topic,
            participants: people,
            projects: picked,
            lead: leadId,
            mode,
          });
        }}
      >
        <label className="block">
          <span className={label}>Topic</span>
          <input
            className={field}
            value={topic}
            placeholder="Ingestion quality"
            onChange={(event) => setTopic(event.target.value)}
          />
        </label>
        <fieldset>
          <legend className={label}>Participants</legend>
          {state.colleagues.map((item) => (
            <label key={item.id} className="mr-4 text-sm">
              <input
                type="checkbox"
                className="mr-1"
                checked={people.includes(item.id)}
                onChange={() => setPeople(toggle(people, item.id))}
              />
              {item.name}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend className={label}>Projects (context, not access)</legend>
          {projects.map((item) => (
            <label key={item.id} className="mr-4 text-sm">
              <input
                type="checkbox"
                className="mr-1"
                checked={picked.includes(item.id)}
                onChange={() => setPicked(toggle(picked, item.id))}
              />
              {item.name}
            </label>
          ))}
          <p className="mt-1 text-xs text-muted-foreground">
            A room with no project is valid. Nothing is inherited from the board
            you were last on.
          </p>
        </fieldset>
        <label className="block">
          <span className={label}>Lead</span>
          <select
            className={field}
            value={leadId}
            disabled={people.length === 0}
            onChange={(event) => setLead(event.target.value)}
          >
            {people.length === 0 && (
              <option value="">Pick participants first</option>
            )}
            {people.map((id) => (
              <option key={id} value={id}>
                {colleagueOf(state, id)?.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={label}>Participation</span>
          <select
            className={field}
            value={mode}
            onChange={(event) => setMode(event.target.value as Room["mode"])}
          >
            <option value="interjections">
              Lead + important interjections
            </option>
            <option value="mention-only">Mention-only</option>
          </select>
        </label>
        <Button type="submit" disabled={!topic.trim() || people.length === 0}>
          Create room
        </Button>
      </form>
    </section>
  );
}

function RoomView({
  state,
  room,
  dispatch,
}: {
  state: State;
  room: Room;
  dispatch: Dispatch;
}) {
  const [text, setText] = useState("");
  const [everyone, setEveryone] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const name = (id: string) =>
    id === "you" ? "You" : (colleagueOf(state, id)?.name ?? id);
  const responding = respondentsFor(state, room, text, everyone);
  const send = () => {
    if (!text.trim()) return;
    dispatch({ type: "send", roomId: room.id, text, everyone });
    setText("");
    setEveryone(false);
  };
  const open = state.panel;
  const usedMessage =
    open && typeof open === "object"
      ? room.messages.find((item) => item.id === open.used)
      : undefined;
  const mentioned = mentionedIds(state, room, text);
  const round = room.round;
  return (
    <section aria-label={`Room ${room.topic}`}>
      <Heading
        eyebrow={`Room · ${room.projects.length ? projectNames(room.projects).join(", ") : "No project"}`}
        title={room.topic}
      >
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            dispatch({
              type: "panel",
              panel: open === "participants" ? null : "participants",
            })
          }
        >
          Participants · {room.participants.length}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            dispatch({
              type: "panel",
              panel: open === "context" ? null : "context",
            })
          }
        >
          Context
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={Boolean(round)}
          onClick={() => dispatch({ type: "standup", roomId: room.id })}
        >
          Run standup
        </Button>
      </Heading>
      <div className="mb-3 text-xs text-muted-foreground">
        Fixture usage: {room.usageRuns} simulated runs · $0.00 real spend · no
        live agents
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-3">
          <ol aria-label="Transcript" className="space-y-3">
            {room.messages.length === 0 && (
              <li className="text-sm text-muted-foreground">
                No messages yet. Try a suggested question below.
              </li>
            )}
            {room.messages.map((message) => (
              <li key={message.id}>
                <Entry
                  state={state}
                  room={room}
                  message={message}
                  name={name}
                  dispatch={dispatch}
                />
              </li>
            ))}
          </ol>
          {round && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"
            >
              <span>
                {round.phase === "primary"
                  ? `${name(round.pending[0])} is responding…`
                  : "Checking for important contributions…"}
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => dispatch({ type: "advance", roomId: room.id })}
              >
                Advance fixture round
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => dispatch({ type: "stop", roomId: room.id })}
              >
                Stop
              </Button>
            </div>
          )}
          {room.paused && (
            <div
              role="status"
              className="flex items-center gap-3 rounded-md border border-border bg-accent/40 px-3 py-2 text-sm"
            >
              Queue paused. New messages wait until you resume or steer.
              <Button
                size="sm"
                className="ml-auto"
                onClick={() => dispatch({ type: "resume", roomId: room.id })}
              >
                Resume queue
              </Button>
            </div>
          )}
          {room.cancelled && (
            <div className="text-xs text-muted-foreground">
              Fixture control:{" "}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  dispatch({ type: "late-output", roomId: room.id })
                }
              >
                Simulate late output from stopped round
              </Button>
            </div>
          )}
          {room.queue.length > 0 && (
            <div aria-label="Queued messages" role="region" className={panel}>
              <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                Queued messages · {room.queue.length}
              </div>
              <ol className="space-y-2">
                {room.queue.map((item, index) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <span className="text-muted-foreground">{index + 1}</span>
                    {editing === item.id ? (
                      <>
                        <input
                          aria-label="Edit queued message"
                          className={`${field} flex-1`}
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                        />
                        <Button
                          size="sm"
                          onClick={() => {
                            dispatch({
                              type: "edit-queued",
                              roomId: room.id,
                              itemId: item.id,
                              text: draft,
                            });
                            setEditing(null);
                          }}
                        >
                          Save
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1">
                          {item.text}
                          {item.everyone && <Chip>Ask everyone</Chip>}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditing(item.id);
                            setDraft(item.text);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            dispatch({
                              type: "remove-queued",
                              roomId: room.id,
                              itemId: item.id,
                            })
                          }
                        >
                          Remove
                        </Button>
                        <Button
                          size="sm"
                          onClick={() =>
                            dispatch({
                              type: "steer",
                              roomId: room.id,
                              itemId: item.id,
                            })
                          }
                        >
                          Steer now
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className={panel}>
            <div className="mb-2 text-xs text-muted-foreground">
              Responding: {responding.map(name).join(", ")} ·{" "}
              {everyone
                ? "Ask everyone"
                : mentioned.length
                  ? "Mention"
                  : room.mode === "interjections"
                    ? "Important interjections on"
                    : "Mention-only"}
            </div>
            <div className="mb-2 flex flex-wrap gap-1">
              {suggestions.map((item) => (
                <button
                  key={item}
                  className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setText(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <textarea
              aria-label="Message"
              className={field}
              rows={2}
              placeholder="Message, or @mention a colleague…"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant={everyone ? "default" : "outline"}
                aria-pressed={everyone}
                onClick={() => setEveryone(!everyone)}
              >
                Ask everyone
              </Button>
              <Button
                size="sm"
                className="ml-auto"
                disabled={!text.trim()}
                onClick={send}
              >
                Send
              </Button>
            </div>
          </div>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              Fixture run log ({room.runLog.length})
            </summary>
            <ul aria-label="Fixture run log" className="mt-1 list-disc pl-5">
              {room.runLog.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </details>
        </div>
        <aside className="space-y-3" aria-label="Room details">
          <div className={panel}>
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              In this room
            </div>
            <ul className="space-y-1 text-sm">
              {room.participants.map((id) => (
                <li key={id}>
                  ● {name(id)}
                  {id === room.lead && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      · lead
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <div className="mb-1 mt-3 text-xs uppercase tracking-wide text-muted-foreground">
              Project context
            </div>
            <div className="flex flex-wrap gap-1">
              {room.projects.length ? (
                projectNames(room.projects).map((item) => (
                  <Chip key={item}>{item}</Chip>
                ))
              ) : (
                <Chip>None</Chip>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Project context does not grant additional tool access.
            </p>
          </div>
          {open === "participants" && (
            <Participants state={state} room={room} dispatch={dispatch} />
          )}
          {open === "context" && (
            <RoomContext state={state} room={room} dispatch={dispatch} />
          )}
          {usedMessage?.context && (
            <ContextUsed state={state} message={usedMessage} />
          )}
          <div className="rounded-lg bg-accent/50 px-3 py-2 text-xs">
            One bounded round per message. At most two important interjections.
            Interjections never start another round.
          </div>
        </aside>
      </div>
    </section>
  );
}

function Participants({
  state,
  room,
  dispatch,
}: {
  state: State;
  room: Room;
  dispatch: Dispatch;
}) {
  const others = state.colleagues.filter(
    (item) => !room.participants.includes(item.id),
  );
  return (
    <div
      role="region"
      aria-label="Participants"
      className={`${panel} space-y-2 text-sm`}
    >
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Participants
      </div>
      {room.participants.map((id) => (
        <div key={id} className="flex items-center gap-2">
          <span>{colleagueOf(state, id)?.name}</span>
          {id === room.lead ? (
            <Chip>Lead</Chip>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                dispatch({ type: "set-lead", roomId: room.id, colleagueId: id })
              }
            >
              Make lead
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={id === room.lead || room.participants.length < 2}
            title={
              id === room.lead ? "Pick another lead before removing" : undefined
            }
            onClick={() =>
              dispatch({
                type: "remove-participant",
                roomId: room.id,
                colleagueId: id,
              })
            }
          >
            Remove
          </Button>
        </div>
      ))}
      {others.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-t border-border pt-2">
          <span className="text-xs text-muted-foreground">Add:</span>
          {others.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant="outline"
              onClick={() =>
                dispatch({
                  type: "add-participant",
                  roomId: room.id,
                  colleagueId: item.id,
                })
              }
            >
              + {item.name}
            </Button>
          ))}
        </div>
      )}
      <label className="block border-t border-border pt-2">
        <span className={label}>Participation</span>
        <select
          className={field}
          value={room.mode}
          onChange={(event) =>
            dispatch({
              type: "set-mode",
              roomId: room.id,
              mode: event.target.value as Room["mode"],
            })
          }
        >
          <option value="interjections">Lead + important interjections</option>
          <option value="mention-only">Mention-only</option>
        </select>
      </label>
    </div>
  );
}

function RoomContext({
  state,
  room,
  dispatch,
}: {
  state: State;
  room: Room;
  dispatch: Dispatch;
}) {
  return (
    <div
      role="region"
      aria-label="Room context"
      className={`${panel} space-y-2 text-sm`}
    >
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Room context
      </div>
      <div>
        <span className="text-muted-foreground">Selected projects:</span>{" "}
        {room.projects.length ? projectNames(room.projects).join(", ") : "none"}
      </div>
      <div>
        <span className="text-muted-foreground">Authorized resources:</span>{" "}
        none in this prototype. Selecting a project grants no repository,
        credential, or tool access.
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={!state.memoryAvailable}
          onChange={() => dispatch({ type: "toggle-memory" })}
        />
        Simulate shared memory unavailable
      </label>
    </div>
  );
}

function ContextUsed({ state, message }: { state: State; message: Message }) {
  const context = message.context!;
  return (
    <div
      role="region"
      aria-label="Context used"
      className={`${panel} space-y-2 text-sm`}
    >
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Context used for {colleagueOf(state, message.author)?.name}'s response
      </div>
      <div>
        <span className="text-muted-foreground">Projects:</span>{" "}
        {context.projects.length
          ? projectNames(context.projects).join(", ")
          : "none"}
      </div>
      <div>
        <span className="text-muted-foreground">Configuration:</span>{" "}
        {context.model} (fixture)
      </div>
      <div>
        <span className="text-muted-foreground">Conversation:</span> first{" "}
        {context.through} message{context.through === 1 ? "" : "s"}. Queued
        messages are not included.
      </div>
      <div>
        <span className="text-muted-foreground">Memories:</span>{" "}
        {context.memories === null
          ? "unavailable"
          : `${context.memories.length} from Impression (simulated)`}
      </div>
      {context.memories === null ? (
        <p className="rounded-md bg-accent/50 px-2 py-1 text-xs">
          Shared memory was unavailable, so memory was not checked. This answer
          does not use saved knowledge.
        </p>
      ) : (
        <ul className="space-y-2">
          {context.memories.map((item) => (
            <li key={item.id} className="rounded-md border border-border p-2">
              <div className="font-medium">{item.title}</div>
              <div className="text-xs text-muted-foreground">
                {item.id} ·{" "}
                {item.scope === "user"
                  ? "User"
                  : `Project: ${project(item.project ?? "")?.name}`}{" "}
                · {item.source}
              </div>
              {item.stale && (
                <div className="mt-1 text-xs text-[color:var(--status-interrupted)]">
                  Staleness warning: {item.stale}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="text-xs text-muted-foreground">
        Tools/workspace: none. No credentials or tool configuration shown. Scope
        isolation: other projects' memories were not supplied.
      </div>
    </div>
  );
}

function Entry({
  state,
  room,
  message,
  name,
  dispatch,
}: {
  state: State;
  room: Room;
  message: Message;
  name: (id: string) => string;
  dispatch: Dispatch;
}) {
  const frame = "rounded-md border-l-4 bg-card px-4 py-3";
  if (message.kind === "system")
    return (
      <div className="px-4 text-xs text-muted-foreground" role="note">
        {message.text}
      </div>
    );
  if (message.kind === "user")
    return (
      <div className={`${frame} border-border`}>
        <div className="text-xs text-muted-foreground">You</div>
        <p className="mt-1">{message.text}</p>
      </div>
    );
  if (message.kind === "card") {
    const card = state.cards.find((item) => item.id === message.cardId);
    return (
      <div className={`${frame} border-primary`}>
        <div className="text-xs text-muted-foreground">
          Simulated card · not a real Bakery card
        </div>
        <p className="mt-1 font-medium">
          {card?.id}: {message.text}
        </p>
        <p className="text-xs text-muted-foreground">
          {project(card?.project ?? "")?.name} · {name(card?.assignee ?? "")} ·{" "}
          {card?.destination === "triage" ? "Triage" : "Ready"}
        </p>
        {card && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              dispatch({
                type: "review-update",
                roomId: room.id,
                cardId: card.id,
              })
            }
          >
            Simulate review update
          </Button>
        )}
      </div>
    );
  }
  if (message.kind === "standup" && message.standup)
    return (
      <Standup
        state={state}
        room={room}
        message={message}
        dispatch={dispatch}
      />
    );
  const lead = message.author === room.lead;
  return (
    <div
      className={`${frame} ${message.kind === "interjection" ? "border-primary/60" : "border-border"}`}
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        {name(message.author)}
        <Chip>
          {message.kind === "interjection"
            ? "Interjection"
            : lead
              ? "Lead"
              : "Response"}
        </Chip>
        {message.status === "interrupted" && <Chip>Interrupted</Chip>}
      </div>
      <p className="mt-2">{message.text}</p>
      {message.status !== "interrupted" && (
        <div className="mt-2 flex gap-3 text-xs">
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={() =>
              dispatch({ type: "panel", panel: { used: message.id } })
            }
          >
            Context used ·{" "}
            {message.context?.memories === null
              ? "memory unavailable"
              : `${message.context?.memories.length ?? 0} memories`}
          </button>
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={() =>
              dispatch({
                type: "open-handoff",
                roomId: room.id,
                messageId: message.id,
              })
            }
          >
            Create card
          </button>
        </div>
      )}
    </div>
  );
}

function Standup({
  state,
  room,
  message,
  dispatch,
}: {
  state: State;
  room: Room;
  message: Message;
  dispatch: Dispatch;
}) {
  const standup = message.standup!;
  const failed = standup.reports.filter((item) => item.state === "failed");
  const lead = colleagueOf(state, room.lead)?.name;
  return (
    <div role="region" aria-label="Standup" className={`${panel} space-y-3`}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Standup ·{" "}
        {room.projects.length
          ? projectNames(room.projects).join(", ")
          : "No project"}{" "}
        · {standup.window}
      </div>
      {standup.reports.map((report) => {
        const who = colleagueOf(state, report.colleagueId);
        if (!who) return null;
        return (
          <div
            key={report.colleagueId}
            aria-label={`${who.name} report`}
            className="text-sm"
          >
            <div className="font-semibold">{who.name}</div>
            {report.state === "failed" ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                Update unavailable (fixture failure)
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    dispatch({
                      type: "retry-report",
                      roomId: room.id,
                      messageId: message.id,
                      colleagueId: who.id,
                    })
                  }
                >
                  Retry report
                </Button>
              </div>
            ) : who.standup ? (
              <dl className="grid grid-cols-[110px_1fr] gap-x-2">
                <dt className="text-muted-foreground">Completed</dt>
                <dd>{who.standup.completed}</dd>
                <dt className="text-muted-foreground">Active</dt>
                <dd>{who.standup.active}</dd>
                <dt className="text-muted-foreground">Blocked</dt>
                <dd>{who.standup.blocked}</dd>
                <dt className="text-muted-foreground">Proposed next</dt>
                <dd>
                  {who.standup.proposed}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      dispatch({
                        type: "open-handoff",
                        roomId: room.id,
                        messageId: message.id,
                        proposal: who.standup!.proposed.replace(
                          / Suggestion, not an assignment\.$/,
                          "",
                        ),
                      })
                    }
                  >
                    Create card…
                  </Button>
                </dd>
              </dl>
            ) : (
              <p className="text-muted-foreground">
                No activity in the window.
              </p>
            )}
          </div>
        );
      })}
      <div
        className="rounded-md bg-accent/40 p-3 text-sm"
        aria-label="Standup summary"
      >
        <div className="font-semibold">
          Summary · {failed.length ? "partial" : "complete"}
        </div>
        <p className="text-xs text-muted-foreground">
          Generated by {lead} (prototype assumption) from{" "}
          {standup.reports.length - failed.length} of {standup.reports.length}{" "}
          reports.
        </p>
        <p className="mt-1">
          Completed and active work is listed above; proposals are suggestions,
          not assignments.
          {failed.length > 0 &&
            ` Missing report: ${failed.map((item) => colleagueOf(state, item.colleagueId)?.name).join(", ")}. A missing report is not "no activity".`}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          The standup ends here. It started no work and changed no assignments.
        </p>
      </div>
    </div>
  );
}

function Handoff({ state, dispatch }: { state: State; dispatch: Dispatch }) {
  const draft = state.draft!;
  const room = roomOf(state, draft.roomId);
  const done = draft.createdCardId !== null;
  const edit = (patch: Partial<typeof draft>) =>
    dispatch({ type: "edit-draft", patch });
  const board = project(draft.project);
  return (
    <section aria-label="Create card">
      <Heading eyebrow={`Room / ${room?.topic ?? ""}`} title="Create card">
        <Button
          variant="outline"
          onClick={() =>
            dispatch({
              type: "view",
              view: { name: "room", roomId: draft.roomId },
            })
          }
        >
          Back to room
        </Button>
      </Heading>
      <div className="mb-4 rounded-md border border-border bg-accent/40 px-3 py-2 text-sm">
        Simulated handoff. The final action creates a simulated card in this tab
        only. No Bakery card, run, or memory is created.
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <fieldset disabled={done} className={`${panel} space-y-3`}>
          <div className="grid gap-3 md:grid-cols-2">
            <label>
              <span className={label}>Board</span>
              <select
                className={field}
                value={draft.project}
                onChange={(event) => edit({ project: event.target.value })}
              >
                {!room?.projects.length && (
                  <option value="">Choose a board</option>
                )}
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className={label}>Assigned to</span>
              <select
                className={field}
                value={draft.assignee}
                onChange={(event) => edit({ assignee: event.target.value })}
              >
                {room?.participants.map((id) => (
                  <option key={id} value={id}>
                    {colleagueOf(state, id)?.name}
                  </option>
                ))}
                <option value="board-default">Board default worker</option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className={label}>Title</span>
            <input
              className={field}
              value={draft.title}
              onChange={(event) => edit({ title: event.target.value })}
            />
          </label>
          <label className="block">
            <span className={label}>Goal</span>
            <textarea
              className={field}
              rows={2}
              value={draft.goal}
              onChange={(event) => edit({ goal: event.target.value })}
            />
          </label>
          <label className="block">
            <span className={label}>Constraints</span>
            <textarea
              className={field}
              rows={3}
              value={draft.constraints}
              onChange={(event) => edit({ constraints: event.target.value })}
            />
          </label>
          <label className="block">
            <span className={label}>Acceptance criteria</span>
            <textarea
              className={field}
              rows={3}
              value={draft.acceptance}
              onChange={(event) => edit({ acceptance: event.target.value })}
            />
          </label>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              Destination
              <select
                className={`${field} w-auto`}
                value={draft.destination}
                onChange={(event) =>
                  edit({
                    destination: event.target.value as "ready" | "triage",
                  })
                }
              >
                <option value="ready">Ready</option>
                <option value="triage">Triage</option>
              </select>
            </label>
            <span className="ml-auto text-xs text-muted-foreground">
              {draft.overridden && draft.destination !== board?.newCards
                ? "Override"
                : "Board default"}
              : {board?.newCards === "ready" ? "Ready" : "Triage"}
            </span>
          </div>
          <div
            className="rounded-md bg-accent/50 px-3 py-2 text-sm"
            aria-label="Consequence"
          >
            {handoffConsequence(draft.destination, draft.project)}{" "}
            <em>(Simulated: no paid work will actually run.)</em>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              type="button"
              onClick={() =>
                dispatch({
                  type: "view",
                  view: { name: "room", roomId: draft.roomId },
                })
              }
            >
              Cancel
            </Button>
            <Button
              className="ml-auto"
              type="button"
              disabled={!draft.project || !draft.title.trim()}
              onClick={() => dispatch({ type: "create-card" })}
            >
              {handoffLabel(draft.destination, draft.project)} (simulated card)
            </Button>
          </div>
          {done && (
            <p role="status" className="text-sm">
              Created simulated card {draft.createdCardId}. Pressing again does
              not add another.
            </p>
          )}
        </fieldset>
        <aside className="space-y-3">
          <div className={panel}>
            <div className={label}>Selected context</div>
            <div>
              {draft.messageCount} room message
              {draft.messageCount === 1 ? "" : "s"}
            </div>
            <div>
              {draft.memoryRefs.length} Impression reference
              {draft.memoryRefs.length === 1 ? "" : "s"}
              {draft.memoryRefs.length > 0 &&
                ` (${draft.memoryRefs.join(", ")})`}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Essential requirements are written into the card. The full
              transcript is not attached.
            </p>
          </div>
          <div className={panel}>
            <div className={label}>Review</div>
            <div>Independent board reviewer</div>
            <p className="mt-2 text-xs text-muted-foreground">
              The assignee implements; review stays a separate assignment.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}

function Assumptions() {
  return (
    <section aria-label="Prototype assumptions">
      <Heading
        eyebrow="Prototype"
        title="Prototype assumptions"
        sub="Spec choices that are still open. This prototype picked one so the flow is clickable."
      />
      <ul className={`${panel} list-disc space-y-2 pl-8 text-sm`}>
        {assumptions.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
        Out of scope: production identity, authorization, routing, Impression
        integration, persistence, and live agents.
      </p>
    </section>
  );
}
