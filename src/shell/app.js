// The trusted shell: accounts, houses, invites, the agent, history, and the frame
// that hosts each house. Nothing in here is editable by houses or by agents.
// No innerHTML anywhere: every string from the server goes through textContent.

import { mountHouseFrame } from "./bridge.js";

const app = document.getElementById("app");
const toasts = document.getElementById("toasts");

// ---------------------------------------------------------------------------
// tiny DOM helper

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    // CSSOM, not the style attribute: the shell's CSP forbids inline style attributes.
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function toast(text) {
  const el = h("div", { class: "toast", text });
  toasts.append(el);
  setTimeout(() => el.remove(), 5000);
}

const COLORS = ["#d9622b", "#2b7bd9", "#2f9e6e", "#9b4fd1", "#c9413f", "#b8860b", "#1f8a9e", "#c2417f"];
function colorFor(id) {
  let x = 0;
  for (const ch of id) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[x % COLORS.length];
}
function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}
const relFmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(ts) {
  const s = Math.round((ts - Date.now()) / 1000);
  if (Math.abs(s) < 60) return relFmt.format(s, "second");
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return relFmt.format(m, "minute");
  const hr = Math.round(m / 60);
  if (Math.abs(hr) < 24) return relFmt.format(hr, "hour");
  return relFmt.format(Math.round(hr / 24), "day");
}

// ---------------------------------------------------------------------------
// HTTP + realtime

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

class Realtime {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.subs = new Set();
    this.queue = [];
    this.listeners = new Set();
    this.backoff = 500;
    this.stopped = false;
  }
  start() {
    this.stopped = false;
    if (!this.ws) this.connect();
  }
  stop() {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }
  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      for (const house of this.subs) ws.send(JSON.stringify({ t: "sub", house }));
      for (const msg of this.queue.splice(0)) ws.send(msg);
      this.emit({ t: "open" });
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === "res") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.error || "Request failed"), { status: msg.status }));
        return;
      }
      this.emit(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Connection lost"));
      }
      this.pending.clear();
      this.emit({ t: "close" });
      if (!this.stopped) {
        setTimeout(() => !this.stopped && !this.ws && this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 10_000);
      }
    };
  }
  sendRaw(obj) {
    const text = JSON.stringify(obj);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.queue.push(text);
  }
  sub(house) {
    this.subs.add(house);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "sub", house }));
  }
  unsub(house) {
    this.subs.delete(house);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "unsub", house }));
  }
  req(house, op, args) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Timed out"));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.sendRaw({ t: "req", id, house, op, args });
    });
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(msg) {
    for (const fn of this.listeners) fn(msg);
  }
}

const rt = new Realtime();
let me = null;
let cleanupView = () => {};

// ---------------------------------------------------------------------------
// routing

function navigate(path) {
  history.pushState(null, "", path);
  route();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[data-nav]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});
window.addEventListener("popstate", route);

async function route() {
  cleanupView();
  cleanupView = () => {};
  const path = location.pathname;
  if (!me) {
    try {
      me = (await api("GET", "/api/me")).user;
    } catch {
      me = null;
    }
  }
  if (!me) {
    rt.stop();
    return renderAuth();
  }
  rt.start();
  let m;
  if ((m = /^\/house\/([0-9a-f]{16})$/.exec(path))) return renderHouse(m[1]);
  if ((m = /^\/invite\/([A-Za-z0-9_-]+)$/.exec(path))) return renderInvite(m[1]);
  return renderHome();
}

// ---------------------------------------------------------------------------
// auth

function renderAuth() {
  let mode = "login";
  const error = h("p", { class: "error-text" });
  const username = h("input", { name: "username", autocomplete: "username", required: true, maxlength: 24 });
  const display = h("input", { name: "displayName", autocomplete: "nickname", maxlength: 40 });
  const password = h("input", { name: "password", type: "password", autocomplete: "current-password", required: true });
  const displayField = h("label", { class: "field" }, "Display name", display);
  const submit = h("button", { class: "btn primary", type: "submit" }, "Log in");
  const tabLogin = h("button", { class: "btn", type: "button", "aria-pressed": "true" }, "Log in");
  const tabSignup = h("button", { class: "btn", type: "button", "aria-pressed": "false" }, "Sign up");

  function setMode(next) {
    mode = next;
    tabLogin.setAttribute("aria-pressed", String(mode === "login"));
    tabSignup.setAttribute("aria-pressed", String(mode === "signup"));
    displayField.hidden = mode === "login";
    password.autocomplete = mode === "login" ? "current-password" : "new-password";
    submit.textContent = mode === "login" ? "Log in" : "Create account";
    error.textContent = "";
  }
  tabLogin.addEventListener("click", () => setMode("login"));
  tabSignup.addEventListener("click", () => setMode("signup"));

  const form = h(
    "form",
    {
      class: "card",
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = "";
        submit.disabled = true;
        try {
          const body =
            mode === "login"
              ? { username: username.value.trim().toLowerCase(), password: password.value }
              : {
                  username: username.value.trim().toLowerCase(),
                  password: password.value,
                  displayName: display.value.trim() || username.value.trim(),
                };
          me = (await api("POST", mode === "login" ? "/api/auth/login" : "/api/auth/signup", body)).user;
          route();
        } catch (err) {
          error.textContent = err.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h("h1", { class: "brand" }, "Dynamic Chats"),
    h("p", { class: "lede" }, "A group chat your group can rebuild into anything: a game room, a studio, a house with rooms. Just describe it."),
    h("div", { class: "tabs" }, tabLogin, tabSignup),
    h("label", { class: "field" }, "Username", username),
    displayField,
    h("label", { class: "field" }, "Password", password),
    error,
    submit,
  );
  setMode("login");
  app.replaceChildren(h("div", { class: "page" }, form));
}

async function logout() {
  await api("POST", "/api/auth/logout").catch(() => {});
  me = null;
  rt.stop();
  navigate("/");
}

// ---------------------------------------------------------------------------
// home

async function renderHome() {
  const list = h("ul", { class: "house-list" });
  const name = h("input", { placeholder: "Name your house, e.g. The Clubhouse", maxlength: 60, required: true });
  const error = h("p", { class: "error-text" });
  const create = h("button", { class: "btn primary", type: "submit" }, "Create house");

  app.replaceChildren(
    h(
      "div",
      { class: "page" },
      h(
        "div",
        { class: "card wide" },
        h(
          "div",
          { class: "row spread" },
          h("h1", { class: "brand" }, "Your houses"),
          h("div", { class: "row" }, h("span", { class: "muted", text: `Signed in as ${me.name}` }), h("button", { class: "btn small", onclick: logout }, "Log out")),
        ),
        list,
        h(
          "form",
          {
            class: "row",
            onsubmit: async (e) => {
              e.preventDefault();
              error.textContent = "";
              create.disabled = true;
              try {
                const { house } = await api("POST", "/api/houses", { name: name.value.trim() });
                navigate(`/house/${house.id}`);
              } catch (err) {
                error.textContent = err.message;
              } finally {
                create.disabled = false;
              }
            },
          },
          h("label", { class: "field", style: "flex:1" }, name),
          create,
        ),
        error,
      ),
    ),
  );

  try {
    const { houses } = await api("GET", "/api/houses");
    if (houses.length === 0) {
      list.append(h("li", { class: "muted" }, "No houses yet. Create one, then invite your friends."));
    }
    for (const house of houses) {
      list.append(
        h(
          "li",
          { class: "house-item" },
          h(
            "a",
            { href: `/house/${house.id}`, "data-nav": true },
            h("span", { class: "name", text: house.name }),
            h("span", { class: "muted", text: `${house.members} ${house.members === 1 ? "person" : "people"} · ${house.role}` }),
          ),
        ),
      );
    }
  } catch (err) {
    error.textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// invites

async function renderInvite(token) {
  const card = h("div", { class: "card" }, h("p", { class: "muted" }, "Checking invite…"));
  app.replaceChildren(h("div", { class: "page" }, card));
  try {
    const info = await api("GET", `/api/invites/${encodeURIComponent(token)}`);
    if (info.alreadyMember) return navigate(`/house/${info.houseId}`);
    const error = h("p", { class: "error-text" });
    const join = h("button", { class: "btn primary" }, "Move in");
    join.addEventListener("click", async () => {
      join.disabled = true;
      try {
        const { houseId } = await api("POST", `/api/invites/${encodeURIComponent(token)}/accept`);
        navigate(`/house/${houseId}`);
      } catch (err) {
        error.textContent = err.message;
        join.disabled = false;
      }
    });
    card.replaceChildren(
      h("h1", { class: "brand", text: info.houseName }),
      h("p", { class: "lede", text: `${info.inviter} invited you to move in. Everyone in a house can chat, play, and rebuild the place together.` }),
      error,
      h("div", { class: "row" }, join, h("a", { class: "btn", href: "/", "data-nav": true }, "Not now")),
    );
  } catch (err) {
    card.replaceChildren(h("p", { class: "error-text", text: err.message }), h("a", { class: "btn", href: "/", "data-nav": true }, "Go home"));
  }
}

// ---------------------------------------------------------------------------
// house view

async function renderHouse(houseId) {
  const view = {
    houseId,
    house: null,
    role: "member",
    members: [],
    online: [],
    liveSha: null,
    previewRun: null,
    frame: null,
    remounts: 0,
    reports: [],
    runs: [],
    versions: [],
    drawer: null,
    disposed: false,
  };

  const title = h("span", { class: "title" });
  const faces = h("div", { class: "faces" });
  const errorsBadge = h("button", { class: "badge", hidden: true, title: "Errors reported by this house" });
  const banner = h("div", { class: "banner" });
  const frameWrap = h("div", { class: "frame-wrap" });
  const drawerBody = h("div", { class: "drawer-body" });
  const tabButtons = {
    build: h("button", { class: "btn small", "aria-pressed": "false" }, "Build"),
    history: h("button", { class: "btn small", "aria-pressed": "false" }, "History"),
    people: h("button", { class: "btn small", "aria-pressed": "false" }, "People"),
  };
  const drawer = h("aside", { class: "drawer", hidden: true }, h("div", { class: "drawer-head" }, ...Object.values(tabButtons), h("button", { class: "btn small", "aria-label": "Close panel", onclick: () => openDrawer(null) }, "✕")), drawerBody);

  const buildBtn = h("button", { class: "btn primary small", onclick: () => openDrawer("build") }, "✦ Build");
  const bar = h(
    "header",
    { class: "shellbar" },
    h("a", { class: "btn small", href: "/", "data-nav": true, "aria-label": "All houses" }, "←"),
    h("div", { class: "grow" }, title, h("span", { class: "shield", title: "This bar belongs to the app. Everything below it is made by the house's members." }, "app"), faces, errorsBadge),
    h("button", { class: "btn small", onclick: () => openDrawer("people") }, "Invite"),
    h("button", { class: "btn small", onclick: () => openDrawer("history") }, "History"),
    buildBtn,
  );
  app.replaceChildren(h("div", { class: "house-view" }, bar, banner, h("div", { class: "stage" }, frameWrap, drawer)));

  for (const [name, btn] of Object.entries(tabButtons)) btn.addEventListener("click", () => openDrawer(name));
  errorsBadge.addEventListener("click", () => {
    openDrawer("build");
    const area = drawerBody.querySelector("textarea");
    if (area) {
      const lines = view.reports.filter((r) => r.kind !== "console").slice(-5).map((r) => `- ${r.detail.replace(/\s+/g, " ").slice(0, 200)}`);
      area.value = `Fix these errors the house reported:\n${lines.join("\n")}`;
      area.focus();
    }
  });

  // -- realtime -------------------------------------------------------------
  const off = rt.on((msg) => {
    if (view.disposed) return;
    if (msg.t === "open") return;
    if (msg.house !== houseId) return;
    if (msg.t === "subbed") {
      view.online = msg.online;
      renderFaces();
      view.frame?.push("presence", { online: view.online });
      return;
    }
    if (msg.t === "kicked" || msg.t === "suberror") {
      toast("You're no longer a member of that house.");
      navigate("/");
      return;
    }
    if (msg.t !== "ev") return;
    switch (msg.name) {
      case "chat.message":
      case "state.change":
      case "event":
        view.frame?.push(msg.name, msg.data);
        break;
      case "members":
        view.members = msg.data;
        renderFaces();
        view.frame?.push("members", msg.data);
        if (view.drawer === "people") renderDrawer();
        break;
      case "presence":
        view.online = msg.data.online;
        renderFaces();
        view.frame?.push("presence", msg.data);
        break;
      case "version":
        view.liveSha = msg.data.sha;
        if (msg.data.by?.id !== me.id) toast(`${msg.data.by?.name ?? "Someone"} changed the house. See History for details.`);
        if (!view.previewRun) mountFrame(view.liveSha);
        else setBanner();
        if (view.drawer === "history") loadVersions();
        break;
      case "run": {
        const run = msg.data;
        const i = view.runs.findIndex((r) => r.id === run.id);
        const prev = i >= 0 ? view.runs[i] : null;
        if (i >= 0) view.runs[i] = run;
        else view.runs.unshift(run);
        if (run.by.id === me.id && prev?.status !== "ready" && run.status === "ready") toast("Your change is ready. Preview it, then ship it.");
        if (run.by.id === me.id && prev?.status !== "failed" && run.status === "failed") toast("The builder couldn't finish that change.");
        if (view.previewRun?.id === run.id && run.status !== "ready") exitPreview();
        if (view.drawer === "build") renderDrawer();
        break;
      }
    }
  });
  rt.sub(houseId);

  cleanupView = () => {
    view.disposed = true;
    off();
    rt.unsub(houseId);
    view.frame?.destroy();
  };

  // -- load -----------------------------------------------------------------
  try {
    const data = await api("GET", `/api/houses/${houseId}`);
    if (view.disposed) return;
    view.house = data.house;
    view.role = data.role;
    view.members = data.members;
    view.liveSha = data.house.liveSha;
    if (data.online) view.online = data.online;
    title.textContent = data.house.name;
    document.title = `${data.house.name} · Dynamic Chats`;
    renderFaces();
    await mountFrame(view.liveSha);
    const runs = await api("GET", `/api/houses/${houseId}/runs`);
    view.runs = runs.runs;
  } catch (err) {
    if (err.status === 404) {
      toast("That house doesn't exist, or you're not a member.");
      return navigate("/");
    }
    setBanner(err.message, "bad");
  }

  // -- helpers --------------------------------------------------------------
  function renderFaces() {
    const online = new Set(view.online);
    faces.replaceChildren(
      ...view.members.slice(0, 8).map((m) =>
        h("span", { class: `face${online.has(m.id) ? " online" : ""}`, style: `background:${colorFor(m.id)}`, title: `${m.name}${online.has(m.id) ? " (here)" : ""}` }, initials(m.name)),
      ),
    );
  }

  function setBanner(text, kind = "warn", actions = []) {
    if (!text && view.previewRun) {
      const run = view.previewRun;
      const canShip = run.by.id === me.id || view.role === "owner";
      banner.className = "banner info";
      banner.replaceChildren(
        h("strong", {}, "Previewing: "),
        h("span", { text: run.prompt.length > 90 ? run.prompt.slice(0, 90) + "…" : run.prompt }),
        h("span", { class: "muted" }, "Only you see this. It uses the house's real chat and state."),
        canShip ? h("button", { class: "btn small primary", onclick: () => shipRun(run) }, "Ship it") : null,
        h("button", { class: "btn small", onclick: exitPreview }, "Back to live"),
      );
      return;
    }
    if (!text) {
      banner.className = "banner";
      banner.replaceChildren();
      return;
    }
    banner.className = `banner ${kind === "warn" ? "" : kind}`;
    banner.replaceChildren(h("span", { text }), ...actions);
  }

  async function mountFrame(sha) {
    const { url } = await api("GET", `/api/houses/${houseId}/frame?sha=${encodeURIComponent(sha)}`);
    if (view.disposed) return;
    view.frame?.destroy();
    view.reports = [];
    errorsBadge.hidden = true;
    setBanner();
    view.frame = mountHouseFrame({
      container: frameWrap,
      url,
      context: { house: { id: houseId, name: view.house.name }, me: { id: me.id, name: me.name }, members: view.members, online: view.online },
      request: (op, args) => rt.req(houseId, op, args),
      onReport: (r) => {
        view.reports.push(r);
        if (view.reports.length > 50) view.reports.shift();
        const n = view.reports.filter((x) => x.kind !== "console").length;
        if (n > 0) {
          errorsBadge.hidden = false;
          errorsBadge.textContent = `${n} error${n === 1 ? "" : "s"}`;
        }
      },
      onStatus: (status) => {
        if (status === "connected") {
          view.remounts = 0;
          return;
        }
        if (status === "unresponsive") {
          setBanner("This house isn't responding. It may be broken.", "warn", [
            h("button", { class: "btn small", onclick: () => openDrawer("history") }, "Restore a version"),
          ]);
        }
        if (status === "navigated") {
          view.remounts += 1;
          if (view.remounts <= 3) {
            mountFrame(sha);
            toast("The house tried to navigate away, so the app reloaded it.");
          } else {
            setBanner("This house keeps navigating away, so the app stopped loading it.", "bad", [
              h("button", { class: "btn small", onclick: () => openDrawer("history") }, "Restore a version"),
            ]);
          }
        }
      },
    });
  }

  function previewRun(run) {
    view.previewRun = run;
    mountFrame(run.resultSha);
    setBanner();
  }

  function exitPreview() {
    view.previewRun = null;
    mountFrame(view.liveSha);
    setBanner();
  }

  async function shipRun(run) {
    try {
      const res = await api("POST", `/api/houses/${houseId}/runs/${run.id}/ship`);
      view.previewRun = null;
      if (res.run.status === "conflict") {
        toast("Someone changed the same part of the house first. Ask the builder again on top of the new version.");
      } else {
        toast("Shipped. Everyone in the house sees it now.");
      }
      view.liveSha = res.liveSha ?? view.liveSha;
      mountFrame(view.liveSha);
    } catch (err) {
      toast(err.message);
    }
  }

  async function discardRun(run) {
    try {
      await api("POST", `/api/houses/${houseId}/runs/${run.id}/discard`);
      if (view.previewRun?.id === run.id) exitPreview();
    } catch (err) {
      toast(err.message);
    }
  }

  async function loadVersions() {
    try {
      view.versions = (await api("GET", `/api/houses/${houseId}/versions`)).versions;
      if (view.drawer === "history") renderDrawer();
    } catch (err) {
      toast(err.message);
    }
  }

  function openDrawer(name) {
    view.drawer = view.drawer === name ? null : name;
    drawer.hidden = !view.drawer;
    for (const [n, btn] of Object.entries(tabButtons)) btn.setAttribute("aria-pressed", String(n === view.drawer));
    if (view.drawer === "history") loadVersions();
    renderDrawer();
  }

  function renderDrawer() {
    if (!view.drawer) return;
    if (view.drawer === "build") return renderBuild();
    if (view.drawer === "history") return renderHistory();
    if (view.drawer === "people") return renderPeople();
  }

  function renderBuild() {
    const existing = drawerBody.querySelector("textarea");
    const draft = existing ? existing.value : "";
    const prompt = h("textarea", { rows: 4, maxlength: 4000, placeholder: "Describe what should change. “Turn the living room into a pixel-art café where our messages float as speech bubbles”, “add a tic-tac-toe table everyone can play”…" });
    prompt.value = draft;
    const error = h("p", { class: "error-text" });
    const go = h("button", { class: "btn primary", type: "submit" }, "Build it");
    const form = h(
      "form",
      {
        class: "field",
        onsubmit: async (e) => {
          e.preventDefault();
          const text = prompt.value.trim();
          if (!text) return;
          go.disabled = true;
          error.textContent = "";
          try {
            const { run } = await api("POST", `/api/houses/${houseId}/runs`, { prompt: text });
            prompt.value = "";
            if (!view.runs.some((r) => r.id === run.id)) view.runs.unshift(run);
            renderBuild();
          } catch (err) {
            error.textContent = err.message;
          } finally {
            go.disabled = false;
          }
        },
      },
      h("span", { class: "muted" }, "The builder edits a private copy of the house. You preview it, then ship it to everyone."),
      prompt,
      error,
      go,
    );
    const runs = view.runs.map((run) => renderRun(run));
    drawerBody.replaceChildren(form, ...(runs.length ? runs : [h("p", { class: "muted" }, "No changes yet.")]));
  }

  function renderRun(run) {
    const mine = run.by.id === me.id;
    const canAct = mine || view.role === "owner";
    const log = h("ol", { class: "run-log" }, ...run.log.slice(-12).map((l) => h("li", { text: l.text })));
    const actions = h("div", { class: "row" });
    if (run.status === "ready") {
      actions.append(h("button", { class: "btn small", onclick: () => previewRun(run) }, view.previewRun?.id === run.id ? "Previewing" : "Preview"));
      if (canAct) actions.append(h("button", { class: "btn small primary", onclick: () => shipRun(run) }, "Ship it"));
    }
    if (canAct && ["queued", "running", "ready", "conflict", "failed"].includes(run.status)) {
      actions.append(h("button", { class: "btn small danger", onclick: () => discardRun(run) }, run.status === "running" || run.status === "queued" ? "Stop" : "Discard"));
    }
    const el = h(
      "div",
      { class: "run" },
      h("div", { class: "run-prompt", text: run.prompt }),
      h("div", { class: "run-meta" }, h("span", { class: `pill ${run.status}`, text: run.status }), h("span", { text: `${run.by.name} · ${ago(run.createdAt)}` })),
      run.summary ? h("div", { class: "run-summary", text: run.summary }) : null,
      run.error ? h("div", { class: "error-text", text: run.error }) : null,
      run.log.length && (run.status === "running" || run.status === "queued") ? log : null,
      actions.childElementCount ? actions : null,
    );
    if (run.status !== "running" && run.log.length) {
      const details = h("details", {}, h("summary", { class: "muted" }, "What the builder did"), log);
      el.insertBefore(details, actions.childElementCount ? actions : null);
    }
    requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
    return el;
  }

  function renderHistory() {
    const items = view.versions.map((v) =>
      h(
        "div",
        { class: `version${v.live ? " live" : ""}` },
        h("div", { class: "run-prompt", text: v.message }),
        h("div", { class: "run-meta" }, v.live ? h("span", { class: "pill ready" }, "live") : null, h("span", { text: `${v.by?.name ?? "app"} · ${ago(v.at)} · ${v.sha.slice(0, 7)}` })),
        v.live
          ? null
          : h(
              "div",
              { class: "row" },
              h(
                "button",
                {
                  class: "btn small",
                  onclick: async () => {
                    try {
                      await api("POST", `/api/houses/${houseId}/versions/${v.sha}/restore`);
                      toast("Restored. Everyone sees that version now.");
                    } catch (err) {
                      toast(err.message);
                    }
                  },
                },
                "Restore this version",
              ),
            ),
      ),
    );
    drawerBody.replaceChildren(
      h("p", { class: "muted" }, "Every change to the house is kept. Restoring makes a new version, so nothing is ever lost. Chat and shared state aren't affected."),
      ...items,
    );
  }

  function renderPeople() {
    const online = new Set(view.online);
    const inviteOut = h("input", { readonly: true, placeholder: "Create a link to invite people" });
    const copy = h("button", { class: "btn small", type: "button", disabled: true }, "Copy");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(inviteOut.value);
        toast("Invite link copied.");
      } catch {
        inviteOut.select();
      }
    });
    const makeInvite = h(
      "button",
      {
        class: "btn small primary",
        type: "button",
        onclick: async () => {
          try {
            const { token } = await api("POST", `/api/houses/${houseId}/invites`);
            inviteOut.value = `${location.origin}/invite/${token}`;
            copy.disabled = false;
            inviteOut.select();
          } catch (err) {
            toast(err.message);
          }
        },
      },
      "New invite link",
    );
    const people = view.members.map((m) =>
      h(
        "div",
        { class: "member" },
        h("div", { class: "row spread" }, h("strong", { text: m.name + (m.id === me.id ? " (you)" : "") }), h("span", { class: "muted", text: `${m.role}${online.has(m.id) ? " · here" : ""}` })),
        view.role === "owner" && m.id !== me.id
          ? h("div", { class: "row" }, h("button", { class: "btn small danger", onclick: () => removeMember(m) }, "Remove from house"))
          : null,
      ),
    );
    const owner = view.role === "owner";
    const removedList = h("div", { class: "field" });
    const footer = owner
      ? h(
          "div",
          { class: "field" },
          h(
            "button",
            {
              class: "btn",
              onclick: async () => {
                if (!confirm("Turn off every invite link for this house? People already inside stay.")) return;
                try {
                  const { revoked } = await api("DELETE", `/api/houses/${houseId}/invites`);
                  toast(`${revoked} invite link${revoked === 1 ? "" : "s"} turned off.`);
                } catch (err) {
                  toast(err.message);
                }
              },
            },
            "Turn off all invite links",
          ),
          h("button", { class: "btn danger", onclick: deleteHouse }, "Delete this house"),
        )
      : h("button", { class: "btn danger", onclick: () => removeMember({ id: me.id, name: me.name }, true) }, "Leave this house");
    drawerBody.replaceChildren(
      h("div", { class: "field" }, h("span", { class: "muted" }, "Invite links work for 7 days and up to 25 people."), h("div", { class: "row" }, makeInvite, copy), inviteOut),
      ...people,
      owner ? removedList : null,
      footer,
    );
    if (owner) loadRemoved(removedList);
  }

  async function loadRemoved(container) {
    try {
      const { removed } = await api("GET", `/api/houses/${houseId}/bans`);
      if (!removed.length) return;
      container.replaceChildren(
        h("span", { class: "muted" }, "Removed. They can't rejoin with an invite until you let them."),
        ...removed.map((p) =>
          h(
            "div",
            { class: "member" },
            h(
              "div",
              { class: "row spread" },
              h("span", { text: p.name }),
              h(
                "button",
                {
                  class: "btn small",
                  onclick: async () => {
                    try {
                      await api("DELETE", `/api/houses/${houseId}/bans/${p.id}`);
                      toast(`${p.name} can rejoin with an invite now.`);
                      loadRemoved(container);
                    } catch (err) {
                      toast(err.message);
                    }
                  },
                },
                "Let back in",
              ),
            ),
          ),
        ),
      );
    } catch {
      /* not critical */
    }
  }

  async function removeMember(m, self = false) {
    const question = self
      ? "Leave this house? You'll need a new invite to come back."
      : `Remove ${m.name} from the house? Their invite links stop working, and they can't rejoin until you let them back in.`;
    if (!confirm(question)) return;
    try {
      await api("DELETE", `/api/houses/${houseId}/members/${m.id}`);
      if (self) navigate("/");
      else if (view.drawer === "people") renderPeople();
    } catch (err) {
      toast(err.message);
    }
  }

  async function deleteHouse() {
    if (!confirm(`Delete ${view.house.name} for everyone? This can't be undone.`)) return;
    try {
      await api("DELETE", `/api/houses/${houseId}`);
      navigate("/");
    } catch (err) {
      toast(err.message);
    }
  }
}

route();
