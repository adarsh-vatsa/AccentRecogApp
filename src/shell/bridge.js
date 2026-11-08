// The bridge between the trusted shell and an untrusted house frame.
//
// The house runs in an iframe with an opaque origin. It cannot read the shell's
// cookies, DOM or storage, and it has no network access of its own. The only thing
// it can do is ask the shell, over a MessagePort, to perform one of a fixed set of
// operations on the house it belongs to. The shell decides which house that is.

export const HOUSE_SANDBOX = "allow-scripts allow-forms allow-pointer-lock";
export const HOUSE_ALLOW = "autoplay; gamepad";

const ALLOWED_OPS = new Set([
  "chat.send",
  "chat.list",
  "state.get",
  "state.list",
  "state.set",
  "state.delete",
  "events.emit",
  "members.list",
]);

const MAX_MESSAGE_BYTES = 48 * 1024;

class Bucket {
  constructor(capacity, perSecond) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.tokens = capacity;
    this.updated = performance.now();
  }
  take() {
    const now = performance.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updated) / 1000) * this.perSecond);
    this.updated = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

function approxSize(value) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Infinity;
  }
}

/**
 * Mount a house frame.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container
 * @param {string} opts.url          capability URL for one version of the house
 * @param {{house: object, me: object, members: object[], online: string[]}} opts.context
 * @param {(op: string, args: object) => Promise<unknown>} opts.request  performs an op for this house
 * @param {(report: {kind: string, detail: string}) => void} [opts.onReport]
 * @param {(status: "connected" | "unresponsive" | "navigated") => void} [opts.onStatus]
 */
export function mountHouseFrame(opts) {
  const { container, url, context, request } = opts;
  const onReport = opts.onReport ?? (() => {});
  const onStatus = opts.onStatus ?? (() => {});
  const limiter = new Bucket(200, 60);

  const iframe = document.createElement("iframe");
  iframe.className = "house-frame";
  iframe.title = `${context.house.name} (made by its members)`;
  iframe.setAttribute("sandbox", HOUSE_SANDBOX);
  iframe.setAttribute("allow", HOUSE_ALLOW);
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("loading", "eager");
  // Set src before insertion so there is exactly one load event per mount.
  iframe.src = url;

  let channel = null;
  let destroyed = false;
  let loads = 0;

  function teardown() {
    window.removeEventListener("message", onWindowMessage);
    if (channel) {
      channel.port1.onmessage = null;
      channel.port1.close();
      channel = null;
    }
  }

  function onWindowMessage(event) {
    if (destroyed || channel) return;
    if (event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (!data || data.type !== "house-sdk-hello") return;
    channel = new MessageChannel();
    channel.port1.onmessage = onPortMessage;
    // The frame's origin is opaque, so "*" is the only possible target. The port is
    // what scopes the conversation to this one document: if the frame navigates
    // away, the port goes with the old document and we tear down (see load below).
    iframe.contentWindow.postMessage(
      {
        type: "house-sdk-welcome",
        v: 1,
        house: { id: context.house.id, name: context.house.name },
        me: context.me,
        members: context.members,
        online: context.online,
      },
      "*",
      [channel.port2],
    );
    clearTimeout(unresponsiveTimer);
    onStatus("connected");
  }

  async function onPortMessage(event) {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.op === "report") {
      const kind = String(msg.args?.kind ?? "error").slice(0, 20);
      const detail = String(msg.args?.detail ?? "").slice(0, 2000);
      onReport({ kind, detail });
      return;
    }
    const id = msg.id;
    if (typeof id !== "number") return;
    const reply = (body) => channel?.port1.postMessage({ id, ...body });
    if (!ALLOWED_OPS.has(msg.op)) return reply({ ok: false, error: `Unknown operation ${String(msg.op).slice(0, 40)}` });
    if (!limiter.take()) return reply({ ok: false, error: "Too many requests from this house", status: 429 });
    const args = msg.args && typeof msg.args === "object" ? msg.args : {};
    if (approxSize(args) > MAX_MESSAGE_BYTES) return reply({ ok: false, error: "Request too large", status: 413 });
    try {
      const result = await request(msg.op, args);
      reply({ ok: true, result });
    } catch (err) {
      reply({ ok: false, error: err?.message ?? "Request failed", status: err?.status });
    }
  }

  iframe.addEventListener("load", () => {
    loads += 1;
    if (loads > 1 && !destroyed) {
      // The house navigated or reloaded itself. Cut it off; the shell decides
      // whether to remount a fresh copy.
      teardown();
      destroyed = true;
      onStatus("navigated");
    }
  });

  const unresponsiveTimer = setTimeout(() => {
    if (!channel && !destroyed) onStatus("unresponsive");
  }, 10_000);

  window.addEventListener("message", onWindowMessage);
  container.replaceChildren(iframe);

  return {
    iframe,
    /** Forward a house event (chat.message, state.change, event, members, presence). */
    push(name, data) {
      if (!destroyed && channel) channel.port1.postMessage({ ev: name, data });
    },
    destroy() {
      destroyed = true;
      clearTimeout(unresponsiveTimer);
      teardown();
      iframe.remove();
    },
  };
}
