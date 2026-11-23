---
title: request_secret
status: living
summary: Ask the user for a secret without exposing its value; returns only the environment variable name.
scope:
  - packages/coding-agent/src/tools/request-secret.ts
  - packages/coding-agent/src/secrets/agent-store.ts
  - packages/coding-agent/src/daemon/approval-bridge.ts
---

# request_secret

English | [中文](request_secret.zh-CN.md)

> Ask the user for a credential the agent needs inside a bash command, without ever seeing the value.

The full contract — storage, scope, RPC, timeout and known limits — lives in
[`docs/secrets.md`](../secrets.md). This page is the tool-facing root.

## Source
- Entry: `packages/coding-agent/src/tools/request-secret.ts`
- Store/runtime: `packages/coding-agent/src/secrets/agent-store.ts`, `packages/coding-agent/src/secrets/agent-runtime.ts`
- UI channel: `packages/coding-agent/src/daemon/approval-bridge.ts`
- Wire contract: `packages/wire/src/secret.ts`

## Inputs

| Field     | Type     | Required | Description                                                          |
| --------- | -------- | -------- | -------------------------------------------------------------------- |
| `name`    | `string` | Yes      | Environment suffix matching `/^[A-Z][A-Z0-9_]{0,63}$/`, e.g. `GITHUB_TOKEN` |
| `purpose` | `string` | Yes      | One line explaining what the command needs the secret for             |

## Outputs
- `content[0].text` names the environment variable, e.g.
  `Secret GITHUB_TOKEN is available to bash as $MUSEPI_SECRET_GITHUB_TOKEN.`
  It never contains the value.
- `details`: `{ name, envName, purpose, scope, status }`, where `status` is
  `"available"`, `"saved"` or `"cancelled"` and `scope` is `"all"` or the
  workspace roots the entry covers.
- A host with no interactive secret channel throws instead of returning a
  placeholder result; the message suggests Settings → Secrets or `secrets.yml`.

## Flow
1. The tool validates the name and purpose.
2. If the name is stored, decryptable and allowed in this workspace, it returns
   the environment variable name immediately. Saving was the consent: there is
   no second per-session grant card, including after a restart.
3. If it is stored but covers other workspaces only, the card is
   `kind:"allow"`: allowing adds this workspace to the scope without retyping
   the value.
4. Otherwise the card is `kind:"fill"`. The user types (or replaces) the value
   and may scope it to this workspace or every session; the daemon persists a
   `save` before the tool's promise settles and the tool only learns the action.
5. On success the value is available only as `$MUSEPI_SECRET_<NAME>` in bash
   child processes in a covered workspace, and is registered into the session
   obfuscator. The tool result never carries it.
6. If a command prints the variable, the output shows `[secret:<NAME>]`. That
   marker is expected redaction, not a failure; the model is told not to retry
   or report an error because of it.

## Side Effects
- Persists an encrypted value (save) and/or its scope (allow).
- Registers the value with live session obfuscators.
- Cancelling and timeouts write nothing.
- A value already allowed in this workspace needs no further grant: later calls
  return the environment variable name without reopening the card.

## See also
- [`docs/secrets.md`](../secrets.md) — storage layout, RPCs, scope, limitations
- [`list_secrets`](./list_secrets.md) — inspect names without values