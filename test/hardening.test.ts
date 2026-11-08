// Regression tests for the findings of the first security review.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { Client, ScriptedModel, assistant, frameGet, startApp, text, toolUse, waitUntil, type TestApp } from "./helpers.ts";

function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(payload));
    let out = "";
    sock.on("data", (d) => (out += d.toString()));
    sock.on("close", () => resolve(out));
    sock.on("error", () => resolve(out));
    setTimeout(() => sock.destroy(), 1000);
  });
}

describe("malformed input can't crash the server", () => {
  let t: TestApp;
  before(async () => (t = await startApp()));
  after(async () => t.close());

  test("an unparseable request target gets a 400 and the server keeps serving", async () => {
    const out = await rawRequest(t.cfg.platformPort, "GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    assert.match(out, /^HTTP\/1\.1 400/);
    assert.equal((await fetch(t.base + "/api/me")).status, 401);
  });

  test("a malformed cookie on the socket upgrade is just unauthenticated", async () => {
    const out = await rawRequest(
      t.cfg.platformPort,
      `GET /ws HTTP/1.1\r\nHost: localhost\r\nOrigin: ${t.cfg.platformOrigin}\r\nCookie: sid=%E0%A4%A\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    assert.match(out, /401/);
    assert.equal((await fetch(t.base + "/api/me")).status, 401);
  });
});

describe("removal sticks", () => {
  let t: TestApp;
  let owner: Client;
  let houseId: string;
  before(async () => {
    t = await startApp();
    owner = new Client(t);
    await owner.signup("owner_ola");
    houseId = await owner.createHouse();
  });
  after(async () => t.close());

  test("a removed member can't walk back in with an invite they made", async () => {
    const m = new Client(t);
    const u = await m.signup("sneaky_sam");
    await m.join(owner, houseId);
    const saved = (await m.req("POST", `/api/houses/${houseId}/invites`)).json.token;
    await owner.req("DELETE", `/api/houses/${houseId}/members/${u.id}`);
    assert.notEqual((await m.req("POST", `/api/invites/${saved}/accept`)).status, 200);
    assert.equal((await m.req("GET", `/api/houses/${houseId}`)).status, 404);
  });

  test("a removed member's invites stop working for everyone", async () => {
    const m = new Client(t);
    const u = await m.signup("inviter_ian");
    await m.join(owner, houseId);
    const token = (await m.req("POST", `/api/houses/${houseId}/invites`)).json.token;
    await owner.req("DELETE", `/api/houses/${houseId}/members/${u.id}`);
    const stranger = new Client(t);
    await stranger.signup("stranger_sid");
    assert.equal((await stranger.req("POST", `/api/invites/${token}/accept`)).status, 404);
  });

  test("a removed member can't use someone else's invite until the owner lets them back", async () => {
    const m = new Client(t);
    const u = await m.signup("banned_bo");
    await m.join(owner, houseId);
    await owner.req("DELETE", `/api/houses/${houseId}/members/${u.id}`);
    const fresh = (await owner.req("POST", `/api/houses/${houseId}/invites`)).json.token;
    const denied = await m.req("POST", `/api/invites/${fresh}/accept`);
    assert.equal(denied.status, 403);
    assert.match(denied.json.error, /removed/);
    const bans = await owner.req("GET", `/api/houses/${houseId}/bans`);
    assert.ok(bans.json.removed.some((b: any) => b.id === u.id));
    await owner.req("DELETE", `/api/houses/${houseId}/bans/${u.id}`);
    assert.equal((await m.req("POST", `/api/invites/${fresh}/accept`)).status, 200);
  });

  test("leaving voluntarily doesn't ban you", async () => {
    const m = new Client(t);
    const u = await m.signup("leaver_lu");
    await m.join(owner, houseId);
    await m.req("DELETE", `/api/houses/${houseId}/members/${u.id}`);
    await m.join(owner, houseId);
    assert.equal((await m.req("GET", `/api/houses/${houseId}`)).status, 200);
  });

  test("the owner can turn off every invite link, and only the owner", async () => {
    const m = new Client(t);
    await m.signup("member_mo");
    await m.join(owner, houseId);
    const token = (await owner.req("POST", `/api/houses/${houseId}/invites`)).json.token;
    assert.equal((await m.req("DELETE", `/api/houses/${houseId}/invites`)).status, 403);
    assert.equal((await m.req("GET", `/api/houses/${houseId}/bans`)).status, 403);
    assert.equal((await owner.req("DELETE", `/api/houses/${houseId}/invites`)).status, 200);
    const late = new Client(t);
    await late.signup("late_lee");
    assert.equal((await late.req("POST", `/api/invites/${token}/accept`)).status, 404);
  });
});

describe("restore can only bring back versions that were live", () => {
  let t: TestApp;
  const model = new ScriptedModel([]);
  before(async () => (t = await startApp({ model })));
  after(async () => t.close());

  test("a discarded build can't be restored into production", async () => {
    const owner = new Client(t);
    const member = new Client(t);
    await owner.signup("owner_rae");
    await member.signup("member_max");
    const houseId = await owner.createHouse();
    await member.join(owner, houseId);
    model.setScript([
      assistant([toolUse("write_file", { path: "evil.js", content: "/* not approved */" })]),
      assistant([text("done")], "end_turn"),
    ]);
    const r = await owner.req("POST", `/api/houses/${houseId}/runs`, { prompt: "draft" });
    const run = await waitUntil(async () => {
      const runs = (await owner.req("GET", `/api/houses/${houseId}/runs`)).json.runs;
      return runs.find((x: any) => x.id === r.json.run.id && x.status === "ready");
    });
    await owner.req("POST", `/api/houses/${houseId}/runs/${run.id}/discard`);
    const attempt = await member.req("POST", `/api/houses/${houseId}/versions/${run.resultSha}/restore`);
    assert.equal(attempt.status, 404);
    const live = (await member.req("GET", `/api/houses/${houseId}/frame`)).json.url;
    assert.equal((await frameGet(t, live, "evil.js")).status, 404);
  });
});

describe("login can't be used to lock people out", () => {
  let t: TestApp;
  before(async () => (t = await startApp({ config: { trustProxy: true } })));
  after(async () => t.close());

  test("failures from one address don't block the owner logging in from another", async () => {
    const victim = new Client(t);
    await victim.signup("victim_vi");
    const attacker = new Client(t);
    for (let i = 0; i < 15; i++) {
      await attacker.req("POST", "/api/auth/login", { username: "victim_vi", password: "guess guess " + i }, { "x-forwarded-for": "203.0.113.9" });
    }
    const blocked = await attacker.req("POST", "/api/auth/login", { username: "victim_vi", password: "another guess" }, { "x-forwarded-for": "203.0.113.9" });
    assert.equal(blocked.status, 429);
    const real = await new Client(t).req("POST", "/api/auth/login", { username: "victim_vi", password: "a long enough password" }, { "x-forwarded-for": "198.51.100.7" });
    assert.equal(real.status, 200);
  });

  test("successful logins aren't rate limited", async () => {
    const c = new Client(t);
    await c.signup("frequent_fi");
    for (let i = 0; i < 15; i++) {
      const r = await new Client(t).req("POST", "/api/auth/login", { username: "frequent_fi", password: "a long enough password" }, { "x-forwarded-for": "192.0.2.1" });
      assert.equal(r.status, 200);
    }
  });

  test("only the proxy-appended address counts, not client-supplied ones", async () => {
    const c = new Client(t);
    await c.signup("spoof_sp");
    for (let i = 0; i < 12; i++) {
      await c.req("POST", "/api/auth/login", { username: "spoof_sp", password: "wrong " + i }, { "x-forwarded-for": `10.0.0.${i}, 203.0.113.50` });
    }
    const r = await c.req("POST", "/api/auth/login", { username: "spoof_sp", password: "wrong" }, { "x-forwarded-for": "10.9.9.9, 203.0.113.50" });
    assert.equal(r.status, 429);
  });
});

describe("realtime resource limits", () => {
  let t: TestApp;
  before(async () => (t = await startApp()));
  after(async () => t.close());

  test("one account can hold at most 8 sockets", async () => {
    const c = new Client(t);
    await c.signup("hoarder_ho");
    const sockets = [];
    for (let i = 0; i < 8; i++) sockets.push(await c.ws());
    await assert.rejects(c.ws(), /429/);
    sockets.pop()!.close();
    await new Promise((r) => setTimeout(r, 100));
    sockets.push(await c.ws());
    for (const s of sockets) s.close();
  });

  test("sockets close when their session ends", async () => {
    const c = new Client(t);
    await c.signup("expiring_ex");
    const ws = await c.ws();
    const closed = new Promise<number>((r) => ws.ws.once("close", (code) => r(code)));
    t.app.svc.db.prepare("UPDATE sessions SET expires_at = 0").run();
    (t.app.svc.hub as unknown as { ping(): void }).ping();
    assert.equal(await closed, 4001);
  });

  test("houses never see usernames", async () => {
    const a = new Client(t);
    const b = new Client(t);
    await a.signup("secret_login_a", "Ann");
    await b.signup("secret_login_b", "Bea");
    const houseId = await a.createHouse();
    const ws = await a.ws();
    await ws.sub(houseId);
    await b.join(a, houseId);
    const ev = await ws.waitFor((m) => m.t === "ev" && m.name === "members");
    const list = await ws.req(houseId, "members.list", {});
    const api = await a.req("GET", `/api/houses/${houseId}`);
    for (const blob of [ev.data, list.result, api.json.members]) {
      assert.doesNotMatch(JSON.stringify(blob), /secret_login/);
    }
    ws.close();
  });
});

describe("house pages only render inside the app", () => {
  let t: TestApp;
  before(async () => (t = await startApp()));
  after(async () => t.close());

  test("the check harness isn't served by the platform", async () => {
    for (const p of ["/check-harness.html", "/__check/harness.html", "/shell/check-harness.js", "/__check/check-harness.js"]) {
      assert.equal((await fetch(t.base + p)).status, 404, p);
    }
  });

  test("top-level navigations to a house page are refused; frame loads work", async () => {
    const c = new Client(t);
    await c.signup("tab_tess");
    const houseId = await c.createHouse();
    const url = new URL((await c.req("GET", `/api/houses/${houseId}/frame`)).json.url);
    const get = (dest: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: t.cfg.housePort, path: url.pathname, headers: { host: url.host, "sec-fetch-dest": dest } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
    assert.equal(await get("document"), 403);
    assert.equal(await get("iframe"), 200);
  });
});

describe("house file serving stays cheap", () => {
  let t: TestApp;
  before(async () => (t = await startApp()));
  after(async () => t.close());

  test("repeated misses don't spawn git again", async () => {
    const c = new Client(t);
    await c.signup("prober_pr");
    const houseId = await c.createHouse();
    const url = (await c.req("GET", `/api/houses/${houseId}/frame`)).json.url;
    const repos = t.app.svc.repos as unknown as { readFile: (...a: unknown[]) => Promise<Buffer | null> };
    const original = repos.readFile.bind(repos);
    let calls = 0;
    repos.readFile = async (...a: unknown[]) => {
      calls++;
      return original(...a);
    };
    for (let i = 0; i < 20; i++) assert.equal((await frameGet(t, url, "nope.js")).status, 404);
    assert.equal(calls, 1);
    repos.readFile = original;
  });
});
