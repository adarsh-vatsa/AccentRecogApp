import { z } from "zod";

/** Limits shared by the HTTP API, the realtime hub and the agent tools. */
export const LIMITS = {
  messageChars: 4000,
  channelPattern: /^[A-Za-z0-9_-]{1,64}$/,
  stateKeyPattern: /^[A-Za-z0-9_.:/-]{1,128}$/,
  stateValueBytes: 32 * 1024,
  stateKeysPerHouse: 5000,
  stateBytesPerHouse: 8 * 1024 * 1024,
  eventNamePattern: /^[A-Za-z0-9_.:-]{1,64}$/,
  eventPayloadBytes: 8 * 1024,
  promptChars: 4000,
  houseNameChars: 60,
  houseFileBytes: 512 * 1024,
  houseFilesMax: 200,
  houseTotalBytes: 5 * 1024 * 1024,
} as const;

export const usernameSchema = z
  .string()
  .regex(/^[a-z0-9_]{3,24}$/, "Usernames are 3-24 characters: lowercase letters, digits, underscores.");
export const passwordSchema = z
  .string()
  .min(10, "Passwords need at least 10 characters.")
  .max(200, "Passwords can be at most 200 characters.");
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Display name is required.")
  .max(40, "Display names can be at most 40 characters.")
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Display names can't contain control characters.");
export const houseNameSchema = z
  .string()
  .trim()
  .min(1, "House name is required.")
  .max(LIMITS.houseNameChars)
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "House names can't contain control characters.");

export const idPattern = /^[0-9a-f]{16}$/;
export const shaPattern = /^[0-9a-f]{40}$/;

/**
 * House file paths. Every segment must start with a letter or digit, which rules out
 * `..`, `.git`, `.gitattributes`, `.gitmodules` and other dotfiles in one rule.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export function isValidHousePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0 || p.length > 200) return false;
  const segments = p.split("/");
  if (segments.length > 8) return false;
  return segments.every((s) => SEGMENT.test(s));
}

export function jsonByteLength(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
}
