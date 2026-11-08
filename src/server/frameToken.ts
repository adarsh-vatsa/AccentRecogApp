import crypto from "node:crypto";
import { idPattern, shaPattern } from "./validate.ts";

/**
 * Capability tokens for house frames. A token grants read access to one immutable
 * version (commit) of one house until it expires. It is embedded in the iframe URL
 * path, so the house origin needs no cookies at all.
 *
 *   <houseId>.<sha>.<expiresAt base36>.<hmac>
 */

function mac(secret: Buffer, payload: string): string {
  return crypto.createHmac("sha256", secret).update(`frame-v1:${payload}`).digest("base64url");
}

export function signFrameToken(secret: Buffer, houseId: string, sha: string, expiresAt: number): string {
  const payload = `${houseId}.${sha}.${expiresAt.toString(36)}`;
  return `${payload}.${mac(secret, payload)}`;
}

export interface FrameGrant {
  houseId: string;
  sha: string;
  expiresAt: number;
}

export function verifyFrameToken(secret: Buffer, token: string, now = Date.now()): FrameGrant | null {
  if (token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [houseId, sha, exp36, sig] = parts as [string, string, string, string];
  if (!idPattern.test(houseId) || !shaPattern.test(sha) || !/^[0-9a-z]{1,12}$/.test(exp36)) return null;
  const expected = Buffer.from(mac(secret, `${houseId}.${sha}.${exp36}`));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  const expiresAt = parseInt(exp36, 36);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { houseId, sha, expiresAt };
}
