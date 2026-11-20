import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { messageUsage } from "./agent.js";
import { defaultChatModel, piModelArgs, type AgentModel } from "./agent-models.js";
import type { Board, Card, ChatPart } from "./board.js";
import { applyPiEvent, replyText } from "./chat.js";
import { ColleagueStore, type Colleague, type Handoff, type MemorySave, type MemoryUse, type Room, type RoomMessage, type Round, type RoundContext, type RunRecord, type RunRole } from "./colleague-store.js";
import { memoryProject, saveMemory, searchMemories, type ImpressionConfig } from "./impression.js";
import { command } from "./platform.js";

/** Hard limits that keep a round bounded. */
export const limits = { interjections: 2, screened: 4, transcriptMessages: 40, transcriptChars: 12_000, messageChars: 8000, memoryPerSearch: 3, standupWindowMs: 86_400_000 };
export class Conflict extends Error {}
export class NeedsClarification extends Error {}

export type RoomsOptions = {
  piBin: string; dataDir: string; env: NodeJS.ProcessEnv; impression: () => ImpressionConfig | null;
  /** The inexpensive model that decides whether a colleague has anything material to add. */
  screenModel?: AgentModel; runTimeoutMs?: number; screenTimeoutMs?: number; pollMs?: number;
};

type Active = { child: ChildProcess; parts: ChatPart[] };
type Outcome = { ok: true; text: string; run: RunRecord } | { ok: false; run: RunRecord | null; fenced: boolean; error: string };
type Facts = { completed: Fact[]; active: Fact[]; blockers: Fact[]; proposed: Fact[] };
type Fact = { cardId: string; title: string; status: string; note: string; runs: { id: string; attempt: number; status: string; finishedAt: string | null }[] };

const readOnlyTools = "read,grep,find,ls";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Rooms {
  private active = new Map<string, Active>();
  private cancelled = new Set<string>();
  private listeners = new Map<string, Set<() => void>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private board: Board, readonly store: ColleagueStore, private options: RoomsOptions) {
    const pollMs = options.pollMs ?? 5000;
    if (pollMs > 0) { this.timer = setInterval(() => { try { this.syncHandoffs(); } catch { /* Next tick retries. */ } }, pollMs); this.timer.unref(); }
  }
  shutdown() { clearInterval(this.timer); for (const [, active] of this.active) this.kill(active.child); }

  subscribe(roomId: string, listener: () => void): () => void {
    const set = this.listeners.get(roomId) ?? new Set(); this.listeners.set(roomId, set); set.add(listener);
    return () => { set.delete(listener); };
  }
  private emit(roomId: string) { for (const listener of this.listeners.get(roomId) ?? []) listener(); }

  private knownBoards(): Set<string> { return new Set(this.board.listBoards().map(board => board.id)); }
  private boardName(boardId: string): string { const found = this.board.getBoard(boardId); return found ? found.repo.split("/").filter(Boolean).at(-1) ?? found.repo : "(removed project)"; }
  private screenModel(): AgentModel { return this.options.screenModel ?? { model: "anthropic/claude-haiku-4-5", thinking: "low" }; }

  // ── colleagues and rooms ──
  saveColleague(id: string | null, input: Record<string, unknown>) { return this.store.saveColleague(id, input, this.knownBoards()); }
  saveRoom(id: string | null, input: Record<string, unknown>): Room {
    const room = this.store.saveRoom(id, input, this.knownBoards());
    this.emit(room.id);
    return room;
  }

  /** Everything the room page shows, in one read. */
  detail(roomId: string) {
    const room = this.store.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    const colleagues = this.store.listColleagues(true);
    const rounds = this.store.listRounds(roomId).map(round => ({ ...round, runs: this.store.listRuns(round.id), cost: this.store.roundCost(round.id), cutoff: round.kind === "standup" ? this.store.standupCutoff(round.id) : null }));
    const live = [...this.active.entries()].flatMap(([runId, active]) => {
      const run = this.store.getRun(runId);
      return run && run.roomId === roomId && run.status === "running" ? [{ runId, colleagueId: run.colleagueId, role: run.role, text: replyText(active.parts) }] : [];
    });
    const handoffs = this.store.listHandoffs(roomId).map(handoff => ({ ...handoff, card: this.card(handoff.cardId) }));
    return {
      room, colleagues,
      projects: room.projects.map(project => ({ ...project, name: this.boardName(project.boardId) })),
      messages: this.store.listMessages(roomId), rounds, live, handoffs, saves: this.store.listSaves(roomId), running: !!this.store.runningRound(roomId),
    };
  }
  private card(cardId: string) { const card = this.board.getCard(cardId); return card ? { id: card.id, title: card.title, status: card.status, repo: card.repo } : null; }

  // ── messages and the queue ──
  /** Which colleagues answer a message: Ask everyone reaches all, mentions replace the lead, otherwise the lead. */
  route(room: Room, message: Pick<RoomMessage, "body" | "ask">): Colleague[] {
    const participants = room.participantIds.map(id => this.store.getColleague(id)!).filter(colleague => colleague && !colleague.archived);
    if (message.ask === "everyone") return participants;
    const mentioned = participants.filter(colleague => new RegExp(`(^|[^\\w])@${escapeRegExp(colleague.name)}(?![\\w])`, "i").test(message.body));
    if (mentioned.length) return mentioned;
    const lead = participants.find(colleague => colleague.id === room.leadId);
    return lead ? [lead] : participants.slice(0, 1);
  }

  send(roomId: string, input: Record<string, any>): RoomMessage {
    const room = this.store.getRoom(roomId);
    if (!room || room.archived) throw new Error("Room not found");
    if (typeof input.body !== "string" || !input.body.trim() || input.body.length > limits.messageChars) throw new Error(`Write a message of up to ${limits.messageChars} characters`);
    if (input.ask !== undefined && input.ask !== "normal" && input.ask !== "everyone") throw new Error("ask must be normal or everyone");
    if (input.ask === "everyone" && room.kind === "direct") throw new Error("Ask everyone needs a group room");
    const busy = !!this.store.runningRound(roomId) || room.paused || this.store.listQueue(roomId).length > 0;
    const message = this.store.addMessage(roomId, { kind: "user", body: input.body.trim(), ask: input.ask === "everyone" ? "everyone" : "normal", queued: busy });
    if (!busy) this.startRound(room, message);
    this.emit(roomId);
    return message;
  }
  editQueued(roomId: string, messageId: string, body: unknown): RoomMessage {
    this.ownMessage(roomId, messageId);
    if (typeof body !== "string" || !body.trim() || body.length > limits.messageChars) throw new Error(`Write a message of up to ${limits.messageChars} characters`);
    const message = this.store.editQueued(messageId, body.trim());
    this.emit(roomId);
    return message;
  }
  removeQueued(roomId: string, messageId: string) { this.ownMessage(roomId, messageId); this.store.removeQueued(messageId); this.emit(roomId); }
  private ownMessage(roomId: string, messageId: string): RoomMessage {
    const message = this.store.getMessage(messageId);
    if (!message || message.roomId !== roomId) throw new Error("Message not found");
    if (message.state !== "queued") throw new Conflict("That message is no longer queued");
    return message;
  }

  /** Stop cancels everything pending in the running round and pauses the queue. */
  stop(roomId: string) {
    if (!this.store.getRoom(roomId)) throw new Error("Room not found");
    const round = this.store.runningRound(roomId);
    if (round) this.cancelRound(round, "Stopped by the operator");
    this.store.setPaused(roomId, true);
    this.emit(roomId);
  }
  resume(roomId: string) {
    if (!this.store.getRoom(roomId)) throw new Error("Room not found");
    this.store.setPaused(roomId, false);
    this.drain(roomId);
    this.emit(roomId);
  }
  /** Promotes one queued message: cancels the old round (keeping what it already said), runs the message now, then the rest of the queue resumes in its own order. */
  steer(roomId: string, messageId: string) {
    const room = this.store.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    this.ownMessage(roomId, messageId);
    const round = this.store.runningRound(roomId);
    if (round) this.cancelRound(round, "Steered: a queued message was promoted");
    this.store.setPaused(roomId, false);
    const delivered = this.store.deliver(messageId);
    if (!delivered) throw new Conflict("That message is no longer queued");
    this.startRound(this.store.getRoom(roomId)!, delivered);
    this.emit(roomId);
  }
  private drain(roomId: string) {
    const room = this.store.getRoom(roomId);
    if (!room || room.paused || this.store.runningRound(roomId)) return;
    const next = this.store.listQueue(roomId)[0];
    if (!next) return;
    const delivered = this.store.deliver(next.id);
    if (delivered) this.startRound(room, delivered);
  }

  // ── rounds ──
  private startRound(room: Room, trigger: RoomMessage) {
    const round = this.store.createRound(room.id, trigger.ask === "everyone" ? "everyone" : "message", trigger.id, trigger.seq!);
    void this.runMessageRound(room, round, trigger).catch(error => this.failRound(round, error));
  }
  private failRound(round: Round, error: unknown) {
    if (this.store.getRound(round.id)?.status !== "running") return;
    this.store.updateRound(round.id, { status: "failed", note: error instanceof Error ? error.message : String(error) });
    this.store.addMessage(round.roomId, { kind: "error", body: `The round failed: ${error instanceof Error ? error.message : String(error)}`, roundId: round.id });
    this.emit(round.roomId); this.drain(round.roomId);
  }
  private endRound(round: Round, status: "done" | "failed" = "done") {
    if (this.store.getRound(round.id)?.status !== "running") return;
    this.store.updateRound(round.id, { status });
    this.emit(round.roomId); this.drain(round.roomId);
  }
  private isCancelled(round: Round) { return this.cancelled.has(round.id) || this.store.getRound(round.id)?.status !== "running"; }

  private cancelRound(round: Round, reason: string) {
    this.cancelled.add(round.id);
    for (const run of this.store.listRuns(round.id)) {
      if (run.status !== "running") continue;
      const active = this.active.get(run.id);
      const partial = active ? replyText(active.parts) : "";
      // Settle first: anything the child still prints is fenced out by the status check.
      this.store.finishRun(run.id, "cancelled", { error: reason });
      if (partial && run.role !== "screen") this.store.addMessage(run.roomId, { kind: "colleague", colleagueId: run.colleagueId, body: partial, roundId: round.id, runId: run.id, role: run.role, interrupted: true });
      if (active) { this.kill(active.child); this.active.delete(run.id); }
    }
    this.store.updateRound(round.id, { status: "stopped", note: reason });
    this.emit(round.roomId);
  }
  private kill(child: ChildProcess) {
    try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* Already gone. */ } }
  }

  private async runMessageRound(room: Room, round: Round, trigger: RoomMessage) {
    const targets = this.route(room, trigger);
    const context = await this.retrieveMemory(room, round, trigger.body);
    if (this.isCancelled(round)) return;
    await Promise.all(targets.map(colleague => this.respond(room, round, colleague, "primary", trigger, context, round.snapshotSeq)));
    if (this.isCancelled(round)) return;
    // Interjections: only for ordinary rounds in group rooms that did not opt into quiet mode.
    if (round.kind === "message" && room.kind === "group" && room.mode === "lead") await this.interject(room, round, trigger, targets, context);
    if (this.isCancelled(round)) return;
    this.endRound(round);
  }

  private async interject(room: Room, round: Round, trigger: RoomMessage, answered: Colleague[], context: RoundContext) {
    const snapshotSeq = this.store.maxSeq(room.id);
    const candidates = room.participantIds.filter(id => !answered.some(colleague => colleague.id === id)).slice(0, limits.screened).map(id => this.store.getColleague(id)!);
    const screens = await Promise.all(candidates.map(async colleague => {
      const outcome = await this.execute(room, round, colleague, "screen", this.screenPrompt(room, colleague, snapshotSeq), "You decide whether a colleague should speak. Answer with JSON only.", context, snapshotSeq);
      return { colleague, speak: outcome.ok && /"interject"\s*:\s*true/i.test(outcome.text) };
    }));
    if (this.isCancelled(round)) return;
    const chosen = screens.filter(screen => screen.speak).slice(0, limits.interjections);
    this.store.updateRound(round.id, { interjections: chosen.length });
    await Promise.all(chosen.map(screen => this.respond(room, round, screen.colleague, "interjection", trigger, context, snapshotSeq)));
  }

  private screenPrompt(room: Room, colleague: Colleague, snapshotSeq: number): string {
    return `${this.transcriptText(room, snapshotSeq)}\n\nYou are screening for ${colleague.name} (${colleague.specialty || "no stated specialty"}). The replies above were already given. Should ${colleague.name} add an unsolicited interjection? Only say yes for a material correction, a dependency, a risk or a blocker that nobody mentioned. Otherwise say no. Reply with exactly one JSON object: {"interject": true|false}`;
  }

  /** One colleague's reply. Returns nothing: the message, error and cost are recorded on the room. */
  private async respond(room: Room, round: Round, colleague: Colleague, role: RunRole, trigger: RoomMessage, context: RoundContext, snapshotSeq: number, supersedes?: string) {
    const prompt = this.replyPrompt(room, colleague, role, trigger, context, snapshotSeq, round.kind);
    const outcome = await this.execute(room, round, colleague, role, prompt, this.systemPrompt(room, colleague), context, snapshotSeq, supersedes);
    if (!outcome.ok && !outcome.fenced && outcome.run) this.store.addMessage(room.id, { kind: "error", colleagueId: colleague.id, body: `${colleague.name} could not reply: ${outcome.error}`, roundId: round.id, runId: outcome.run.id, role });
    this.emit(room.id);
  }

  // ── Pi ──
  private settings(room: Room, colleague: Colleague, role: RunRole) {
    const choice: AgentModel = role === "screen" ? this.screenModel() : { model: colleague.model || defaultChatModel.model, thinking: colleague.thinking || defaultChatModel.thinking };
    const exec = role === "screen" ? null : room.executionBoardId ? this.board.getBoard(room.executionBoardId) ?? null : null;
    const cwd = exec ? exec.repo : join(this.options.dataDir, "rooms", "scratch");
    if (!exec) mkdirSync(cwd, { recursive: true });
    return { choice, exec, cwd, tools: exec ? "read-only" as const : "none" as const };
  }

  /** Runs Pi once with an inspectable configuration snapshot. Output is recorded only if the run is still running when it ends. */
  private async execute(room: Room, round: Round, colleague: Colleague, role: RunRole, prompt: string, system: string, context: RoundContext, snapshotSeq: number, supersedes?: string, facts?: unknown): Promise<Outcome> {
    if (this.isCancelled(round)) return { ok: false, run: null, fenced: true, error: "cancelled" };
    const { choice, exec, cwd, tools } = this.settings(room, colleague, role);
    // Pi starts with no extensions, MCP, skills or context files, so no other memory system or project instructions leak in. Filesystem access is read-only and only in the one chosen execution project.
    const args = ["--mode", "json", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", ...(tools === "none" ? ["--no-tools"] : ["--tools", readOnlyTools]), ...piModelArgs(choice), "--append-system-prompt", system];
    const config = {
      model: choice.model, thinking: choice.thinking, tools, cwd, snapshotSeq, executionBoardId: exec?.id ?? null, mode: room.mode, lead: this.store.getColleague(room.leadId)?.name ?? "",
      identity: role === "screen" ? null : { name: colleague.name, specialty: colleague.specialty, instructions: colleague.instructions },
      contextProjects: room.projects.map(project => ({ boardId: project.boardId, name: this.boardName(project.boardId) })),
      memory: role === "screen" ? null : context.memory && { status: context.memory.status, ids: context.memory.items.map(item => item.id) },
      piArgs: args.filter(arg => arg !== prompt && arg !== system),
    };
    const run = this.store.createRun({ roundId: round.id, roomId: room.id, colleagueId: colleague.id, role, config, facts });
    if (supersedes) this.store.supersede(supersedes, run.id);
    this.emit(room.id);
    const timeout = role === "screen" ? this.options.screenTimeoutMs ?? 60_000 : this.options.runTimeoutMs ?? 300_000;
    const parts: ChatPart[] = [];
    let usage = { cost: 0, inputTokens: 0, outputTokens: 0 }, settled = false, stop: { stopReason?: string; errorMessage?: string } | undefined, stderr = "", buffer = "", timedOut = false;
    const result = await new Promise<{ error: string | null }>(resolve => {
      let child: ChildProcess;
      try { child = spawn(...command(this.options.piBin, [...args, "--", prompt]), { cwd, env: this.options.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" }); }
      catch (error) { resolve({ error: `Pi could not start: ${error instanceof Error ? error.message : String(error)}` }); return; }
      this.active.set(run.id, { child, parts });
      const timer = setTimeout(() => { timedOut = true; this.kill(child); }, timeout);
      let flush: ReturnType<typeof setTimeout> | undefined;
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "agent_settled") settled = event.aborted !== true;
          if (event.type === "message_end") { const used = messageUsage(event.message); if (used) usage = { cost: usage.cost + used.cost, inputTokens: usage.inputTokens + used.inputTokens, outputTokens: usage.outputTokens + used.outputTokens }; }
          stop = applyPiEvent(parts, event) ?? stop;
          flush ??= setTimeout(() => { flush = undefined; this.emit(room.id); }, 120);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000); });
      child.once("error", error => { clearTimeout(timer); resolve({ error: `Pi could not start: ${error.message}` }); });
      child.once("close", code => {
        clearTimeout(timer); clearTimeout(flush);
        if (timedOut) return resolve({ error: `Timed out after ${Math.round(timeout / 1000)}s` });
        if (code !== 0) return resolve({ error: `Pi failed (${code})${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}` });
        if (!settled) return resolve({ error: "Pi ended without finishing its reply" });
        if (stop?.stopReason !== "stop") return resolve({ error: `Pi stopped early (${stop?.stopReason ?? "no reply"})${stop?.errorMessage ? `: ${stop.errorMessage.slice(0, 500)}` : ""}` });
        resolve({ error: null });
      });
    });
    this.active.delete(run.id);
    // Fence: a cancelled run's late output is dropped.
    if (this.store.getRun(run.id)?.status !== "running") return { ok: false, run: this.store.getRun(run.id)!, fenced: true, error: "cancelled" };
    const text = replyText(parts);
    if (result.error === null && !text) result.error = "Pi replied with no text";
    if (result.error !== null) {
      this.store.finishRun(run.id, "failed", { error: result.error, ...usage });
      return { ok: false, run: this.store.getRun(run.id)!, fenced: false, error: result.error };
    }
    const message = role === "screen" ? null : this.store.addMessage(room.id, { kind: "colleague", colleagueId: colleague.id, body: text, roundId: round.id, runId: run.id, role });
    this.store.finishRun(run.id, "done", { messageId: message?.id ?? null, ...usage });
    this.emit(room.id);
    return { ok: true, text, run: this.store.getRun(run.id)! };
  }

  private systemPrompt(room: Room, colleague: Colleague): string {
    const names = room.participantIds.map(id => this.store.getColleague(id)).filter((c): c is Colleague => !!c).map(c => `${c.name}${c.specialty ? ` (${c.specialty})` : ""}`);
    return [
      `You are ${colleague.name}${colleague.specialty ? `, ${colleague.specialty}` : ""}, a persistent colleague in a Bakery room called "${room.title}". Speak as yourself, briefly and concretely.`,
      colleague.instructions ? `Your standing instructions: ${colleague.instructions}` : "",
      names.length > 1 ? `Also in the room: ${names.filter(name => !name.startsWith(colleague.name)).join(", ")}.` : "",
      "You cannot create cards, change code or start work from here. A casual suggestion of yours is not authorization; ask the operator to hand work off.",
    ].filter(Boolean).join("\n");
  }

  private transcriptText(room: Room, uptoSeq: number): string {
    const lines = this.store.transcript(room.id, uptoSeq).filter(message => message.kind === "user" || message.kind === "colleague").map(message => {
      const who = message.kind === "user" ? "Operator" : this.store.getColleague(message.colleagueId ?? "")?.name ?? "Colleague";
      return `${who}${message.interrupted ? " (interrupted, partial)" : ""}: ${message.body}`;
    }).slice(-limits.transcriptMessages);
    let text = lines.join("\n\n");
    if (text.length > limits.transcriptChars) text = `…${text.slice(-limits.transcriptChars)}`;
    return `Conversation so far:\n${text}`;
  }

  private replyPrompt(room: Room, colleague: Colleague, role: RunRole, trigger: RoomMessage, context: RoundContext, snapshotSeq: number, kind: Round["kind"]): string {
    const projects = room.projects.map(project => this.boardName(project.boardId));
    const exec = room.executionBoardId ? this.boardName(room.executionBoardId) : null;
    const memory = context.memory?.items.length ? `Relevant memories from Impression (may be stale; cite ids if used):\n${context.memory.items.map(item => `- [${item.id}] ${item.stale ? "(stale) " : ""}${item.content}`).join("\n")}\n\n` : "";
    const instruction = role === "interjection" ? `Others have already replied. Add one short interjection only about a material correction, dependency, risk or blocker.`
      : kind === "everyone" ? `Answer the latest operator message independently. You cannot see anyone else's answer.`
      : `Reply to the latest operator message as ${colleague.name}.`;
    return `${projects.length ? `Context projects: ${projects.join(", ")}.` : "No project context is attached."} ${exec ? `You may read files read-only in the execution project ${exec}.` : "You have no tools and no filesystem access."}\n\n${memory}${this.transcriptText(room, snapshotSeq)}\n\n${instruction}`;
  }

  // ── memory ──
  private async retrieveMemory(room: Room, round: Round, query: string): Promise<RoundContext> {
    const targets: ({ scope: "user" } | { scope: "project"; project: string; boardId: string })[] = [];
    if (room.useUserMemory) targets.push({ scope: "user" });
    for (const project of room.projects) { const found = project.memory ? this.board.getBoard(project.boardId) : undefined; if (found) targets.push({ scope: "project", project: memoryProject(found.repo).key, boardId: project.boardId }); }
    if (!targets.length) { const context: RoundContext = { memory: { status: "off", error: "", searches: [], items: [] } }; this.store.updateRound(round.id, { context }); return context; }
    const config = this.options.impression();
    const settled = await Promise.allSettled(targets.map(target => searchMemories(config, query, target, limits.memoryPerSearch)));
    const searches: NonNullable<RoundContext["memory"]>["searches"] = [];
    const items: MemoryUse[] = [];
    let degraded = false, failures = 0, lastError = "";
    settled.forEach((result, index) => {
      const target = targets[index], project = target.scope === "project" ? target.project : null;
      if (result.status === "fulfilled") { degraded ||= result.value.degraded; items.push(...result.value.memories); searches.push({ scope: target.scope, project, query: query.slice(0, 200), count: result.value.memories.length, error: "" }); }
      else { failures++; lastError = result.reason instanceof Error ? result.reason.message : String(result.reason); searches.push({ scope: target.scope, project, query: query.slice(0, 200), count: 0, error: lastError }); }
    });
    const status = failures === targets.length ? "unavailable" : failures || degraded ? "degraded" : "used";
    const context: RoundContext = { memory: { status, error: lastError, searches, items: items.slice(0, 12) } };
    this.store.updateRound(round.id, { context });
    if (status !== "used") this.store.addMessage(room.id, { kind: "system", roundId: round.id, body: status === "unavailable" ? `Memory is unavailable (${lastError}). Replying without Impression memory.` : `Memory is degraded${lastError ? ` (${lastError})` : ""}. Replies may be missing some context.` });
    return context;
  }

  /** Explicit Remember. Saved only once Impression confirms; a failure stays visible as unsaved and can be retried. */
  async remember(roomId: string, input: Record<string, any>): Promise<MemorySave> {
    const room = this.store.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    const message = typeof input.messageId === "string" ? this.store.getMessage(input.messageId) : undefined;
    if (!message || message.roomId !== roomId || !["delivered", "final"].includes(message.state) || message.kind === "system") throw new Error("Choose a message from this room to remember");
    if (input.scope !== "user" && input.scope !== "project") throw new Error("scope must be user or project");
    let project = { key: "", name: "" };
    if (input.scope === "project") {
      const found = typeof input.boardId === "string" && room.projects.some(item => item.boardId === input.boardId) ? this.board.getBoard(input.boardId) : undefined;
      if (!found) throw new Error("Pick one of this room's context projects for a project memory");
      project = memoryProject(found.repo);
    }
    const text = typeof input.content === "string" && input.content.trim() ? input.content.trim() : message.body;
    if (text.length > 4000) throw new Error("A memory is limited to 4000 characters");
    const who = message.kind === "user" ? "the operator" : this.store.getColleague(message.colleagueId ?? "")?.name ?? "a colleague";
    const content = `${text}\n\nSource: Bakery room "${room.title}" (${room.id}), message ${message.id} by ${who}, ${message.createdAt}`;
    const existing = this.store.findSave(roomId, message.id, input.scope, project.key);
    if (existing?.status === "saved") return existing;
    const save = existing ?? this.store.addSave({ roomId, messageId: message.id, scope: input.scope, projectKey: project.key, projectName: project.name, content });
    return this.attemptSave(save);
  }
  async retrySave(roomId: string, saveId: string): Promise<MemorySave> {
    const save = this.store.getSave(saveId);
    if (!save || save.roomId !== roomId) throw new Error("Memory save not found");
    if (save.status === "saved") return save;
    return this.attemptSave(save);
  }
  private async attemptSave(save: MemorySave): Promise<MemorySave> {
    try {
      const saved = await saveMemory(this.options.impression(), { scope: save.scope, project: save.scope === "project" ? { key: save.projectKey, name: save.projectName } : undefined, content: save.content });
      this.store.settleSave(save.id, { memoryId: saved.id, outcome: saved.outcome });
    } catch (error) { this.store.settleSave(save.id, { error: error instanceof Error ? error.message : String(error) }); }
    this.emit(save.roomId);
    return this.store.getSave(save.id)!;
  }

  // ── retry ──
  /** Reruns one failed or interrupted reply against its original snapshot. Retrying twice is refused. */
  async retry(roomId: string, runId: string): Promise<RunRecord> {
    const room = this.store.getRoom(roomId), run = this.store.getRun(runId);
    if (!room || !run || run.roomId !== roomId) throw new Error("Run not found");
    if (run.supersededBy) throw new Conflict("That reply was already retried");
    if (run.status !== "failed" && run.status !== "interrupted") throw new Conflict("Only failed or interrupted replies can be retried");
    if (this.store.runningRound(roomId)) throw new Conflict("Wait for the running round, or stop it, before retrying");
    const colleague = this.store.getColleague(run.colleagueId);
    if (!colleague || colleague.archived) throw new Conflict("That colleague is archived");
    if (run.role === "interjection" || run.role === "screen") throw new Conflict("Unsolicited interjections and screening are not retried");
    const round = this.store.getRound(run.roundId)!;
    const trigger = run.role === "primary" ? this.store.getMessage(round.triggerMessageId ?? "") : undefined;
    if (run.role === "primary" && !trigger) throw new Error("The original message is gone");
    this.cancelled.delete(round.id);
    this.store.updateRound(round.id, { status: "running", note: "" });
    const work = run.role === "primary" ? this.respond(room, round, colleague, "primary", trigger!, round.context, round.snapshotSeq, run.id)
      : run.role === "standup-report" ? this.standupReport(room, round, colleague, this.store.standupCutoff(round.id)!, run.id)
      : this.standupSummary(room, round, run.id);
    void work.catch(error => this.failRound(round, error)).then(() => this.endRound(round));
    this.emit(roomId);
    return run;
  }

  // ── standup ──
  standup(roomId: string): Round {
    const room = this.store.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    if (this.store.runningRound(roomId)) throw new Conflict("A round is running; stop it or wait before starting a standup");
    const cutoff = this.store.lastStandupAt(roomId) ?? new Date(Date.now() - limits.standupWindowMs).toISOString();
    const round = this.store.createRound(roomId, "standup", null, this.store.maxSeq(roomId));
    this.store.addStandup(roomId, round.id, cutoff);
    this.store.addMessage(roomId, { kind: "system", roundId: round.id, body: `Standup started. Window: activity since ${cutoff}.` });
    void (async () => {
      const participants = room.participantIds.map(id => this.store.getColleague(id)!);
      await Promise.all(participants.map(colleague => this.standupReport(room, round, colleague, cutoff)));
      if (!this.isCancelled(round)) await this.standupSummary(room, round);
    })().catch(error => this.failRound(round, error)).then(() => this.endRound(round));
    this.emit(roomId);
    return round;
  }

  private factsFor(room: Room, colleague: Colleague, cutoff: string): Facts {
    const facts: Facts = { completed: [], active: [], blockers: [], proposed: [] };
    for (const handoff of this.store.listHandoffs(room.id).filter(item => item.assigneeId === colleague.id)) {
      const card = this.board.getCard(handoff.cardId);
      if (!card) continue;
      const runs = this.board.listRuns(card.id).filter(run => run.startedAt >= cutoff || (run.finishedAt ?? "") >= cutoff).map(run => ({ id: run.id, attempt: run.attempt, status: run.status, finishedAt: run.finishedAt }));
      const events = this.board.listCardEvents(card.id).filter(event => event.at >= cutoff);
      const base = { cardId: card.id, title: card.title, status: card.status, runs };
      if (card.status === "failed" || card.status === "interrupted" || card.blocked) facts.blockers.push({ ...base, note: card.blocked ? "Blocked by a dependency" : `Latest run ${card.status}` });
      else if (card.status === "done" && events.some(event => event.toStatus === "done")) facts.completed.push({ ...base, note: "Done in this window" });
      else if (card.status === "review" && runs.some(run => run.status === "review" && (run.finishedAt ?? "") >= cutoff)) facts.completed.push({ ...base, note: card.reviewWait ? `Run finished; waiting on ${card.reviewWait}` : "Run finished; waiting on you to review" });
      else if (card.status === "running" || card.status === "ready" || card.status === "review") facts.active.push({ ...base, note: card.status === "review" ? "In review" : card.status === "ready" ? "Queued" : "Running" });
      else if (card.status === "triage") facts.proposed.push({ ...base, note: "Proposed; not started" });
    }
    return facts;
  }

  private async standupReport(room: Room, round: Round, colleague: Colleague, cutoff: string, supersedes?: string) {
    const facts = this.factsFor(room, colleague, cutoff);
    const any = facts.completed.length + facts.active.length + facts.blockers.length + facts.proposed.length > 0;
    if (!any) {
      // Nothing to ground a report in: say so without a paid call.
      const run = this.store.createRun({ roundId: round.id, roomId: room.id, colleagueId: colleague.id, role: "standup-report", config: { model: null, tools: "none", note: "No linked cards had activity; no model call was made", cutoff }, facts });
      if (supersedes) this.store.supersede(supersedes, run.id);
      const message = this.store.addMessage(room.id, { kind: "colleague", colleagueId: colleague.id, body: "No activity in this window.", roundId: round.id, runId: run.id, role: "standup-report" });
      this.store.finishRun(run.id, "done", { messageId: message.id });
      this.emit(room.id);
      return;
    }
    const snapshotSeq = round.snapshotSeq;
    const prompt = `Standup window: since ${cutoff}.\nFacts about your linked cards and runs (the only source of truth; do not invent others):\n${JSON.stringify(facts, null, 1)}\n\nWrite your standup report in four short sections: Completed, Active, Blockers, Proposed. Use only these facts and cite card ids. Do not create work, propose debates or ask others to act.`;
    const outcome = await this.execute(room, round, colleague, "standup-report", prompt, this.systemPrompt(room, colleague), { memory: null }, snapshotSeq, supersedes, facts);
    if (!outcome.ok && !outcome.fenced && outcome.run) this.store.addMessage(room.id, { kind: "error", colleagueId: colleague.id, body: `${colleague.name}'s standup report failed: ${outcome.error}`, roundId: round.id, runId: outcome.run.id, role: "standup-report" });
    this.emit(room.id);
  }

  private async standupSummary(room: Room, round: Round, supersedes?: string) {
    const lead = this.store.getColleague(room.leadId)!;
    const reports = this.store.listRuns(round.id).filter(run => run.role === "standup-report" && !run.supersededBy);
    const lines = reports.map(run => {
      const name = this.store.getColleague(run.colleagueId)?.name ?? "Colleague";
      const message = run.messageId ? this.store.getMessage(run.messageId) : undefined;
      return run.status === "done" && message ? `## ${name}\n${message.body}` : `## ${name}\n(report missing: ${run.status}${run.error ? ` - ${run.error}` : ""})`;
    });
    const missing = reports.filter(run => run.status !== "done").length;
    const prompt = `You are the lead. Summarize these standup reports into one short summary with Completed, Active, Blockers and Proposed. ${missing ? `${missing} of ${reports.length} reports are missing: say plainly that the summary is partial and name who is missing. ` : ""}Use only the reports. Do not create work or start a discussion.\n\n${lines.join("\n\n")}`;
    const outcome = await this.execute(room, round, lead, "standup-summary", prompt, this.systemPrompt(room, lead), { memory: null }, round.snapshotSeq, supersedes);
    if (!outcome.ok && !outcome.fenced && outcome.run) this.store.addMessage(room.id, { kind: "error", colleagueId: lead.id, body: `The standup summary failed: ${outcome.error}`, roundId: round.id, runId: outcome.run.id, role: "standup-summary" });
    this.emit(room.id);
  }

  // ── handoffs ──
  async handoff(roomId: string, input: Record<string, unknown>): Promise<{ handoff: Handoff; card: Card; created: boolean; paid: boolean }> {
    const room = this.store.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    const key = input.idempotencyKey;
    if (typeof key !== "string" || !key.trim() || key.length > 100) throw new Error("idempotencyKey is required (1 to 100 characters)");
    const existing = this.store.getHandoffByKey(roomId, key);
    if (existing) { const card = this.board.getCard(existing.cardId); if (card) return { handoff: existing, card, created: false, paid: false }; }
    const boardId = typeof input.boardId === "string" ? input.boardId : "";
    const target = this.board.getBoard(boardId);
    if (!target) throw new Error("Choose a target board");
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title || title.length > 120) throw new Error("Give the card a title of up to 120 characters");
    const requirements = typeof input.requirements === "string" ? input.requirements.trim() : "";
    if (requirements.length < 10) throw new NeedsClarification("The scope is unresolved. State the essential requirements, or ask the room to clarify, before creating a card.");
    const sources = input.sourceMessageIds === undefined ? [] : input.sourceMessageIds;
    if (!Array.isArray(sources) || sources.length > 20) throw new Error("sourceMessageIds must list up to 20 messages");
    const decisions = sources.map(id => { const message = typeof id === "string" ? this.store.getMessage(id) : undefined; if (!message || message.roomId !== roomId || !["delivered", "final"].includes(message.state) || (message.kind !== "user" && message.kind !== "colleague")) throw new Error("Source decisions must be messages from this room"); return message; });
    const assigneeId = typeof input.assigneeId === "string" && input.assigneeId ? input.assigneeId : null;
    const assignee = assigneeId ? this.store.getColleague(assigneeId) : undefined;
    if (assigneeId && (!assignee || assignee.archived)) throw new Error("Assignee must be an active colleague");
    const policy = this.store.newCardPolicy(boardId);
    const requested = input.creation === undefined ? (policy === "ready" ? "ready" : "triage") : input.creation;
    if (requested !== "triage" && requested !== "ready" && requested !== "queue") throw new Error("creation must be triage, ready or queue");
    if (requested === "queue" && !target.autoPickupEnabled) throw new Conflict("This board has auto-pickup off, so nothing would start the card. Create it in Ready or Triage.");
    // A Ready card on a board with auto-pickup is picked up and spends money: the operator must confirm.
    const paid = requested !== "triage" && target.autoPickupEnabled;
    if (paid && input.confirmPaid !== true) throw new Conflict("Creating this card in Ready starts a paid agent run through auto-pickup. Confirm the paid run (confirmPaid) or create it in Triage.");
    const who = (message: RoomMessage) => message.kind === "user" ? "Operator" : this.store.getColleague(message.colleagueId ?? "")?.name ?? "Colleague";
    const body = [
      requirements,
      decisions.length ? `## Decisions from the room\n${decisions.map(message => `> **${who(message)}:** ${message.body.replace(/\n/g, "\n> ")}`).join("\n\n")}` : "",
      assignee ? `## Assignee\n${assignee.name}${assignee.specialty ? ` (${assignee.specialty})` : ""}${assignee.instructions ? `\n\nGuidance: ${assignee.instructions}` : ""}` : "",
      `## Source\nBakery room "${room.title}" (${room.id})${decisions.length ? `, messages ${decisions.map(message => message.id).join(", ")}` : ""}`,
    ].filter(Boolean).join("\n\n");
    const workModel = this.board.agentModelFor(target.repo, "work");
    const config = { board: target.repo, workModel, assignee: assignee ? { id: assignee.id, name: assignee.name, model: assignee.model, thinking: assignee.thinking } : null, note: "The card runs with the board's work model; the assignee's own model is not applied to card runs", creation: requested, paid, policy };
    let handoff!: Handoff;
    const card = this.board.createCard({
      title, body, repo: target.repo, idempotencyKey: `room-handoff:${roomId}:${key}`, origin: "ui",
      ready: requested === "triage" ? undefined : `Handed off from room "${room.title}"${requested === "queue" ? " and queued for work" : ""}`,
      inTransaction: created => { handoff = this.store.addHandoff({ roomId, cardId: created.id, boardId, assigneeId, idempotencyKey: key, creation: requested, sourceMessageIds: decisions.map(message => message.id), requirements, config, lastStatus: requested === "triage" ? "triage" : "ready" }); },
    });
    if (!handoff) handoff = this.store.getHandoffByKey(roomId, key) ?? this.store.addHandoff({ roomId, cardId: card.id, boardId, assigneeId, idempotencyKey: key, creation: requested, sourceMessageIds: decisions.map(message => message.id), requirements, config });
    this.store.addMessage(roomId, { kind: "system", body: `Created card ${card.id} "${title}" on ${this.boardName(boardId)} in ${card.status}${assignee ? `, assigned to ${assignee.name}` : ""}.` });
    this.emit(roomId);
    return { handoff, card, created: true, paid };
  }

  /** Posts a compact system entry back to the source room when a linked card needs attention. Never starts a round. */
  syncHandoffs() {
    for (const handoff of this.store.listHandoffs()) {
      const card = this.board.getCard(handoff.cardId);
      const status = card ? card.status : "deleted";
      if (status === handoff.lastStatus) continue;
      this.store.setHandoffStatus(handoff.id, status);
      const label = status === "review" ? (card?.reviewWait ? `in review, waiting on ${card.reviewWait}` : "ready for your review")
        : status === "failed" || status === "interrupted" ? `needs input: the run ${status}` : status === "done" ? "done" : status === "deleted" ? "deleted" : null;
      if (label && this.store.getRoom(handoff.roomId)) { this.store.addMessage(handoff.roomId, { kind: "system", body: `Card ${handoff.cardId} "${card?.title ?? ""}" is ${label}.` }); this.emit(handoff.roomId); }
    }
  }
}
