import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS houses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  live_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (house_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_channel ON messages (house_id, channel, id);

CREATE TABLE IF NOT EXISTS state (
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (house_id, key)
);

CREATE TABLE IF NOT EXISTS versions (
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('init', 'ship', 'restore')),
  author_id TEXT REFERENCES users(id),
  run_id TEXT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (house_id, sha)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  result_sha TEXT,
  summary TEXT,
  error TEXT,
  log TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_by_house ON runs (house_id, created_at);
CREATE INDEX IF NOT EXISTS runs_by_user ON runs (user_id, created_at);
`;

export type DB = DatabaseSync;

export function openDb(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, "app.db"));
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction (node:sqlite has no helper for this). */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: number;
}

export interface HouseRow {
  id: string;
  name: string;
  owner_id: string;
  live_sha: string;
  created_at: number;
}

export interface MembershipRow {
  house_id: string;
  user_id: string;
  role: "owner" | "member";
  joined_at: number;
}

export interface RunRow {
  id: string;
  house_id: string;
  user_id: string;
  prompt: string;
  status: RunStatus;
  base_sha: string;
  result_sha: string | null;
  summary: string | null;
  error: string | null;
  log: string;
  created_at: number;
  updated_at: number;
}

export type RunStatus =
  | "queued"
  | "running"
  | "ready"
  | "failed"
  | "shipped"
  | "discarded"
  | "conflict";
