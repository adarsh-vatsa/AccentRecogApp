# Security model

Dynamic Chats runs code written by strangers (house code), produced by a model that strangers can steer (the builder), shown to people who didn't write it (other members). This document covers what's trusted, what isn't, the controls in place, and the gaps that remain.

## Trust boundaries

| Component | Trusted? | Why |
|---|---|---|
| Server, trusted shell, House SDK | Yes | Platform code. Houses and agents can't modify it. |
| House code | **No** | Written by any member, by the builder, or forked from elsewhere. |
| Builder output | **No** | The builder reads requests and files written by members, so it can be steered. |
| Members | Partially | They're authorized for their own houses, and nothing beyond that. |

## Controls

### House code can't reach the viewer's account

- **A separate origin per house.** Houses are served from `<houseId>.<HOUSE_DOMAIN>` (`houseServer.ts`). That origin sets no cookies, has no API, and serves only house files.
- **Forced sandbox.** Every house response carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-pointer-lock`. The document gets an opaque origin even when someone opens its URL directly, outside the app. The shell's iframe uses the same flags. There's no `allow-same-origin`, `allow-popups`, `allow-top-navigation` or `allow-modals`.
- **No network.** The house CSP allows `connect-src 'self'` (the house's own files only), `frame-src 'none'`, `form-action 'none'`, `base-uri 'none'` and `frame-ancestors <platform origin>`. Tests confirm that fetches to the API, to external sites and over WebSocket are all blocked.
- **Capability URLs.** A house version is reachable only through `/v/<token>/…`. The token is an HMAC over `(houseId, commit, expiry)` and is bound to the house's subdomain. Tests cover tampered, expired, wrong-key and wrong-house tokens. The token is issued only after a membership check, and only for commits in that house's repo.
- **A fixed bridge.** The house gets one `MessagePort` and can ask for exactly eight operations: chat send/list, state get/list/set/delete, events emit, and members list. The shell chooses the house id, the house doesn't. The shell rate-limits and size-checks requests, and the server re-validates and re-authorizes every request against the database.
- **Navigation detection.** If a house frame navigates or reloads itself, the shell tears down its port and remounts a fresh copy. After three attempts it stops and offers a restore.

### Members can't exceed their membership

- Every house endpoint and every socket operation checks membership. Non-members get 404 rather than 403, so house ids can't be probed. Removed members are unsubscribed from the socket immediately.
- Owner-only actions are removing others and deleting the house. Only the requester or the owner can ship or discard a run.
- Invite links are random 192-bit tokens stored hashed. They expire after 7 days and allow at most 25 uses.

### Outsiders

- Sessions are 256-bit random tokens stored as SHA-256 hashes, in an `HttpOnly; SameSite=Strict` cookie (plus `Secure` over HTTPS). Logout deletes the session server-side and closes the user's sockets.
- Passwords are hashed with scrypt (N=2^15, r=8, p=1, per-user salt). Unknown usernames run the same hash, so response timing doesn't reveal which usernames exist. Login and signup are rate-limited.
- **CSRF:** every non-GET API request must carry the shell's `Origin`, and JSON bodies must be `application/json`.
- **Cross-site WebSocket hijacking:** the socket upgrade requires the shell's `Origin` and a valid session.
- The shell's CSP allows `script-src 'self'` only and `frame-ancestors 'none'`, plus `X-Frame-Options: DENY` and `nosniff`. The shell never uses `innerHTML`. The platform serves an explicit allowlist of files, never directories.

### The builder is contained

- Its tools are file operations on its own worktree, plus a headless render. It has no shell, no network, no access to chat, and no access to other houses.
- Paths must be relative, with every segment starting with a letter or digit. That blocks `..`, `.git`, `.gitattributes` and any other dotfile in one rule. It also rejects symlinks anywhere on a path, caps file size, file count and total size, and limits turns and checks per run.
- Git runs with hooks disabled, no system or global config, no symlinks, no fsmonitor and no network protocols. The house server only serves regular blobs (mode 100644/100755) from commits.
- Nothing ships without a person: the requester previews, then ships. Every change is attributed and revertible.
- The system prompt is byte-stable and tells the builder to treat requests and files as data. That isn't a security boundary. The boundaries are the tool limits above.

## Known gaps

These are real, and they're ordered by how much they matter.

1. **Malicious house code acts as the viewer inside that house.** A house that renders member text with `innerHTML` is a stored-XSS hole: one member's message can run script in every viewer's frame. That script can post messages and change state as each viewer, but only in that house. The default template uses `textContent`, and the builder is told to. Planned fixes are a static check on builder output for unsafe sinks fed by member data, and Trusted Types for houses (`require-trusted-types-for 'script'`) once the SDK provides a sanitizer.
2. **Exfiltration through self-navigation.** A house can set `location` to an external URL with data in the query string. The shell detects the navigation and cuts the frame off, but the first request has already left. What can leak is limited to what the house could see: that house's chat, state, member names, and its own frame token. CSP has no working navigation control today.
3. **WebRTC.** Chromium doesn't apply `connect-src` to `RTCPeerConnection`, so a house can reach a STUN or TURN server and leak data through ICE candidates. The same leak scope as (2) applies. The fix is to serve houses with a policy that disables WebRTC, or to drop the feature from house frames once browsers support that.
4. **Frame tokens are readable by the house.** A house can read its own URL. If it leaks the token through (2) or (3), an outsider can fetch that version's code, but not chat or state, until the token expires (6 hours).
5. **Phishing inside a house.** A house can draw a fake login form. It has no network to send the result to except through (2) and (3). The platform never asks for credentials inside a house, and the shell bar labels everything below it as member-made.
6. **No end-to-end encryption.** The server stores chat in plaintext. Server-side builders and E2E-encrypted house chat are fundamentally incompatible. The plan is encrypted DMs as the private channel, with house chat stated plainly as readable by the server. The builder doesn't read chat today.
7. **Previews use live data.** Preview code reads and writes the house's real chat and state. A buggy or malicious preview can corrupt shared state before anyone ships it. Fixing this means a scratch copy of state for previews.
8. **Single process.** Rate limits and the realtime hub are in memory. Scaling out needs shared rate limiting and a pub/sub hub.
9. **No house computer yet.** When builds get a real machine, they must run in microVMs (Firecracker or equivalent) with egress filtering, quotas and abuse detection, not containers.

## Production checklist

- Serve houses from a **different registrable domain** than the shell, over HTTPS with a wildcard certificate. Set `HOUSE_SCHEME=https`, `HOUSE_DOMAIN`, `PLATFORM_ORIGIN`.
- Set `HOUSE_SECRET` explicitly (32+ random bytes, base64url) and keep `DATA_DIR` private (mode 700).
- Terminate TLS in front of both ports and forward WebSocket upgrades on `/ws`. Make sure the proxy preserves `Origin` and `Host`.
- Set `AGENT_RUNS_PER_USER_PER_DAY` and give the API key a provider-side spend limit.
