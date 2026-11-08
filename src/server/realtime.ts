import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { sessionTokenFromRequest, userForSessionToken } from "./auth.ts";
import type { Config } from "./config.ts";
import type { DB, UserRow } from "./db.ts";
import type { HouseService } from "./houses.ts";
import { HttpError } from "./http.ts";
import { RateLimiter } from "./ratelimit.ts";
import { LIMITS, idPattern, jsonByteLength } from "./validate.ts";

/**
 * Realtime hub for the trusted shell. The shell holds the user's session; house code
 * never talks to this socket directly. It reaches it only through the shell's bridge,
 * which forwards a fixed set of ops scoped to the house being viewed.
 *
 * Every request is re-authorized against the database: a member removed from a house
 * loses access on their very next message, and is unsubscribed immediately.
 */

interface Conn {
  id: number;
  ws: WebSocket;
  user: UserRow;
  houses: Set<string>;
  alive: boolean;
}

const clientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), house: z.string().regex(idPattern) }),
  z.object({ t: z.literal("unsub"), house: z.string().regex(idPattern) }),
  z.object({
    t: z.literal("req"),
    id: z.number().int().nonnegative(),
    house: z.string().regex(idPattern),
    op: z.string().max(32),
    args: z.unknown().optional(),
  }),
]);

const channel = z.string().regex(LIMITS.channelPattern).default("main");
const stateKey = z.string().regex(LIMITS.stateKeyPattern);
const rev = z.number().int().nonnegative().optional();

const opSchemas = {
  "chat.send": z.object({ channel, body: z.string().trim().min(1).max(LIMITS.messageChars) }),
  "chat.list": z.object({
    channel,
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  "state.get": z.object({ key: stateKey }),
  "state.list": z.object({ prefix: z.string().max(128).default("") }),
  "state.set": z.object({ key: stateKey, value: z.unknown(), ifRev: rev }),
  "state.delete": z.object({ key: stateKey, ifRev: rev }),
  "events.emit": z.object({ name: z.string().regex(LIMITS.eventNamePattern), data: z.unknown().optional() }),
  "members.list": z.object({}).passthrough(),
} as const;

type Op = keyof typeof opSchemas;

export class Hub {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private rooms = new Map<string, Set<Conn>>();
  private conns = new Set<Conn>();
  private nextId = 1;
  private general = new RateLimiter(120, 40);
  private chat = new RateLimiter(10, 1);
  private events = new RateLimiter(60, 30);
  private heartbeat: NodeJS.Timeout;

  constructor(
    private readonly db: DB,
    private readonly houses: HouseService,
    private readonly cfg: Config,
  ) {
    houses.onEvent((houseId, name, data) => this.onHouseEvent(houseId, name, data));
    this.heartbeat = setInterval(() => this.ping(), 30_000);
    this.heartbeat.unref();
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Cross-site WebSocket hijacking defence: only the shell's own origin may connect.
    if (req.headers.origin !== this.cfg.platformOrigin) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const user = userForSessionToken(this.db, sessionTokenFromRequest(req));
    if (!user) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, user));
  }

  /** Users currently connected to a house. */
  online(houseId: string): string[] {
    const ids = new Set<string>();
    for (const c of this.rooms.get(houseId) ?? []) ids.add(c.user.id);
    return [...ids];
  }

  private accept(ws: WebSocket, user: UserRow): void {
    const conn: Conn = { id: this.nextId++, ws, user, houses: new Set(), alive: true };
    this.conns.add(conn);
    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return ws.close(1003, "text only");
      void this.onMessage(conn, raw.toString());
    });
    ws.on("close", () => {
      this.conns.delete(conn);
      for (const houseId of [...conn.houses]) this.leave(conn, houseId);
    });
    ws.on("error", () => ws.terminate());
  }

  private send(conn: Conn, msg: unknown): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private async onMessage(conn: Conn, raw: string): Promise<void> {
    if (!this.general.take(`c:${conn.id}`)) {
      this.send(conn, { t: "error", error: "Slow down" });
      return;
    }
    let parsed: z.infer<typeof clientMessage>;
    try {
      parsed = clientMessage.parse(JSON.parse(raw));
    } catch {
      this.send(conn, { t: "error", error: "Malformed message" });
      return;
    }
    if (parsed.t === "sub") {
      if (!this.houses.membership(parsed.house, conn.user.id)) {
        this.send(conn, { t: "suberror", house: parsed.house, error: "House not found" });
        return;
      }
      this.join(conn, parsed.house);
      this.send(conn, { t: "subbed", house: parsed.house, online: this.online(parsed.house) });
      return;
    }
    if (parsed.t === "unsub") {
      this.leave(conn, parsed.house);
      return;
    }
    try {
      const result = await this.handleOp(conn, parsed.house, parsed.op, parsed.args ?? {});
      this.send(conn, { t: "res", id: parsed.id, ok: true, result });
    } catch (err) {
      const message = err instanceof HttpError || err instanceof z.ZodError ? errorText(err) : "Something went wrong";
      if (!(err instanceof HttpError) && !(err instanceof z.ZodError)) console.error("[hub]", err);
      this.send(conn, { t: "res", id: parsed.id, ok: false, error: message });
    }
  }

  private async handleOp(conn: Conn, houseId: string, op: string, rawArgs: unknown): Promise<unknown> {
    if (!(op in opSchemas)) throw new HttpError(400, `Unknown op ${op}`);
    // Re-check membership on every request.
    if (!conn.houses.has(houseId) || !this.houses.membership(houseId, conn.user.id)) {
      throw new HttpError(404, "House not found");
    }
    const user = conn.user;
    switch (op as Op) {
      case "chat.send": {
        const a = opSchemas["chat.send"].parse(rawArgs);
        if (!this.chat.take(`${houseId}:${user.id}`)) throw new HttpError(429, "You're sending messages too fast");
        return this.houses.postMessage(houseId, user, a.channel, a.body);
      }
      case "chat.list": {
        const a = opSchemas["chat.list"].parse(rawArgs);
        return this.houses.listMessages(houseId, a.channel, a.before, a.limit);
      }
      case "state.get": {
        const a = opSchemas["state.get"].parse(rawArgs);
        return this.houses.getState(houseId, a.key);
      }
      case "state.list": {
        const a = opSchemas["state.list"].parse(rawArgs);
        return this.houses.listState(houseId, a.prefix);
      }
      case "state.set": {
        const a = opSchemas["state.set"].parse(rawArgs);
        return this.houses.setState(houseId, user, a.key, a.value, a.ifRev);
      }
      case "state.delete": {
        const a = opSchemas["state.delete"].parse(rawArgs);
        return { deleted: this.houses.deleteState(houseId, user, a.key, a.ifRev) };
      }
      case "events.emit": {
        const a = opSchemas["events.emit"].parse(rawArgs);
        if (jsonByteLength(a.data ?? null) > LIMITS.eventPayloadBytes) throw new HttpError(413, "Event payload too large");
        if (!this.events.take(`c:${conn.id}`)) throw new HttpError(429, "Too many events");
        const payload = { name: a.name, data: a.data ?? null, from: user.id, at: Date.now() };
        this.broadcast(houseId, { t: "ev", house: houseId, name: "event", data: payload }, conn);
        return { delivered: true };
      }
      case "members.list": {
        return { members: this.houses.members(houseId), online: this.online(houseId) };
      }
    }
  }

  private join(conn: Conn, houseId: string): void {
    if (conn.houses.has(houseId)) return;
    const before = this.online(houseId).includes(conn.user.id);
    conn.houses.add(houseId);
    let room = this.rooms.get(houseId);
    if (!room) this.rooms.set(houseId, (room = new Set()));
    room.add(conn);
    if (!before) this.broadcastPresence(houseId);
  }

  private leave(conn: Conn, houseId: string): void {
    if (!conn.houses.delete(houseId)) return;
    const room = this.rooms.get(houseId);
    room?.delete(conn);
    if (room && room.size === 0) this.rooms.delete(houseId);
    if (!this.online(houseId).includes(conn.user.id)) this.broadcastPresence(houseId);
  }

  private broadcastPresence(houseId: string): void {
    this.broadcast(houseId, { t: "ev", house: houseId, name: "presence", data: { online: this.online(houseId) } });
  }

  private broadcast(houseId: string, msg: unknown, except?: Conn): void {
    const text = JSON.stringify(msg);
    for (const c of this.rooms.get(houseId) ?? []) {
      if (c !== except && c.ws.readyState === WebSocket.OPEN) c.ws.send(text);
    }
  }

  private onHouseEvent(houseId: string, name: string, data: unknown): void {
    if (name === "member.removed") {
      const { userId } = data as { userId: string };
      for (const c of [...(this.rooms.get(houseId) ?? [])]) {
        if (c.user.id === userId) {
          this.leave(c, houseId);
          this.send(c, { t: "kicked", house: houseId });
        }
      }
      return;
    }
    this.broadcast(houseId, { t: "ev", house: houseId, name, data });
  }

  private ping(): void {
    for (const c of this.conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  /** Close every socket a user has open (e.g. after logout). */
  disconnectUser(userId: string): void {
    for (const c of this.conns) if (c.user.id === userId) c.ws.close(4001, "signed out");
  }
}

function errorText(err: HttpError | z.ZodError): string {
  if (err instanceof HttpError) return err.message;
  const issue = err.issues[0];
  return issue ? `${issue.path.join(".") || "args"}: ${issue.message}` : "Invalid arguments";
}
