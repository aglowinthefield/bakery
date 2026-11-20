import type { IncomingMessage, ServerResponse } from "node:http";
import { Conflict, NeedsClarification, type Rooms } from "./rooms.js";
import type { Board } from "./board.js";
import { impressionConfig } from "./impression.js";

type Send = (res: ServerResponse, status: number, payload: unknown) => void;

/** Colleague, room, standup, handoff and memory routes. Returns true when the request was handled. */
export async function handleRoomRoute(rooms: Rooms, board: Board, req: IncomingMessage, res: ServerResponse, path: string, send: Send, readBody: (req: IncomingMessage) => Promise<Record<string, any>>): Promise<boolean> {
  const method = req.method ?? "GET";
  try {
    if (path === "/api/colleagues") {
      if (method === "GET") { send(res, 200, rooms.store.listColleagues(new URL(req.url ?? "/", "http://localhost").searchParams.get("archived") === "1")); return true; }
      if (method === "POST") { send(res, 201, rooms.saveColleague(null, await readBody(req))); return true; }
    }
    const colleague = path.match(/^\/api\/colleagues\/([\w-]+)$/);
    if (colleague) {
      if (method === "PATCH") { send(res, 200, rooms.saveColleague(colleague[1], await readBody(req))); return true; }
      if (method === "DELETE") { send(res, 200, rooms.store.archiveColleague(colleague[1])); return true; }
      if (method === "GET") { const found = rooms.store.getColleague(colleague[1]); send(res, found ? 200 : 404, found ?? { error: "Colleague not found" }); return true; }
    }
    const policy = path.match(/^\/api\/boards\/([\w-]+)\/new-card-policy$/);
    if (policy) {
      if (!board.getBoard(policy[1])) { send(res, 404, { error: "Board not found" }); return true; }
      if (method === "GET") { send(res, 200, { policy: rooms.store.newCardPolicy(policy[1]) }); return true; }
      if (method === "PUT") { rooms.store.setNewCardPolicy(policy[1], (await readBody(req)).policy); send(res, 200, { policy: rooms.store.newCardPolicy(policy[1]) }); return true; }
    }
    if (path === "/api/rooms") {
      if (method === "GET") { send(res, 200, rooms.store.listRooms(new URL(req.url ?? "/", "http://localhost").searchParams.get("boardId") ?? undefined)); return true; }
      if (method === "POST") { send(res, 201, rooms.saveRoom(null, await readBody(req))); return true; }
    }
    const route = path.match(/^\/api\/rooms\/([\w-]+)(?:\/(messages|stop|resume|steer|standup|handoffs|remember|events|runs|context)(?:\/([\w-]+)(?:\/(retry))?)?)?$/);
    if (!route) return false;
    const [, roomId, action, extra, sub] = route;
    if (!rooms.store.getRoom(roomId)) { send(res, 404, { error: "Room not found" }); return true; }
    if (!action) {
      if (method === "GET") { send(res, 200, rooms.detail(roomId)); return true; }
      if (method === "PATCH") { rooms.saveRoom(roomId, await readBody(req)); send(res, 200, rooms.detail(roomId)); return true; }
      if (method === "DELETE") { rooms.store.db.prepare("UPDATE rooms SET archived=1 WHERE id=?").run(roomId); send(res, 200, { ok: true }); return true; }
    }
    if (action === "messages") {
      if (method === "POST" && !extra) { send(res, 202, rooms.send(roomId, await readBody(req))); return true; }
      if (method === "PATCH" && extra) { send(res, 200, rooms.editQueued(roomId, extra, (await readBody(req)).body)); return true; }
      if (method === "DELETE" && extra) { rooms.removeQueued(roomId, extra); send(res, 200, { ok: true }); return true; }
    }
    if (method === "POST" && action === "stop") { rooms.stop(roomId); send(res, 200, { ok: true }); return true; }
    if (method === "POST" && action === "resume") { rooms.resume(roomId); send(res, 200, { ok: true }); return true; }
    if (method === "POST" && action === "steer") { const { messageId } = await readBody(req); if (typeof messageId !== "string") throw new Error("messageId is required"); rooms.steer(roomId, messageId); send(res, 200, { ok: true }); return true; }
    if (method === "POST" && action === "standup") { send(res, 202, rooms.standup(roomId)); return true; }
    if (method === "POST" && action === "runs" && extra && sub === "retry") { send(res, 202, await rooms.retry(roomId, extra)); return true; }
    if (method === "POST" && action === "handoffs") {
      const result = await rooms.handoff(roomId, await readBody(req));
      send(res, result.created ? 201 : 200, result); return true;
    }
    if (method === "POST" && action === "remember" && !extra) { send(res, 200, await rooms.remember(roomId, await readBody(req))); return true; }
    if (method === "POST" && action === "remember" && extra && sub === "retry") { send(res, 200, await rooms.retrySave(roomId, extra)); return true; }
    if (method === "GET" && action === "context") {
      const target = rooms.store.getRun(extra ?? "");
      if (!target || target.roomId !== roomId) { send(res, 404, { error: "Run not found" }); return true; }
      const round = rooms.store.getRound(target.roundId)!;
      send(res, 200, { run: target, memory: round.context.memory, snapshotSeq: Number(target.config.snapshotSeq ?? round.snapshotSeq) }); return true;
    }
    if (method === "GET" && action === "events") {
      const write = () => res.write(`data: ${JSON.stringify({ type: "room" })}\n\n`);
      let pending: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = rooms.subscribe(roomId, () => { pending ??= setTimeout(() => { pending = undefined; if (!res.destroyed) write(); }, 100); });
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.once("close", () => { unsubscribe(); clearInterval(ping); clearTimeout(pending); });
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
      write(); return true;
    }
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (error instanceof NeedsClarification) send(res, 422, { code: "needs_clarification", error: message });
    else if (error instanceof Conflict) send(res, 409, { error: message, paid: /paid/i.test(message) });
    else send(res, /not found/i.test(message) ? 404 : 400, { error: message });
    return true;
  }
}

export { impressionConfig };
