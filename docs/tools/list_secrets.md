---
title: list_secrets
status: living
summary: List stored agent secret names, purposes, scope and availability without values.
scope:
  - packages/coding-agent/src/tools/list-secrets.ts
  - packages/coding-agent/src/secrets/agent-store.ts
---

# list_secrets

English | [中文](list_secrets.zh-CN.md)

> List stored agent secret names, purposes, scope and availability — never values.

The full contract lives in [`docs/secrets.md`](../secrets.md).

## Source
- Entry: `packages/coding-agent/src/tools/list-secrets.ts`
- Store/runtime: `packages/coding-agent/src/secrets/agent-store.ts`, `packages/coding-agent/src/secrets/agent-runtime.ts`

## Inputs

None.

## Outputs
- `content[0].text`: one line per entry with name, purpose, scope and
  availability (`$MUSEPI_SECRET_<NAME>`), or an empty-store sentence.
- `details.entries`: `{ name, purpose, scope, available }[]`.
- Values never appear in either field; `available` is a boolean derived from
  successful decryption, not the decrypted string.

## Flow
1. Reads the metadata sidecar and attempts to decrypt each listed entry.
2. An entry whose envelope cannot be decrypted stays listed as
   `unavailable: value unreadable` so the user can save the value again via
   [`request_secret`](./request_secret.md) or Settings → Secrets.

## See also
- [`docs/secrets.md`](../secrets.md) — storage layout, RPCs, scope, limitations
- [`request_secret`](./request_secret.md) — collect a missing value