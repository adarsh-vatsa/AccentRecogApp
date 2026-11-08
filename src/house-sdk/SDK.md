# House SDK reference

Every house page loads the SDK with a classic script tag **before** its own code:

```html
<script src="/_sdk/house.js"></script>
<script type="module" src="app.js"></script>
```

Then wait for the connection:

```js
const house = await House.ready; // resolves once the app has connected this house
```

`House.ready` rejects only if the page is opened outside the app.

## Identity and members

- `house.house` → `{ id, name }` (the house's name)
- `house.me` → `{ id, name, username }` (the person viewing; every viewer gets their own `me`)
- `house.members` → `[{ id, name, username, role: "owner"|"member", online: boolean }]`
- `house.onMembers(fn)` → calls `fn(members)` whenever someone joins, leaves, comes online or goes offline. Returns an unsubscribe function.

## Chat (persistent messages)

- `house.chat.send(text, { channel = "main" })` → resolves to the saved message
- `house.chat.history({ channel = "main", before, limit = 50 })` → oldest-first array of messages. `before` is a message id, for paging back. `limit` is at most 100.
- `house.chat.onMessage(fn, { channel })` → `fn(message)` for every new message (including your own). Omit `channel` to hear all channels.

Message shape: `{ id, channel, body, at, from: { id, name } }`. `body` is plain text: render it with `textContent`, never `innerHTML`. Channels are names like `main` or `game-lobby` (letters, digits, `-`, `_`, at most 64 characters). Messages are at most 4000 characters.

## Shared state (persistent, synced to everyone)

A key-value store shared by everyone in the house. It survives reloads and new versions of the house.

- `house.state.get(key)` → `{ key, value, rev, by, at }` or `null`
- `house.state.list(prefix = "")` → array of entries whose key starts with `prefix` (at most 1000)
- `house.state.set(key, value, { ifRev })` → the new entry. Pass `ifRev` to make the write conditional: it must equal the key's current `rev`, and `0` means "only if the key doesn't exist". A mismatch rejects with an error whose message contains `Revision mismatch`.
- `house.state.update(key, fn)` → read-modify-write that retries on conflicts. `fn(currentValue)` returns the next value. **Use this for counters, turns, scores and anything two people might change at once.**
- `house.state.delete(key, { ifRev })`
- `house.state.on(key, fn)` → `fn(value, entry)` whenever that key changes (value is `null` when deleted). Returns an unsubscribe function.
- `house.state.onAny(fn)` → `fn(entry)` for every change in the house.

Keys use letters, digits, and `_ . : / -`, up to 128 characters. Namespace them by feature, for example `game:tictactoe:board` or `room:kitchen:layout`. Values are JSON up to 32 KB each. Don't store large things like images.

## Events (ephemeral, realtime)

These are fire-and-forget broadcasts to everyone else currently in the house. They are not stored. Use them for things that change many times a second: cursor positions, player movement, typing indicators, emoji reactions.

- `house.events.emit(name, data)` → sends to every other open copy of the house. You don't receive your own events.
- `house.events.on(name, fn)` → `fn(data, { from, at, name })`. `from` is the sender's user id.
- `house.events.onAny(fn)` → `fn(name, data, meta)`

Limits: about 30 events per second per viewer, 8 KB per event. Throttle movement updates to 10–20 per second.

## Patterns for multiplayer

- **Turn-based games** (board games, quizzes): keep the whole game in one state key and change it with `state.update`, so two players can't both move at once. Subscribe with `state.on`.
- **Realtime games** (movement, physics): broadcast each player's own position with `events.emit` at about 15 per second, and interpolate others. Store only durable results (scores, winners) in state. If one copy of the game must run the simulation, pick a host deterministically: the online member with the smallest `id`. Re-pick when `onMembers` fires.
- **Presence**: `house.members` with `online`, plus `onMembers`.
- **Late joiners**: anything a newcomer needs must be in state, not only in events.

## Environment rules

- The house runs in a sandboxed frame with an opaque origin. `localStorage`, `sessionStorage`, `indexedDB` and cookies throw or don't persist. Use `house.state`.
- No network access outside the house's own files. Requests to other sites, CDNs and external fonts are blocked by the content security policy. Vendor everything you need as local files and use system font stacks.
- `alert`, `confirm`, `prompt`, popups, form submission and top-level navigation are blocked. Build in-page UI instead, and call `event.preventDefault()` in form submit handlers.
- Relative URLs (`app.js`, `img/logo.svg`) work. Don't use absolute paths (`/app.js`) except `/_sdk/house.js`.
- ES modules (`<script type="module">`, `import ... from "./x.js"`), Canvas, WebGL, WebGPU, Web Audio, Web Workers (from local files or blobs) and WebAssembly all work.
- Uncaught errors are reported to the app automatically.
