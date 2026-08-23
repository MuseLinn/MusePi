# @musepi/collab-proto

Collab live-session wire transport shared by the host (`coding-agent`) and
guests (`desktop-web`): AES-256-GCM frame sealing, share-link format, wire
envelope, QR codes, and the relay WebSocket client. Pure transport — no
agent/session imports, browser-safe (zero `Buffer`), generic frame types.

## Modules

| Module | Purpose |
| --- | --- |
| `crypto` | AES-256-GCM frame sealing/unsealing. WebCrypto-only (Bun, Node ≥22, browsers). Room key lives only in the link fragment — the relay sees opaque bytes. Sealed layout: `[12B IV][ciphertext+tag]` |
| `link` | Share-link format + wire envelope. Link: `wss://<host[:port]>/r/<roomId>.<base64url-32-byte-key>`; envelope: `[4B uint32 BE peerId][sealed payload]` (guests always send peerId 0; the relay rewrites it) |
| `socket` | Client WebSocket wrapper for a relay room — seals/opens frames, reconnects with exponential backoff, maps fatal relay close codes. Generic over the frame type (host `CollabFrame` / guest `GuestFrame`/`HostFrame`) |
| `qrcode` | Self-contained QR generator (byte mode, versions 1–40, EC L/M/Q/H) with a half-block ANSI terminal renderer — the `/collab qrcode` command prints scannable join codes with zero runtime QR dependency |
| `extension-slots` | 内核↔渲染端 slot contract (single authority: daemon validation + GUI mount diagnostics share it) — declare new slots here, daemon `extensions.list` pushes them automatically |

## Usage

Host and guest both import the barrel; each side seals its own rich frame type
with `crypto`, transports it through `socket`, and renders joins via `link` /
`qrcode`.

```ts
import { sealFrame, openFrame, createRelaySocket } from "@musepi/collab-proto";
```

## Constraints

- No `Buffer`, no Node globals in `crypto`/`link`/`socket` — keep it browser-safe.
- No i18n, logging, or agent imports — callers translate close reasons at the
  UI layer.
