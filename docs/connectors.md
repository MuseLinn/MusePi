---
layout: default
title: Connector catalog
status: living
summary: Catalog sources, enablement state, MCP projection, OAuth reuse, and the read-only agent tool for remote connectors.
scope:
  - packages/coding-agent/src/connectors
  - packages/coding-agent/src/discovery/connector-catalog.ts
  - packages/coding-agent/src/daemon/services/connector-catalog-service.ts
  - packages/coding-agent/src/tools/connector-catalog.ts
---

# Connector catalog

[English](connectors.md) | [中文](connectors.zh-CN.md)

A connector is a discoverable remote MCP server plus the display and auth metadata a client needs to render it. The catalog owns discovery and enablement; the MCP manager still owns connection, health, and OAuth. Nothing in this layer stores a token.

## Sources

The loader reads three sources, highest precedence first:

1. `MUSEPI_CONNECTOR_CATALOG` — an absolute JSON file path, a path relative to the agent directory, or an `http(s)` URL. Remote indexes use a 10 s timeout and never block the other sources on failure.
2. `<agentDir>/connectors/catalog.json` — the default local index.
3. `<agentDir>/connectors/marketplace/<id>/` — WorkBuddy-compatible packages: `plugin.json` plus `mcp.json`.

Entries are deduplicated by id; an index entry wins over a package entry. The catalog accepts remote `http`/`sse` endpoints, local `stdio` commands, and managed CLI packages. A stdio entry is mounted only after the user approves that exact command fingerprint; the catalog never installs packages, so the command must already be available (`npx`/`uvx` or an installed binary).

### Index shape

A local MCP process uses the same entry shape with a command instead of a URL:

```json
{
  "id": "local-demo",
  "name": "Local demo",
  "server": { "type": "stdio", "command": "npx", "args": ["-y", "demo-mcp"] },
  "auth": { "mode": "none" }
}
```

A managed CLI package declares its install/version/auth/status commands:

```json
{
  "id": "meeting-cli",
  "name": "Meeting CLI",
  "cli": {
    "init": { "win32": "npm install -g @scope/meeting-cli", "linux": "npm install -g @scope/meeting-cli" },
    "versionCheck": { "command": { "win32": "meeting-cli --version" }, "minVersion": "1.1.0" },
    "auth": { "win32": "meeting-cli auth login --no-browser" },
    "status": { "win32": "meeting-cli auth status" },
    "unAuth": { "win32": "meeting-cli auth logout" },
    "statusMatch": "Logged in"
  }
}
```

Install runs into `<agentDir>/cli-connectors/packages` with its own npm cache; the installer must be `npm`/`pnpm`/`yarn`/`bun`/`uv`. `connect` first returns `needsApproval` with the install/auth commands; `approve: true` installs if needed, checks `minVersion`, starts `auth`, and returns a `flowId` plus any parsed URL/device code. The client polls `connectors.cli.status` until `statusMatch` is found, then the connector becomes enabled; `connectors.cli.cancel` stops the auth process.

The remote index shape:

```json
{
  "version": 1,
  "connectors": [
    {
      "id": "example",
      "name": "Example",
      "description": "One sentence the card shows.",
      "category": "productivity",
      "icon": "https://example.com/icon.png",
      "docsUrl": "https://example.com/docs",
      "examples": ["Summarize my unread items"],
      "server": { "type": "http", "url": "https://example.com/mcp" },
      "auth": { "mode": "oauth" }
    }
  ]
}
```

`auth.mode` is `oauth` (default), `none`, or `token`. Optional `oauth` hints (`clientId`, `authorizationUrl`, `tokenUrl`, `scopes`, `callbackPort`, `callbackPath`) map onto the existing MCP OAuth config; omitted hints fall back to runtime discovery. A `token` entry must declare a form schema; values are stored in the encrypted connector secret store, never in the catalog:

```json
{
  "auth": { "mode": "token" },
  "tokenSchema": {
    "title": "Connect Example",
    "fields": [{ "key": "API_KEY", "label": "API key", "type": "password", "required": true }],
    "header": { "name": "Authorization", "template": "Bearer ${value}" }
  }
}
```

`header` is optional; the default is `Authorization: Bearer ${value}`, where `${value}` is the first field and `${KEY}` addresses a named field. Line breaks are stripped before injection.

### Package shape

A package uses the plugin marketplace layout:

```
marketplace/<dir>/
  plugin.json      # name, description, version, extensions["musepi.connector"].display
  mcp.json         # mcpServers.<name>.url / .type / .headers
  ai.workbuddy/token-schema.json  # optional; presence selects token auth
  assets/icon.png  # optional
```

`extensions["musepi.connector"].display` may carry `name`, `description`, `examples`, `icon`, `docsUrl`; `auth.mode` and `oauth` live beside it. The legacy `extensions["ai.workbuddy"]` key is accepted so an existing package works without edits. A `token-schema.json` in `ai.workbuddy/` or `musepi.connector/` supplies the form schema and makes the connector token-authenticated unless `auth.mode` says otherwise.

## Enablement and projection

Enablement is one boolean per connector in `<agentDir>/connectors/state.json`, written atomically with owner-only permissions. It is the only state this layer owns. Connect status is never persisted here: the MCP manager is the only component that can observe a live connection, and duplicating it would let a stale `connected` flag outlive a dead socket.

Token values live in `<agentDir>/connectors/secrets.json`: one AES-256-GCM envelope per connector, keyed by HKDF-SHA256 from a 32-byte master key at `<agentDir>/connectors/.master.key` (or `MUSEPI_CONNECTOR_MASTER_KEY` for managed deployments). The file never contains a plaintext value, a decrypt failure leaves it untouched and reports the connector as unconfigured, and `disconnect` deletes the entry.

OAuth grants still land in AuthStorage. Rows owned by the MCP client (`mcp_oauth:` and legacy `mcp_oauth_`) are encrypted at rest in `agent.db`: the `data` column keeps a marker and plaintext hash for compare-and-swap refreshes, the ciphertext lives in `secret`, and the key sits beside the database as `mcp-oauth.key` (or `MUSEPI_MCP_OAUTH_KEY`). Other providers keep their existing storage path until their own migration is designed.

The `connector-catalog` discovery provider (priority 40) projects each enabled entry into a canonical MCP server named `connector:<id>`. That namespace keeps a catalog entry from shadowing a hand-written `mcp.json` server and lets `/mcp` output distinguish the two. Static headers, when declared, are marked `origin-locked`; credentials are resolved from auth storage by server URL.

## RPC surface

| Route | Behavior |
| --- | --- |
| `connectors.catalog.list` | Catalog rows with enablement and live `connected` / `connecting` / `disconnected` status; optional `query`. |
| `connectors.catalog.detail` | One row plus its OAuth hints. |
| `connectors.catalog.refresh` | Drop the 5 s catalog cache and re-scan every source. |
| `connectors.connect` | Enable one connector, reload managers, return `{ serverName, needsAuth, status }`; a stdio entry returns `{ needsApproval, command, args, envKeys }` until called with `approve: true`. |
| `connectors.disconnect` | Disable one connector and reload. |
| `connectors.setEnabled` | Explicit toggle over the same two operations. |
| `connectors.token.save` | Validate Token form values against the schema, merge them into the encrypted store, and require every required field. Empty values keep the stored value. |
| `connectors.cli.status` | Run the CLI `status` command for a pending auth flow; `success` enables the connector. |
| `connectors.cli.cancel` | Stop the auth process and forget the flow. |

`connect` does not start OAuth. When `needsAuth` is true the client calls the existing `mcp.oauth.start` with the returned server name; the grant lands in auth storage and the manager reconnects. On desktop the start call also passes `redirectUri: musepi://oauth/callback`: the Electron shell registers `musepi://`, forwards the URL to the renderer, and the renderer calls `mcp.oauth.callback`. State and PKCE are validated inside the flow, so an unrelated app invoking the scheme cannot finish a grant. When `needsTokenConfig` is true the connector is not enabled and the client shows the Token form, saves it through `connectors.token.save`, then calls `connect` again. This keeps one OAuth implementation and one credential store for hand-written servers and catalog connectors alike.

## Security boundaries

- Catalog rows on the wire exclude `headers`; no token, client secret, or credential id is returned.
- Credential-bearing static headers (`Authorization`, `Cookie`, `X-Api-Key`, and peers) are dropped with a warning; a catalog cannot smuggle a token through package metadata.
- Token values are encrypted at rest and never returned; `connectors.catalog.list` exposes only the schema and a `tokenSet` boolean.
- A local command is never mounted from metadata alone: `connect` returns `needsApproval` with the exact command/args and env keys (CLI connectors show install/auth commands), and only `connect { approve: true }` writes the approved fingerprint. Changing the command invalidates the approval.
- CLI installers are restricted to known package managers and run in an isolated prefix. Commands are tokenized and spawned as argv; on Windows a bare name resolves through `PATH`/`PATHEXT`, and a `.cmd`/`.bat` shim (what npm and its installed CLIs produce) runs through `cmd.exe` with the command line passed verbatim, because a batch file cannot be spawned directly.
- Static headers are origin-locked to the configured URL.
- A malformed source degrades to the remaining sources with warnings; it never fails all MCP discovery.
- Enabling a connector is a user action. The agent tool is read-only and cannot write state.

## Agent surface

`connector_catalog` is a read-only built-in tool with three actions: `list`, `search`, `detail`. It reads the same loader and state file, returns display metadata and enablement, and never returns endpoints' headers or credentials. Its model-facing prompt (`packages/coding-agent/src/prompts/tools/connector-catalog.md`) tells the model to recommend from real rows, never invent ids, and leave enabling and OAuth to the Connectors UI.

## Out of scope

Enterprise registries and connector-to-connector token injection are out of scope.

## Implementation

- `packages/coding-agent/src/connectors/types.ts`
- `packages/coding-agent/src/connectors/catalog.ts`
- `packages/coding-agent/src/connectors/state.ts`
- `packages/coding-agent/src/connectors/runtime.ts`
- `packages/coding-agent/src/connectors/secrets.ts`
- `packages/coding-agent/src/discovery/connector-catalog.ts`
- `packages/coding-agent/src/daemon/services/connector-catalog-service.ts`
- `packages/coding-agent/src/tools/connector-catalog.ts`
