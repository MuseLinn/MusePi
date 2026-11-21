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

1. On session startup, secrets are collected from two sources:
   - **Environment variables** whose names match common secret patterns (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASS`, `AUTH`, `CREDENTIAL`, `PRIVATE`, `OAUTH`) with values >= 8 characters
   - **`secrets.yml` files** (see below)

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

| Tool             | Input                | Result                                                    |
| ---------------- | -------------------- | --------------------------------------------------------- |
| `request_secret` | `name`, `purpose`    | Environment variable name and a status; never the value   |
| `list_secrets`   | none                 | Name, purpose, scope and availability; never the value    |

`name` must match `/^[A-Z][A-Z0-9_]{0,63}$/`. The daemon pushes a
`secret-request` card with `kind:"fill"` when no value is stored and
`kind:"allow"` when one already exists. A card times out as a cancel after ten
minutes. Interactive collection requires a host that implements the
`requestSecret` UI channel (the daemon approval bridge); a headless/TUI host
returns an error telling the user to add the secret from Settings → Secrets.

### Storage

```
<agentDir>/agent-secrets/
  secrets.json    # AES-256-GCM envelope per name (values only)
  metadata.json   # name, purpose, scope, timestamps (0600, atomic write)
  .master.key     # per-profile master key (0600; optional MUSEPI_AGENT_SECRET_KEY override)
```

The store is always encrypted; there is no plaintext mode. Values are
AES-256-GCM envelopes derived with HKDF from the profile master key, reusing
the connector vault envelope implementation. The metadata sidecar never
contains a value, and the encrypted file never contains one either.

`scope` is `"all"` in P0: every stored secret is available to every session.
Workspace/bot scopes are a future union extension, not a current field.

### Bash injection

Every bash child process receives `MUSEPI_SECRET_<NAME>`, for every decryptable
stored entry. The value is only in that child's environment:

- `process.env` is never modified.
- A model-supplied `env` entry of the same name is overridden by the stored
  value.
- Tool output (foreground, timeout/cancel errors, streamed chunks, async job
  text, ACP terminal polls) replaces the value with `[secret:NAME]`.

### Provider boundary

At session start, stored agent secrets join the session's `SecretObfuscator` as
plain obfuscate-mode entries with `friendlyName` = the secret name. A save
mid-session registers the value into every live session's obfuscator
immediately. Provider requests therefore carry a reversible placeholder such as
`#GITHUBTOKEN_AB12:L#`, never the value. This coverage follows the
`secrets.enabled` toggle: with obfuscation disabled, bash injection and tool
output scrubbing still apply, but provider-boundary replacement does not.

### Daemon RPC

| RPC              | Params                                           | Result                                     |
| ---------------- | ------------------------------------------------ | ------------------------------------------ |
| `secret.status`  | `{}`                                             | `{ mode: "encrypted", count }`             |
| `secret.list`    | `{}`                                             | `{ entries: SecretEntryView[], count }`    |
| `secret.set`     | `{ name, value, purpose?, scope? }`              | `{ entry }`                                |
| `secret.delete`  | `{ name }`                                       | `{ ok: true }` (idempotent)                |
| `secret.answer`  | `{ requestId, action, value?, scope? }`          | `{ ok: true }`                             |

Timestamps in `SecretEntryView` are epoch milliseconds. `secret.answer` saves
the value in the daemon before resolving the tool's promise, so the tool only
sees which action won. Unknown or expired request ids fail with
`Unknown secret request: <id>`. No response, push, log or transcript contains a
value.

### Known limitations

- Values shorter than 8 characters are rejected (`Secret value must be at least
  8 characters`). The obfuscator only mints reversible placeholders for plain
  values of at least 8 characters, so allowing a 4-digit PIN would send it to
  the model unredacted. Supporting short secrets requires a separate
  replace-mode implementation, not a threshold bypass.
- P0 scope is `"all"`; per-workspace and per-bot scoping are future extensions.
- Malformed key/value pairs still need `secret.set` to reach a session started
  before the value existed; sessions started afterwards pick it up from disk.
- Bash's raw-output artifact is written by the executor before output
  redaction, so a command that echoes a value can leave it in that local
  artifact file. The value never enters the tool result, and the
  provider-boundary obfuscator still replaces it if the artifact is read back
  into the model context.
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
