import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Workspace } from "../src/server/agent/workspace.ts";
import { signFrameToken } from "../src/server/frameToken.ts";
import { isValidHousePath } from "../src/server/validate.ts";
import { Client, frameGet, houseGet, startApp, type TestApp } from "./helpers.ts";

describe("accounts and sessions", () => {
  let t: TestApp;
  before(async () => (t = await startApp()));
  after(async () => t.close());

  test("signup validates input and refuses duplicate usernames", async () => {
    const c = new Client(t);
    assert.equal((await c.req("POST", "/api/auth/signup", { username: "A!", password: "a long enough password", displayName: "x" })).status, 400);
    assert.equal((await c.req("POST", "/api/auth/signup", { username: "short_pw", password: "short", displayName: "x" })).status, 400);
    await c.signup("dana");
    const dup = await new Client(t).req("POST", "/api/auth/signup", { username: "dana", password: "a long enough password", displayName: "Dana 2" });
    assert.equal(dup.status, 409);
  });

  test("session cookie is HttpOnly and SameSite=Strict", async () => {
    const c = new Client(t);
    const r = await c.req("POST", "/api/auth/signup", { username: "erin", password: "a long enough password", displayName: "Erin" });
    const cookie = r.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  test("login gives the same error for unknown users and wrong passwords", async () => {
    const c = new Client(t);
    await c.signup("frank");
    const wrong = await new Client(t).req("POST", "/api/auth/login", { username: "frank", password: "not the password" });
    const unknown = await new Client(t).req("POST", "/api/auth/login", { username: "nobody_here", password: "whatever password" });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.json.error, unknown.json.error);
    const ok = await new Client(t).req("POST", "/api/auth/login", { username: "frank", password: "a long enough password" });
    assert.equal(ok.status, 200);
  });

  test("logout invalidates the session server-side", async () => {
    const c = new Client(t);
    await c.signup("gina");
    const stolen = c.cookie;
    await c.req("POST", "/api/auth/logout");
    const replay = new Client(t);
    replay.cookie = stolen;
    assert.equal((await replay.req("GET", "/api/me")).status, 401);
  });

  test("state-changing requests need the shell's Origin (CSRF)", async () => {
    const c = new Client(t);
    await c.signup("hank");
    c.origin = null;
    assert.equal((await c.req("POST", "/api/houses", { name: "x" })).status, 403);
    c.origin = "https://evil.example";
    assert.equal((await c.req("POST", "/api/houses", { name: "x" })).status, 403);
    c.origin = t.cfg.platformOrigin;
    assert.equal((await c.req("POST", "/api/houses", { name: "x" })).status, 200);
  });

  test("JSON endpoints refuse non-JSON bodies", async () => {
    const c = new Client(t);
    await c.signup("ivy");
    const res = await fetch(t.base + "/api/houses", {
      method: "POST",
      headers: { cookie: c.cookie, origin: t.cfg.platformOrigin, "content-type": "text/plain" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(res.status, 415);
  });

  test("shell pages carry a strict CSP and anti-framing headers", async () => {
    const res = await fetch(t.base + "/");
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, new RegExp(`frame-src http://\\*\\.houses\\.localhost:${t.cfg.housePort}`));
    assert.equal(res.headers.get("x-frame-options"), "DENY");
  });

  test("the shell only serves allowlisted files", async () => {
    assert.equal((await fetch(t.base + "/shell/../server/auth.ts")).status, 404);
    assert.equal((await fetch(t.base + "/src/server/config.ts")).status, 404);
    assert.equal((await fetch(t.base + "/data/secret.key")).status, 404);
  });
});

describe("house membership boundaries", () => {
  let t: TestApp;
  let owner: Client;
  let outsider: Client;
  let houseId: string;
  before(async () => {
    t = await startApp();
    owner = new Client(t);
    outsider = new Client(t);
    await owner.signup("olivia");
    await outsider.signup("oscar");
    houseId = await owner.createHouse("Private Place");
  });
  after(async () => t.close());

  test("non-members get 404 on every house endpoint", async () => {
    for (const [method, p] of [
      ["GET", `/api/houses/${houseId}`],
      ["GET", `/api/houses/${houseId}/frame`],
      ["GET", `/api/houses/${houseId}/versions`],
      ["GET", `/api/houses/${houseId}/runs`],
      ["POST", `/api/houses/${houseId}/runs`],
      ["POST", `/api/houses/${houseId}/invites`],
    ] as const) {
      const r = await outsider.req(method, p, method === "POST" ? { prompt: "hi" } : undefined);
      assert.equal(r.status, 404, `${method} ${p}`);
    }
  });

  test("non-members can't subscribe or act over the socket", async () => {
    const ws = await outsider.ws();
    const sub = await ws.sub(houseId);
    assert.equal(sub.t, "suberror");
    const res = await ws.req(houseId, "chat.send", { body: "let me in" });
    assert.equal(res.ok, false);
    ws.close();
  });

  test("websocket refuses foreign origins and missing sessions", async () => {
    await assert.rejects(owner.ws("https://evil.example"), /403/);
    await assert.rejects(new Client(t).ws(), /401/);
  });

  test("members can only remove themselves; owners can remove others", async () => {
    const m1 = new Client(t);
    const m2 = new Client(t);
    const u1 = await m1.signup("mem_one");
    const u2 = await m2.signup("mem_two");
    await m1.join(owner, houseId);
    await m2.join(owner, houseId);
    assert.equal((await m1.req("DELETE", `/api/houses/${houseId}/members/${u2.id}`)).status, 403);
    assert.equal((await owner.req("DELETE", `/api/houses/${houseId}/members/${u2.id}`)).status, 200);
    assert.equal((await m1.req("DELETE", `/api/houses/${houseId}/members/${u1.id}`)).status, 200);
    assert.equal((await m1.req("GET", `/api/houses/${houseId}`)).status, 404);
  });

  test("a removed member is kicked from the live socket and loses access", async () => {
    const m = new Client(t);
    const u = await m.signup("kicked_kim");
    await m.join(owner, houseId);
    const ws = await m.ws();
    assert.equal((await ws.sub(houseId)).t, "subbed");
    assert.equal((await ws.req(houseId, "chat.send", { body: "hello" })).ok, true);
    await owner.req("DELETE", `/api/houses/${houseId}/members/${u.id}`);
    await ws.waitFor((msg) => msg.t === "kicked" && msg.house === houseId);
    const after = await ws.req(houseId, "chat.send", { body: "still here?" });
    assert.equal(after.ok, false);
    ws.close();
  });

  test("invite links are single-house, expire, and can't be forged", async () => {
    assert.equal((await outsider.req("GET", "/api/invites/not-a-real-token-at-all-xxxx")).status, 404);
    const inv = await owner.req("POST", `/api/houses/${houseId}/invites`);
    const preview = await outsider.req("GET", `/api/invites/${inv.json.token}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.json.houseName, "Private Place");
    t.app.svc.db.prepare("UPDATE invites SET expires_at = 0").run();
    assert.equal((await outsider.req("POST", `/api/invites/${inv.json.token}/accept`)).status, 404);
  });

  test("only the owner can delete the house", async () => {
    const m = new Client(t);
    await m.signup("not_owner");
    await m.join(owner, houseId);
    assert.equal((await m.req("DELETE", `/api/houses/${houseId}`)).status, 403);
  });
});

describe("house origin isolation", () => {
  let t: TestApp;
  let owner: Client;
  let houseId: string;
  let frameUrl: string;
  before(async () => {
    t = await startApp();
    owner = new Client(t);
    await owner.signup("pat");
    houseId = await owner.createHouse();
    frameUrl = (await owner.req("GET", `/api/houses/${houseId}/frame`)).json.url;
  });
  after(async () => t.close());

  test("frame URLs live on the house's own subdomain", () => {
    const u = new URL(frameUrl);
    assert.equal(u.host, `${houseId}.houses.localhost:${t.cfg.housePort}`);
  });

  test("house documents are force-sandboxed and frame-locked by CSP, with no cookies", async () => {
    const r = await frameGet(t, frameUrl);
    assert.equal(r.status, 200);
    assert.match(r.body, /<script src="\/_sdk\/house.js"><\/script>/);
    const csp = String(r.headers["content-security-policy"]);
    assert.match(csp, /sandbox allow-scripts allow-forms allow-pointer-lock(;|$)/);
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.match(csp, new RegExp(`frame-ancestors ${t.cfg.platformOrigin}`));
    assert.match(csp, /connect-src 'self' data: blob:/);
    assert.match(csp, /form-action 'none'/);
    assert.equal(r.headers["set-cookie"], undefined);
    assert.equal(r.headers["referrer-policy"], "no-referrer");
  });

  test("a token for one house doesn't work on another house's subdomain", async () => {
    const other = await owner.createHouse("Other");
    const u = new URL(frameUrl);
    const r = await houseGet(t, `${other}.houses.localhost:${t.cfg.housePort}`, u.pathname);
    assert.equal(r.status, 404);
  });

  test("tampered, expired, and wrong-key tokens are refused", async () => {
    const u = new URL(frameUrl);
    const token = u.pathname.split("/")[2]!;
    const [h, sha, exp, sig] = token.split(".") as [string, string, string, string];
    const host = u.host;
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    assert.equal((await houseGet(t, host, `/v/${h}.${sha}.${exp}.${flipped}/index.html`)).status, 404);
    const longer = (parseInt(exp, 36) + 1_000_000).toString(36);
    assert.equal((await houseGet(t, host, `/v/${h}.${sha}.${longer}.${sig}/index.html`)).status, 404);
    const expired = signFrameToken(t.cfg.secret, houseId, sha, Date.now() - 1000);
    assert.equal((await houseGet(t, host, `/v/${expired}/index.html`)).status, 404);
    const wrongKey = signFrameToken(Buffer.alloc(32, 7), houseId, sha, Date.now() + 60_000);
    assert.equal((await houseGet(t, host, `/v/${wrongKey}/index.html`)).status, 404);
  });

  test("path tricks can't reach outside the house's files", async () => {
    const u = new URL(frameUrl);
    const prefix = u.pathname.replace(/index\.html$/, "");
    for (const p of ["../../etc/passwd", "..%2f..%2fetc%2fpasswd", ".git/config", "%2e%2e/secret.key", "app.js%00.html", "a//b"]) {
      const r = await houseGet(t, u.host, prefix + p);
      assert.equal(r.status, 404, p);
    }
  });

  test("frame URLs only cover commits that belong to that house", async () => {
    // Init commits are identical across houses (same template), so make one that's unique.
    const other = await owner.createHouse("Other 2");
    const { repos } = t.app.svc;
    const live = (await owner.req("GET", `/api/houses/${other}`)).json.house.liveSha;
    const dir = await repos.addWorktree(other, "00000000000000bb", live);
    fs.writeFileSync(path.join(dir, "secret-plans.txt"), "only for Other 2");
    const otherSha = await repos.commitWorktree(other, "00000000000000bb", "private", { name: "x", email: "x@x.invalid" });
    await repos.removeWorktree(other, "00000000000000bb");
    assert.equal((await owner.req("GET", `/api/houses/${other}/frame?sha=${otherSha}`)).status, 200);
    const r = await owner.req("GET", `/api/houses/${houseId}/frame?sha=${otherSha}`);
    assert.equal(r.status, 404);
  });

  test("the house origin has no API", async () => {
    const host = new URL(frameUrl).host;
    assert.equal((await houseGet(t, host, "/api/me")).status, 404);
    assert.equal((await houseGet(t, "localhost", "/_sdk/house.js")).status, 404);
  });
});

describe("realtime data", () => {
  let t: TestApp;
  let a: Client;
  let b: Client;
  let houseId: string;
  before(async () => {
    t = await startApp();
    a = new Client(t);
    b = new Client(t);
    await a.signup("ana");
    await b.signup("ben");
    houseId = await a.createHouse();
    await b.join(a, houseId);
  });
  after(async () => t.close());

  test("chat messages reach other members and are stored", async () => {
    const wa = await a.ws();
    const wb = await b.ws();
    await wa.sub(houseId);
    await wb.sub(houseId);
    const sent = await wa.req(houseId, "chat.send", { body: "hello <b>world</b>" });
    assert.equal(sent.ok, true);
    const got = await wb.waitFor((m) => m.t === "ev" && m.name === "chat.message");
    assert.equal(got.data.body, "hello <b>world</b>");
    assert.equal(got.data.from.name, "ana");
    const hist = await wb.req(houseId, "chat.list", {});
    assert.equal(hist.result.at(-1).body, "hello <b>world</b>");
    wa.close();
    wb.close();
  });

  test("state supports compare-and-set and enforces size limits", async () => {
    const ws = await a.ws();
    await ws.sub(houseId);
    const first = await ws.req(houseId, "state.set", { key: "game:board", value: [1, 2, 3], ifRev: 0 });
    assert.equal(first.result.rev, 1);
    const stale = await ws.req(houseId, "state.set", { key: "game:board", value: [9], ifRev: 0 });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /Revision mismatch/);
    const big = await ws.req(houseId, "state.set", { key: "big", value: "x".repeat(40_000) });
    assert.equal(big.ok, false);
    const badKey = await ws.req(houseId, "state.set", { key: "has spaces", value: 1 });
    assert.equal(badKey.ok, false);
    ws.close();
  });

  test("events go to everyone except the sender", async () => {
    const wa = await a.ws();
    const wb = await b.ws();
    await wa.sub(houseId);
    await wb.sub(houseId);
    await wa.req(houseId, "events.emit", { name: "cursor", data: { x: 1 } });
    const got = await wb.waitFor((m) => m.t === "ev" && m.name === "event");
    assert.deepEqual(got.data.data, { x: 1 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(wa.messages.some((m) => m.name === "event"), false);
    wa.close();
    wb.close();
  });

  test("unknown ops are refused", async () => {
    const ws = await a.ws();
    await ws.sub(houseId);
    const r = await ws.req(houseId, "admin.deleteEverything", {});
    assert.equal(r.ok, false);
    ws.close();
  });
});

describe("agent workspace confinement", () => {
  test("house paths reject traversal, dotfiles and absolute paths", () => {
    for (const bad of ["../x", "a/../b", "/etc/passwd", ".git/config", ".gitattributes", "a//b", "a/.hidden", "", "a\\b", "x".repeat(300)]) {
      assert.equal(isValidHousePath(bad), false, bad);
    }
    for (const good of ["index.html", "games/chess.js", "img/logo-2.svg", "a_b/c.d.e"]) {
      assert.equal(isValidHousePath(good), true, good);
    }
  });

  test("workspace refuses to follow symlinks out of the house", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ws-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
    fs.symlinkSync(outside, path.join(root, "link"));
    const ws = new Workspace(root);
    await assert.rejects(ws.read("link/secret.txt"), /Symlinks/);
    await assert.rejects(ws.write("link/pwned.txt", "x"), /Symlinks/);
    assert.equal(fs.existsSync(path.join(outside, "pwned.txt")), false);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test("workspace enforces file size limits", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
    const ws = new Workspace(root);
    await assert.rejects(ws.write("huge.js", "x".repeat(600 * 1024)), /limited/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
