// Headless check harness used by the agent's check() tool. Mounts a house version
// with the real bridge but an in-memory backend: two fake members, a few seeded
// messages, private state. Nothing here touches real house data.

import { mountHouseFrame } from "./bridge.js";

const params = new URLSearchParams(location.hash.slice(1));
const url = params.get("frame");
const houseName = params.get("name") || "Test House";

const me = { id: "0000000000000001", name: "Alex Tester" };
const friend = { id: "0000000000000002", name: "Sam Friend" };
const members = [
  { ...me, role: "owner" },
  { ...friend, role: "member" },
];

const report = { connected: false, status: "loading", errors: [], blocked: [], console: [], ops: 0 };
window.__houseCheck = report;

let nextMsg = 1;
const messages = [
  { id: nextMsg++, channel: "main", body: "hey! welcome to the house", at: Date.now() - 600_000, from: { id: friend.id, name: friend.name } },
  { id: nextMsg++, channel: "main", body: "this place is great", at: Date.now() - 300_000, from: { id: me.id, name: me.name } },
];
const state = new Map();

function entry(key) {
  const e = state.get(key);
  return e ? { ...e } : null;
}

let frame;
async function request(op, args) {
  report.ops += 1;
  switch (op) {
    case "chat.send": {
      const body = String(args.body ?? "").trim();
      if (!body) throw new Error("body: Too small");
      const msg = { id: nextMsg++, channel: args.channel || "main", body: body.slice(0, 4000), at: Date.now(), from: { id: me.id, name: me.name } };
      messages.push(msg);
      queueMicrotask(() => frame?.push("chat.message", msg));
      return msg;
    }
    case "chat.list": {
      const channel = args.channel || "main";
      const before = args.before ?? Infinity;
      const limit = Math.min(args.limit ?? 50, 100);
      return messages.filter((m) => m.channel === channel && m.id < before).slice(-limit);
    }
    case "state.get":
      return entry(args.key);
    case "state.list":
      return [...state.keys()].filter((k) => k.startsWith(args.prefix || "")).sort().map(entry);
    case "state.set": {
      const current = state.get(args.key);
      const rev = current?.rev ?? 0;
      if (args.ifRev !== undefined && args.ifRev !== rev) throw new Error(`Revision mismatch: key is at ${rev}`);
      if (args.value === undefined) throw new Error("State values must be JSON");
      const e = { key: args.key, value: JSON.parse(JSON.stringify(args.value)), rev: rev + 1, by: me.id, at: Date.now() };
      state.set(args.key, e);
      queueMicrotask(() => frame?.push("state.change", e));
      return { ...e };
    }
    case "state.delete": {
      const current = state.get(args.key);
      if (args.ifRev !== undefined && args.ifRev !== (current?.rev ?? 0)) throw new Error("Revision mismatch");
      state.delete(args.key);
      if (current) queueMicrotask(() => frame?.push("state.change", { key: args.key, value: null, rev: 0, by: me.id, at: Date.now(), deleted: true }));
      return { deleted: Boolean(current) };
    }
    case "events.emit":
      return { delivered: true };
    case "members.list":
      return { members, online: [me.id, friend.id] };
    default:
      throw new Error(`Unknown op ${op}`);
  }
}

if (!url) {
  report.status = "no-frame";
} else {
  frame = mountHouseFrame({
    container: document.getElementById("frame"),
    url,
    context: { house: { id: "check", name: houseName }, me, members, online: [me.id, friend.id] },
    request,
    onReport: (r) => {
      const list = r.kind === "blocked" ? report.blocked : r.kind === "console" ? report.console : report.errors;
      if (list.length < 30 && !list.includes(r.detail)) list.push(r.detail);
    },
    onStatus: (s) => {
      report.status = s;
      if (s === "connected") report.connected = true;
    },
  });
}
