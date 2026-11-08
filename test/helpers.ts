import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { CheckResult, Checker } from "../src/server/agent/check.ts";
import type { AgentMessage, ModelClient, TurnParams } from "../src/server/agent/model.ts";
import { createApp, type App } from "../src/server/app.ts";
import { loadConfig, type Config } from "../src/server/config.ts";

let portCursor = 20000 + Math.floor(Math.random() * 20000);

export interface TestApp {
  app: App;
  cfg: Config;
  base: string;
  close(): Promise<void>;
}

export async function startApp(opts: { model?: ModelClient; checker?: Checker; agent?: Partial<Config["agent"]> } = {}): Promise<TestApp> {
  const platformPort = portCursor++;
  const housePort = portCursor++;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-test-"));
  const cfg = loadConfig({
    platformPort,
    housePort,
    dataDir,
    platformOrigin: `http://localhost:${platformPort}`,
    houseDomain: `houses.localhost:${housePort}`,
    secret: crypto.randomBytes(32),
    signupsPerIpPerHour: 10_000,
    agent: { ...loadConfig({ dataDir, secret: crypto.randomBytes(32) }).agent, ...opts.agent },
  });
  const app = createApp(cfg, { model: opts.model ?? new ScriptedModel([]), checker: opts.checker ?? new FakeChecker() });
  await app.listen();
  return {
    app,
    cfg,
    base: cfg.platformOrigin,
    async close() {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A browser-ish API client: keeps the session cookie and sends the shell's Origin. */
export class Client {
  cookie = "";
  constructor(
    private readonly t: TestApp,
    public origin: string | null = t.cfg.platformOrigin,
  ) {}

  async req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Headers }> {
    const h: Record<string, string> = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.origin && method !== "GET") h.origin = this.origin;
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await fetch(this.t.base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }

  async signup(username: string, displayName = username): Promise<{ id: string; name: string }> {
    const r = await this.req("POST", "/api/auth/signup", { username, password: "a long enough password", displayName });
    if (r.status !== 200) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json.user;
  }

  async createHouse(name = "Test House"): Promise<string> {
    const r = await this.req("POST", "/api/houses", { name });
    if (r.status !== 200) throw new Error(`create house failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json.house.id;
  }

  async join(owner: Client, houseId: string): Promise<void> {
    const inv = await owner.req("POST", `/api/houses/${houseId}/invites`);
    const r = await this.req("POST", `/api/invites/${inv.json.token}/accept`);
    if (r.status !== 200) throw new Error(`join failed: ${r.status}`);
  }

  ws(origin: string | null = this.t.cfg.platformOrigin): Promise<WsClient> {
    return WsClient.open(this.t.base.replace("http", "ws") + "/ws", this.cookie, origin);
  }
}

export class WsClient {
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  messages: any[] = [];
  private waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];

  private constructor(public ws: WebSocket) {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === "res") {
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
        return;
      }
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(msg)) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
    });
  }

  static open(url: string, cookie: string, origin: string | null): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (cookie) headers.cookie = cookie;
      const ws = new WebSocket(url, { headers, origin: origin ?? undefined });
      ws.once("open", () => resolve(new WsClient(ws)));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`ws refused: ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for ws message")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  async sub(house: string): Promise<any> {
    this.send({ t: "sub", house });
    return this.waitFor((m) => (m.t === "subbed" || m.t === "suberror") && m.house === house);
  }

  req(house: string, op: string, args: unknown = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ t: "req", id, house, op, args });
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** GET a path on the house origin with an explicit Host header. */
export function houseGet(t: TestApp, host: string, p: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: t.cfg.housePort, path: p, method: "GET", headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Fetch a frame URL returned by the API (rewrites the *.localhost host to 127.0.0.1). */
export function frameGet(t: TestApp, url: string, file = "index.html"): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const u = new URL(url);
  const p = u.pathname.replace(/index\.html$/, file);
  return houseGet(t, u.host, p);
}

// ---- fakes -----------------------------------------------------------------

export function assistant(content: any[], stop_reason: AgentMessage["stop_reason"] = "tool_use"): AgentMessage {
  return {
    id: `msg_${crypto.randomBytes(6).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: "fake",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as AgentMessage;
}

export function toolUse(name: string, input: unknown): any {
  return { type: "tool_use", id: `toolu_${crypto.randomBytes(6).toString("hex")}`, name, input };
}

export function text(t: string): any {
  return { type: "text", text: t };
}

type Step = AgentMessage | ((params: TurnParams, signal: AbortSignal) => AgentMessage | Promise<AgentMessage>);

/** Plays back a fixed script of turns, recording what it was sent. */
export class ScriptedModel implements ModelClient {
  calls: TurnParams[] = [];
  constructor(private steps: Step[]) {}
  setScript(steps: Step[]): void {
    this.steps = steps;
  }
  async turn(params: TurnParams, signal: AbortSignal): Promise<AgentMessage> {
    this.calls.push(structuredClone(params));
    const step = this.steps.shift();
    if (!step) return assistant([text("Done.")], "end_turn");
    return typeof step === "function" ? step(params, signal) : step;
  }
}

export class FakeChecker implements Checker {
  calls: string[] = [];
  result: Partial<CheckResult> = {};
  async check(frameUrl: string): Promise<CheckResult> {
    this.calls.push(frameUrl);
    return { available: true, connected: true, errors: [], blocked: [], console: [], screenshots: [], ...this.result };
  }
  async close(): Promise<void> {}
}

export async function waitUntil<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
