# Security model

Dynamic Chats runs code written by strangers (house code), produced by a model that strangers can steer (the builder), shown to people who didn't write it (other members). This document covers what's trusted, what isn't, the controls in place, and the gaps that remain.

## Trust boundaries

| Component | Trusted? | Why |
|---|---|---|
| Server, trusted shell, House SDK | Yes | Platform code. Houses and agents can't modify it. |
| House code | **No** | Written by any member, by the builder, or forked from elsewhere. |
| Builder output | **No** | The builder reads requests and files written by members, so it can be steered. |
| Members | Partially | They're authorized for their own houses, and nothing beyond that. |

**Working assumption: anything a house can see, it can leak.** That covers the viewer's display name and id, the house's members (names and ids, never usernames), and that house's chat and shared state. Controls below keep house code from seeing anything more.

## Controls

### House code can't reach the viewer's account

- **A separate origin per house.** Houses are served from `<houseId>.<HOUSE_DOMAIN>` (`houseServer.ts`). That origin sets no cookies, has no API, and serves only house files.
- **Forced sandbox.** Every house response carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-pointer-lock`, so the document gets an opaque origin however it's loaded. The shell's iframe uses the same flags. There's no `allow-same-origin`, `allow-popups`, `allow-top-navigation` or `allow-modals`.
- **Frame-only.** The house server refuses top-level navigations (`Sec-Fetch-Dest: document`), so a leaked or shared frame URL can't be opened as a full page. That stops it being used as a phishing page outside the shell. `frame-ancestors` limits embedding to the app.
- **No network.** The house CSP allows `connect-src 'self'` (the house's own files only), `frame-src 'none'`, `form-action 'none'` and `base-uri 'none'`. The shell's `frame-src` lets a house frame navigate only to house origins, so a house can't navigate itself to an external site with data in the URL. Tests confirm that fetches to the API, to external sites and over WebSocket are all blocked.
- **Capability URLs.** A house version is reachable only through `/v/<token>/…`. The token is an HMAC over `(houseId, commit, expiry)` and is bound to the house's subdomain. It's issued only after a membership check, and only for commits in that house's repo.
- **A fixed bridge.** The house gets one `MessagePort` and can ask for exactly eight operations: chat send/list, state get/list/set/delete, events emit, and members list. The shell chooses the house id, the house doesn't. The shell rate-limits and size-checks requests, and the server re-validates and re-authorizes every request against the database.
- **Navigation detection.** If a house frame navigates or reloads itself, the shell tears down its port and remounts a fresh copy. After three attempts it stops and offers a restore.
- **Shell text.** Toasts never quote text written by a member or the builder. The "errors" shortcut copies at most five house-reported lines, 200 characters each, into the Build box, where the person can read them before sending.

### Members can't exceed their membership

- Every house endpoint and every socket operation checks membership. Non-members get 404 rather than 403, so house ids can't be probed. Removed members are kicked off the socket immediately.
- **Removal sticks:**
  - A removed member's invite links are deleted.
  - An invite only works while the person who created it is still a member.
  - People the owner removes go on a ban list, so no invite lets them back in until the owner chooses **Let back in**.
  - The owner can turn off every invite link at once.
- Owner-only actions are removing others, managing bans and invites, and deleting the house. Only the requester or the owner can ship or discard a run.
- **Restore** only accepts versions that were actually live. A member can't use it to promote someone else's unshipped or discarded build.
- Invite links are random 192-bit tokens stored hashed. They expire after 7 days and allow at most 25 uses.

### Outsiders

- **Sessions:** 256-bit random tokens, stored as SHA-256 hashes, in an `HttpOnly; SameSite=Strict` cookie (plus `Secure` over HTTPS). Logout deletes the session and closes the user's sockets. Open sockets are re-checked against the session on every 30-second heartbeat.
- **Passwords:** hashed with scrypt (N=2^15, r=8, p=1, per-user salt). Unknown usernames run the same hash, so response timing doesn't reveal which usernames exist.
- **Login limits:** only failed attempts count, per (address, username) and per address. Someone guessing from elsewhere can't lock a user out. Behind a reverse proxy, set `TRUST_PROXY=1` so limits use the address your proxy appended, not one the client supplied.
- **CSRF:** every non-GET API request must carry the shell's `Origin`, and JSON bodies must be `application/json`.
- **Cross-site WebSocket hijacking:** the socket upgrade requires the shell's `Origin` and a valid session.
- **Malformed input:** bad request targets and badly encoded cookies get 400 or 401, not a crash.
- **Shell page:** the CSP allows `script-src 'self'` only and `frame-ancestors 'none'`, plus `X-Frame-Options: DENY` and `nosniff`. The shell never uses `innerHTML`. The platform serves an explicit allowlist of files, never directories.

### Resource limits

- **Sockets:** at most 8 per account. Message, event and request rate limits are per account, so extra sockets buy nothing. A socket whose unread queue passes 1 MB is cut off, so clients that stop reading can't pile up server memory.
- **Chat:** limited per account per house, and per account across all houses.
- **Shared state:** 32 KB per value, 5,000 keys and 8 MB per house. Listing state costs ten requests.
- **House file serving:** misses are cached, and at most 8 git processes run at once.
- **Builds:** one at a time per person, a daily cap per person, concurrency caps per house and globally, and limits on turns and checks per run.

### The builder is contained

- Its tools are file operations on its own worktree, plus a headless render. It has no shell, no network, and no access to chat or other houses.
- **File rules:**
  - Paths must be relative, and every segment must start with a letter or digit. That one rule blocks `..`, `.git`, `.gitattributes` and every other dotfile.
  - Symlinks anywhere on a path are rejected.
  - File size, file count and total size are capped.
- **Git** runs with hooks disabled, no system or global config, no symlinks, no fsmonitor and no network protocols. The house server only serves regular blobs (mode 100644/100755).
- **The check browser:**
  - It runs with Chromium's sandbox on.
  - It can only reach house origins; every other request is aborted.
  - House code under test has no `RTCPeerConnection`.
  - The harness page is answered by the checker itself. The platform never serves it, so there's no public page that shows a house without the shell around it.
- Nothing ships without a person: the requester previews, then ships. Every change is attributed and revertible.
- The system prompt is byte-stable and tells the builder to treat requests and files as data. That isn't a security boundary. The boundaries are the tool limits above.

## Known gaps

These are real, and they're ordered by how much they matter.

1. **Malicious house code acts as the viewer inside that house.** A house that renders member text with `innerHTML` is a stored-XSS hole: one member's message can run script in every viewer's frame. That script can post messages and change state as each viewer, but only in that house. The default template uses `textContent`, and the builder is told to. Planned fixes are a static check on builder output for unsafe sinks fed by member data, and Trusted Types for houses once the SDK ships a sanitizer.
2. **WebRTC exfiltration in members' browsers.** Chromium doesn't apply CSP to `RTCPeerConnection`, and no response header turns it off (the `webrtc` CSP directive isn't implemented). A malicious house can send whatever it can see to a STUN or TURN server. The checker removes WebRTC, but members' browsers can't be forced to. The mitigation is the working assumption above: houses only ever get data the viewer could already share with that house, and no usernames.
3. **Frame tokens are readable by the house.** A house can read its own URL and leak the token through (2). The house server refuses top-level loads, but someone with a token can still fetch that version's files (code, not chat or state) with a script until it expires (6 hours).
4. **No end-to-end encryption.** The server stores chat in plaintext. Server-side builders and E2E-encrypted house chat are fundamentally incompatible. The plan is encrypted DMs as the private channel, with house chat stated plainly as readable by the server. The builder doesn't read chat today.
5. **Previews use live data.** Preview code reads and writes the house's real chat and state. A buggy or malicious preview can corrupt shared state before anyone ships it. Fixing this means a scratch copy of state for previews.
6. **The checker shares a process tree with the server.** Its renderer is sandboxed, but its browser process runs as the server's user. In production, move it into its own service, as a separate user or container without access to `DATA_DIR`.
7. **A distributed password-guessing attack** isn't stopped by per-address limits. Scrypt and a 10-character minimum slow it down. Real defence needs per-account backoff with notification, or passkeys.
8. **Storage growth.** Messages have rate limits but no retention policy yet.
9. **Single process.** Rate limits and the realtime hub are in memory. Scaling out needs shared rate limiting and a pub/sub hub.
10. **No house computer yet.** When builds get a real machine, they must run in microVMs (Firecracker or equivalent) with egress filtering, quotas and abuse detection, not containers.

## Review history

- **v0, independent adversarial review.** It confirmed by exploit:
  - two unauthenticated server crashes
  - removed members rejoining through old invites
  - socket-based memory exhaustion
  - restore bypassing ship permissions
  - login lockout
  - a public page that showed houses without the shell
  - the check browser running without Chromium's sandbox
  - WebRTC exfiltration

  All of them are fixed or documented above, and each fix has a regression test in `test/hardening.test.ts` and `test/browser.test.ts`.

## Production checklist

- Serve houses from a **different registrable domain** than the shell, over HTTPS with a wildcard certificate. Set `HOUSE_SCHEME=https`, `HOUSE_DOMAIN`, `PLATFORM_ORIGIN`.
- Set `HOUSE_SECRET` explicitly (32+ random bytes, base64url) and keep `DATA_DIR` private (mode 700).
- Put exactly one reverse proxy in front, set `TRUST_PROXY=1`, and forward WebSocket upgrades on `/ws` with `Origin` and `Host` preserved.
- Run as a non-root user so the check browser's sandbox works. Never set `CHECKER_NO_SANDBOX` in production.
- Set `AGENT_RUNS_PER_USER_PER_DAY` and give the API key a provider-side spend limit.
