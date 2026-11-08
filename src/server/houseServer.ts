import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { SDK_DIR, type Config } from "./config.ts";
import { verifyFrameToken } from "./frameToken.ts";
import type { Repos } from "./repo.ts";
import { isValidHousePath } from "./validate.ts";

/**
 * The house origin. Serves house code and nothing else: no cookies, no API, no user
 * data. Each house gets its own subdomain, and every document is additionally forced
 * into a sandbox with an opaque origin by CSP, even if someone opens the URL directly.
 * Access to a version requires a signed capability token in the path.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
};

/** Sandbox flags shared by the CSP header and the shell's iframe attribute. */
export const HOUSE_SANDBOX = "allow-scripts allow-forms allow-pointer-lock";

export function houseCsp(cfg: Config): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${cfg.platformOrigin}`,
    `sandbox ${HOUSE_SANDBOX}`,
  ].join("; ");
}

/** Small LRU over immutable (house, sha, path) blobs. */
class BlobCache {
  private map = new Map<string, Buffer>();
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}
  get(key: string): Buffer | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: Buffer): void {
    if (value.length > this.maxBytes / 8) return;
    this.map.set(key, value);
    this.bytes += value.length;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(k);
      this.bytes -= v.length;
    }
  }
}

export function createHouseServer(cfg: Config, repos: Repos): http.Server {
  const csp = houseCsp(cfg);
  const cache = new BlobCache(64 * 1024 * 1024);
  const sdkPath = path.join(SDK_DIR, "house.js");
  const domain = cfg.houseDomain.toLowerCase();

  function baseHeaders(res: http.ServerResponse): void {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // House documents run with an opaque origin, so subresource fetches arrive as
    // Origin: null. Assets are only reachable with a capability token anyway.
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  function notFound(res: http.ServerResponse): void {
    baseHeaders(res);
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
  }

  return http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, HEAD");
        return res.end();
      }
      const host = (req.headers.host ?? "").toLowerCase();
      const suffix = `.${domain}`;
      const hostHouse = host.endsWith(suffix) ? host.slice(0, -suffix.length) : "";
      if (!/^[0-9a-f]{16}$/.test(hostHouse)) return notFound(res);

      const url = new URL(req.url ?? "/", "http://house.invalid");
      if (url.pathname === "/_sdk/house.js") {
        baseHeaders(res);
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        return res.end(req.method === "HEAD" ? undefined : fs.readFileSync(sdkPath));
      }

      const m = /^\/v\/([^/]+)\/(.*)$/.exec(url.pathname);
      if (!m) return notFound(res);
      const grant = verifyFrameToken(cfg.secret, m[1]!);
      if (!grant || grant.houseId !== hostHouse) return notFound(res);

      let filePath: string;
      try {
        filePath = decodeURIComponent(m[2] ?? "");
      } catch {
        return notFound(res);
      }
      if (filePath === "" || filePath.endsWith("/")) filePath += "index.html";
      if (!isValidHousePath(filePath)) return notFound(res);

      const key = `${grant.houseId}:${grant.sha}:${filePath}`;
      let body = cache.get(key);
      if (!body) {
        const blob = await repos.readFile(grant.houseId, grant.sha, filePath);
        if (!blob) return notFound(res);
        body = blob;
        cache.set(key, body);
      }
      baseHeaders(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
      res.setHeader("Cache-Control", "private, max-age=3600, immutable");
      res.setHeader("Content-Length", body.length);
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (err) {
      console.error("[house-server]", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    }
  });
}
