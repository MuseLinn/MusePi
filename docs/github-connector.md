---
layout: default
title: GitHub connector
status: living
summary: Registering an OAuth app so the GitHub connector can sign in, and why GitHub needs one.
scope:
  - packages/coding-agent/src/connectors/bundled-catalog.ts
---

# GitHub connector

[English](github-connector.md) | [中文](github-connector.zh-CN.md)

The GitHub connector talks to GitHub's own remote MCP server at
`https://api.githubcopilot.com/mcp/`. Sign-in goes through GitHub's
authorization server at `github.com/login/oauth`.

## Why an app has to be registered

GitHub's authorization server publishes no registration endpoint — the
[github-mcp-server issue tracker records the same](https://github.com/github/github-mcp-server/issues/1404).
A client therefore cannot register itself the way RFC 7591 describes, and
every client that wants to sign in has to bring an OAuth app that was
registered by hand.

GitHub also refuses a PKCE-only exchange: the token endpoint answers
`incorrect_client_credentials` when the request carries a code verifier but
no client secret. The browser-callback path therefore needs both a client id
and a client secret.

## The device grant, which needs neither

The same authorization server offers the OAuth 2.0 device grant, and the
device grant needs no client secret and no callback URL — only a client id
with device flow enabled in the app's settings. MusePi ships an app
registered for exactly that:

| | |
| --- | --- |
| Client ID | `Ov23liWleGB0BcR9IPBm` |
| Device flow | enabled |
| Callback URL | `http://127.0.0.1:3000/callback` |

With it, the Connectors page offers **Sign in with a device code**: the
server issues a short code, the user opens the verification page and types
it, and the grant arrives by polling. Nothing listens on a port, and the
same flow works from a phone.

That path was verified end to end: the device grant produced a token with
the `repo` and `read:org` scopes, the remote MCP server at
`api.githubcopilot.com/mcp/` accepted it, and `get_me` returned the
account it belonged to.

## The token fallback

The device grant depends on the vendor offering it, and on the account
being allowed to authorize the app. When it is not, the Connectors page also
offers **Connect with a token**: paste a personal access token, and it is
used instead of a sign-in.

The two never fight over the same field. The token travels in the
authorization header; when an OAuth grant exists, the manager replaces that
header with the grant's own, so a sign-in that worked is never quietly
downgraded to a token. The token stays in the encrypted connector secret
store, and the catalog records only its field name.

This is the path openchamber takes for GitHub — its catalog entry for GitHub
is a plain personal-access-token form, with no OAuth at all.

## Registering an app of your own

You only need this for the browser-callback path, or to run your own app
against the same server.

1. Open <https://github.com/settings/developers> and choose **OAuth Apps**,
   then **New OAuth App**.
2. Fill the form:
   - **Application name** — anything, for example `MusePi`.
   - **Homepage URL** — the address of your application's own page.
   - **Authorization callback URL** — `http://127.0.0.1:3000/callback`.
3. Tick **Enable Device Flow** if you want the device grant.
4. **Register application**, then **Generate a new client secret**.

The secret belongs in the encrypted connector secret store, never in the
catalog.

## The callback URL

GitHub accepts a loopback address, but the host and path have to match
what the app registered: use the literal `127.0.0.1`, not `localhost`, and
the path must be exactly `/callback`. The port does not have to match —
GitHub's documentation says a loopback `redirect_uri` may use any port, and
the authorization lands on the port the client asked for.

`http://127.0.0.1:3000/callback` is what MusePi asks for. The desktop app
registers the scheme `musepi://oauth/callback` instead, which GitHub does
not accept — which is one more reason the device grant is the default path
here.

## What the connector can do

The server is GitHub's own, so it exposes GitHub's tools for repositories,
issues, pull requests and Actions. The catalog narrows the toolset to
`context,repos,issues,pull_requests` through the `X-MCP-Toolsets` header,
which keeps the tool list to what a working session needs.

The token it receives is scoped by the app you registered and by the scopes
GitHub grants it. Ask for the narrowest set that does the job: `repo` for
private repositories and `read:org` for organization membership.

## When it does not connect

- **`incorrect_client_credentials`** — the client id or secret is wrong, or
  the secret was regenerated after you copied it. GitHub issues a new secret
  when you ask for one; the old one stops working immediately.
- **`redirect_uri_mismatch`** — the callback URL in the app does not match the
  one the flow used. Register the exact URL above, including the port and
  the `/callback` path.
- **The authorization page never appears** — the row was mounted without a
  client. Fill in the form first; MusePi does not mount a GitHub connector
  that has no client id and secret.
