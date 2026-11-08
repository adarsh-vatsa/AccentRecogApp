// The default house: one room with a chat. Everything here is house code,
// so the builder can restyle or replace any of it, including the chat itself.

const house = await House.ready;

const els = {
  name: document.getElementById("house-name"),
  people: document.getElementById("people"),
  onlineCount: document.getElementById("online-count"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
};

els.name.textContent = house.house.name;
document.title = house.house.name;

const COLORS = ["#d9622b", "#2b7bd9", "#2f9e6e", "#9b4fd1", "#c9413f", "#b8860b", "#1f8a9e", "#c2417f"];
function colorFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}
function avatar(user, online) {
  const el = document.createElement("span");
  el.className = "avatar";
  el.style.background = colorFor(user.id);
  el.textContent = initials(user.name);
  if (online !== undefined) el.dataset.online = String(online);
  return el;
}

function renderPeople(members) {
  els.people.replaceChildren(
    ...members
      .slice()
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
      .map((m) => {
        const li = document.createElement("li");
        li.className = "person";
        const label = document.createElement("span");
        label.textContent = m.id === house.me.id ? `${m.name} (you)` : m.name;
        li.append(avatar(m, m.online), label);
        if (m.role === "owner") {
          const role = document.createElement("span");
          role.className = "person-role";
          role.textContent = "owner";
          li.append(role);
        }
        return li;
      }),
  );
  const n = members.filter((m) => m.online).length;
  els.onlineCount.textContent = `${n} here now`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
let lastAuthor = null;
let lastAt = 0;

function renderMessage(msg) {
  els.messages.querySelector(".empty")?.remove();
  const li = document.createElement("li");
  const continued = lastAuthor === msg.from.id && msg.at - lastAt < 5 * 60 * 1000;
  li.className = "msg" + (continued ? " continued" : "") + (msg.from.id === house.me.id ? " mine" : "");
  const meta = document.createElement("div");
  meta.className = "meta";
  const who = document.createElement("strong");
  who.textContent = msg.from.name;
  const when = document.createElement("time");
  when.dateTime = new Date(msg.at).toISOString();
  when.textContent = timeFmt.format(msg.at);
  meta.append(who, when);
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = msg.body;
  li.append(avatar(msg.from), meta, body);
  els.messages.append(li);
  lastAuthor = msg.from.id;
  lastAt = msg.at;
}

function showEmpty() {
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = "It's quiet in here. Say hi, or open Build and describe what this house should become.";
  els.messages.append(li);
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

renderPeople(house.members);
house.onMembers(renderPeople);

const history = await house.chat.history({ limit: 100 });
if (history.length === 0) showEmpty();
history.forEach(renderMessage);
scrollToBottom();

house.chat.onMessage((msg) => {
  const nearBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 120;
  renderMessage(msg);
  if (nearBottom || msg.from.id === house.me.id) scrollToBottom();
}, { channel: "main" });

function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}

async function send() {
  const text = els.input.value.trim();
  if (!text) return;
  els.send.disabled = true;
  try {
    await house.chat.send(text);
    els.input.value = "";
    autosize();
  } catch (err) {
    els.input.setCustomValidity(err.message);
    els.input.reportValidity();
    setTimeout(() => els.input.setCustomValidity(""), 2000);
  } finally {
    els.send.disabled = false;
    els.input.focus();
  }
}

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  send();
});
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
els.input.addEventListener("input", autosize);
