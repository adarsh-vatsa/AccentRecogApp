import { randomId, newToken, sha256 } from "./auth.ts";
import { TEMPLATE_DIR, type Config, houseOrigin } from "./config.ts";
import { tx, type DB, type HouseRow, type MembershipRow, type UserRow } from "./db.ts";
import { signFrameToken } from "./frameToken.ts";
import { HttpError } from "./http.ts";
import type { GitIdentity, Repos } from "./repo.ts";
import { LIMITS, jsonByteLength } from "./validate.ts";

export interface PublicUser {
  id: string;
  username: string;
  name: string;
}

export interface PublicMember extends PublicUser {
  role: "owner" | "member";
}

export interface PublicMessage {
  id: number;
  channel: string;
  body: string;
  at: number;
  from: { id: string; name: string };
}

export interface StateEntry {
  key: string;
  value: unknown;
  rev: number;
  by: string;
  at: number;
}

export interface VersionInfo {
  sha: string;
  kind: "init" | "ship" | "restore";
  message: string;
  at: number;
  by: { id: string; name: string } | null;
  runId: string | null;
  live: boolean;
}

export type HouseEventListener = (houseId: string, name: string, data: unknown) => void;

export function publicUser(u: UserRow): PublicUser {
  return { id: u.id, username: u.username, name: u.display_name };
}

export function identityFor(u: Pick<UserRow, "id" | "display_name">): GitIdentity {
  return { name: u.display_name, email: `${u.id}@users.dynamic-chats.invalid` };
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_MAX_USES = 25;

/**
 * Everything a house is, minus its code: membership, invites, messages, shared state
 * and the version log. Mutations publish events through `listener` (the realtime hub).
 */
export class HouseService {
  private listener: HouseEventListener = () => {};

  constructor(
    private readonly db: DB,
    private readonly repos: Repos,
    private readonly cfg: Config,
  ) {}

  onEvent(listener: HouseEventListener): void {
    this.listener = listener;
  }

  publish(houseId: string, name: string, data: unknown): void {
    this.listener(houseId, name, data);
  }

  // ---- houses & membership -------------------------------------------------

  getHouse(houseId: string): HouseRow | undefined {
    return this.db.prepare("SELECT * FROM houses WHERE id = ?").get(houseId) as HouseRow | undefined;
  }

  membership(houseId: string, userId: string): MembershipRow | undefined {
    return this.db
      .prepare("SELECT * FROM memberships WHERE house_id = ? AND user_id = ?")
      .get(houseId, userId) as MembershipRow | undefined;
  }

  /** 404 rather than 403 for non-members, so house ids can't be probed. */
  requireMember(houseId: string, userId: string): { house: HouseRow; membership: MembershipRow } {
    const house = this.getHouse(houseId);
    const membership = house ? this.membership(houseId, userId) : undefined;
    if (!house || !membership) throw new HttpError(404, "House not found");
    return { house, membership };
  }

  requireOwner(houseId: string, userId: string): HouseRow {
    const { house, membership } = this.requireMember(houseId, userId);
    if (membership.role !== "owner") throw new HttpError(403, "Only the house owner can do that");
    return house;
  }

  listHouses(userId: string): Array<{ id: string; name: string; role: string; members: number }> {
    return this.db
      .prepare(
        `SELECT h.id, h.name, m.role,
                (SELECT COUNT(*) FROM memberships m2 WHERE m2.house_id = h.id) AS members
         FROM houses h JOIN memberships m ON m.house_id = h.id
         WHERE m.user_id = ? ORDER BY h.created_at DESC`,
      )
      .all(userId) as Array<{ id: string; name: string; role: string; members: number }>;
  }

  async createHouse(owner: UserRow, name: string): Promise<HouseRow> {
    const id = randomId();
    const sha = await this.repos.init(id, TEMPLATE_DIR, identityFor(owner));
    const now = Date.now();
    tx(this.db, () => {
      this.db
        .prepare("INSERT INTO houses (id, name, owner_id, live_sha, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, name, owner.id, sha, now);
      this.db
        .prepare("INSERT INTO memberships (house_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
        .run(id, owner.id, now);
      this.db
        .prepare(
          "INSERT INTO versions (house_id, sha, kind, author_id, run_id, message, created_at) VALUES (?, ?, 'init', ?, NULL, ?, ?)",
        )
        .run(id, sha, owner.id, "Moved in with the default house", now);
    });
    return this.getHouse(id)!;
  }

  async deleteHouse(houseId: string): Promise<void> {
    this.db.prepare("DELETE FROM houses WHERE id = ?").run(houseId);
    await this.repos.removeHouse(houseId);
  }

  members(houseId: string): PublicMember[] {
    const rows = this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name, m.role FROM memberships m
         JOIN users u ON u.id = m.user_id WHERE m.house_id = ? ORDER BY m.joined_at`,
      )
      .all(houseId) as Array<{ id: string; username: string; display_name: string; role: "owner" | "member" }>;
    return rows.map((r) => ({ id: r.id, username: r.username, name: r.display_name, role: r.role }));
  }

  createInvite(houseId: string, userId: string): { token: string; expiresAt: number } {
    const token = newToken(24);
    const now = Date.now();
    const expiresAt = now + INVITE_TTL_MS;
    this.db
      .prepare(
        "INSERT INTO invites (token_hash, house_id, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(sha256(token), houseId, userId, now, expiresAt, INVITE_MAX_USES);
    return { token, expiresAt };
  }

  private liveInvite(token: string): { house_id: string; created_by: string; token_hash: string } | undefined {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
    return this.db
      .prepare("SELECT house_id, created_by, token_hash FROM invites WHERE token_hash = ? AND expires_at > ? AND uses < max_uses")
      .get(sha256(token), Date.now()) as { house_id: string; created_by: string; token_hash: string } | undefined;
  }

  previewInvite(token: string, userId: string): { houseId: string; houseName: string; inviter: string; alreadyMember: boolean } {
    const invite = this.liveInvite(token);
    const house = invite ? this.getHouse(invite.house_id) : undefined;
    if (!invite || !house) throw new HttpError(404, "This invite link is invalid or has expired");
    const inviter = this.db.prepare("SELECT display_name FROM users WHERE id = ?").get(invite.created_by) as
      | { display_name: string }
      | undefined;
    return {
      houseId: house.id,
      houseName: house.name,
      inviter: inviter?.display_name ?? "someone",
      alreadyMember: Boolean(this.membership(house.id, userId)),
    };
  }

  acceptInvite(token: string, user: UserRow): string {
    const joined = tx(this.db, () => {
      const invite = this.liveInvite(token);
      if (!invite) throw new HttpError(404, "This invite link is invalid or has expired");
      if (this.membership(invite.house_id, user.id)) return { houseId: invite.house_id, isNew: false };
      this.db.prepare("UPDATE invites SET uses = uses + 1 WHERE token_hash = ?").run(invite.token_hash);
      this.db
        .prepare("INSERT INTO memberships (house_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)")
        .run(invite.house_id, user.id, Date.now());
      return { houseId: invite.house_id, isNew: true };
    });
    if (joined.isNew) this.publish(joined.houseId, "members", this.members(joined.houseId));
    return joined.houseId;
  }

  removeMember(houseId: string, actorId: string, targetId: string): void {
    const { house, membership } = this.requireMember(houseId, actorId);
    if (targetId === house.owner_id) {
      throw new HttpError(400, "The owner can't leave their own house. Delete it instead.");
    }
    if (actorId !== targetId && membership.role !== "owner") {
      throw new HttpError(403, "Only the house owner can remove people");
    }
    const res = this.db.prepare("DELETE FROM memberships WHERE house_id = ? AND user_id = ?").run(houseId, targetId);
    if (res.changes === 0) throw new HttpError(404, "Not a member");
    this.publish(houseId, "members", this.members(houseId));
    this.publish(houseId, "member.removed", { userId: targetId });
  }

  // ---- messages ------------------------------------------------------------

  postMessage(houseId: string, user: UserRow, channel: string, body: string): PublicMessage {
    const at = Date.now();
    const res = this.db
      .prepare("INSERT INTO messages (house_id, channel, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(houseId, channel, user.id, body, at);
    const msg: PublicMessage = {
      id: Number(res.lastInsertRowid),
      channel,
      body,
      at,
      from: { id: user.id, name: user.display_name },
    };
    this.publish(houseId, "chat.message", msg);
    return msg;
  }

  listMessages(houseId: string, channel: string, before: number | undefined, limit: number): PublicMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.channel, m.body, m.created_at, u.id AS uid, u.display_name
         FROM messages m JOIN users u ON u.id = m.user_id
         WHERE m.house_id = ? AND m.channel = ? AND m.id < ?
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(houseId, channel, before ?? Number.MAX_SAFE_INTEGER, limit) as Array<{
      id: number;
      channel: string;
      body: string;
      created_at: number;
      uid: string;
      display_name: string;
    }>;
    return rows
      .reverse()
      .map((r) => ({ id: r.id, channel: r.channel, body: r.body, at: r.created_at, from: { id: r.uid, name: r.display_name } }));
  }

  // ---- shared state ----------------------------------------------------------

  private toEntry(r: { key: string; value: string; rev: number; updated_by: string; updated_at: number }): StateEntry {
    return { key: r.key, value: JSON.parse(r.value), rev: r.rev, by: r.updated_by, at: r.updated_at };
  }

  getState(houseId: string, key: string): StateEntry | null {
    const row = this.db.prepare("SELECT * FROM state WHERE house_id = ? AND key = ?").get(houseId, key) as
      | { key: string; value: string; rev: number; updated_by: string; updated_at: number }
      | undefined;
    return row ? this.toEntry(row) : null;
  }

  listState(houseId: string, prefix: string): StateEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM state WHERE house_id = ? AND substr(key, 1, ?) = ? ORDER BY key LIMIT 1000")
      .all(houseId, prefix.length, prefix) as Array<{ key: string; value: string; rev: number; updated_by: string; updated_at: number }>;
    return rows.map((r) => this.toEntry(r));
  }

  /**
   * Last-write-wins set, with optional compare-and-set: pass ifRev to require the
   * current revision (0 = key must not exist). Throws 409 on mismatch.
   */
  setState(houseId: string, user: UserRow, key: string, value: unknown, ifRev?: number): StateEntry {
    if (value === undefined) throw new HttpError(400, "State values must be JSON");
    const text = JSON.stringify(value);
    const bytes = jsonByteLength(value);
    if (bytes > LIMITS.stateValueBytes) throw new HttpError(413, `State values are limited to ${LIMITS.stateValueBytes} bytes`);
    const entry = tx(this.db, () => {
      const current = this.db.prepare("SELECT rev, length(value) AS len FROM state WHERE house_id = ? AND key = ?").get(houseId, key) as
        | { rev: number; len: number }
        | undefined;
      const currentRev = current?.rev ?? 0;
      if (ifRev !== undefined && ifRev !== currentRev) throw new HttpError(409, `Revision mismatch: key is at ${currentRev}`);
      const totals = this.db
        .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(length(value)), 0) AS bytes FROM state WHERE house_id = ?")
        .get(houseId) as { n: number; bytes: number };
      if (!current && totals.n >= LIMITS.stateKeysPerHouse) throw new HttpError(413, "This house has too many state keys");
      if (totals.bytes - (current?.len ?? 0) + bytes > LIMITS.stateBytesPerHouse) throw new HttpError(413, "This house's state is full");
      const at = Date.now();
      this.db
        .prepare(
          `INSERT INTO state (house_id, key, value, rev, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (house_id, key) DO UPDATE SET value = excluded.value, rev = excluded.rev,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .run(houseId, key, text, currentRev + 1, user.id, at);
      return { key, value, rev: currentRev + 1, by: user.id, at };
    });
    this.publish(houseId, "state.change", entry);
    return entry;
  }

  deleteState(houseId: string, user: UserRow, key: string, ifRev?: number): boolean {
    const deleted = tx(this.db, () => {
      const current = this.db.prepare("SELECT rev FROM state WHERE house_id = ? AND key = ?").get(houseId, key) as
        | { rev: number }
        | undefined;
      if (ifRev !== undefined && ifRev !== (current?.rev ?? 0)) {
        throw new HttpError(409, `Revision mismatch: key is at ${current?.rev ?? 0}`);
      }
      if (!current) return false;
      this.db.prepare("DELETE FROM state WHERE house_id = ? AND key = ?").run(houseId, key);
      return true;
    });
    if (deleted) this.publish(houseId, "state.change", { key, value: null, rev: 0, by: user.id, at: Date.now(), deleted: true });
    return deleted;
  }

  // ---- versions & frames ------------------------------------------------------

  listVersions(houseId: string): VersionInfo[] {
    const house = this.getHouse(houseId);
    const rows = this.db
      .prepare(
        `SELECT v.sha, v.kind, v.message, v.created_at, v.run_id, u.id AS uid, u.display_name
         FROM versions v LEFT JOIN users u ON u.id = v.author_id
         WHERE v.house_id = ? ORDER BY v.created_at DESC, v.rowid DESC LIMIT 200`,
      )
      .all(houseId) as Array<{
      sha: string;
      kind: VersionInfo["kind"];
      message: string;
      created_at: number;
      run_id: string | null;
      uid: string | null;
      display_name: string | null;
    }>;
    return rows.map((r) => ({
      sha: r.sha,
      kind: r.kind,
      message: r.message,
      at: r.created_at,
      runId: r.run_id,
      by: r.uid ? { id: r.uid, name: r.display_name ?? "" } : null,
      live: r.sha === house?.live_sha,
    }));
  }

  /**
   * Move the live version. Caller must hold the repo lock for this house and must
   * already have written refs/heads/main.
   */
  recordLive(houseId: string, sha: string, kind: "ship" | "restore", author: UserRow, runId: string | null, message: string): void {
    tx(this.db, () => {
      this.db.prepare("UPDATE houses SET live_sha = ? WHERE id = ?").run(sha, houseId);
      this.db
        .prepare(
          `INSERT INTO versions (house_id, sha, kind, author_id, run_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (house_id, sha) DO UPDATE SET created_at = excluded.created_at, kind = excluded.kind,
             author_id = excluded.author_id, run_id = excluded.run_id, message = excluded.message`,
        )
        .run(houseId, sha, kind, author.id, runId, message, Date.now());
    });
    this.publish(houseId, "version", { sha, kind, by: { id: author.id, name: author.display_name }, message });
  }

  async restore(houseId: string, user: UserRow, targetSha: string): Promise<string> {
    if (!(await this.repos.hasCommit(houseId, targetSha))) throw new HttpError(404, "Version not found");
    return this.repos.withLock(houseId, async () => {
      const live = await this.repos.mainSha(houseId);
      if (live === targetSha) return live;
      const tree = await this.repos.treeOf(houseId, targetSha);
      const message = `Restore the house to version ${targetSha.slice(0, 7)}`;
      const sha = await this.repos.commitTree(houseId, tree, [live], message, identityFor(user));
      await this.repos.setMain(houseId, sha, live);
      this.recordLive(houseId, sha, "restore", user, null, message);
      return sha;
    });
  }

  /** A capability URL for one version of a house. Caller must have checked membership. */
  async frameUrl(houseId: string, sha: string): Promise<string> {
    if (!(await this.repos.hasCommit(houseId, sha))) throw new HttpError(404, "Version not found");
    const token = signFrameToken(this.cfg.secret, houseId, sha, Date.now() + this.cfg.frameTtlMs);
    return `${houseOrigin(this.cfg, houseId)}/v/${token}/index.html`;
  }
}
