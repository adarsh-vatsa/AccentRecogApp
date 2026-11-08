import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SHELL_DIR = path.join(ROOT, "src/shell");
export const SDK_DIR = path.join(ROOT, "src/house-sdk");
export const TEMPLATE_DIR = path.join(ROOT, "src/template");

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentConfig {
  model: string;
  effort: Effort;
  /** Hard cap on model turns per run. */
  maxTurns: number;
  /** Hard cap on check() calls per run (each adds screenshots to context). */
  maxChecks: number;
  runsPerUserPerDay: number;
  maxConcurrentPerHouse: number;
  maxConcurrentGlobal: number;
}

export interface Config {
  platformPort: number;
  housePort: number;
  /** Origin of the trusted shell, e.g. http://localhost:4100 */
  platformOrigin: string;
  /** Scheme for house origins. */
  houseScheme: "http" | "https";
  /**
   * Host (and port) that house subdomains hang off. House origin is
   * `${houseScheme}://${houseId}.${houseDomain}`. In production this MUST be a
   * separate registrable domain from the platform (like googleusercontent.com).
   */
  houseDomain: string;
  dataDir: string;
  /** HMAC key for capability URLs. */
  secret: Buffer;
  secureCookies: boolean;
  /** How long a frame capability URL stays valid. */
  frameTtlMs: number;
  signupsPerIpPerHour: number;
  /** Trust X-Forwarded-For from exactly one reverse proxy in front of the server. */
  trustProxy: boolean;
  /** Run the check browser with Chromium's sandbox. Only disable for local dev as root. */
  checkerSandbox: boolean;
  agent: AgentConfig;
}

function loadSecret(dataDir: string): Buffer {
  const fromEnv = process.env.HOUSE_SECRET;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, "base64url");
    if (buf.length < 32) throw new Error("HOUSE_SECRET must be at least 32 bytes (base64url)");
    return buf;
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "secret.key");
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const platformPort = overrides.platformPort ?? Number(process.env.PLATFORM_PORT ?? 4100);
  const housePort = overrides.housePort ?? Number(process.env.HOUSE_PORT ?? 4101);
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? path.join(ROOT, "data"));
  const platformOrigin =
    overrides.platformOrigin ?? process.env.PLATFORM_ORIGIN ?? `http://localhost:${platformPort}`;
  const houseScheme =
    overrides.houseScheme ?? (process.env.HOUSE_SCHEME === "https" ? "https" : "http");
  const houseDomain =
    overrides.houseDomain ?? process.env.HOUSE_DOMAIN ?? `houses.localhost:${housePort}`;
  const agentDefaults: AgentConfig = {
    model: process.env.AGENT_MODEL ?? "claude-opus-5-5",
    effort: (process.env.AGENT_EFFORT as Effort | undefined) ?? "high",
    maxTurns: Number(process.env.AGENT_MAX_TURNS ?? 40),
    maxChecks: Number(process.env.AGENT_MAX_CHECKS ?? 6),
    runsPerUserPerDay: Number(process.env.AGENT_RUNS_PER_USER_PER_DAY ?? 30),
    maxConcurrentPerHouse: 3,
    maxConcurrentGlobal: 6,
  };
  return {
    platformPort,
    housePort,
    platformOrigin,
    houseScheme,
    houseDomain,
    dataDir,
    secret: overrides.secret ?? loadSecret(dataDir),
    secureCookies: overrides.secureCookies ?? platformOrigin.startsWith("https://"),
    frameTtlMs: overrides.frameTtlMs ?? 6 * 60 * 60 * 1000,
    signupsPerIpPerHour: overrides.signupsPerIpPerHour ?? Number(process.env.SIGNUPS_PER_IP_PER_HOUR ?? 5),
    trustProxy: overrides.trustProxy ?? process.env.TRUST_PROXY === "1",
    checkerSandbox: overrides.checkerSandbox ?? process.env.CHECKER_NO_SANDBOX !== "1",
    agent: { ...agentDefaults, ...overrides.agent },
  };
}

export function houseOrigin(cfg: Config, houseId: string): string {
  return `${cfg.houseScheme}://${houseId}.${cfg.houseDomain}`;
}

/** CSP source expression matching every house origin, e.g. http://*.houses.localhost:4101 */
export function houseOriginWildcard(cfg: Config): string {
  return `${cfg.houseScheme}://*.${cfg.houseDomain}`;
}
