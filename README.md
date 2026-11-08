# Dynamic Chats

A group chat where the group owns its interface. Every group lives in a **house**: a live web app that any member can reshape by describing what they want to a builder agent. A house starts as a plain chat room. It can become a game room, a studio, a themed hangout, or a house with rooms, and it keeps the group's chat and shared state through every change.

This is v0. It shows the core loop working end to end and safely: prompt, build, preview, ship, everyone sees it live, roll back any time.

## Run it

```bash
npm install
export ANTHROPIC_API_KEY=...   # needed for the builder; everything else works without it
npm run dev
```

Open http://localhost:4100, sign up, create a house, and open **Build**. To try it with friends locally, use a second browser profile and send yourself the invite link from **Invite**.

The builder's `check` step renders houses in a headless Chromium with its sandbox on. That needs `npx playwright install chromium` once, and a non-root user. In a root-only dev container, start with `CHECKER_NO_SANDBOX=1`, and never do that in production.

Houses are served from `http://<house-id>.houses.localhost:4101`. Chrome, Edge and Firefox resolve `*.localhost` to your machine automatically. Safari doesn't, so use another browser for local development.

`npm test` runs the suite: security boundaries, versioning and merges, the agent loop with a scripted model, and end-to-end tests in headless Chromium.

## How it fits together

```
 browser
 ┌───────────────────────────────────────────────────────────────┐
 │ trusted shell  (localhost:4100)                               │
 │  session cookie · Build / History / People · invite · undo    │
 │ ┌───────────────────────────────────────────────────────────┐ │
 │ │ house frame  (<id>.houses.localhost:4101, sandboxed)       │ │
 │ │  the group's own HTML/CSS/JS + House SDK                  │ │
 │ │  no cookies · no network · opaque origin                  │ │
 │ └──────────────▲────────────────────────────────────────────┘ │
 │                │ MessagePort: a fixed set of ops, scoped to   │
 │                │ this house (chat, state, events, members)    │
 └────────────────┼──────────────────────────────────────────────┘
                  │ WebSocket + REST (session)
 ┌────────────────▼──────────────────────────────────────────────┐
 │ server                                                        │
 │  accounts · houses · invites · messages · shared state        │
 │  realtime hub · version log                                   │
 │  git repo per house (main = live, refs/runs/* = builds)       │
 │  builder: Claude tool loop on a worktree + headless check     │
 │  house origin: serves one immutable version per signed URL    │
 └───────────────────────────────────────────────────────────────┘
```

Three layers, as in the design:

1. **Trusted shell** (`src/shell/`). Platform-owned and never editable by houses or agents. It handles accounts, membership, invites, the builder panel, version history and restore. The bar at the top is drawn outside the house frame, so a house can't cover or fake it.
2. **The house** (`src/template/` is the starting point). This is all the group's interface, including the chat UI. It's stored as a git repo per house. Every shipped change is a commit, and any version can be restored.
3. **Core services** (`src/server/`). These are messages, shared key-value state with compare-and-set, realtime events, presence and members. House code reaches them only through the SDK (`src/house-sdk/`), so restyling the chat never breaks the chat, and rolling back code never deletes messages.

### Builds

`POST /api/houses/:id/runs` starts a builder run (`src/server/agent/`):

1. The run gets its own git worktree, branched from the live version.
2. Claude (`claude-opus-5-5`, adaptive thinking, streaming, server-side refusal fallback) works in a tool loop with `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file` and `check`. `check` commits the work in progress and renders it in headless Chromium at desktop and phone sizes, inside the real sandbox with two simulated members. It returns errors, blocked requests and screenshots, so the builder can see what it made.
3. The result is a preview only the requester sees. It's wired to the house's real chat and state.
4. **Ship** merges the result into `main` with a three-way merge. Two people building at once both land if they touched different things. If they edited the same lines, the second gets a conflict instead of silently overwriting. Every open copy of the house reloads to the new version.

The builder has no shell, no network, and no access to chat or other houses. Its input is the request plus the house's files.

### House SDK

House code talks to the group through `House.ready`:

```js
const house = await House.ready;
house.chat.send("hi");                                  // persistent messages
await house.state.update("game:score", (s = 0) => s + 1); // shared, synced, conflict-safe
house.events.emit("cursor", { x, y });                   // ephemeral realtime broadcast
house.onMembers((members) => render(members));           // who's here
```

The full reference is in [`src/house-sdk/SDK.md`](src/house-sdk/SDK.md). The builder gets the same document.

## Configuration

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Required for builds |
| `PLATFORM_PORT` / `HOUSE_PORT` | `4100` / `4101` | |
| `PLATFORM_ORIGIN` | `http://localhost:4100` | Public origin of the shell |
| `HOUSE_DOMAIN` | `houses.localhost:4101` | Houses are served at `<id>.<HOUSE_DOMAIN>` |
| `HOUSE_SCHEME` | `http` | `https` in production |
| `DATA_DIR` | `./data` | SQLite database, house repos, generated secret |
| `HOUSE_SECRET` | generated into `DATA_DIR` | HMAC key for frame URLs (base64url, 32+ bytes) |
| `AGENT_MODEL` / `AGENT_EFFORT` | `claude-opus-5-5` / `high` | |
| `AGENT_MAX_TURNS` / `AGENT_MAX_CHECKS` | `40` / `6` | Per-run limits |
| `AGENT_RUNS_PER_USER_PER_DAY` | `30` | Cost control |
| `TRUST_PROXY` | off | Set to `1` behind exactly one reverse proxy so rate limits see real client addresses |
| `SIGNUPS_PER_IP_PER_HOUR` | `5` | |
| `CHECKER_NO_SANDBOX` | off | Set to `1` only for local development as root, where Chromium's sandbox can't start |

**Production requirement:** `HOUSE_DOMAIN` must be a different registrable domain from the shell, the way Google serves user content from googleusercontent.com. For example, the app is on `app.example.com` and houses are on `*.examplehouses.net`, with a wildcard TLS certificate. Putting houses on a subdomain of the app's domain weakens the isolation. See [SECURITY.md](SECURITY.md).

## Not built yet

These are deliberately out of v0:

- **A real computer per house.** Builds can edit files and render them, but they can't run commands, install packages or host servers. That needs a microVM per house (Firecracker or similar) behind the same tool interface. Containers aren't enough isolation for strangers' code.
- Bringing other agents (Codex, Claude Code, OpenCode). Because a house is just a git repo, this mostly means running them against a worktree inside that microVM.
- Media uploads, voice, push notifications, mobile apps.
- Fullscreen and camera/microphone for houses. These need a shell-mediated permission prompt with a visible indicator, because fullscreen hides the trusted bar.
- Production infrastructure: Postgres instead of SQLite, a multi-process realtime hub, durable rate limits.
