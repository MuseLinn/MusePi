# Marketplace plugin system
English | [中文](marketplace.zh-CN.md)


The marketplace system lets you discover, install, and manage plugins from Git, local, or direct-catalog sources. It is compatible with the Claude Code plugin registry format.

## Quick start

```
/marketplace add anthropics/claude-plugins-official
/marketplace install wordpress.com@claude-plugins-official
```

In the TUI, `/marketplace` with no arguments opens the interactive plugin browser. In non-TUI command handling, `/marketplace` lists configured marketplaces; use `/marketplace discover` to browse.

## Concepts

A **marketplace** is a Git repository (or local directory) containing a catalog file at `.omp-plugin/marketplace.json` (preferred) or `.claude-plugin/marketplace.json` (Claude Code-compatible fallback). The catalog lists available plugins with their sources, descriptions, and metadata.

A **plugin** is a directory containing Claude/OMP plugin content such as skills, commands, agents, hooks, tools, MCP servers, or LSP servers. Marketplace installs also load extension modules declared by `package.json` `omp.extensions`: installation symlinks the cached plugin into the scope's `node_modules` tree and records it in `musepi-plugins.lock.json`, the same runtime surfaces used by npm-installed and `musepi plugin link`ed plugins. Plugins are identified by `name@marketplace` (e.g. `code-review@claude-plugins-official`).

**Scopes**: marketplace plugins can be installed at two scopes:

- **user** (default) -- available in all projects, stored in `~/.musepi/plugins/installed_plugins.json`
- **project** -- available only in the active project, stored in the nearest project `.musepi/plugins/installed_plugins.json`

Enabled project-scoped installs shadow enabled user-scoped installs of the same plugin. A disabled project install does not shadow the user install.

### Vocabulary

These terms have one meaning each in the marketplace docs and code:

| Term | Meaning |
| --- | --- |
| **index** | One `musepi-plugin-index` JSON document that a market publishes. It carries every field a list row shows plus every installable version, so browsing costs one read instead of one request per row. |
| **catalog** | The Claude-compatible `marketplace.json` (`.omp-plugin/` preferred, `.claude-plugin/` fallback). It lists plugin entries with sources; it does not pin exact versions or commits. |
| **market** | The capability center's plugin-market surface, fed only by sources the user configured. A market publishes an index (or catalog); it is not a plugin host. |
| **plugin** | A Cordis plugin bundle: a package whose manifest is the `package.json` `musepi` block (`omp` and `pi` are accepted for older packages). This is the native MusePi capability unit. |
| **compat plugin** | A bundle written for another host layout — Claude Code's `.claude-plugin/` or Codex's `.codex-plugin/` — and loaded through the compatibility layer. |
| **dock** | A fixed GUI seat a *loaded* plugin can claim: the composer dock (`conversation.composer.dock`) or a tab in the right-side panel. Browsing or installing never creates one; enabling a plugin can. |
| **lane** | One partition of the market list. Native plugins fill the main lane; compat plugins sit in one compat lane with a badge. |

**The main list shows MusePi plugins only.** A row is native when its index entry declares `runtime: "cordis"`. Claude- and Codex-compatible bundles appear in one separate compat lane, marked with a compat badge, never mixed into the main list. `runtime` names the manifest contract, not where the bundle came from: format 1 admits exactly `"cordis"` and `"claude"`, and a third contract requires a new format.

**The installed manifest is the authority.** After an install, the host re-reads the plugin's `package.json` `musepi` block (with `omp`/`pi` fallbacks) and checks the manifest's name, version, and display label against the install. An index is an unsigned claim by the market: its title, labels, and even its package name do not outrank the manifest that actually landed on disk.

## Commands

### Interactive mode

| Command        | Effect                                    |
| -------------- | ----------------------------------------- |
| `/marketplace` | Open interactive plugin browser (install) |

### Marketplace management

| Command                      | Effect                                       |
| ---------------------------- | -------------------------------------------- |
| `/marketplace add <source>`  | Add a marketplace source                     |
| `/marketplace remove <name>` | Remove a marketplace                         |
| `/marketplace update [name]` | Re-fetch catalog(s); omit name to update all |
| `/marketplace list`          | List configured marketplaces                 |

### Plugin operations

| Command                                                                   | Effect                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| `/marketplace discover [marketplace]`                                     | Browse available plugins                           |
| `/marketplace install [--force] [--scope user\|project] name@marketplace` | Install a plugin                                   |
| `/marketplace uninstall [--scope user\|project] name@marketplace`         | Uninstall a plugin; no args opens the TUI selector |
| `/marketplace installed`                                                  | List installed marketplace plugins                 |
| `/marketplace upgrade [--scope user\|project] [name@marketplace]`         | Upgrade one or all plugins                         |
| `/plugins list`                                                           | List npm/link and marketplace plugins              |
| `/plugins enable [--scope user\|project] name@marketplace`                | Enable a marketplace plugin                        |
| `/plugins disable [--scope user\|project] name@marketplace`               | Disable a marketplace plugin                       |

### CLI equivalents

The same operations are available from the command line:

```
musepi plugin marketplace add <source>
musepi plugin marketplace remove <name>
musepi plugin marketplace update [name]
musepi plugin marketplace list
musepi plugin discover [marketplace]
musepi plugin install [--force] [--scope user|project] name@marketplace
musepi plugin uninstall [--scope user|project] name@marketplace
musepi plugin upgrade [--scope user|project] [name@marketplace]
musepi plugin enable [--scope user|project] name@marketplace
musepi plugin disable [--scope user|project] name@marketplace
```

## Marketplace sources

When you run `/marketplace add <source>`, the system classifies the source:

| Source format                   | Type                                               | Example                                |
| ------------------------------- | -------------------------------------------------- | -------------------------------------- |
| `owner/repo`                    | GitHub shorthand                                   | `anthropics/claude-plugins-official`   |
| `https://...*.json`             | Direct catalog URL                                 | `https://example.com/marketplace.json` |
| `https://...` / `http://...`    | Git repository unless the URL path ends in `.json` | `https://github.com/org/repo`          |
| `git@...` / `ssh://...`         | Git repository                                     | `git@github.com:org/repo.git`          |
| `./path` or `~/path` or `/path` | Local directory                                    | `./my-marketplace`                     |

Git and local sources must contain a catalog at `.omp-plugin/marketplace.json` (preferred) or `.claude-plugin/marketplace.json` (Claude Code-compatible fallback). Direct catalog URLs cache only the JSON catalog; plugins in URL-sourced catalogs cannot use relative string sources like `"./plugins/foo"`.

## Catalog format (marketplace.json)

A marketplace catalog lives at `.omp-plugin/marketplace.json` in the repository root. When musepi is the only intended consumer, prefer this path. To remain Claude Code-compatible (musepi loads the same shape from either path), publish at `.claude-plugin/marketplace.json` instead — musepi uses it as a fallback when `.omp-plugin/marketplace.json` is absent. A repository may ship both: musepi reads the `.omp-plugin/` copy, Claude Code reads the `.claude-plugin/` copy. Same catalog format either way:

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "my-marketplace",
  "owner": {
    "name": "Your Name",
    "email": "you@example.com"
  },
  "metadata": {
    "description": "A collection of plugins",
    "version": "1.0.0",
    "pluginRoot": "plugins"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What this plugin does",
      "source": "./my-plugin",
      "category": "development",
      "homepage": "https://github.com/you/my-plugin"
    }
  ]
}
```

### Required fields

| Field        | Description                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `name`       | Marketplace name. Lowercase alphanumeric, hyphens, and dots. Must start and end with alphanumeric. Max 64 chars. |
| `owner.name` | Marketplace owner name                                                                                           |
| `plugins`    | Array of plugin entries                                                                                          |

Top-level `metadata.description`, `metadata.version`, and `metadata.pluginRoot` are optional. When `metadata.pluginRoot` is set, it is prepended to relative plugin `source` paths.

### Plugin entry fields

| Field         | Required | Description                                                                             |
| ------------- | -------- | --------------------------------------------------------------------------------------- |
| `name`        | yes      | Plugin name (same rules as marketplace name)                                            |
| `source`      | yes      | Where to find the plugin (see below)                                                    |
| `description` | no       | Short description                                                                       |
| `version`     | no       | Version string; install version falls back to plugin manifest, source SHA, then `0.0.0` |
| `author`      | no       | `{ name, email? }`                                                                      |
| `homepage`    | no       | URL                                                                                     |
| `repository`  | no       | Repository URL/string                                                                   |
| `license`     | no       | License string                                                                          |
| `keywords`    | no       | Array of string keywords                                                                |
| `category`    | no       | Category string (e.g. `development`, `productivity`, `security`)                        |
| `tags`        | no       | Array of string tags                                                                    |
| `strict`      | no       | Boolean                                                                                 |
| `commands`    | no       | Slash commands provided                                                                 |
| `agents`      | no       | Agents provided                                                                         |
| `hooks`       | no       | Hook definitions                                                                        |
| `mcpServers`  | no       | MCP server definitions                                                                  |
| `lspServers`  | no       | LSP server definitions or path; copied to `.lsp.json` on install                        |

### Plugin source formats

The `source` field supports these formats. String sources must start with `./` and are resolved inside the marketplace root, after optional `metadata.pluginRoot` is prepended:

**Relative path** (within the marketplace repo):

```json
"source": "./my-plugin"
```

**Git repository URL**:

```json
"source": {
  "source": "url",
  "url": "https://github.com/org/repo.git",
  "sha": "abc123..."
}
```

**GitHub shorthand**:

```json
"source": {
  "source": "github",
  "repo": "org/repo",
  "ref": "main",
  "sha": "abc123..."
}
```

**Git subdirectory** (monorepo):

```json
"source": {
  "source": "git-subdir",
  "url": "https://github.com/org/monorepo.git",
  "path": "plugins/my-plugin",
  "ref": "main",
  "sha": "abc123..."
}
```

**npm package** (parsed but not installable yet):

```json
"source": {
  "source": "npm",
  "package": "@scope/my-plugin",
  "version": "1.0.0"
}
```

Current installer behavior rejects npm marketplace sources with `npm plugin sources are not yet supported`; use relative, GitHub, URL, or git-subdir sources.

## Plugin index format (`musepi-plugin-index`)

A market can publish one index instead of a catalog. The index is one document with everything a list renders plus every installable version; the host reads it from a source the user configured and validates it as a whole. Format 1 is defined by `index-format.ts` (`parsePluginIndex`) and read by `index-source.ts`.

```json
{
  "format": 1,
  "name": "musepi-market",
  "title": { "en": "MusePi Market", "zh": "MusePi 市场" },
  "description": { "en": "Community MusePi plugins", "zh": "社区 MusePi 插件" },
  "owner": { "name": "MusePi" },
  "metadata": {
    "categories": { "productivity": { "title": { "en": "Productivity", "zh": "效率" } } },
    "labels": { "official": { "title": { "en": "Official", "zh": "官方" } } },
    "sortKeys": { "downloads": { "title": { "en": "Downloads", "zh": "下载量" }, "order": "desc" } }
  },
  "plugins": [
    {
      "name": "@musepi/auto-review",
      "runtime": "cordis",
      "title": { "en": "Auto Review", "zh": "自动审查" },
      "description": { "en": "Per-tool authorization review" },
      "author": "MusePi",
      "homepage": "https://example.com/auto-review",
      "repository": { "url": "https://github.com/musepi/plugins", "directory": "auto-review" },
      "license": "MIT",
      "metadata": {
        "category": "productivity",
        "labels": ["official"],
        "keywords": ["review", "authorization"],
        "sortKeys": { "downloads": 12034 }
      },
      "versions": [
        {
          "version": "0.2.0",
          "publishedAt": 1790476800,
          "source": { "type": "npm", "registry": "https://registry.example.com/npm" },
          "engines": { "musepi": ">=0.2.0 <0.3.0" }
        },
        {
          "version": "0.1.0",
          "publishedAt": 1789872000,
          "source": {
            "type": "git",
            "url": "https://github.com/musepi/plugins",
            "commit": "3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4",
            "path": "auto-review"
          },
          "engines": { "musepi": "*" }
        }
      ]
    }
  ]
}
```

`LocalizedText` is a non-blank string, or an object mapping language id → non-blank string. Language ids match `^[a-z]{2,8}(-[a-z0-9]{1,8})*$`; an object declares at least one language.

### Root fields

| Field | Required | Rule |
| --- | --- | --- |
| `format` | yes | Integer `1`. Any other value (or a missing value) rejects the index. |
| `name` | yes | Market name; the same lowercase name-segment rule as a marketplace name (max 64). |
| `title` | yes | `LocalizedText` naming the market. |
| `description` | no | `LocalizedText`. |
| `owner` | yes | `{ "name": string, "email"?: string }`. |
| `metadata` | no | Declaration maps below; absent means no declarations. |
| `plugins` | yes | Array of plugins, possibly empty. Array order is the initial display order. |

`metadata.categories` and `metadata.labels` map an id → `{ "title": LocalizedText }`. `metadata.sortKeys` maps an id → `{ "title": LocalizedText, "order": "asc" | "desc" }`. Category, label, and sort-key ids are opaque: the market filters, sorts, and displays their titles, and never interprets an id.

### Plugin fields

| Field | Required | Rule |
| --- | --- | --- |
| `name` | yes | Lowercase npm package name; unique within the index. |
| `runtime` | yes | `"cordis"` (native MusePi manifest) or `"claude"` (compat manifest). |
| `title` | no | `LocalizedText`; a reader displays `name` when absent. |
| `description` | no | `LocalizedText`. |
| `icon` | no | Inline `data:<type>;base64,<payload>` (`image/svg+xml`, `image/png`, `image/jpeg`, `image/webp`; canonical padded base64; at most 32 KiB decoded) or an absolute `https:` URL. |
| `glyph` | no | Short text/emoji stand-in, at most 32 UTF-16 code units. |
| `author` | no | Non-blank string. |
| `homepage` | no | Absolute `http:`/`https:` URL without credentials. |
| `repository` | no | `{ "url": string, "directory"?: string }`. Display only, never an install source. `url` is an absolute `http:`/`https:` URL without credentials, query, or fragment; `directory` is a safe relative path. |
| `license` | no | Non-blank string. |
| `metadata` | no | `category` (one declared id), `labels` (distinct declared ids), `keywords` (free-form strings), `sortKeys` (declared id → finite number or `null`). |
| `versions` | yes | Non-empty array; exact version strings are unique within the plugin. |

Undeclared category, label, or sort-key references reject the whole index. Unknown members at any level are dropped and reported with their JSON path, so a newer writer's extra field never breaks an older reader and never passes silently. An unrecognized `source.type` is an error, not an unknown member: a version whose pin form the reader does not understand cannot be installed.

### Version fields

| Field | Required | Rule |
| --- | --- | --- |
| `version` | yes | Exact SemVer, canonical form. Ranges (`^1.0.0`, `>=1`), tags (`latest`), and `v`-prefixed or leading-zero strings are rejected. |
| `publishedAt` | yes | Integer Unix timestamp in seconds, `0 ≤ publishedAt < 10^11`. |
| `source` | yes | One of the two forms below. |
| `engines` | yes | `{ "musepi": <valid npm SemVer range> }`, copied from the installed manifest. `*` declares support for any host version. |

`source` forms:

- **npm** — `{ "type": "npm", "registry"?: string }`. `registry` is an `http:`/`https:` URL without credentials, query, or fragment. Without it, the installer uses its configured registries.
- **git** — `{ "type": "git", "url": string, "commit": string, "path"?: string }`. `url` is a canonical `https:` URL (equal to its WHATWG serialization) with at least two path segments, no trailing slash, no credentials/query/fragment, and no `.tgz`/`.tar.gz` suffix. `commit` is a lowercase 40-hex-digit SHA. `path` is a `/`-separated relative directory whose segments contain only ASCII letters, digits, and `._@+-`, and are neither `.` nor `..`; absent means the repository root.

The index has no free-form install field. The host derives the installer argument from the exact version and the structured source, so a reader can verify that the install is pinned to what the list displayed:

- npm → `name@exactVersion`, with the named registry applied to that install only.
- git → `git+<url>.git#<commit>`, with `&path:/<path>` appended when `path` is present; an existing `.git` suffix is not doubled.

**Default version**: highest compatible stable version (no prerelease part). Only when no stable version is compatible does the host choose the highest compatible prerelease. There is no npm `latest` fallback — an unpublished tag must never decide what an index entry installs. Compatibility means the host version satisfies that version's `engines.musepi` range (a prerelease host is also checked by its base version).

### Reading an index

- Index URLs are user configuration. The reader only reads configured sources; it exposes no method that fetches an arbitrary URL.
- Allowed schemes are `http:` and `https:`; URLs with credentials or a fragment are rejected.
- Redirects are followed only within the configured URL's origin, up to three hops. A market cannot bounce a reader to another host.
- The response body is bounded (8 MiB default) before JSON parsing.
- A successful document is cached for a TTL (5 minutes default). A read reports the document's `fetchedAt`; concurrent reads of the same URL join one in-flight request.
- Git-hosted indexes are reserved for the next phase: the location type and docs carry them, and the reader rejects them with a named error instead of fetching.

## On-disk layout

```
~/.musepi/
  marketplaces.json              # Registry of added marketplaces
  plugins/
    installed_plugins.json       # User-scoped marketplace plugins (version: 2)
    musepi-plugins.lock.json         # Runtime enable/feature state
    node_modules/<package>        # Symlink to the cached plugin
    cache/
      marketplaces/<name>/       # Cached marketplace clone/catalog
      plugins/<marketplace>___<plugin>___<version>/  # Cached plugin directories

<project>/.musepi/
  plugins/
    installed_plugins.json       # Project-scoped marketplace plugins (version: 2)
    musepi-plugins.lock.json         # Project runtime enable/feature state
    node_modules/<package>        # Symlink to the cached plugin
```

## Naming rules

Marketplace and plugin names must:

- Start and end with a lowercase letter or digit
- Contain only lowercase letters, digits, hyphens, and dots
- Be at most 64 characters

Plugin IDs (`name@marketplace`) must be at most 128 characters total.

Valid examples: `my-plugin`, `code-review`, `wordpress.com`, `ai-firstify`
Invalid examples: `-bad`, `bad-`, `.bad`, `Bad`, `under_score`
