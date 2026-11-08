/*
 * House SDK. Loaded by every house from /_sdk/house.js on the house origin.
 * Owned by the platform, not by the house repo, so a house edit can't break it.
 *
 * The house runs in a sandboxed iframe with an opaque origin and no network access
 * beyond its own files. Everything social (members, chat, shared state, realtime
 * events) goes through a MessagePort handed over by the trusted shell.
 */
(function () {
  "use strict";
  if (window.House) return;

  var port = null;
  var nextId = 1;
  var pending = new Map();
  var earlyReports = [];
  var ctx = null;
  var members = [];
  var online = new Set();

  var messageListeners = new Set();
  var stateListeners = new Map(); // key -> Set<fn>
  var stateAnyListeners = new Set();
  var eventListeners = new Map(); // name -> Set<fn>
  var eventAnyListeners = new Set();
  var memberListeners = new Set();

  var resolveReady, rejectReady;
  var ready = new Promise(function (res, rej) {
    resolveReady = res;
    rejectReady = rej;
  });
  // Avoid an "unhandled rejection" report if the house never awaits `ready`.
  ready.catch(function () {});

  function report(kind, detail) {
    var payload = { op: "report", args: { kind: kind, detail: String(detail).slice(0, 2000) } };
    if (port) port.postMessage(payload);
    else if (earlyReports.length < 50) earlyReports.push(payload);
  }

  window.addEventListener("error", function (e) {
    var where = e.filename ? " (" + String(e.filename).split("/").pop() + ":" + e.lineno + ")" : "";
    report("error", (e.message || "Script error") + where);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    report("error", "Unhandled promise rejection: " + (r && r.stack ? r.stack : String(r)));
  });
  document.addEventListener("securitypolicyviolation", function (e) {
    report("blocked", e.effectiveDirective + " blocked " + (e.blockedURI || "inline content"));
  });
  var origConsoleError = console.error;
  console.error = function () {
    try {
      report("console", Array.prototype.map.call(arguments, String).join(" "));
    } catch (_) {}
    return origConsoleError.apply(console, arguments);
  };

  function call(op, args) {
    return new Promise(function (resolve, reject) {
      if (!port) return reject(new Error("This house isn't connected to the shell yet. Await House.ready first."));
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      port.postMessage({ id: id, op: op, args: args || {} });
    });
  }

  function emitTo(set, args) {
    set.forEach(function (fn) {
      try {
        fn.apply(null, args);
      } catch (err) {
        report("error", "Listener threw: " + (err && err.stack ? err.stack : err));
      }
    });
  }

  function memberList() {
    return members.map(function (m) {
      return { id: m.id, name: m.name, username: m.username, role: m.role, online: online.has(m.id) };
    });
  }

  function onPortMessage(e) {
    var msg = e.data || {};
    if (typeof msg.id === "number") {
      var p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else {
        var err = new Error(msg.error || "Request failed");
        err.status = msg.status;
        p.reject(err);
      }
      return;
    }
    if (!msg.ev) return;
    var data = msg.data;
    switch (msg.ev) {
      case "chat.message":
        emitTo(messageListeners, [data]);
        break;
      case "state.change": {
        var set = stateListeners.get(data.key);
        if (set) emitTo(set, [data.deleted ? null : data.value, data]);
        emitTo(stateAnyListeners, [data]);
        break;
      }
      case "event": {
        var named = eventListeners.get(data.name);
        var meta = { from: data.from, at: data.at, name: data.name };
        if (named) emitTo(named, [data.data, meta]);
        emitTo(eventAnyListeners, [data.name, data.data, meta]);
        break;
      }
      case "members":
        members = data || [];
        emitTo(memberListeners, [memberList()]);
        break;
      case "presence":
        online = new Set((data && data.online) || []);
        emitTo(memberListeners, [memberList()]);
        break;
    }
  }

  function addListener(set, fn) {
    if (typeof fn !== "function") throw new TypeError("Expected a function");
    set.add(fn);
    return function unsubscribe() {
      set.delete(fn);
    };
  }

  function keyedListener(map, key, fn) {
    if (typeof fn !== "function") throw new TypeError("Expected a function");
    var set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(fn);
    return function unsubscribe() {
      set.delete(fn);
    };
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  var client = {
    get house() {
      return ctx && { id: ctx.house.id, name: ctx.house.name };
    },
    get me() {
      return ctx && { id: ctx.me.id, name: ctx.me.name, username: ctx.me.username };
    },
    get members() {
      return memberList();
    },
    onMembers: function (fn) {
      return addListener(memberListeners, fn);
    },
    chat: {
      send: function (body, opts) {
        return call("chat.send", { body: String(body), channel: (opts && opts.channel) || "main" });
      },
      history: function (opts) {
        opts = opts || {};
        return call("chat.list", { channel: opts.channel || "main", before: opts.before, limit: opts.limit });
      },
      onMessage: function (fn, opts) {
        var channel = opts && opts.channel;
        return addListener(messageListeners, function (msg) {
          if (!channel || msg.channel === channel) fn(msg);
        });
      },
    },
    state: {
      get: function (key) {
        return call("state.get", { key: key });
      },
      list: function (prefix) {
        return call("state.list", { prefix: prefix || "" });
      },
      set: function (key, value, opts) {
        return call("state.set", { key: key, value: value, ifRev: opts && opts.ifRev });
      },
      delete: function (key, opts) {
        return call("state.delete", { key: key, ifRev: opts && opts.ifRev });
      },
      /** Read-modify-write with automatic retry on conflicting writes. */
      update: async function (key, fn, opts) {
        var retries = (opts && opts.retries) || 8;
        for (var attempt = 0; ; attempt++) {
          var current = await call("state.get", { key: key });
          var next = await fn(current ? current.value : undefined);
          try {
            return await call("state.set", { key: key, value: next, ifRev: current ? current.rev : 0 });
          } catch (err) {
            if (attempt >= retries || !/Revision mismatch/.test(err.message)) throw err;
            await sleep(15 + Math.random() * 40 * (attempt + 1));
          }
        }
      },
      on: function (key, fn) {
        return keyedListener(stateListeners, key, fn);
      },
      onAny: function (fn) {
        return addListener(stateAnyListeners, fn);
      },
    },
    events: {
      emit: function (name, data) {
        return call("events.emit", { name: name, data: data === undefined ? null : data });
      },
      on: function (name, fn) {
        return keyedListener(eventListeners, name, fn);
      },
      onAny: function (fn) {
        return addListener(eventAnyListeners, fn);
      },
    },
  };

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent || port) return;
    var data = e.data;
    if (!data || data.type !== "house-sdk-welcome" || !e.ports || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = onPortMessage;
    ctx = { house: data.house, me: data.me };
    members = data.members || [];
    online = new Set(data.online || []);
    earlyReports.splice(0).forEach(function (r) {
      port.postMessage(r);
    });
    resolveReady(client);
  });

  // Say hello until the shell answers (it may still be wiring up the frame).
  var hellos = 0;
  (function hello() {
    if (port) return;
    if (hellos++ >= 40) {
      rejectReady(new Error("No house shell answered. Houses only run inside the app."));
      return;
    }
    window.parent.postMessage({ type: "house-sdk-hello", v: 1 }, "*");
    setTimeout(hello, 250);
  })();

  window.House = Object.freeze({ ready: ready, version: 1 });
})();
