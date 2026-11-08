import { z } from "zod";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  getDummyHash,
  hashPassword,
  randomId,
  sessionCookie,
  sessionTokenFromRequest,
  userForSessionToken,
  verifyPassword,
} from "./auth.ts";
import type { Services } from "./app.ts";
import type { UserRow } from "./db.ts";
import { HttpError, clientIp, parseBody, sendJson, type Ctx, type Router } from "./http.ts";
import { publicUser } from "./houses.ts";
import { RateLimiter } from "./ratelimit.ts";
import {
  LIMITS,
  displayNameSchema,
  houseNameSchema,
  idPattern,
  passwordSchema,
  shaPattern,
  usernameSchema,
} from "./validate.ts";

export function registerApi(router: Router, svc: Services): void {
  const { db, houses, runs, hub, cfg } = svc;
  const loginLimiter = new RateLimiter(10, 10 / 60); // 10 attempts, refilling 10/min
  const signupLimiter = new RateLimiter(cfg.signupsPerIpPerHour, cfg.signupsPerIpPerHour / 3600);
  const writeLimiter = new RateLimiter(60, 1);

  function requireUser(ctx: Ctx): UserRow {
    const user = userForSessionToken(db, sessionTokenFromRequest(ctx.req));
    if (!user) throw new HttpError(401, "Please log in");
    return user;
  }

  function houseParam(ctx: Ctx): string {
    const id = ctx.params.id ?? "";
    if (!idPattern.test(id)) throw new HttpError(404, "House not found");
    return id;
  }

  function limitWrites(user: UserRow): void {
    if (!writeLimiter.take(user.id)) throw new HttpError(429, "Slow down a little");
  }

  // ---- auth ------------------------------------------------------------------

  router.add("POST", "/api/auth/signup", async (ctx) => {
    const body = await parseBody(ctx, z.object({ username: usernameSchema, password: passwordSchema, displayName: displayNameSchema }));
    if (!signupLimiter.take(clientIp(ctx.req))) throw new HttpError(429, "Too many new accounts from here. Try later.");
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(body.username)) {
      throw new HttpError(409, "That username is taken");
    }
    const id = randomId();
    db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      body.username,
      body.displayName,
      await hashPassword(body.password),
      Date.now(),
    );
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow;
    const session = createSession(db, id);
    ctx.res.setHeader("Set-Cookie", sessionCookie(session.token, session.expiresAt, cfg.secureCookies));
    return { user: publicUser(user) };
  });

  router.add("POST", "/api/auth/login", async (ctx) => {
    const body = await parseBody(ctx, z.object({ username: z.string().max(100), password: z.string().max(200) }));
    const username = body.username.trim().toLowerCase();
    if (!loginLimiter.take(`ip:${clientIp(ctx.req)}`) || !loginLimiter.take(`user:${username}`)) {
      throw new HttpError(429, "Too many attempts. Wait a minute and try again.");
    }
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await getDummyHash()));
    if (!user || !ok) throw new HttpError(401, "Wrong username or password");
    const session = createSession(db, user.id);
    ctx.res.setHeader("Set-Cookie", sessionCookie(session.token, session.expiresAt, cfg.secureCookies));
    return { user: publicUser(user) };
  });

  router.add("POST", "/api/auth/logout", (ctx) => {
    const token = sessionTokenFromRequest(ctx.req);
    const user = userForSessionToken(db, token);
    if (token) deleteSession(db, token);
    if (user) hub.disconnectUser(user.id);
    ctx.res.setHeader("Set-Cookie", clearSessionCookie(cfg.secureCookies));
    return { ok: true };
  });

  router.add("GET", "/api/me", (ctx) => ({ user: publicUser(requireUser(ctx)) }));

  // ---- houses ----------------------------------------------------------------

  router.add("GET", "/api/houses", (ctx) => ({ houses: houses.listHouses(requireUser(ctx).id) }));

  router.add("POST", "/api/houses", async (ctx) => {
    const user = requireUser(ctx);
    limitWrites(user);
    const body = await parseBody(ctx, z.object({ name: houseNameSchema }));
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM houses WHERE owner_id = ?").get(user.id) as { n: number };
    if (n >= 20) throw new HttpError(429, "You can own up to 20 houses");
    const house = await houses.createHouse(user, body.name);
    return { house: { id: house.id, name: house.name } };
  });

  router.add("GET", "/api/houses/:id", (ctx) => {
    const user = requireUser(ctx);
    const { house, membership } = houses.requireMember(houseParam(ctx), user.id);
    return {
      house: { id: house.id, name: house.name, liveSha: house.live_sha, ownerId: house.owner_id },
      role: membership.role,
      members: houses.members(house.id),
      online: hub.online(house.id),
    };
  });

  router.add("DELETE", "/api/houses/:id", async (ctx) => {
    const user = requireUser(ctx);
    const house = houses.requireOwner(houseParam(ctx), user.id);
    const members = houses.members(house.id);
    for (const m of members) houses.publish(house.id, "member.removed", { userId: m.id });
    await houses.deleteHouse(house.id);
    return { ok: true };
  });

  router.add("DELETE", "/api/houses/:id/members/:userId", (ctx) => {
    const user = requireUser(ctx);
    const target = ctx.params.userId ?? "";
    if (!idPattern.test(target)) throw new HttpError(404, "Not a member");
    houses.removeMember(houseParam(ctx), user.id, target);
    return { ok: true };
  });

  router.add("POST", "/api/houses/:id/invites", (ctx) => {
    const user = requireUser(ctx);
    limitWrites(user);
    const { house } = houses.requireMember(houseParam(ctx), user.id);
    return houses.createInvite(house.id, user.id);
  });

  router.add("GET", "/api/invites/:token", (ctx) => {
    const user = requireUser(ctx);
    return houses.previewInvite(ctx.params.token ?? "", user.id);
  });

  router.add("POST", "/api/invites/:token/accept", (ctx) => {
    const user = requireUser(ctx);
    limitWrites(user);
    return { houseId: houses.acceptInvite(ctx.params.token ?? "", user) };
  });

  // ---- versions & frames -------------------------------------------------------

  router.add("GET", "/api/houses/:id/frame", async (ctx) => {
    const user = requireUser(ctx);
    const { house } = houses.requireMember(houseParam(ctx), user.id);
    const sha = ctx.url.searchParams.get("sha") ?? house.live_sha;
    if (!shaPattern.test(sha)) throw new HttpError(400, "Bad version");
    return { url: await houses.frameUrl(house.id, sha), sha };
  });

  router.add("GET", "/api/houses/:id/versions", (ctx) => {
    const user = requireUser(ctx);
    const { house } = houses.requireMember(houseParam(ctx), user.id);
    return { versions: houses.listVersions(house.id) };
  });

  router.add("POST", "/api/houses/:id/versions/:sha/restore", async (ctx) => {
    const user = requireUser(ctx);
    limitWrites(user);
    const { house } = houses.requireMember(houseParam(ctx), user.id);
    const sha = ctx.params.sha ?? "";
    if (!shaPattern.test(sha)) throw new HttpError(404, "Version not found");
    return { liveSha: await houses.restore(house.id, user, sha) };
  });

  // ---- agent runs --------------------------------------------------------------

  router.add("GET", "/api/houses/:id/runs", (ctx) => {
    const user = requireUser(ctx);
    const { house } = houses.requireMember(houseParam(ctx), user.id);
    return { runs: runs.list(house.id) };
  });

  router.add("POST", "/api/houses/:id/runs", async (ctx) => {
    const user = requireUser(ctx);
    limitWrites(user);
    const { house } = houses.requireMember(houseParam(ctx), user.id);
    const body = await parseBody(ctx, z.object({ prompt: z.string().trim().min(1, "Describe what should change").max(LIMITS.promptChars) }));
    return { run: await runs.create(house.id, user, body.prompt) };
  });

  router.add("POST", "/api/houses/:id/runs/:runId/ship", async (ctx) => {
    const user = requireUser(ctx);
    limitWrites(user);
    const { house } = houses.requireMember(houseParam(ctx), user.id);
    return runs.ship(house.id, ctx.params.runId ?? "", user);
  });

  router.add("POST", "/api/houses/:id/runs/:runId/discard", (ctx) => {
    const user = requireUser(ctx);
    const { house } = houses.requireMember(houseParam(ctx), user.id);
    return { run: runs.discard(house.id, ctx.params.runId ?? "", user) };
  });
}

export function sendError(ctx: Ctx, err: unknown): void {
  if (err instanceof HttpError) return sendJson(ctx.res, err.status, { error: err.message });
  console.error("[api]", err);
  sendJson(ctx.res, 500, { error: "Something went wrong" });
}
