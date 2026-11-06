// In-memory state machine for the colleagues prototype. Pure: no network, storage, timers, or Bakery imports.
// A simulated round only moves when the operator clicks "Advance fixture round", so nothing runs by itself.
import {
  colleagues as fixtureColleagues,
  memories,
  projects,
  type Colleague,
  type Memory,
  type Rule,
} from "./fixtures";

export type RoomMode = "interjections" | "mention-only";
export type Destination = "ready" | "triage";

export interface ContextUsed {
  projects: string[];
  model: string;
  /** Messages the respondent saw: the transcript when its round began. Queued messages are never included. */
  through: number;
  /** null means shared memory was unavailable, so nothing was checked. */
  memories: Memory[] | null;
}

export interface StandupReport {
  colleagueId: string;
  state: "ok" | "failed";
}

export interface Message {
  id: string;
  kind: "user" | "reply" | "interjection" | "system" | "standup" | "card";
  author: string;
  text: string;
  status?: "complete" | "interrupted";
  roundId?: string;
  context?: ContextUsed;
  standup?: { window: string; reports: StandupReport[] };
  cardId?: string;
}

export interface QueueItem {
  id: string;
  text: string;
  everyone: boolean;
}

export interface Round {
  id: string;
  text: string;
  everyone: boolean;
  primary: string[];
  pending: string[];
  phase: "primary" | "screening";
  through: number;
}

export interface Room {
  id: string;
  topic: string;
  participants: string[];
  projects: string[];
  lead: string;
  mode: RoomMode;
  messages: Message[];
  queue: QueueItem[];
  round: Round | null;
  paused: boolean;
  /** Last cancelled round, so the late-output fence can be demonstrated. */
  cancelled: string | null;
  /** How many times each operator message started a round. Must never exceed 1. */
  executions: Record<string, number>;
  runLog: string[];
  usageRuns: number;
}

export interface SimCard {
  id: string;
  title: string;
  project: string;
  assignee: string;
  destination: Destination;
  consequence: string;
  roomId: string;
}

export interface HandoffDraft {
  roomId: string;
  key: string;
  project: string;
  assignee: string;
  title: string;
  goal: string;
  constraints: string;
  acceptance: string;
  destination: Destination;
  /** Set when the operator picked a destination, so the board default stops following the board. */
  overridden: boolean;
  messageCount: number;
  memoryRefs: string[];
  createdCardId: string | null;
}

export type View =
  | { name: "colleagues" }
  | { name: "rooms" }
  | { name: "new-room"; colleagueId?: string }
  | { name: "room"; roomId: string }
  | { name: "handoff" }
  | { name: "assumptions" };

export type Panel = "participants" | "context" | { used: string } | null;

export interface State {
  colleagues: Colleague[];
  rooms: Room[];
  cards: SimCard[];
  view: View;
  panel: Panel;
  draft: HandoffDraft | null;
  memoryAvailable: boolean;
  seq: number;
}

export type Action =
  | { type: "reset" }
  | { type: "view"; view: View }
  | { type: "panel"; panel: Panel }
  | {
      type: "save-colleague";
      id?: string;
      name: string;
      specialty: string;
      instructions: string;
      projects: string[];
    }
  | { type: "open-direct"; colleagueId: string }
  | {
      type: "create-room";
      topic: string;
      participants: string[];
      projects: string[];
      lead: string;
      mode: RoomMode;
    }
  | { type: "add-participant"; roomId: string; colleagueId: string }
  | { type: "remove-participant"; roomId: string; colleagueId: string }
  | { type: "set-lead"; roomId: string; colleagueId: string }
  | { type: "set-mode"; roomId: string; mode: RoomMode }
  | { type: "toggle-memory" }
  | { type: "send"; roomId: string; text: string; everyone: boolean }
  | { type: "advance"; roomId: string }
  | { type: "stop"; roomId: string }
  | { type: "resume"; roomId: string }
  | { type: "steer"; roomId: string; itemId: string }
  | { type: "edit-queued"; roomId: string; itemId: string; text: string }
  | { type: "remove-queued"; roomId: string; itemId: string }
  | { type: "late-output"; roomId: string }
  | { type: "standup"; roomId: string }
  | {
      type: "retry-report";
      roomId: string;
      messageId: string;
      colleagueId: string;
    }
  | {
      type: "open-handoff";
      roomId: string;
      messageId: string;
      proposal?: string;
    }
  | { type: "edit-draft"; patch: Partial<HandoffDraft> }
  | { type: "create-card" }
  | { type: "review-update"; roomId: string; cardId: string };

export const initialState = (): State => ({
  colleagues: fixtureColleagues.map((item) => ({ ...item })),
  rooms: [],
  cards: [],
  view: { name: "colleagues" },
  panel: null,
  draft: null,
  memoryAvailable: true,
  seq: 1,
});

export const project = (id: string) => projects.find((item) => item.id === id);
export const colleagueOf = (state: State, id: string) =>
  state.colleagues.find((item) => item.id === id);
export const roomOf = (state: State, id: string) =>
  state.rooms.find((item) => item.id === id);

/** Memories supplied to a response: user-scope plus the room's selected projects only. */
export function memoriesFor(roomProjects: string[]): Memory[] {
  return memories.filter(
    (item) =>
      item.scope === "user" ||
      (item.project && roomProjects.includes(item.project)),
  );
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()[\]\\]/g, "\\$&");

/** Mentions resolve to participant IDs, never to ambiguous display text. */
export function mentionedIds(state: State, room: Room, text: string): string[] {
  return room.participants.filter((id) => {
    const item = colleagueOf(state, id);
    return item && new RegExp(`@${escapeRegExp(item.name)}\\b`, "i").test(text);
  });
}

/** Who will answer, shown in the composer before sending. */
export function respondentsFor(
  state: State,
  room: Room,
  text: string,
  everyone: boolean,
): string[] {
  if (everyone) return [...room.participants];
  const mentioned = mentionedIds(state, room, text);
  return mentioned.length > 0 ? mentioned : [room.lead];
}

function pick(rules: Rule[], text: string) {
  const lower = text.toLowerCase();
  return rules.find((rule) =>
    rule.keywords.some((word) => lower.includes(word)),
  );
}

export function fixtureReply(item: Colleague, text: string) {
  return (
    pick(item.replies, text)?.text ??
    `(Fixture) From my ${item.specialty.toLowerCase()} angle I would start by writing down the constraint, then check it against the current code.`
  );
}

const consequence = (destination: Destination, pickup: boolean) =>
  destination === "triage"
    ? "Triage holds the card for review. Nothing runs."
    : pickup
      ? "Auto pickup is on. Creating this card queues paid work."
      : "Auto pickup is off. The card waits in Ready until someone starts it.";

export const handoffLabel = (destination: Destination, projectId: string) =>
  destination === "triage"
    ? "Create in Triage"
    : project(projectId)?.autoPickup
      ? "Create & queue work"
      : "Create in Ready";

export const handoffConsequence = (
  destination: Destination,
  projectId: string,
) => consequence(destination, Boolean(project(projectId)?.autoPickup));

function nextId(state: State, prefix: string): [State, string] {
  return [{ ...state, seq: state.seq + 1 }, `${prefix}${state.seq}`];
}

const mapRoom = (
  state: State,
  id: string,
  change: (room: Room) => Room,
): State => ({
  ...state,
  rooms: state.rooms.map((room) => (room.id === id ? change(room) : room)),
});

function append(room: Room, message: Message): Room {
  return { ...room, messages: [...room.messages, message] };
}

function system(state: State, room: Room, text: string): [State, Room] {
  const [next, id] = nextId(state, "m");
  return [next, append(room, { id, kind: "system", author: "system", text })];
}

/** Begin one bounded round for one operator message. Each message may begin a round at most once. */
function startRound(state: State, room: Room, item: QueueItem): [State, Room] {
  if ((room.executions[item.id] ?? 0) > 0) return [state, room];
  let next = state;
  let id: string;
  [next, id] = nextId(next, "r");
  const withMessage = append(room, {
    id: item.id,
    kind: "user",
    author: "you",
    text: item.text,
  });
  const primary = respondentsFor(state, room, item.text, item.everyone);
  const round: Round = {
    id,
    text: item.text,
    everyone: item.everyone,
    primary,
    pending: [...primary],
    phase: "primary",
    through: withMessage.messages.length,
  };
  return [
    next,
    {
      ...withMessage,
      round,
      executions: { ...room.executions, [item.id]: 1 },
      runLog: [
        ...room.runLog,
        `${id} started for “${short(item.text)}”. Input: ${round.through} messages; ${room.queue.length} queued message${room.queue.length === 1 ? "" : "s"} not included.`,
      ],
    },
  ];
}

const short = (text: string) =>
  text.length > 40 ? `${text.slice(0, 39)}…` : text;

/** Start the next queued message when nothing is running and the queue is not paused. */
function drain(state: State, room: Room): [State, Room] {
  if (room.round || room.paused || room.queue.length === 0)
    return [state, room];
  const [first, ...rest] = room.queue;
  return startRound(state, { ...room, queue: rest }, first);
}

function finish(state: State, room: Room): [State, Room] {
  return drain(state, { ...room, round: null });
}

/** Cancel the running round: completed answers stay, a partial answer is marked interrupted. */
function cancelRound(state: State, room: Room, reason: string): [State, Room] {
  const round = room.round;
  if (!round) return [state, room];
  let next = state;
  let current = room;
  const head = round.phase === "primary" ? round.pending[0] : undefined;
  const who = head ? colleagueOf(state, head) : undefined;
  if (who) {
    let id: string;
    [next, id] = nextId(next, "m");
    const full = fixtureReply(who, round.text);
    current = append(current, {
      id,
      kind: "reply",
      author: who.id,
      text: `${full.slice(0, Math.max(24, Math.floor(full.length / 3)))}…`,
      status: "interrupted",
      roundId: round.id,
    });
  }
  [next, current] = system(next, current, reason);
  return [
    next,
    {
      ...current,
      round: null,
      cancelled: round.id,
      runLog: [
        ...current.runLog,
        `${round.id} cancelled. Pending interjections dropped.`,
      ],
    },
  ];
}

function contextFor(
  state: State,
  room: Room,
  who: Colleague,
  round: Round,
): ContextUsed {
  return {
    projects: room.projects,
    model: who.model,
    through: round.through,
    memories: state.memoryAvailable ? memoriesFor(room.projects) : null,
  };
}

function advance(state: State, room: Room): [State, Room] {
  const round = room.round;
  if (!round) return [state, room];
  let next = state;
  let current = room;
  if (round.phase === "primary" && round.pending.length > 0) {
    const [head, ...rest] = round.pending;
    const who = colleagueOf(state, head);
    if (who) {
      let id: string;
      [next, id] = nextId(next, "m");
      current = append(current, {
        id,
        kind: "reply",
        author: who.id,
        text: fixtureReply(who, round.text),
        status: "complete",
        roundId: round.id,
        context: contextFor(state, room, who, round),
      });
      current = { ...current, usageRuns: current.usageRuns + 1 };
    }
    const screens =
      room.mode === "interjections" &&
      !round.everyone &&
      room.participants.length > 1;
    if (rest.length === 0 && !screens)
      return finish(next, { ...current, round });
    return [
      next,
      {
        ...current,
        round: {
          ...round,
          pending: rest,
          phase: rest.length === 0 ? "screening" : "primary",
        },
      },
    ];
  }
  // Screening: at most two unsolicited points, and they never start another round.
  const candidates = room.participants
    .filter((id) => !round.primary.includes(id))
    .flatMap((id) => {
      const who = colleagueOf(state, id);
      const rule = who && pick(who.interjections, round.text);
      return who && rule ? [{ who, text: rule.text }] : [];
    })
    .slice(0, 2);
  current = { ...current, usageRuns: current.usageRuns + 1 };
  for (const item of candidates) {
    let id: string;
    [next, id] = nextId(next, "m");
    current = append(current, {
      id,
      kind: "interjection",
      author: item.who.id,
      text: item.text,
      status: "complete",
      roundId: round.id,
      context: contextFor(state, room, item.who, round),
    });
  }
  if (candidates.length === 0)
    [next, current] = system(
      next,
      current,
      "Screening finished. No important contributions.",
    );
  return finish(next, { ...current, round });
}

const defaultDraft = (
  room: Room,
  key: string,
  projectId: string,
  assignee: string,
  title: string,
  goal: string,
): HandoffDraft => {
  const board = project(projectId);
  return {
    roomId: room.id,
    key,
    project: projectId,
    assignee,
    title,
    goal,
    constraints:
      "Preserve the existing schema.\nKeep original metadata available to ranking.",
    acceptance:
      "Retrying does not create duplicate media.\nRepeated retries are safe.",
    destination: board?.newCards ?? "triage",
    overridden: false,
    messageCount: 2,
    memoryRefs: memoriesFor(room.projects)
      .filter((item) => item.scope === "project" && !item.stale)
      .slice(0, 1)
      .map((item) => item.id),
    createdCardId: null,
  };
};

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return initialState();
    case "view":
      return { ...state, view: action.view, panel: null };
    case "panel":
      return { ...state, panel: action.panel };
    case "toggle-memory":
      return { ...state, memoryAvailable: !state.memoryAvailable };
    case "save-colleague": {
      const detail = {
        name: action.name.trim(),
        specialty: action.specialty.trim(),
        instructions: action.instructions.trim(),
        projects: action.projects,
      };
      if (!detail.name || !detail.specialty) return state;
      if (action.id)
        return {
          ...state,
          colleagues: state.colleagues.map((item) =>
            item.id === action.id ? { ...item, ...detail } : item,
          ),
          view: { name: "colleagues" },
        };
      const id = `new-${state.seq}`;
      const created: Colleague = {
        id,
        summary: detail.specialty,
        model: "fixture-medium · thinking low",
        replies: [],
        interjections: [],
        standup: null,
        ...detail,
      };
      return {
        ...state,
        seq: state.seq + 1,
        colleagues: [...state.colleagues, created],
        view: { name: "colleagues" },
      };
    }
    case "open-direct": {
      const existing = state.rooms.find(
        (room) =>
          room.participants.length === 1 &&
          room.participants[0] === action.colleagueId,
      );
      if (existing)
        return {
          ...state,
          view: { name: "room", roomId: existing.id },
          panel: null,
        };
      const who = colleagueOf(state, action.colleagueId);
      if (!who) return state;
      return reduce(state, {
        type: "create-room",
        topic: `Chat with ${who.name}`,
        participants: [who.id],
        projects: who.projects.slice(0, 1),
        lead: who.id,
        mode: "interjections",
      });
    }
    case "create-room": {
      if (
        !action.topic.trim() ||
        action.participants.length === 0 ||
        !action.participants.includes(action.lead)
      )
        return state;
      const [next, id] = nextId(state, "room-");
      const room: Room = {
        id,
        topic: action.topic.trim(),
        participants: action.participants,
        projects: action.projects,
        lead: action.lead,
        mode: action.mode,
        messages: [],
        queue: [],
        round: null,
        paused: false,
        cancelled: null,
        executions: {},
        runLog: [],
        usageRuns: 0,
      };
      return {
        ...next,
        rooms: [...next.rooms, room],
        view: { name: "room", roomId: id },
        panel: null,
      };
    }
    case "add-participant":
      return mapRoom(state, action.roomId, (room) =>
        room.participants.includes(action.colleagueId)
          ? room
          : {
              ...room,
              participants: [...room.participants, action.colleagueId],
            },
      );
    case "remove-participant":
      return mapRoom(state, action.roomId, (room) =>
        action.colleagueId === room.lead || room.participants.length < 2
          ? room
          : {
              ...room,
              participants: room.participants.filter(
                (id) => id !== action.colleagueId,
              ),
            },
      );
    case "set-lead":
      return mapRoom(state, action.roomId, (room) =>
        room.participants.includes(action.colleagueId)
          ? { ...room, lead: action.colleagueId }
          : room,
      );
    case "set-mode":
      return mapRoom(state, action.roomId, (room) => ({
        ...room,
        mode: action.mode,
      }));
    case "send": {
      const room = roomOf(state, action.roomId);
      const text = action.text.trim();
      if (!room || !text) return state;
      let next = state;
      let id: string;
      [next, id] = nextId(next, "q");
      const item: QueueItem = { id, text, everyone: action.everyone };
      // Saved immediately. It starts only when idle and unpaused; otherwise it queues and never interrupts.
      const busy = room.round !== null || room.paused;
      const base: Room = busy
        ? { ...room, queue: [...room.queue, item] }
        : room;
      const [after, updated] = busy
        ? [next, base]
        : startRound(next, base, item);
      return mapRoom(after, room.id, () => updated);
    }
    case "advance": {
      const room = roomOf(state, action.roomId);
      if (!room) return state;
      const [next, updated] = advance(state, room);
      return mapRoom(next, room.id, () => updated);
    }
    case "stop": {
      const room = roomOf(state, action.roomId);
      if (!room?.round) return state;
      const [next, cancelled] = cancelRound(
        state,
        room,
        "Stopped. Queue paused.",
      );
      return mapRoom(next, room.id, () => ({ ...cancelled, paused: true }));
    }
    case "resume": {
      const room = roomOf(state, action.roomId);
      if (!room?.paused) return state;
      const [next, updated] = drain(state, { ...room, paused: false });
      return mapRoom(next, room.id, () => updated);
    }
    case "steer": {
      const room = roomOf(state, action.roomId);
      const item = room?.queue.find((entry) => entry.id === action.itemId);
      if (!room || !item) return state;
      // Cancel, take the message out of the queue so it cannot run twice, run it, and keep the rest in order.
      const [afterCancel, cancelled] = cancelRound(
        state,
        { ...room, queue: room.queue.filter((entry) => entry.id !== item.id) },
        `Steered: “${short(item.text)}” replaced the running round.`,
      );
      const [next, started] = startRound(
        afterCancel,
        { ...cancelled, paused: false },
        item,
      );
      return mapRoom(next, room.id, () => started);
    }
    case "edit-queued":
      return mapRoom(state, action.roomId, (room) => ({
        ...room,
        queue: room.queue.map((item) =>
          item.id === action.itemId && action.text.trim()
            ? { ...item, text: action.text.trim() }
            : item,
        ),
      }));
    case "remove-queued":
      return mapRoom(state, action.roomId, (room) => ({
        ...room,
        queue: room.queue.filter((item) => item.id !== action.itemId),
      }));
    case "late-output": {
      const room = roomOf(state, action.roomId);
      if (!room?.cancelled) return state;
      const [next, updated] = system(
        state,
        room,
        `Discarded late output from stopped round ${room.cancelled}. It cannot become an answer.`,
      );
      return mapRoom(next, room.id, () => ({ ...updated, cancelled: null }));
    }
    case "standup": {
      const room = roomOf(state, action.roomId);
      if (!room || room.round) return state;
      const [next, id] = nextId(state, "m");
      const reports: StandupReport[] = room.participants.map((colleagueId) => ({
        colleagueId,
        state: colleagueOf(state, colleagueId)?.standupFailsFirst
          ? "failed"
          : "ok",
      }));
      const message: Message = {
        id,
        kind: "standup",
        author: "system",
        text: "",
        standup: {
          window:
            "previous 24 hours (first standup), cutoff recorded at 09:00 fixture time",
          reports,
        },
      };
      return mapRoom(next, room.id, () => ({
        ...append(room, message),
        usageRuns: room.usageRuns + reports.length + 1,
        runLog: [
          ...room.runLog,
          `Standup: ${reports.length} reports, then a combined summary. No work started.`,
        ],
      }));
    }
    case "retry-report":
      return mapRoom(state, action.roomId, (room) => ({
        ...room,
        usageRuns: room.usageRuns + 1,
        messages: room.messages.map((message) =>
          message.id === action.messageId && message.standup
            ? {
                ...message,
                standup: {
                  ...message.standup,
                  reports: message.standup.reports.map((report) =>
                    report.colleagueId === action.colleagueId
                      ? { ...report, state: "ok" }
                      : report,
                  ),
                },
              }
            : message,
        ),
      }));
    case "open-handoff": {
      const room = roomOf(state, action.roomId);
      const message = room?.messages.find(
        (item) => item.id === action.messageId,
      );
      if (!room) return state;
      const first = room.projects[0] ?? "";
      const assignee =
        message && message.author !== "system" && message.author !== "you"
          ? message.author
          : room.lead;
      const draft = action.proposal
        ? {
            ...defaultDraft(
              room,
              `${room.id}:${action.messageId}:${action.proposal}`,
              first,
              assignee,
              action.proposal.replace(/\.$/, ""),
              action.proposal,
            ),
            constraints: "",
            acceptance: "",
            messageCount: 1,
            memoryRefs: [],
          }
        : defaultDraft(
            room,
            `${room.id}:${action.messageId}`,
            first,
            assignee,
            "Retry enrichment without duplicate imports",
            message?.text ?? "",
          );
      const existing = state.draft?.key === draft.key ? state.draft : draft;
      return {
        ...state,
        draft: existing,
        view: { name: "handoff" },
        panel: null,
      };
    }
    case "edit-draft": {
      if (!state.draft || state.draft.createdCardId) return state;
      let draft = { ...state.draft, ...action.patch };
      if (action.patch.project !== undefined && !draft.overridden)
        draft = {
          ...draft,
          destination: project(draft.project)?.newCards ?? "triage",
        };
      if (action.patch.destination !== undefined)
        draft = { ...draft, overridden: true };
      return { ...state, draft };
    }
    case "create-card": {
      const draft = state.draft;
      const room = draft && roomOf(state, draft.roomId);
      // Simulated only. A second click, or a retried creation, returns the same card instead of adding another.
      if (!draft || !room || !draft.project || !draft.title.trim())
        return state;
      if (draft.createdCardId)
        return { ...state, view: { name: "room", roomId: room.id } };
      const [afterId, id] = nextId(state, "m");
      const cardId = `SIM-${state.cards.length + 1}`;
      const card: SimCard = {
        id: cardId,
        title: draft.title.trim(),
        project: draft.project,
        assignee: draft.assignee,
        destination: draft.destination,
        consequence: handoffConsequence(draft.destination, draft.project),
        roomId: room.id,
      };
      const next: State = {
        ...afterId,
        cards: [...state.cards, card],
        draft: { ...draft, createdCardId: cardId },
        view: { name: "room", roomId: room.id },
      };
      return mapRoom(next, room.id, (item) =>
        append(item, {
          id,
          kind: "card",
          author: "system",
          text: card.title,
          cardId,
        }),
      );
    }
    case "review-update": {
      const room = roomOf(state, action.roomId);
      if (!room) return state;
      const [next, updated] = system(
        state,
        room,
        `${action.cardId} moved to Review (simulated). No colleague was asked to respond.`,
      );
      return mapRoom(next, room.id, () => updated);
    }
  }
}
