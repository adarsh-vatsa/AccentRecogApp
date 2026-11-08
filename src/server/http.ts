import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

/** Minimal router: "/api/houses/:id/runs/:runId" style patterns, exact match only. */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    const keys: string[] = [];
    const source = pattern
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) {
          keys.push(seg.slice(1));
          return "([^/]+)";
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? "");
      });
      return { handler: route.handler, params };
    }
    return undefined;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

/** Read and parse a JSON body. Requires application/json, which also blocks simple-request CSRF. */
export async function readJson(req: IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "Expected application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

export async function parseBody<T extends z.ZodType>(ctx: Ctx, schema: T): Promise<z.infer<T>> {
  const raw = await readJson(ctx.req);
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new HttpError(400, first?.message ?? "Invalid request");
  }
  return result.data;
}

export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}
