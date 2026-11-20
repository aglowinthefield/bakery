import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { validateAgentModel, defaultChatModel, type AgentModel } from "./agent-models.js";

const now = () => new Date().toISOString();
const json = <T>(text: string | null, fallback: T): T => { try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };

export type Colleague = { id: string; name: string; specialty: string; instructions: string; model: string; thinking: AgentModel["thinking"]; archived: boolean; projectIds: string[]; createdAt: string; updatedAt: string };
export type RoomMode = "lead" | "mention";
export type Room = { id: string; kind: "direct" | "group"; title: string; leadId: string; executionBoardId: string | null; mode: RoomMode; paused: boolean; useUserMemory: boolean; participantIds: string[]; projects: { boardId: string; memory: boolean }[]; archived: boolean; createdAt: string; updatedAt: string };
export type MessageKind = "user" | "colleague" | "system" | "error";
export type RoomMessage = { id: string; roomId: string; seq: number | null; kind: MessageKind; colleagueId: string | null; body: string; ask: "normal" | "everyone"; state: "queued" | "delivered" | "removed" | "final"; queueOrder: number | null; roundId: string | null; runId: string | null; role: string; interrupted: boolean; createdAt: string; editedAt: string | null };
export type RoundKind = "message" | "everyone" | "standup";
export type Round = { id: string; roomId: string; kind: RoundKind; triggerMessageId: string | null; status: "running" | "done" | "stopped" | "interrupted" | "failed"; snapshotSeq: number; context: RoundContext; interjections: number; startedAt: string; finishedAt: string | null; note: string };
export type RunRole = "primary" | "interjection" | "screen" | "standup-report" | "standup-summary";
export type RunStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";
export type RunRecord = { id: string; roundId: string; roomId: string; colleagueId: string; role: RunRole; status: RunStatus; config: Record<string, unknown>; facts: unknown; messageId: string | null; cost: number; inputTokens: number; outputTokens: number; error: string; startedAt: string; finishedAt: string | null; supersededBy: string | null };
export type MemoryUse = { id: string; scope: string; project: string | null; content: string; stale: boolean; warning: string | null; updatedAt: string | null };
export type RoundContext = { memory: { status: "off" | "used" | "degraded" | "unavailable"; error: string; searches: { scope: string; project: string | null; query: string; count: number; error: string }[]; items: MemoryUse[] } | null };
export type Handoff = { id: string; roomId: string; cardId: string; boardId: string; assigneeId: string | null; idempotencyKey: string; creation: string; sourceMessageIds: string[]; requirements: string; config: Record<string, unknown>; lastStatus: string; createdAt: string };
export type MemorySave = { id: string; roomId: string; messageId: string; scope: "user" | "project"; projectKey: string; projectName: string; content: string; status: "unsaved" | "saved"; memoryId: string | null; outcome: string; error: string; attempts: number; createdAt: string; updatedAt: string };
export type NewCardPolicy = "triage" | "ready";

type Row = Record<string, any>;

export class ColleagueStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS colleagues (id TEXT PRIMARY KEY, name TEXT NOT NULL, specialty TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, thinking TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS colleague_projects (colleagueId TEXT NOT NULL REFERENCES colleagues(id) ON DELETE CASCADE, boardId TEXT NOT NULL, PRIMARY KEY (colleagueId, boardId));
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, leadId TEXT NOT NULL, executionBoardId TEXT, mode TEXT NOT NULL DEFAULT 'lead', paused INTEGER NOT NULL DEFAULT 0, useUserMemory INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_participants (roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, colleagueId TEXT NOT NULL REFERENCES colleagues(id), position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (roomId, colleagueId));
      CREATE TABLE IF NOT EXISTS room_projects (roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, boardId TEXT NOT NULL, memory INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (roomId, boardId));
      CREATE TABLE IF NOT EXISTS room_messages (id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, seq INTEGER, kind TEXT NOT NULL, colleagueId TEXT, body TEXT NOT NULL, ask TEXT NOT NULL DEFAULT 'normal', state TEXT NOT NULL, queueOrder INTEGER, roundId TEXT, runId TEXT, role TEXT NOT NULL DEFAULT '', interrupted INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, editedAt TEXT);
      CREATE INDEX IF NOT EXISTS room_messages_room ON room_messages(roomId, seq);
      CREATE TABLE IF NOT EXISTS room_rounds (id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, kind TEXT NOT NULL, triggerMessageId TEXT, status TEXT NOT NULL, snapshotSeq INTEGER NOT NULL, context TEXT NOT NULL DEFAULT '{}', interjections INTEGER NOT NULL DEFAULT 0, startedAt TEXT NOT NULL, finishedAt TEXT, note TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS room_runs (id TEXT PRIMARY KEY, roundId TEXT NOT NULL REFERENCES room_rounds(id) ON DELETE CASCADE, roomId TEXT NOT NULL, colleagueId TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', facts TEXT, messageId TEXT, cost REAL NOT NULL DEFAULT 0, inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', startedAt TEXT NOT NULL, finishedAt TEXT, supersededBy TEXT);
      CREATE INDEX IF NOT EXISTS room_runs_round ON room_runs(roundId);
      CREATE TABLE IF NOT EXISTS room_standups (id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, roundId TEXT NOT NULL, cutoff TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_handoffs (id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, cardId TEXT NOT NULL, boardId TEXT NOT NULL, assigneeId TEXT, idempotencyKey TEXT NOT NULL, creation TEXT NOT NULL, sourceMessageIds TEXT NOT NULL DEFAULT '[]', requirements TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}', lastStatus TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, UNIQUE(roomId, idempotencyKey));
      CREATE TABLE IF NOT EXISTS room_memory_saves (id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, messageId TEXT NOT NULL, scope TEXT NOT NULL, projectKey TEXT NOT NULL DEFAULT '', projectName TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, status TEXT NOT NULL, memoryId TEXT, outcome TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(roomId, messageId, scope, projectKey));
      CREATE TABLE IF NOT EXISTS board_card_policies (boardId TEXT PRIMARY KEY, newCardPolicy TEXT NOT NULL DEFAULT 'triage');
    `);
    // A restart kills every Pi child. Paid work is never replayed: running runs and rounds are marked interrupted, the room is paused, and the queue stays put.
    const stale = db.prepare("SELECT DISTINCT roomId FROM room_rounds WHERE status='running'").all() as Row[];
    const finished = now();
    db.prepare("UPDATE room_runs SET status='interrupted', error='Interrupted by a Bakery restart', finishedAt=? WHERE status='running'").run(finished);
    db.prepare("UPDATE room_rounds SET status='interrupted', note='Interrupted by a Bakery restart', finishedAt=? WHERE status='running'").run(finished);
    for (const { roomId } of stale) {
      db.prepare("UPDATE rooms SET paused=1, updatedAt=? WHERE id=?").run(finished, roomId);
      this.addMessage(roomId, { kind: "system", body: "Bakery restarted while this round was running. Unfinished work was marked interrupted and nothing was replayed. The queue is paused; retry an interrupted reply or Resume queue." });
    }
  }

  // ── colleagues ──
  private colleague(row: Row): Colleague {
    const projectIds = (this.db.prepare("SELECT boardId FROM colleague_projects WHERE colleagueId=? ORDER BY boardId").all(row.id) as Row[]).map(item => item.boardId as string);
    return { id: row.id, name: row.name, specialty: row.specialty, instructions: row.instructions, model: row.model, thinking: row.thinking, archived: row.archived !== 0, projectIds, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }
  listColleagues(includeArchived = false): Colleague[] {
    return (this.db.prepare(`SELECT * FROM colleagues ${includeArchived ? "" : "WHERE archived=0"} ORDER BY name COLLATE NOCASE`).all() as Row[]).map(row => this.colleague(row));
  }
  getColleague(id: string): Colleague | undefined { const row = this.db.prepare("SELECT * FROM colleagues WHERE id=?").get(id) as Row | undefined; return row && this.colleague(row); }
  saveColleague(id: string | null, input: { name?: unknown; specialty?: unknown; instructions?: unknown; model?: unknown; thinking?: unknown; projectIds?: unknown }, knownBoards: Set<string>): Colleague {
    const current = id ? this.getColleague(id) : undefined;
    if (id && !current) throw new Error("Colleague not found");
    const name = String(input.name ?? current?.name ?? "").trim();
    if (!/^[\w][\w .-]{0,39}$/.test(name)) throw new Error("Name must be 1 to 40 letters, numbers, spaces, dots, dashes or underscores");
    const clash = this.db.prepare("SELECT id FROM colleagues WHERE archived=0 AND lower(name)=lower(?) AND id IS NOT ?").get(name, id) as Row | undefined;
    if (clash) throw new Error(`A colleague named ${name} already exists`);
    const specialty = String(input.specialty ?? current?.specialty ?? "").trim(), instructions = String(input.instructions ?? current?.instructions ?? "").trim();
    if (specialty.length > 200) throw new Error("Specialty is limited to 200 characters");
    if (instructions.length > 4000) throw new Error("Instructions are limited to 4000 characters");
    const choice = validateAgentModel({ model: input.model ?? current?.model ?? defaultChatModel.model, thinking: input.thinking ?? current?.thinking ?? defaultChatModel.thinking }, "Colleague model");
    const projectIds = input.projectIds === undefined ? current?.projectIds ?? [] : input.projectIds;
    if (!Array.isArray(projectIds) || !projectIds.every(item => typeof item === "string" && knownBoards.has(item))) throw new Error("projectIds must list existing project boards");
    const time = now(), colleagueId = id ?? randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (current) this.db.prepare("UPDATE colleagues SET name=?, specialty=?, instructions=?, model=?, thinking=?, updatedAt=? WHERE id=?").run(name, specialty, instructions, choice.model, choice.thinking, time, colleagueId);
      else this.db.prepare("INSERT INTO colleagues(id, name, specialty, instructions, model, thinking, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(colleagueId, name, specialty, instructions, choice.model, choice.thinking, time, time);
      this.db.prepare("DELETE FROM colleague_projects WHERE colleagueId=?").run(colleagueId);
      for (const boardId of new Set(projectIds as string[])) this.db.prepare("INSERT INTO colleague_projects(colleagueId, boardId) VALUES (?, ?)").run(colleagueId, boardId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getColleague(colleagueId)!;
  }
  archiveColleague(id: string): Colleague {
    if (!this.getColleague(id)) throw new Error("Colleague not found");
    const inRooms = this.db.prepare("SELECT title FROM rooms WHERE archived=0 AND leadId=?").all(id) as Row[];
    if (inRooms.length) throw new Error(`Colleague leads ${inRooms.map(row => row.title).join(", ")}; pick another lead first`);
    this.db.prepare("UPDATE colleagues SET archived=1, updatedAt=? WHERE id=?").run(now(), id);
    this.db.prepare("DELETE FROM room_participants WHERE colleagueId=? AND roomId IN (SELECT id FROM rooms WHERE archived=0)").run(id);
    return this.getColleague(id)!;
  }

  // ── rooms ──
  private room(row: Row): Room {
    return {
      id: row.id, kind: row.kind, title: row.title, leadId: row.leadId, executionBoardId: row.executionBoardId, mode: row.mode, paused: row.paused !== 0, useUserMemory: row.useUserMemory !== 0, archived: row.archived !== 0,
      participantIds: (this.db.prepare("SELECT colleagueId FROM room_participants WHERE roomId=? ORDER BY position").all(row.id) as Row[]).map(item => item.colleagueId as string),
      projects: (this.db.prepare("SELECT boardId, memory FROM room_projects WHERE roomId=? ORDER BY boardId").all(row.id) as Row[]).map(item => ({ boardId: item.boardId as string, memory: item.memory !== 0 })),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }
  getRoom(id: string): Room | undefined { const row = this.db.prepare("SELECT * FROM rooms WHERE id=?").get(id) as Row | undefined; return row && this.room(row); }
  listRooms(boardId?: string): (Room & { lastMessage: string; lastAt: string; queued: number; running: boolean })[] {
    const rows = this.db.prepare("SELECT * FROM rooms WHERE archived=0 ORDER BY updatedAt DESC").all() as Row[];
    return rows.map(row => this.room(row)).filter(room => !boardId || room.projects.some(project => project.boardId === boardId) || room.executionBoardId === boardId).map(room => {
      const last = this.db.prepare("SELECT body, createdAt FROM room_messages WHERE roomId=? AND state IN ('delivered','final') ORDER BY seq DESC LIMIT 1").get(room.id) as Row | undefined;
      const queued = (this.db.prepare("SELECT COUNT(*) AS n FROM room_messages WHERE roomId=? AND state='queued'").get(room.id) as Row).n as number;
      const running = !!this.db.prepare("SELECT 1 FROM room_rounds WHERE roomId=? AND status='running'").get(room.id);
      return { ...room, lastMessage: String(last?.body ?? "").slice(0, 160), lastAt: String(last?.createdAt ?? room.createdAt), queued, running };
    });
  }
  /** Validates and writes a room. Participants must be active colleagues, the lead one of them, and projects known boards. */
  saveRoom(id: string | null, input: Record<string, unknown>, knownBoards: Set<string>): Room {
    const current = id ? this.getRoom(id) : undefined;
    if (id && !current) throw new Error("Room not found");
    const participantIds = input.participantIds === undefined ? current?.participantIds : input.participantIds;
    if (!Array.isArray(participantIds) || !participantIds.length || participantIds.length > 8 || !participantIds.every(item => typeof item === "string")) throw new Error("Choose between 1 and 8 participants");
    const unique = [...new Set(participantIds as string[])];
    for (const participant of unique) { const found = this.getColleague(participant); if (!found || found.archived) throw new Error("Participants must be active colleagues"); }
    const leadId = String(input.leadId ?? current?.leadId ?? (unique.length === 1 ? unique[0] : ""));
    if (!unique.includes(leadId)) throw new Error("The lead must be one of the active participants");
    const kind = unique.length === 1 ? "direct" : "group";
    const title = String(input.title ?? current?.title ?? "").trim() || this.getColleague(leadId)!.name;
    if (title.length > 80) throw new Error("Title is limited to 80 characters");
    const mode = input.mode === undefined ? current?.mode ?? "lead" : input.mode;
    if (mode !== "lead" && mode !== "mention") throw new Error("mode must be lead or mention");
    const rawProjects = input.projects === undefined ? current?.projects ?? [] : input.projects;
    if (!Array.isArray(rawProjects)) throw new Error("projects must be a list");
    const projects = rawProjects.map(item => typeof item === "string" ? { boardId: item, memory: false } : { boardId: String((item as Row).boardId), memory: (item as Row).memory === true });
    if (!projects.every(project => knownBoards.has(project.boardId))) throw new Error("Room projects must be existing project boards");
    const executionBoardId = input.executionBoardId === undefined ? current?.executionBoardId ?? null : input.executionBoardId === null || input.executionBoardId === "" ? null : String(input.executionBoardId);
    if (executionBoardId !== null && !projects.some(project => project.boardId === executionBoardId)) throw new Error("The execution project must be one of the room's context projects");
    const useUserMemory = input.useUserMemory === undefined ? current?.useUserMemory ?? false : input.useUserMemory === true;
    const time = now(), roomId = id ?? randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (current) this.db.prepare("UPDATE rooms SET kind=?, title=?, leadId=?, executionBoardId=?, mode=?, useUserMemory=?, updatedAt=? WHERE id=?").run(kind, title, leadId, executionBoardId, mode, useUserMemory ? 1 : 0, time, roomId);
      else this.db.prepare("INSERT INTO rooms(id, kind, title, leadId, executionBoardId, mode, useUserMemory, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(roomId, kind, title, leadId, executionBoardId, mode, useUserMemory ? 1 : 0, time, time);
      this.db.prepare("DELETE FROM room_participants WHERE roomId=?").run(roomId);
      unique.forEach((colleagueId, position) => this.db.prepare("INSERT INTO room_participants(roomId, colleagueId, position) VALUES (?, ?, ?)").run(roomId, colleagueId, position));
      this.db.prepare("DELETE FROM room_projects WHERE roomId=?").run(roomId);
      for (const project of new Map(projects.map(item => [item.boardId, item])).values()) this.db.prepare("INSERT INTO room_projects(roomId, boardId, memory) VALUES (?, ?, ?)").run(roomId, project.boardId, project.memory ? 1 : 0);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getRoom(roomId)!;
  }
  setPaused(id: string, paused: boolean) { this.db.prepare("UPDATE rooms SET paused=?, updatedAt=? WHERE id=?").run(paused ? 1 : 0, now(), id); }
  touchRoom(id: string) { this.db.prepare("UPDATE rooms SET updatedAt=? WHERE id=?").run(now(), id); }

  // ── messages ──
  private message(row: Row): RoomMessage { return { ...(row as RoomMessage), interrupted: row.interrupted !== 0 }; }
  private nextSeq(roomId: string): number { return ((this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM room_messages WHERE roomId=?").get(roomId) as Row).n as number) + 1; }
  maxSeq(roomId: string): number { return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM room_messages WHERE roomId=?").get(roomId) as Row).n as number; }
  addMessage(roomId: string, input: { kind: MessageKind; body: string; colleagueId?: string | null; ask?: "normal" | "everyone"; queued?: boolean; roundId?: string | null; runId?: string | null; role?: string; interrupted?: boolean }): RoomMessage {
    const id = randomUUID(), time = now();
    const queueOrder = input.queued ? ((this.db.prepare("SELECT COALESCE(MAX(queueOrder), 0) AS n FROM room_messages WHERE roomId=?").get(roomId) as Row).n as number) + 1 : null;
    const state = input.queued ? "queued" : input.kind === "user" ? "delivered" : "final";
    this.db.prepare("INSERT INTO room_messages(id, roomId, seq, kind, colleagueId, body, ask, state, queueOrder, roundId, runId, role, interrupted, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, roomId, input.queued ? null : this.nextSeq(roomId), input.kind, input.colleagueId ?? null, input.body, input.ask ?? "normal", state, queueOrder, input.roundId ?? null, input.runId ?? null, input.role ?? "", input.interrupted ? 1 : 0, time);
    this.touchRoom(roomId);
    return this.getMessage(id)!;
  }
  getMessage(id: string): RoomMessage | undefined { const row = this.db.prepare("SELECT * FROM room_messages WHERE id=?").get(id) as Row | undefined; return row && this.message(row); }
  /** Messages a person can see: transcript in order, then the queue in queue order. Removed messages are gone. */
  listMessages(roomId: string): RoomMessage[] {
    const rows = this.db.prepare("SELECT * FROM room_messages WHERE roomId=? AND state IN ('delivered','final') ORDER BY seq").all(roomId) as Row[];
    return [...rows, ...this.queue(roomId, true)].map(row => this.message(row));
  }
  private queue(roomId: string, raw = false): Row[] { return this.db.prepare("SELECT * FROM room_messages WHERE roomId=? AND state='queued' ORDER BY queueOrder").all(roomId) as Row[]; }
  listQueue(roomId: string): RoomMessage[] { return this.queue(roomId).map(row => this.message(row)); }
  /** Moves a queued message into the transcript at the end. Returns undefined when it is no longer queued, so a message is delivered once. */
  deliver(messageId: string): RoomMessage | undefined {
    const message = this.getMessage(messageId);
    if (!message || message.state !== "queued") return undefined;
    this.db.prepare("UPDATE room_messages SET state='delivered', seq=?, queueOrder=NULL WHERE id=? AND state='queued'").run(this.nextSeq(message.roomId), messageId);
    this.touchRoom(message.roomId);
    return this.getMessage(messageId);
  }
  editQueued(messageId: string, body: string): RoomMessage {
    const result = this.db.prepare("UPDATE room_messages SET body=?, editedAt=? WHERE id=? AND state='queued'").run(body, now(), messageId);
    if (!result.changes) throw new Error("That message is no longer queued");
    return this.getMessage(messageId)!;
  }
  removeQueued(messageId: string) {
    const result = this.db.prepare("UPDATE room_messages SET state='removed', queueOrder=NULL WHERE id=? AND state='queued'").run(messageId);
    if (!result.changes) throw new Error("That message is no longer queued");
  }
  /** The transcript a run may see: delivered and final messages up to the round's snapshot. Queued text never appears. */
  transcript(roomId: string, uptoSeq: number): RoomMessage[] {
    return (this.db.prepare("SELECT * FROM room_messages WHERE roomId=? AND state IN ('delivered','final') AND seq<=? ORDER BY seq").all(roomId, uptoSeq) as Row[]).map(row => this.message(row));
  }

  // ── rounds and runs ──
  private round(row: Row): Round { return { ...(row as Round), context: json(row.context, { memory: null }) }; }
  createRound(roomId: string, kind: RoundKind, triggerMessageId: string | null, snapshotSeq: number): Round {
    const id = randomUUID();
    this.db.prepare("INSERT INTO room_rounds(id, roomId, kind, triggerMessageId, status, snapshotSeq, startedAt) VALUES (?, ?, ?, ?, 'running', ?, ?)").run(id, roomId, kind, triggerMessageId, snapshotSeq, now());
    return this.getRound(id)!;
  }
  getRound(id: string): Round | undefined { const row = this.db.prepare("SELECT * FROM room_rounds WHERE id=?").get(id) as Row | undefined; return row && this.round(row); }
  runningRound(roomId: string): Round | undefined { const row = this.db.prepare("SELECT * FROM room_rounds WHERE roomId=? AND status='running'").get(roomId) as Row | undefined; return row && this.round(row); }
  listRounds(roomId: string, limit = 30): Round[] { return (this.db.prepare("SELECT * FROM room_rounds WHERE roomId=? ORDER BY startedAt DESC, rowid DESC LIMIT ?").all(roomId, limit) as Row[]).map(row => this.round(row)).reverse(); }
  updateRound(id: string, patch: Partial<Pick<Round, "status" | "context" | "interjections" | "note">>) {
    const current = this.getRound(id)!;
    const status = patch.status ?? current.status;
    this.db.prepare("UPDATE room_rounds SET status=?, context=?, interjections=?, note=?, finishedAt=? WHERE id=?")
      .run(status, JSON.stringify(patch.context ?? current.context), patch.interjections ?? current.interjections, patch.note ?? current.note, status === "running" ? null : current.finishedAt ?? now(), id);
  }
  createRun(input: { roundId: string; roomId: string; colleagueId: string; role: RunRole; config: Record<string, unknown>; facts?: unknown }): RunRecord {
    const id = randomUUID();
    this.db.prepare("INSERT INTO room_runs(id, roundId, roomId, colleagueId, role, status, config, facts, startedAt) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)").run(id, input.roundId, input.roomId, input.colleagueId, input.role, JSON.stringify(input.config), input.facts === undefined ? null : JSON.stringify(input.facts), now());
    return this.getRun(id)!;
  }
  private run(row: Row): RunRecord { return { ...(row as RunRecord), config: json(row.config, {}), facts: json(row.facts, null) }; }
  getRun(id: string): RunRecord | undefined { const row = this.db.prepare("SELECT * FROM room_runs WHERE id=?").get(id) as Row | undefined; return row && this.run(row); }
  listRuns(roundId: string): RunRecord[] { return (this.db.prepare("SELECT * FROM room_runs WHERE roundId=? ORDER BY startedAt, rowid").all(roundId) as Row[]).map(row => this.run(row)); }
  /** Settles a run only if it is still running. Returns false when it was cancelled first, which fences late output. */
  finishRun(id: string, status: Exclude<RunStatus, "running">, patch: { error?: string; messageId?: string | null; cost?: number; inputTokens?: number; outputTokens?: number } = {}): boolean {
    const result = this.db.prepare("UPDATE room_runs SET status=?, error=?, messageId=?, cost=?, inputTokens=?, outputTokens=?, finishedAt=? WHERE id=? AND status='running'")
      .run(status, patch.error ?? "", patch.messageId ?? null, patch.cost ?? 0, patch.inputTokens ?? 0, patch.outputTokens ?? 0, now(), id);
    return result.changes > 0;
  }
  supersede(runId: string, by: string) { this.db.prepare("UPDATE room_runs SET supersededBy=? WHERE id=?").run(by, runId); }
  roundCost(roundId: string): { total: number; screening: number; screens: number } {
    const row = this.db.prepare("SELECT COALESCE(SUM(cost),0) AS total, COALESCE(SUM(CASE WHEN role='screen' THEN cost END),0) AS screening, COALESCE(SUM(CASE WHEN role='screen' THEN 1 END),0) AS screens FROM room_runs WHERE roundId=?").get(roundId) as Row;
    return { total: row.total, screening: row.screening, screens: row.screens };
  }

  // ── standups ──
  lastStandupAt(roomId: string): string | null { return ((this.db.prepare("SELECT createdAt FROM room_standups WHERE roomId=? ORDER BY createdAt DESC LIMIT 1").get(roomId) as Row | undefined)?.createdAt as string | undefined) ?? null; }
  addStandup(roomId: string, roundId: string, cutoff: string) { this.db.prepare("INSERT INTO room_standups(id, roomId, roundId, cutoff, createdAt) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), roomId, roundId, cutoff, now()); }
  standupCutoff(roundId: string): string | null { return ((this.db.prepare("SELECT cutoff FROM room_standups WHERE roundId=?").get(roundId) as Row | undefined)?.cutoff as string | undefined) ?? null; }

  // ── handoffs ──
  private handoff(row: Row): Handoff { return { ...(row as Handoff), sourceMessageIds: json(row.sourceMessageIds, []), config: json(row.config, {}) }; }
  getHandoffByKey(roomId: string, key: string): Handoff | undefined { const row = this.db.prepare("SELECT * FROM room_handoffs WHERE roomId=? AND idempotencyKey=?").get(roomId, key) as Row | undefined; return row && this.handoff(row); }
  listHandoffs(roomId?: string): Handoff[] { return (this.db.prepare(`SELECT * FROM room_handoffs ${roomId ? "WHERE roomId=?" : ""} ORDER BY createdAt`).all(...(roomId ? [roomId] : [])) as Row[]).map(row => this.handoff(row)); }
  addHandoff(input: Omit<Handoff, "id" | "createdAt" | "lastStatus"> & { lastStatus?: string }): Handoff {
    const id = randomUUID();
    this.db.prepare("INSERT INTO room_handoffs(id, roomId, cardId, boardId, assigneeId, idempotencyKey, creation, sourceMessageIds, requirements, config, lastStatus, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.roomId, input.cardId, input.boardId, input.assigneeId, input.idempotencyKey, input.creation, JSON.stringify(input.sourceMessageIds), input.requirements, JSON.stringify(input.config), input.lastStatus ?? "", now());
    return this.handoff(this.db.prepare("SELECT * FROM room_handoffs WHERE id=?").get(id) as Row);
  }
  setHandoffStatus(id: string, status: string) { this.db.prepare("UPDATE room_handoffs SET lastStatus=? WHERE id=?").run(status, id); }
  newCardPolicy(boardId: string): NewCardPolicy { return ((this.db.prepare("SELECT newCardPolicy FROM board_card_policies WHERE boardId=?").get(boardId) as Row | undefined)?.newCardPolicy as NewCardPolicy | undefined) ?? "triage"; }
  setNewCardPolicy(boardId: string, policy: NewCardPolicy) {
    if (policy !== "triage" && policy !== "ready") throw new Error("Policy must be triage or ready");
    this.db.prepare("INSERT INTO board_card_policies(boardId, newCardPolicy) VALUES (?, ?) ON CONFLICT(boardId) DO UPDATE SET newCardPolicy=excluded.newCardPolicy").run(boardId, policy);
  }

  // ── memory saves ──
  getSave(id: string): MemorySave | undefined { return this.db.prepare("SELECT * FROM room_memory_saves WHERE id=?").get(id) as MemorySave | undefined; }
  listSaves(roomId: string): MemorySave[] { return this.db.prepare("SELECT * FROM room_memory_saves WHERE roomId=? ORDER BY createdAt").all(roomId) as unknown as MemorySave[]; }
  findSave(roomId: string, messageId: string, scope: string, projectKey: string): MemorySave | undefined { return this.db.prepare("SELECT * FROM room_memory_saves WHERE roomId=? AND messageId=? AND scope=? AND projectKey=?").get(roomId, messageId, scope, projectKey) as MemorySave | undefined; }
  addSave(input: { roomId: string; messageId: string; scope: "user" | "project"; projectKey: string; projectName: string; content: string }): MemorySave {
    const id = randomUUID(), time = now();
    this.db.prepare("INSERT INTO room_memory_saves(id, roomId, messageId, scope, projectKey, projectName, content, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'unsaved', ?, ?)").run(id, input.roomId, input.messageId, input.scope, input.projectKey, input.projectName, input.content, time, time);
    return this.getSave(id)!;
  }
  settleSave(id: string, result: { memoryId: string; outcome: string } | { error: string }) {
    if ("error" in result) this.db.prepare("UPDATE room_memory_saves SET error=?, attempts=attempts+1, updatedAt=? WHERE id=? AND status='unsaved'").run(result.error, now(), id);
    else this.db.prepare("UPDATE room_memory_saves SET status='saved', memoryId=?, outcome=?, error='', attempts=attempts+1, updatedAt=? WHERE id=?").run(result.memoryId, result.outcome, now(), id);
  }
}
