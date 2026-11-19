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

The loader reads four sources, highest precedence first:

1. `MUSEPI_CONNECTOR_CATALOG` — an absolute JSON file path, a path relative to the agent directory, an `http(s)` URL, or one of two words:
   - `auto` checks the index this app publishes at
     `https://raw.githubusercontent.com/MuseLinn/MusePi/main/connectors/catalog.json`.
   - `off` keeps the catalog local even if a default would otherwise apply.
   Remote indexes use a 10 s timeout and never block the other sources on failure.
2. `<agentDir>/connectors/catalog.json` — the default local index.
3. `<agentDir>/connectors/marketplace/<id>/` — WorkBuddy-compatible packages: `plugin.json` plus `mcp.json`.
4. The bundled catalog — `packages/coding-agent/src/connectors/bundled-catalog.ts`, the one list every profile starts with. It is code rather than JSON because it ships inside the CLI bundle, and it sits at the lowest precedence so a user index or a package replaces a same-id entry.

Entries are deduplicated by id; a stronger source wins, and only two declarations in the same tier that name different servers produce a warning. The bundled layer is why the Connectors page lists real services before anyone writes an index. The catalog accepts remote `http`/`sse` endpoints, local `stdio` commands, and managed CLI packages. A stdio entry is mounted only after the user approves that exact command fingerprint; the catalog never installs packages, so the command must already be available (`npx`/`uvx` or an installed binary).

### The automatic check

The automatic check is **opt-in** (`MUSEPI_CONNECTOR_CATALOG=auto`) rather than
on by default. It is a network call made from a settings screen: the host is
not reachable everywhere, and on a machine that cannot reach it the first open
would stall for the request timeout before falling back to a catalog that was
already local. A catalog compiled into the app opens instantly and works
offline, so that is the default; a user or a deployment turns the check on
deliberately.

When a remote index is configured, its body is cached at
`<agentDir>/connectors/index-cache/<hash>.json` together with its `ETag` and
fetch time:

| Situation | What happens |
| --- | --- |
| Cached less than six hours ago | The cached copy is used; no request. |
| Older than six hours | Revalidated with `If-None-Match`; a `304` refreshes the fetch time and keeps the entries. |
| The request fails, a cached copy exists | The cached entries are used and a warning names the failure and the age of the copy. A network outage does not make a connector disappear. |
| The request fails, no cached copy | No entries from this source; the other sources still load. |

`connectors.catalog.refresh` (the **刷新目录** button) revalidates regardless of
the cache window, so a user who presses it gets the current index.

The index only overrides what the app ships. An entry with the same id
replaces the bundled row; a new id adds a row. Enabling is still the user's
action, a stdio entry still needs its command approved, and the loader still
refuses a static credential header — a remote index can change what is
*offered*, never what is already trusted.

Publishing a change: edit `connectors/catalog.json` on the default branch. The
worst case for a bad edit is a row that does not connect; the bundled catalog
underneath is untouched.

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

`auth.mode` is `oauth` (default), `none`, or `token`. `descriptionZh` supplies a Chinese one-liner for a Chinese UI, and `featured: true` puts an entry in the page's opening section. Optional `oauth` hints (`clientId`, `authorizationUrl`, `tokenUrl`, `scopes`, `callbackPort`, `callbackPath`, `deviceAuthorizationUrl`) map onto the existing MCP OAuth config; omitted hints fall back to runtime discovery. `deviceAuthorizationUrl` matters for vendors that run the device grant but publish no authorization-server metadata — GitHub's `/login/device/code` — because the conventional fallback path is not one they serve. A `token` entry must declare a form schema; values are stored in the encrypted connector secret store, never in the catalog. A schema may carry the value in a header or in a URL query parameter, because some vendors issue a plain key for a query string (`query: "key"` for Amap's `?key=`) rather than a bearer token; `header` wins when both are declared:

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

`extensions["musepi.connector"].display` may carry `name`, `description`, `examples`, `examplesZh`, `icon`, `docsUrl`; `auth.mode` and `oauth` live beside it. The legacy `extensions["ai.workbuddy"]` key is accepted so an existing package works without edits. A `token-schema.json` in `ai.workbuddy/` or `musepi.connector/` supplies the form schema and makes the connector token-authenticated unless `auth.mode` says otherwise.

## Enablement and projection

Enablement is one boolean per connector in `<agentDir>/connectors/state.json`, written atomically with owner-only permissions. It is the only state this layer owns. Connect status is never persisted here: the MCP manager is the only component that can observe a live connection, and duplicating it would let a stale `connected` flag outlive a dead socket.

Token values live in `<agentDir>/connectors/secrets.json`: one AES-256-GCM envelope per connector, keyed by HKDF-SHA256 from a 32-byte master key at `<agentDir>/connectors/.master.key` (or `MUSEPI_CONNECTOR_MASTER_KEY` for managed deployments). The file never contains a plaintext value, a decrypt failure leaves it untouched and reports the connector as unconfigured, and `disconnect` deletes the entry.

OAuth grants still land in AuthStorage. Rows owned by the MCP client (`mcp_oauth:` and legacy `mcp_oauth_`) are encrypted at rest in `agent.db`: the `data` column keeps a marker and plaintext hash for compare-and-swap refreshes, the ciphertext lives in `secret`, and the key sits beside the database as `mcp-oauth.key` (or `MUSEPI_MCP_OAUTH_KEY`). Other providers keep their existing storage path until their own migration is designed.

The `connector-catalog` discovery provider (priority 40) projects each enabled entry into a canonical MCP server named `connector:<id>`. That namespace keeps a catalog entry from shadowing a hand-written `mcp.json` server and lets `/mcp` output distinguish the two. Static headers, when declared, are marked `origin-locked`; credentials are resolved from auth storage by server URL.

The GUI reflects that containment: settings has ONE entry, 连接器, and hand-written `mcp.json` servers render as the 已配置服务器 section at the bottom of that page (`apps/desktop/src/components/settings-sections/mcp.tsx`, mounted from `connectors.tsx`). A separate MCP page used to sit beside the catalog and showed less — a toggle without transport, URL, or OAuth login. The retired `mcp` settings id stays in `SECTION_ALIAS` (`apps/desktop/src/lib/settings-nav.ts`) so existing deep links land on the connector page.

The page is two levels. Rows are an index — icon, name, one sentence, one action — grouped as connected, featured, and category, each category showing six rows until the user narrows it. Everything longer (the full description, examples, docs, the credential form, CLI authorization, local-process approval, the probe verdict) lives in the detail dialog a row opens. A connect that turns out to need authorization, a credential, or an approval opens that dialog, so a flow never waits behind a row the user cannot see. The device-code panel stays on the page instead of the dialog: its polling lives in the component, and closing the dialog must not strand a sign-in that is already being entered in the browser. Examples follow the UI language (`examplesZh` when present) and each one can be copied or handed to the composer, which closes settings and appends the sentence to the draft.

Servers outside the catalog — what `mcp.json` and other agents declare — sit in their own section below the catalog, separated by a rule: one row per server with its transport, source, auth and live state, and one switch that decides whether a session can use it. The same server cannot appear twice, once as a toggle and once as a configuration dump.

Sign-in is one action. A row whose catalog entry pins a client id without a client secret reports `deviceAuth`; `connectors.connect` answers `needsDeviceAuth` and Connect starts the device grant (and its poll) directly, instead of opening an authorization page that cannot complete. Any personal-access-token fallback sits under 其他登录方式. The desktop no longer requests a custom-scheme redirect: the daemon rejects a non-http(s) redirect URI, and browser OAuth uses its loopback listener. Enablement is transactional: `connect` leaves an unauthorized row untouched, and the client enables it with `setEnabled` once the grant lands, so a failed or abandoned flow never leaves a row that reads as connected. The device code is its own dialog; closing it cancels the pending flow. The code is a copy target: it lands on the clipboard when it arrives and a click copies it again (the CLI auth code uses the same chip), so nobody has to retype it from the screen.

## RPC surface

| Route | Behavior |
| --- | --- |
| `connectors.catalog.list` | Catalog rows with enablement and live `connected` / `connecting` / `disconnected` status; optional `query`. |
| `connectors.catalog.detail` | One row plus its OAuth hints. |
| `connectors.catalog.refresh` | Drop the 5 s catalog cache and re-scan every source. |
| `connectors.connect` | Answer whether a connector can be enabled. An OAuth row without a stored grant returns `{ needsAuth }` (or `{ needsDeviceAuth }`) and changes nothing; an open row enables, reloads managers, and returns `{ serverName, needsAuth: false, status }`; a stdio entry returns `{ needsApproval, command, args, envKeys }` until called with `approve: true`. |
| `connectors.disconnect` | Disable one connector and reload. |
| `connectors.setEnabled` | Explicit toggle over the same two operations. The client calls it with `enabled: true` after a sign-in lands: with the grant stored, the same `connect` path enables the row, so a failed flow never leaves it enabled. |
| `connectors.token.save` | Validate Token form values against the schema, merge them into the encrypted store, and require every required field. Empty values keep the stored value. |
| `connectors.cli.status` | Run the CLI `status` command for a pending auth flow; `success` enables the connector. |
| `connectors.cli.cancel` | Stop the auth process and forget the flow. |
| `connectors.import.scan` | MCP servers the other agents on this machine have configured, by source and endpoint. Credential fields are listed by name; no value crosses the wire. |
| `connectors.import.apply` | Copy the picked servers into the user's own catalog and move a plain-text credential into the encrypted secret store. The source file is never written to. |
| `mcp.servers.probe` | Handshake and release, joining no session and caching nothing. With `url`/`command` it validates like `add`; with only a `name` (plus optional `cwd`/`sessionId`) it resolves the user `mcp.json` entry, then the workspace's live manager config, injects stored credentials through `prepareConfig`, and connects. Returns `{ ok, serverInfo?, toolNames?, resourceCount?, promptCount?, error? }`; a missing live manager is a stated failure, never a credential-less retry. |

`connect` does not start OAuth. When `needsAuth` is true the client calls the existing `mcp.oauth.start` with the returned server name; the grant lands in auth storage and the manager reconnects. On desktop the start call also passes `redirectUri: musepi://oauth/callback`: the Electron shell registers `musepi://`, forwards the URL to the renderer, and the renderer calls `mcp.oauth.callback`. State and PKCE are validated inside the flow, so an unrelated app invoking the scheme cannot finish a grant. When `needsTokenConfig` is true the connector is not enabled and the client shows the Token form, saves it through `connectors.token.save`, then calls `connect` again. This keeps one OAuth implementation and one credential store for hand-written servers and catalog connectors alike.

## Importing from other agents

The discovery layer already reads every agent's MCP configuration — Cursor, VS Code, Claude, Codex, Kimi Code and the rest — so those servers are reachable in a session. `connectors.import.scan` offers exactly that set, and `connectors.import.apply` copies the picked ones into `<agentDir>/connectors/custom.json`, where they join the catalog as user-owned entries.

Importing is a copy, not a link. The other agent's file is never written to, and removing the imported connector later leaves it untouched. The scan reports each server's live MCP state (available, disabled, shadowed) and whether the same endpoint is already in the user's catalog, so the dialog badges it and greys out a would-be duplicate. Writing happens on a second, explicit confirmation that names the selected servers and the three effects: the entry goes to `connectors/custom.json`, credentials move into the encrypted store, and the connector stays disabled until approved.

A credential the other agent stored in plain text — an `Authorization` header, or an environment variable whose name says it is a token — moves into the encrypted connector secret store, and the catalog keeps only the field name. Leaving the plaintext where it was would keep it readable to every other tool on the machine. An environment variable that is ordinary configuration (`CODEX_HOME`, `JAVA_HOME`, a trusted-path list) stays in the entry: it is not a secret, and the server reads it as configuration.

An imported local command still needs the user's approval before it runs, exactly like a catalog entry that declares one.

## Verification

`scripts/probe-connectors.ts` walks the sign-in path each row would take: an anonymous `initialize`, the protected-resource and authorization-server metadata, then a dynamic client registration with a loopback redirect, stopping at the authorization page without granting anything. Its verdict per row is recorded in the catalog's `verified` field.

The probe exists because a vendor's documentation is not the answer. Figma rejects a redirect URI whose path does not end in `/callback`, and rejects a client name outside its list, while its docs promise a working registration. Asana advertises an authorization server that offers no registration, while the resource itself runs one that does. Both only appear when a registration is actually attempted.

### Brand marks

Each bundled connector's mark is committed data in
`apps/desktop/src/components/settings-sections/connector-brand-icons.generated.ts`,
generated by `scripts/generate-connector-brand-icons.ts`. Reading it from a
vendor at render time would make one request per card and tell each vendor
that this machine opened its settings page, so the marks ship with the app.

The generator prefers, in order: `simple-icons` from the installed package
(pinned by the lockfile, no network), the `logos` collection, and the icon the
vendor's own page declares. `apps/desktop/test/connector-brand-icons.test.ts`
fails when a bundled connector has no mark and is not a recorded exception, so
adding a connector without regenerating is caught before release.

Run it after changing the catalog:

```sh
bun scripts/probe-connectors.ts            # every row
bun scripts/probe-connectors.ts github figma
bun scripts/probe-connectors.ts --json
```

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
- `packages/coding-agent/src/connectors/bundled-catalog.ts`
- `packages/coding-agent/src/connectors/catalog.ts`
- `packages/coding-agent/src/connectors/state.ts`
- `packages/coding-agent/src/connectors/runtime.ts`
- `packages/coding-agent/src/connectors/secrets.ts`
- `packages/coding-agent/src/discovery/connector-catalog.ts`
- `packages/coding-agent/src/daemon/services/connector-catalog-service.ts`
- `packages/coding-agent/src/tools/connector-catalog.ts`
