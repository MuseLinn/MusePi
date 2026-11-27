---
title: request_login
status: living
summary: Ask the user to save a website login that the browser can fill without exposing its credentials to the agent.
scope:
  - packages/coding-agent/src/tools/request-login.ts
  - packages/coding-agent/src/secrets/agent-store.ts
  - packages/coding-agent/src/daemon/approval-bridge.ts
  - packages/coding-agent/src/tools/browser/login-fill.ts
---

# request_login

English | [中文](request_login.zh-CN.md)

> Ask the user for a website sign-in without exposing the username, password, or one-time code to the agent.

Storage, scope, and encryption are covered by [`docs/secrets.md`](../secrets.md). This page owns the tool-facing contract.

## Source
- Entry: `packages/coding-agent/src/tools/request-login.ts`
- Store: `packages/coding-agent/src/secrets/agent-store.ts`
- UI channel: `packages/coding-agent/src/daemon/approval-bridge.ts`
- Browser fill: `packages/coding-agent/src/tools/browser.ts`, `packages/coding-agent/src/tools/browser/login-fill.ts`

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Login label matching `/^[A-Z][A-Z0-9_]{0,63}$/`, such as `ACME_PORTAL`. |
| `site` | `string` | Yes | Site to sign in to, such as `example.com`. |
| `purpose` | `string` | Yes | One line explaining what the agent is doing on that site. |

## Outputs
- `content[0].text` names the saved login and instructs the agent to use the browser tool with `action: "fill_login"` and that login name.
- `details` is `{ name, site, status, fillWith: "browser" }`, where `status` is `"available"`, `"saved"`, or `"cancelled"`.
- Neither field contains the username, password, 2FA setup key, or generated one-time code.

## Flow
1. The tool validates the name, site, and purpose.
2. A decryptable login for the same site whose scope covers this workspace returns `"available"` without opening a card. Saving the login was the consent; filling it is not a second disclosure.
3. Otherwise the user can save a login or pick another saved login for the same site. The daemon persists the choice before settling the request.
4. On success, the agent calls `browser` with `action: "fill_login"` and the returned name. The daemon fills and submits the form over its own browser connection, outside model-authored `browser run` code.
5. A one-time code is generated locally when the entry has a 2FA setup key. It is used only for that fill.
6. Cancelling stores nothing. A host without an interactive credential channel throws and directs the user to Settings → Vault.

## Side Effects
- Saves an encrypted login or extends an existing login's workspace scope.
- Returns only the login name and site to the agent.
- A page without a password field is reported rather than filled speculatively.

## See also
- [`docs/secrets.md`](../secrets.md) — encrypted storage, scope, and locking
- [`browser`](./browser.md) — browser tool operations
- [`request_secret`](./request_secret.md) — request a non-login secret without exposing its value
