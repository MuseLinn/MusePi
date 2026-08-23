# @musepi/sdk

MusePi daemon protocol contract: JSON-RPC 2.0 method table with TypeBox
schemas. This package is the **single source of truth** for what the daemon
exposes — GUI/TUI/remote clients compile `Type.Static` types derived from
these schemas, so a schema change breaks every consumer at build time.

Every method carries a `TransportAuth` level so the tunnel/relay security
boundary is enforced by the method table itself, not patched on later:

- `local` — unix socket / localhost only: writes, settings, terminal, files
- `session` — any authenticated session (relay/tunnel OK): read-only session
  ops plus prompt/approve inside an existing session
- `public` — no session required: handshake/connect/QR only

## Modules

| Module | Purpose |
| --- | --- |
| `index` | JSON-RPC method table (`MethodEntry` rows: method / auth / TypeBox params) |
| `events` | Session stream contract — subscribe/resume envelope + event union; the envelope is runtime-validated with TypeBox (kind/seq), payloads are typed |
| `events-types` | Runtime shape of the stream envelope (`entry` / `event` / `state` / `approval-request` / `ask-request` / …) |
| `materialized-view` | Projection layer of the daemon's event-sourcing pipeline, shared with browser clients — folds the append-only journal into a queryable session state |

## Constraints

- Schema drift is a breaking change for every compiled client — extend the
  contract, never tighten it silently.
- Never import agent/session code here; the protocol contract stays
  transport- and engine-agnostic.
