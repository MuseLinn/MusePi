---
title: connector_catalog
status: living
summary: Read-only discovery of catalog connectors, their enablement, and their setup metadata.
scope:
  - packages/coding-agent/src/tools/connector-catalog.ts
  - packages/coding-agent/src/connectors
---

# connector_catalog

> Discover the connectors this machine can mount, before recommending one.

## Source
- Entry: `packages/coding-agent/src/tools/connector-catalog.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/connector-catalog.md`
- Catalog: `packages/coding-agent/src/connectors/catalog.ts`
- Enablement state: `packages/coding-agent/src/connectors/state.ts`
- Runtime projection: `packages/coding-agent/src/connectors/runtime.ts` (provider `connector-catalog`)

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `action` | `"list" \| "search" \| "detail"` | Yes | Operation to apply. |
| `query` | `string` | For `search` | Case-insensitive match over id, name, description and category. |
| `id` | `string` | For `detail` | Connector id exactly as `list` reports it. |

## Outputs
One text block. `list` and `search` print one row per connector:

```
- <id> — <name>: <description> [<auth mode>; enabled|not enabled] {<category>}
```

`detail` prints the name, description, endpoint, auth mode, enablement, optional docs and example prompts. `details` carries `{ action, count }` plus the rows (or the single detailed connector) for rendering. Static headers, tokens and client secrets are never returned.

## Flow
1. Load the catalog (`MUSEPI_CONNECTOR_CATALOG`, `<agentDir>/connectors/catalog.json`, then package directories) and the per-profile state file.
2. `search` filters, `detail` resolves one id, `list` returns everything.
3. The tool never enables a connector, writes config or starts OAuth. Those are user actions in the Connectors UI; after enablement the `connector-catalog` MCP provider exposes the server as `connector:<id>` and the manager mounts its tools.
