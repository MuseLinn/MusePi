# Secret Obfuscation

English | [中文](secrets.zh-CN.md)

Prevents sensitive values (API keys, tokens, passwords) from being sent to LLM providers. When enabled, secrets are replaced before outbound text content leaves the process. Reversible obfuscation placeholders are restored when session context is rebuilt for display or resume.

## Enabling

Disabled by default. Toggle via `/settings` UI or directly in `config.yml`:

```yaml
secrets:
  enabled: true
```

## How it works

1. On session startup, entries come from configured sources and the agent secret store:
   - **Environment variables** whose names match common secret patterns (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASS`, `AUTH`, `CREDENTIAL`, `PRIVATE`, `OAUTH`) with values >= 8 characters
   - **`secrets.yml` files** (see below)
   - **Built-in credential patterns** (GitHub/GitLab/OpenAI-style tokens), matched lazily
   - **Agent secrets** saved through the `request_secret` card (always loaded, independent of `secrets.enabled`; see [Agent secrets](#agent-secrets))

2. Outbound text messages to the LLM have secret values replaced with deterministic placeholders like `#AB12#`, `#AB12:L#`, or `#GITHUBTOKEN_AB12:L#`.

3. Session context is deep-walked and obfuscation placeholders are restored when building display/resume context. Replace-mode substitutions are one-way and are not restored.

Two modes control what happens to each secret:

| Mode                  | Behavior                                                                                      | Reversible                                   |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `obfuscate` (default) | Replaced with deterministic placeholder `#[A-Z0-9]+(?::[ULCM])?#`, optionally name-prefixed | Yes (deobfuscated in display/resume context) |
| `replace`             | Replaced with deterministic same-length string                                                | No (one-way)                                 |

## secrets.yml

Define custom secret entries in YAML. Two locations are checked:

| Level   | Path                       | Purpose                     |
| ------- | -------------------------- | --------------------------- |
| Global  | `~/.musepi/agent/secrets.yml` | Secrets across all projects |
| Project | `<cwd>/.musepi/secrets.yml`   | Project-specific secrets    |

Project entries override global entries with matching `content`.

### Schema

Each entry in the array has these fields:

| Field          | Type                         | Required | Description                                                   |
| -------------- | ---------------------------- | -------- | ------------------------------------------------------------- |
| `type`         | `"plain"` or `"regex"`       | Yes      | Match strategy                                                |
| `content`      | string                       | Yes      | The secret value (plain) or regex pattern (regex)             |
| `mode`         | `"obfuscate"` or `"replace"` | No       | Default: `"obfuscate"`                                        |
| `replacement`  | string                       | No       | Custom replacement (replace mode only)                        |
| `flags`        | string                       | No       | Regex flags (regex type only)                                 |
| `friendlyName` | string                       | No       | Sanitized model-visible label for obfuscate-mode placeholders |

### Examples

#### Plain secrets

```yaml
# Obfuscate a specific API key (default mode)
- type: plain
  content: sk-proj-abc123def456

# Replace a database password with a fixed string
- type: plain
  content: hunter2
  mode: replace
  replacement: "********"
```

#### Friendly names

`friendlyName` adds semantic context to reversible obfuscation placeholders without exposing the secret value:

```yaml
- type: plain
  content: github_pat_abc123def456
  friendlyName: GitHub Token
```

This produces placeholders shaped like `#GITHUBTOKEN_AB12:L#`. The friendly name is sanitized to uppercase letters and digits, capped at 32 characters, and omitted if it sanitizes to an empty value. Invalid optional `friendlyName` metadata does not disable the secret entry; the secret still obfuscates with an unlabeled placeholder.

The hash base is an HMAC of the secret under a private per-install key (stored at `~/.musepi/agent/secret-placeholder.key`, or `$XDG_STATE_HOME/omp/secret-placeholder.key` on XDG-enabled installs, never sent to a model), so a transcript reader cannot dictionary the placeholder back to the secret. The base is keyed on the exact secret value, so two secrets that differ only by case get independent bases and a provider that sees one placeholder cannot synthesize another secret's token by swapping the hint. A case hint suffix labels the casing of the redacted value for the model:

| Hint | Meaning                                      |
| ---- | -------------------------------------------- |
| `:U` | all cased ASCII letters are uppercase         |
| `:L` | all cased ASCII letters are lowercase         |
| `:C` | first cased ASCII letter uppercase, rest lower |
| `:M` | mixed ASCII casing                            |

`friendlyName` on regex entries labels the configured regex entry, not the matched value. Keep regex labels broad enough to be true for every match.

#### Regex secrets

```yaml
# Obfuscate any AWS-style key
- type: regex
  content: "AKIA[0-9A-Z]{16}"

# Case-insensitive match with explicit flags
- type: regex
  content: "api[_-]?key\\s*=\\s*\\w+"
  flags: "i"

# Regex literal syntax (pattern and flags in one string)
- type: regex
  content: "/bearer\\s+[a-zA-Z0-9._~+\\/=-]+/i"
```

Regex entries always scan globally (the `g` flag is enforced automatically). The regex literal syntax `/pattern/flags` is supported as an alternative to separate `content` + `flags` fields. Escaped slashes within the pattern (`\\/`) are handled correctly.

#### Replace mode with regex

```yaml
# One-way replace connection strings (not reversible)
- type: regex
  content: "postgres://[^\\s]+"
  mode: replace
  replacement: "postgres://***"
```

## Interaction with env var detection

Environment variables are collected first, then file-defined entries are appended. File entries can cover secrets that don't live in env vars (config files, hardcoded values, etc.). Env and file entries are not deduplicated against each other, so a plain value present in both is registered twice; both placeholders restore to the same secret, so deobfuscation is unaffected.

## Agent secrets

Agent secrets are credentials the model discovers it needs at runtime — an API
token for a `curl`, a registry password. Unlike `secrets.yml`, the value is
typed by the user into a card after the agent asks for it, so the model knows
the name but never the value.

### Tools

| Tool             | Input                     | Result                                             |
| ---------------- | ------------------------- | -------------------------------------------------- |
| `request_secret` | `name`, `purpose`, `delivery?` | Environment variable name or private file path, and a status; never the value |
| `list_secrets`   | none                      | Name, purpose, scope, delivery and availability; never the value |

`name` must match `/^[A-Z][A-Z0-9_]{0,63}$/`. A stored value answers immediately
only when it is readable and its scope covers the session's working directory. A
value stored for other workspaces opens a `kind:"allow"` card: the answer extends
the scope to that workspace without retyping the value. A missing or unreadable
value opens `kind:"fill"`. `delivery` is `"env"` by default; `"file"` is for a
command that takes a path (a certificate, kubeconfig, service-account JSON). A
stored entry keeps the delivery it was saved with. A card times out as a cancel
after ten minutes. Interactive collection requires a host that implements the
`requestSecret` UI channel (the daemon approval bridge); a headless/TUI host
returns an error telling the user to add the secret from Settings → Vault.

### Storage

```
<agentDir>/agent-secrets/
  secrets.json    # AES-256-GCM envelope per name (values only)
  metadata.json   # name, purpose, scope, delivery, timestamps (0600, atomic write)
  .master.key     # per-profile master key (0600; optional MUSEPI_AGENT_SECRET_KEY override)
  files/          # working copies for `file` delivery (0700; each file 0600)
```

The store is always encrypted; there is no plaintext mode. Values are
AES-256-GCM envelopes derived with HKDF from the profile master key, reusing
the connector vault envelope implementation. The metadata sidecar never
contains a value, and the encrypted file never contains one either.

`scope` is `"all"` or a list of absolute workspace roots. A root covers its own
subdirectories; comparison is case-insensitive on Windows. An unrecognized
stored value narrows to an empty list (nobody may use it), never widening to
`"all"`. Replacing a value without a new choice keeps the stored scope.

### Bash injection

Every bash child process receives `MUSEPI_SECRET_<NAME>`, for every decryptable
**`env`** entry whose scope covers the session's working directory. A `file`
entry is never exported to the environment: it is written to
`agent-secrets/files/<NAME>` (directory 0700, file 0600 where the platform has
POSIX modes) and the tool result names that path. The value is only in that
child's environment:

- `process.env` is never modified.
- A model-supplied `env` entry of the same name is overridden by the stored
  value.
- Tool output (foreground, timeout/cancel errors, streamed chunks, async job
  text, ACP terminal polls) replaces the value with `[secret:NAME]`. The raw
  value, its JSON-escaped form and its URL-encoded form are all replaced, so a
  token inside a query string or a JSON document does not survive. Streamed
  partials are redacted from the accumulated tail, so a value split across two
  chunks is still replaced.
- If a command prints the variable, `[secret:NAME]` is the expected marker, not
  a command failure; the model is told not to retry or report an error for it.
- `secrets.bashInjection` defaults to `"all"`. With `"referenced"`, only the
  names whose `MUSEPI_SECRET_<NAME>` appears in the command text enter the child
  environment; the redactor still covers every stored value, so a command that
  reads another value from a file is still scrubbed.

### Provider boundary

At session start, stored agent secrets join the session's `SecretObfuscator` as
plain obfuscate-mode entries with `friendlyName` = the secret name. Each value
joins as its raw text, its JSON-escaped form and its URL-encoded form, so an
encoded copy never reaches a provider either. Values shorter than 8 characters
join as one-way, word-bounded replacements instead of reversible placeholders. A
save mid-session registers the value into every live session's obfuscator
immediately, including the session that performed the first save when the store
was empty at startup. Provider requests therefore carry a reversible placeholder
such as `#GITHUBTOKEN_AB12:L#`, never the value.

Agent secrets are **always** covered: a value the user explicitly saved in the
safety card is a separate grant from the generic scanning feature. The session
builds an agent-secret obfuscator even when `secrets.enabled` is false. That
toggle only controls the generic sources (environment scanning, `secrets.yml`,
built-in credential patterns); with it off, those sources are not registered,
while agent-card values still are.

### MCP config reference

An MCP server's `env` or `headers` value may be exactly `${vault:NAME}`. At
connect time the daemon reads that entry for the server's workspace, so the
config file never holds the value; a missing, unreadable or out-of-scope entry
drops that env/header. This is the path that lets MCP use a vault value without
writing it into `mcp.json` or the process environment.

### Daemon RPC

| RPC              | Params                                           | Result                                     |
| ---------------- | ------------------------------------------------ | ------------------------------------------ |
| `secret.status`  | `{}`                                             | `{ mode: "encrypted", count }`             |
| `secret.list`    | `{}`                                             | `{ entries: SecretEntryView[], count }`    |
| `secret.set`     | `{ name, value, purpose?, scope?: "all" \| "workspace", delivery?: "env" \| "file" }` | `{ entry }`       |
| `secret.update`  | `{ name, scope: "all" }`                         | `{ entry }`                                |
| `secret.delete`  | `{ name }`                                       | `{ ok: true }` (idempotent)                |
| `secret.answer`  | `{ requestId, action, value?, scope?: "all" \| "workspace", delivery?: "env" \| "file" }` | `{ ok: true }` |

Timestamps in `SecretEntryView` are epoch milliseconds. `secret.answer` saves
the value in the daemon before resolving the tool's promise, so the tool only
sees which action won. `"workspace"` resolves to the pending request's session
directory; `secret.set` refuses it because the settings page has no session
context, and `secret.update` only widens a narrowed entry to `"all"`. Unknown
or expired request ids fail with `Unknown secret request: <id>`. No response,
push, log or transcript contains a value.

### Known limitations

- Values need at least 4 characters. A value shorter than 8 is redacted with a
  one-way marker and only where it stands alone (no letter or digit on either
  side): it is never restored in display context, and a value that appears
  inside a longer word is left intact on purpose. Values below 4 are rejected.
- Scope is `"all"` or workspace directories. A session outside every scoped
  root gets the allow card; narrowing an entry again needs saving it with the
  "this workspace" choice, because the settings page only widens.
- A `file` delivery's working copy persists until the entry is deleted or
  replaced; there is no per-file TTL yet. It is a plain owner-only file, so an
  administrator or another process running as the same user can read it. Binary
  values are written as UTF-8 text, so certificates and JSON are supported but
  binary blobs are not.
- An entry whose envelope cannot be decrypted stays listed as unavailable.
  Save the value again through `request_secret` or Settings → Vault to repair
  it; do not edit the sidecar by hand.
- Deleting a secret removes it from disk and from future bash injection, but an
  obfuscator already live in a running session keeps replacing that old value
  for the session's lifetime. This is intentional: removing coverage could make
  an already-seen value provider-visible again.
- Bash's raw-output artifact is written by the executor before output
  redaction, so a command that echoes a value can leave it in that local
  artifact file. The value never enters the tool result, and the
  provider-boundary obfuscator (always active for agent secrets) still replaces
  it if the artifact is read back into the model context.
- The envelope and metadata writes are separate atomic writes. A crash between
  them can leave an orphaned encrypted value (invisible, harmless) or a listed
  name whose value is missing (reported as unavailable).

## Key files

- `packages/coding-agent/src/secrets/index.ts` -- loading, merging, env var collection
- `packages/coding-agent/src/secrets/obfuscator.ts` -- `SecretObfuscator` class, placeholder generation, message obfuscation
- `packages/coding-agent/src/secrets/regex.ts` -- regex literal parsing and compilation
- `packages/coding-agent/src/secrets/agent-store.ts` -- encrypted agent secret store, metadata sidecar, validation
- `packages/coding-agent/src/secrets/agent-runtime.ts` -- session loading, dynamic obfuscator registration, bash env and output scrub
- `packages/coding-agent/src/tools/request-secret.ts` -- the interactive secret card tool
- `packages/coding-agent/src/tools/list-secrets.ts` -- metadata-only listing tool
- `packages/coding-agent/src/daemon/services/secret-service.ts` -- `secret.*` RPC implementation
- `packages/coding-agent/src/daemon/approval-bridge.ts` -- secret card pending table, timeout and settlement
- `packages/wire/src/secret.ts` -- daemon/GUI secret contract
- `packages/coding-agent/src/config/settings-schema.ts` -- `secrets.enabled` setting definition

## See also

- [`auth-broker-gateway.md`](./auth-broker-gateway.html) -- remote credential vault and forward-proxy that keep provider OAuth refresh tokens and access tokens off developer hosts entirely (complementary to in-process obfuscation).
