import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { BrowserChecker, type Checker } from "./agent/check.ts";
import { ClaudeModel, type ModelClient } from "./agent/model.ts";
import { RunService } from "./agent/runs.ts";
import { registerApi, sendError } from "./api.ts";
import { SHELL_DIR, houseOriginWildcard, type Config } from "./config.ts";
import { openDb, type DB } from "./db.ts";
import { createHouseServer } from "./houseServer.ts";
import { HouseService } from "./houses.ts";
import { Router, sendJson, type Ctx } from "./http.ts";
import { Hub } from "./realtime.ts";
import { Repos } from "./repo.ts";

export interface Services {
  cfg: Config;
  db: DB;
  repos: Repos;
  houses: HouseService;
  hub: Hub;
  runs: RunService;
}

export interface App {
  svc: Services;
  platform: http.Server;
  house: http.Server;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** Shell files served from the platform origin. Explicit allowlist: no directory serving. */
const SHELL_FILES: Record<string, { file: string; type: string }> = {
  "/shell/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/shell/bridge.js": { file: "bridge.js", type: "text/javascript; charset=utf-8" },
  "/shell/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};
const SPA_ROUTES = [/^\/$/, /^\/house\/[0-9a-f]{16}$/, /^\/invite\/[A-Za-z0-9_-]{1,100}$/];

function shellCsp(cfg: Config): string {
  const wsOrigin = cfg.platformOrigin.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${wsOrigin}`,
    `frame-src ${houseOriginWildcard(cfg)}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function createApp(cfg: Config, opts: { model?: ModelClient; checker?: Checker } = {}): App {
  const db = openDb(cfg.dataDir);
  const repos = new Repos(path.join(cfg.dataDir, "houses"));
  const houses = new HouseService(db, repos, cfg);
  const hub = new Hub(db, houses, cfg);
  const runs = new RunService(db, repos, houses, cfg, opts.model ?? new ClaudeModel(cfg.agent), opts.checker ??
      new BrowserChecker({ platformOrigin: cfg.platformOrigin, houseScheme: cfg.houseScheme, houseDomain: cfg.houseDomain, sandbox: cfg.checkerSandbox }));
  runs.recover();
  const svc: Services = { cfg, db, repos, houses, hub, runs };

  const router = new Router();
  registerApi(router, svc);
  const csp = shellCsp(cfg);

  function securityHeaders(res: http.ServerResponse): void {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()");
    if (cfg.secureCookies) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  function serveFile(res: http.ServerResponse, file: string, type: string, method: string): void {
    const body = fs.readFileSync(path.join(SHELL_DIR, file));
    res.statusCode = 200;
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Length", body.length);
    res.end(method === "HEAD" ? undefined : body);
  }

  const platform = http.createServer(async (req, res) => {
    securityHeaders(res);
    let url: URL;
    try {
      url = new URL(req.url ?? "/", cfg.platformOrigin);
    } catch {
      res.statusCode = 400;
      return res.end();
    }
    const method = req.method ?? "GET";
    const ctx: Ctx = { req, res, url, params: {} };
    try {
      if (url.pathname.startsWith("/api/")) {
        // CSRF: state-changing requests must come from the shell's own origin.
        if (method !== "GET" && method !== "HEAD" && req.headers.origin !== cfg.platformOrigin) {
          return sendJson(res, 403, { error: "Cross-origin request refused" });
        }
        const match = router.match(method, url.pathname);
        if (!match) return sendJson(res, 404, { error: "Not found" });
        ctx.params = match.params;
        const result = await match.handler(ctx);
        if (!res.writableEnded) sendJson(res, 200, result ?? { ok: true });
        return;
      }
      if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
      const shellFile = SHELL_FILES[url.pathname];
      if (shellFile) return serveFile(res, shellFile.file, shellFile.type, method);
      if (SPA_ROUTES.some((r) => r.test(url.pathname))) return serveFile(res, "index.html", "text/html; charset=utf-8", method);
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not found");
    } catch (err) {
      if (!res.headersSent) sendError(ctx, err);
      else res.end();
    }
  });

  platform.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", cfg.platformOrigin);
      if (url.pathname !== "/ws") return socket.destroy();
      hub.handleUpgrade(req, socket, head);
    } catch (err) {
      console.error("[upgrade]", (err as Error).message);
      socket.destroy();
    }
  });
  platform.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    else socket.destroy();
  });

  const house = createHouseServer(cfg, repos);

  return {
    svc,
    platform,
    house,
    async listen() {
      await new Promise<void>((resolve) => platform.listen(cfg.platformPort, resolve));
      await new Promise<void>((resolve) => house.listen(cfg.housePort, resolve));
    },
    async close() {
      hub.close();
      await runs.shutdown();
      await Promise.all([
        new Promise<void>((r) => platform.close(() => r())),
        new Promise<void>((r) => house.close(() => r())),
      ]);
      platform.closeAllConnections();
      house.closeAllConnections();
      db.close();
    },
  };
}
