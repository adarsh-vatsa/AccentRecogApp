import crypto from "node:crypto";
import { promisify } from "node:util";
import type { IncomingMessage } from "node:http";
import type { DB, UserRow } from "./db.ts";

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;
export const SESSION_COOKIE = "sid";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function randomId(bytes = 8): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function newToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, KEYLEN, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64url");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A real hash of a random password, so unknown-user logins cost the same as wrong-password ones. */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(newToken());
  return dummyHash;
}

export function createSession(db: DB, userId: string): { token: string; expiresAt: number } {
  const token = newToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    sha256(token),
    userId,
    now,
    expiresAt,
  );
  return { token, expiresAt };
}

export function deleteSession(db: DB, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function userForSessionToken(db: DB, token: string | undefined): UserRow | undefined {
  if (!token || token.length > 100) return undefined;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), Date.now()) as UserRow | undefined;
  return row;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name && !(name in out)) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function sessionTokenFromRequest(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

export function sessionCookie(token: string, expiresAt: number, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
