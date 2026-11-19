# Collab: Live Session Sharing


[English](collab.md) | [中文](collab.zh-CN.md)
`/collab` shares your running session with other musepi instances in real time. Guests render the **same session natively in their own TUI** — streaming assistant text, tool-call cards, footer state (cwd, model, context %, cost), ctrl+o expansion, `/dump` — no terminal mirroring. Guests can prompt and interrupt the agent; the host machine runs the agent and all tools.

## Quick start

Host:

```
/collab
```

prints

```
Collab session started!
 • Join from another terminal: musepi join "mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30"
 • or any web browser: my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30
```

The browser line is click-to-join (an OSC 8 hyperlink to the full `https://` deep link): the relay serves the web guest client at `/`, and the room id + key ride in the URL fragment. From another musepi (any directory, any machine), either form works:

Running `/collab` or `/collab view` starts or displays the active hosting session, rendering both the terminal/browser join links and their corresponding QR codes.

```
/join my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJU…
```

The guest's previous session is restored on `/leave` (or when the host stops).

### Commands

| Command | Effect |
|---|---|
| `/collab` | Start sharing full-control (or re-print the link/QR when already hosting) |
| `/collab <relay>` | Start sharing through a specific relay (`relay.example.com`, `ws://localhost:7475`) |
| `/collab view` | Start sharing read-only (or re-print the link/QR when already hosting) |
| `/collab status` | Show link + participants |
| `/collab stop` | Stop sharing |
| `/collab lan` | Share over the local network (self-hosted relay, no public endpoint) |
| `/collab tunnel [cloudflared\|ngrok\|tailscale]` | Share through a public tunnel (defaults to `collab.exposure`) |
| `/pair` | Start a LAN share and show a 6-digit code for the mobile app |
| `/join <link>` | Join a shared session as a guest |
| `/leave` | Leave (guest) or stop sharing (host) |

## Sharing outside the default relay

`/collab` uses the production relay by default. When the agent must stay on your machine, a share can run a local relay instead, and only the path guests reach it through changes — the encrypted room protocol is identical in every mode.

| Mode | Command | Guests reach it from | Needs |
|---|---|---|---|
| LAN | `/collab lan` or `/pair` | the same network | nothing |
| Cloudflare Tunnel | `/collab tunnel cloudflared` | anywhere with the link | `cloudflared` binary |
| ngrok | `/collab tunnel ngrok` | anywhere with the link | `ngrok` binary and its free authtoken |
| Tailscale Serve | `/collab tunnel tailscale` or a share with `collab.exposure = tailscale` | your tailnet | Tailscale on both ends |

`/collab tunnel` uses `collab.exposure` when no transport is named inline, and accepts `cloudflared`, `ngrok`, or `tailscale` inline; any other registered exposure id also works as the configured default. Daemon and GUI shares (`collab.start`) read the same setting.

### LAN

A LAN share binds the relay to `0.0.0.0` and prints one link per routable NIC. Terminals join over plaintext `ws`; browsers need a secure context for WebCrypto, so a second relay with a self-signed certificate serves the `https`/`wss` deep link. When Tailscale is installed and Serve can be used, the share also prints a tailnet URL with a real certificate (no browser warning); that best-effort decoration never fails the LAN share.

### Cloudflare Tunnel

Quick mode is zero-config: `cloudflared tunnel --url ws://localhost:<port>` prints a random `https://<id>.trycloudflare.com` that changes on every start. The URL is parsed from `--logformat json` output (plain-text logs still parse), and the public host is probed before the link is shown — a blocked edge node fails with a diagnosable message instead of a dead WebSocket later.

Named mode needs `collab.cloudflaredHostname` and a tunnel token. The token lives in the encrypted secret store under `collab.cloudflared.<tunnelId>`, never in settings, argv, or logs (the child receives it as `TUNNEL_TOKEN`), and the link is `https://<hostname>` — stable across restarts.

### ngrok

`/collab tunnel ngrok` runs `ngrok http <port>` and parses the public URL from its JSON log. ngrok's free tier requires a one-time `ngrok config add-authtoken <TOKEN>`; MusePi reports that step instead of running it.

### Tailscale Serve

Serve exposes the relay at `https://<machine>.<tailnet>.ts.net`. It does not require an empty Serve configuration: MusePi backs the current config up with `tailscale serve get-config --all`, mounts the relay on 443, and falls back to 8443 (carrying the port into the link) when 443 is already served. Stopping removes exactly its own entry (`tailscale serve --https=<port> off`) and restores the backup with `tailscale serve set-config` — `tailscale serve reset` is never used. MusePi never runs `tailscale up` and stores no Tailscale credential; an unauthenticated node, disabled MagicDNS, or unavailable HTTPS certificates degrade with the specific admin-console toggle to change.

### Health, revocation, and TTL

Every tunnel watches its child process and probes the public host every 30 seconds. A tunnel that dies is revoked immediately: the URL is cleared, health becomes `degraded` with the reason and a next step, and the relay behind it is closed. Share state is authoritative — `remote-access.status` returns `mode`, `sessionId`, `exposure`, and `health`, and reports `hosting: false` once the host ends, the session switches, or the exposure fails, so a share panel never keeps a dead link. The reason survives that clearing: while `hosting` is `false`, the same reply carries `lastEnd {exposure, health, at, reason, detail, hint}` (cleared by the next `collab.start`), which is where a failed tunnel's `detail` and next-step `hint` reach the UI.

`collab.shareTtlMinutes` (default `0`, no limit) stops a share automatically after the configured number of minutes.

### Privacy boundary

- **LAN** — traffic stays on your network; the browser link is `https` with a self-signed certificate, and the tailnet link (when shown) is encrypted by Tailscale.
- **Public tunnels** — Cloudflare or ngrok terminates TLS at its edge and can see connection metadata, never room content, which is sealed end to end. The public URL alone is not a secret: the fragment carries the room key, and anyone with the full link can steer the session.
- **Tailscale** — the relay is reachable only inside your tailnet; guests need Tailscale installed and signed in to the same tailnet.

### Extending exposures

Self-hosting a relay is a plugin, not a built-in: register a transport in the process-wide registry when your plugin loads.

```ts
import { BaseExposure, exposureRegistry } from "@musepi/pi-coding-agent/collab/exposure";

exposureRegistry.register("my-relay", () => new MyRelayExposure());
```

An exposure declares `id`, `label`, `capabilities` (`guestInstall`, `publicExposure`, `stableUrl`, `thirdParty`), `probe()`, `start({ port })`, `close()`, and reports health through `onChange` with `unavailable | starting | ready | degraded | stopped`. `LocalShareManager` resolves it by id (`startExposure("my-relay")`), the daemon lists it in `collab.exposures`, and a degraded exposure revokes the relay automatically. The protocol needs no change: a transport only has to provide an origin guests can reach.

### When not to use a public tunnel

- The default relay is enough when both sides can reach the internet and the agent does not need to stay on your machine.
- Prefer LAN for devices on the same network, and Tailscale when both ends are in your tailnet.
- Do not expose a machine to the public internet just because it is convenient: a full link reads the entire session history and can steer the agent.
- Corporate networks often block `trycloudflare.com`; use LAN or a named tunnel on your own domain.

## Link format

Accepted by `/join <link>` and `musepi join "<link>"`:

```
<roomId>.<secret>                                                 → default relay (wss://my.omp.sh)
<roomId>#<secret>                                                 → legacy bare form
host[:port]/r/<roomId>#<secret>                                   → custom relay, wss:// inferred
host[:port]/r/<roomId>.<secret>                                   → legacy direct relay form
https://host[:port]/r/<roomId>#<secret>                           → direct relay URL, normalized to wss://
https://host[:port]/r/<roomId>.<secret>                           → legacy direct relay form
wss://host[:port]/r/<roomId>#<secret>                             → direct websocket relay URL
wss://host[:port]/r/<roomId>.<secret>                             → legacy direct websocket relay form
ws://localhost:7475/r/<roomId>#<secret>                           → direct plain ws, localhost only
https://host[:port]/#<link>                                       → browser deep link when web UI and relay share a host
https://web-host[:port][/<path>]/#<relay-link>                    → browser UI wrapper with relay link in the fragment
https://web.example/collab/#relay.example.com/r/<roomId>.<secret> → web UI and relay on different hosts
```

Newly generated direct links put the room secret in the fragment (`/r/<roomId>#<secret>`): a URL path is sent to, and logged by, the outermost proxy — with a tunnel share that is the tunnel edge — while a fragment never leaves the client. The legacy path form (`/r/<roomId>.<secret>`) is still parsed. Two forms keep generating it: the bare default-relay form (`<roomId>.<secret>`, which has no origin or path to carry a `#`) and the inner link of a browser deep link (a second `#` inside a fragment is what strict URL stacks percent-encode).

`<link>` / `<relay-link>` are parsed recursively as any accepted link above. For `http(s)` browser wrappers with a parseable fragment, the fragment wins before the HTTP host/path are treated as a relay. This lets `https://web.example/collab/#relay.example.com/r/<roomId>.<secret>` open the web UI at `web.example` while joining `wss://relay.example.com/r/<roomId>`. If the fragment is not a complete collab link, parsing falls back to the legacy direct relay form, so `https://relay.example.com/r/<roomId>#<secret>` still means relay `relay.example.com`.

The trailing `.<secret>` or `#<secret>` part is the room secret, base64url-encoded, in one of two strengths:

- **Full link** — 48 bytes: the 32-byte AES-256-GCM room key followed by a 16-byte write token. Grants prompting, interrupting, and subagent control.
- **View-only link** — the bare 32-byte key, no write token. Grants live read access only. Pre-token links parse as view-only.

Parsers accept both secret positions (and `%23`-mangled legacy deep links). Only the fragment position keeps the secret out of proxy logs; links embedded inside another fragment use the path position because RFC 3986 forbids a raw `#` there.

## End-to-end encryption

Every session payload (entries, events, state, prompts) is sealed with AES-256-GCM before it touches the socket. The relay sees only:

- room ids and connection counts,
- opaque ciphertext frames and their sizes,
- a 4-byte routing prefix (which guest a frame targets).

Possession of the link is the trust boundary: a full link reads and steers the session, a view-only link reads it. Share both like secrets.

## Guest permission model

Two trust levels, enforced by the link itself — the host verifies the 16-byte write token at join and rejects writes from peers without it (they appear as read-only in the participants list, and the join notice says so).

Guests with a full link can:

- read the entire session (including the back-transcript at join time),
- prompt the agent (rendered with their name badge on every participant's transcript; the LLM sees the prompt text verbatim — names are display-only),
- interrupt the agent (Esc),
- use [Agent Hub](./agent-hub.html) against the host's subagents: live table and progress, chat (steers the host's subagent), kill, revive, and transcript viewing (fetched from the host on demand).
- answer host interactive `select` and `editor` requests. The host broadcasts each pending request only to writable guests; the first submitted or cancelled response settles it and dismisses the other presentations.

Guests with a view-only link can read everything live — back-transcript, streaming text, tool cards, subagent transcripts — but the host rejects prompting, interrupting, and agent control from them.

Everything that mutates the host session or machine is host-only: `/model`, `/compact`, `/resume`, `/branch`, bash (`!`), python (`$`), skills, etc. Guests keep a small local allowlist (`/dump`, `/export`, `/copy`, `/help`, `/hotkeys`, `/theme`, `/settings`, `/leave`, `/collab`, `/exit`, `/quit`).

Known v1 limit for guests: a turn already streaming when you join becomes visible from its next message boundary.

## Web client

`packages/client-core` is a standalone browser client for the same links — no musepi install needed on the guest side. The relay serves it at `/`, which is what makes the `/collab` deep link click-to-join: `https://<relay>/#<link>` loads the client and auto-connects from the fragment. It renders the live transcript (streaming text, thinking, tool cards), a subagent panel with on-demand transcripts, and a composer with the same guest powers (prompt, interrupt, hub actions). Run `bun run dev` in the package for a local instance, `bun run mock-host` for an offline scripted host to develop against, and `bun run build` to emit a static `dist/` deployable anywhere (HTTPS required for WebCrypto). The client never talks to anything but the relay, and the key stays in the URL fragment.

Set `collab.webUrl` when the browser UI is hosted separately from the websocket relay. When empty, `/collab` derives `http(s)://host[:port]` from `collab.relayUrl`; explicit web UI URLs must use `https://` except for `http://localhost` development origins. The generated browser URL still carries the relay-specific collab link in the fragment. For a share that runs its own relay, the configured UI origin is also passed to that relay, so the cross-origin WebSocket is accepted instead of failing the Origin gate with `403`.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `collab.relayUrl` | `wss://my.omp.sh` | Relay used by `/collab` when no relay is passed inline |
| `collab.webUrl` | empty | Browser UI URL for `/collab` links; empty derives from relay; explicit `http://` is allowed only for localhost |
| `collab.displayName` | OS username | Name shown to other participants |
| `collab.exposure` | `cloudflared` | Default transport for `/collab tunnel` and tunnel shares that do not name one (a registered exposure id) |
| `collab.cloudflaredHostname` | empty | Hostname for a named Cloudflare tunnel; empty uses a quick tunnel |
| `collab.shareTtlMinutes` | `0` | Stop a LAN or tunnel share after this many minutes; `0` keeps it until stopped |
| `share.serverUrl` | `https://my.omp.sh/s` | Share viewer/upload base used by `/share` (links are `<base>/<id>#<key>`) |
| `share.redactSecrets` | `true` | Run the secret obfuscator over `/share` snapshots before upload |

## Self-hosting the relay

The production relay is not currently distributed for self-hosting: its Go source and standalone binaries are not published. The endpoint list below documents the hosted service's network contract, not an installable release.

For local protocol development, this repository includes a source-available, WebSocket-only stand-in at [`packages/client-core/scripts/local-relay.ts`](../packages/client-core/scripts/local-relay.ts). Run `bun run relay` from `packages/client-core` to listen on `ws://localhost:7466`. It implements `/r/<roomId>` but does not serve the browser client, `/share` blobs, or `/healthz`, so it is not a replacement for the production service.

The relay is a small content-blind Go service. It keeps no state beyond live connections and exposes:

- `GET /` — the static guest-client guest client (target of the `/collab` deep link),
- `GET /r/<roomId>?role=host|guest` — WebSocket upgrade,
- `POST /s` / `GET /s/<id>` / `GET /s/<id>/raw` — `/share` blob upload, viewer page, and blob fetch,
- `GET /healthz` — liveness.

### Relay liveness, limits, and close codes

Every in-process relay — the one LAN, tunnel, and `collab.start` shares run — follows this connection contract, and clients apply the same close-code rules to any relay:

- **Heartbeat** — a WebSocket ping every 25 seconds. A peer that leaves a ping unanswered for a full interval is treated as half-open (Wi-Fi handoff, Doze, NAT expiry) and dropped; the traffic also keeps a quiet tunnel's idle timer from closing a healthy share. Clients answer pings automatically.
- **Host drops and reclaim** — when a host connection disappears without a close, its room survives for 30 seconds. Guests are closed with `4001` and retry with backoff inside that window (at most 30 seconds and five attempts from the first `4001`); the host reclaims the same room by reconnecting with the same link, and learns about guests that joined during the gap. A host that closes normally ends the room immediately, and a relay that stops closes guests with `1001`.
- **Close codes** — `4001` means the host is gone but the room may come back: retry. `4004` means the room no longer exists (host stopped, grace expired, or a link from an older share): retry cannot help. `1001` means the relay itself stopped serving: also terminal. `4009` (another host owns the room) and `4029` (room full) are terminal for that attempt. `1008` is a policy rejection — too many guests from one address, or the inbound byte rate — and the client may reconnect, but the same condition recurs until the cause changes; `1013` is relay capacity (room or connection caps), so retry later.
- **Admission limits** — the in-process relay allows, per client address, 32 live upgrades, 60 new upgrades per minute, and 16 sockets that have not upgraded yet. Those budgets are separate on purpose: loading the browser page and its assets uses the pending budget, never the join budget, so a reload storm cannot lock a real guest out. Globally it keeps 256 connections and 64 rooms; a room holds 16 guests, at most 8 from one address. Rejections before the upgrade are HTTP: `403` for a disallowed origin, `429` for a connection or rate cap, `503` when the relay is at capacity.
- **Origin gate** — browsers attach `Origin` to the WebSocket upgrade. The relay accepts its own origin, the bundled app shells (`https://localhost`, `capacitor://localhost`, `ionic://localhost`), and any origin passed in `allowedOrigins`; terminal clients that send no `Origin` pass. This is why an in-process share accepts the `collab.webUrl` origin automatically: the UI and the relay may be served from different origins.

### Troubleshooting a join

| Symptom | Meaning | What to do |
|---|---|---|
| `403` / "origin not allowed" when a browser joins | the page's origin is neither the relay's nor an allowed one | serve the UI from the relay, set `collab.webUrl` so an in-process share allows it, or add the origin to `allowedOrigins` on a self-hosted relay |
| `429` / "connection rate limit" | one address opened too many upgrades in a minute, or holds too many live/pending sockets | wait a minute, close extra tabs, and avoid reload loops |
| `4004` / "no such room" | the host stopped, the share TTL expired, the 30-second reclaim window ended, or the link belongs to an older share | start a new share and hand out its new link |
| `4001` repeating | the host connection dropped; the room is waiting for it | keep the guest retrying inside 30 seconds, and check the host's network or tunnel; after five attempts start a new share |
| `1001` / "sharing stopped" | the relay itself shut down | reconnect once the relay is back; the link itself stays valid |
| `1008` / "too many guests from one address" | one address already holds 8 of the room's 16 guest seats (the per-address fairness cap) | join from another address, or self-host a relay with a higher per-address cap |
| `1008` / "byte rate limit exceeded" | the client sent more than 32 MiB/s into the relay | usually a looping or buggy client; fix it before reconnecting, since the limit trips again |
| `1013` / "relay is at capacity" | the relay reached its global room or connection cap | retry later, or self-host a relay with higher caps |
| `4009` / "host conflict" | another host already owns that room id | stop that host, or let it miss a heartbeat interval; room ids are per share, so a new share avoids the collision |
| `4029` / "room is full" | the room reached its 16-guest cap | start a view-only share with fewer guests, or self-host a relay with a higher per-room cap |
| The web UI opens but no session connects | the UI origin and the relay origin differ and the relay does not allow the UI's | set `collab.webUrl` for an in-process share, or allow the UI origin on the relay |


## Architecture notes

Hub topology — the host is authoritative, guests never peer:

1. `entry` frames — durable session entries, broadcast pre-blob-externalization so images stay inline (guests cannot resolve host blob refs). Guests append them verbatim (ids preserved) to a replica session file under `~/.musepi/collab/<roomId>.jsonl` and into the agent's message array, which is why `/dump` and context estimates work.
2. `event` frames — live agent events, fed straight into the guest's normal event controller; rendering is events-only to prevent double-render.
3. `state` frames — debounced footer snapshots: streaming flag, the host's full model object and thinking level (applied to the guest's replica agent state, so model display and context-window math are native), host context numbers, and participants.
4. `bus` frames — mirrored task-subagent lifecycle/progress EventBus traffic, republished on the guest's local bus so the subagent HUD and status-line count work natively.
5. `agents` frames — agent-registry snapshots feeding a guest-local registry, so the Agent Hub table renders host subagents.

Guest→host: `hello`, `prompt`, `abort`, `agent-cmd` (hub chat/kill/revive), and `fetch-transcript` (incremental subagent-transcript reads answered by targeted `transcript` frames). The replica loads through the regular `/resume` machinery, so theming, ctrl+o, and transcript behavior are native by construction; the guest process never chdirs to host paths.
