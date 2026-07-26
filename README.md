# MusePi

<p>
  <a href="https://github.com/MuseLinn/MusePi/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MuseLinn/MusePi/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://muselinn.github.io/MusePi/"><img alt="Site" src="https://img.shields.io/badge/site-muselinn.github.io%2FMusePi-0e5f4e?style=flat-square" /></a>
  <a href="https://github.com/MuseLinn/MusePi/releases"><img alt="Release" src="https://img.shields.io/github/v/release/MuseLinn/MusePi?style=flat-square" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

MusePi is a fork of the [pi agent harness](https://github.com/earendil-works/pi)
(`earendil-works/pi`) with the muselinn feature set layered on top of the
upstream agent loop. See [CHANGELOG.md](CHANGELOG.md) for MusePi's own release
history — the same changelog drives the startup What's New screen (pre-fork
upstream history is preserved at
[packages/coding-agent/UPSTREAM-CHANGELOG.md](packages/coding-agent/UPSTREAM-CHANGELOG.md)).

* **[@musepi/coding-agent](packages/coding-agent)**: Interactive coding agent CLI (musepi command)
* **[@musepi/core](packages/musepi/core)**: MusePi core — pure agent orchestration logic (goal/plan/permission/hooks/skills/swarm/task), zero host imports
* **[@musepi/transcript](packages/musepi/transcript)**: MusePi transcript layer
* **[@musepi/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@musepi/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, Kimi, …)

## What MusePi adds over upstream pi

- **Hashline editing** — hash-anchored edit format (`@musepi/core/hashline`) for
  robust, retryable file edits by weaker models.
- **Long-term memory** — MiMo-style markdown memory (`@musepi/core/memory`):
  project + global `MEMORY.md` files, BM25 recall, a `memory` tool
  (search/retain/edit), and a budgeted one-shot startup injection. Opt-in via
  `musepi.memory.enabled` (default off); inspect and manage it with `/memory`
  (view/stats/clear/enable/disable — toggles hot-switch the live session).
- **Grouped settings panel** — the interactive settings UI is organized into
  sections with type-to-search, and a dedicated MusePi submenu exposes all 42
  `musepi.*` settings across nine groups (Memory / MCP / LSP / Advisor /
  Model Roles / Tools / Swarm / Interface / Updates & Compat): booleans and
  enums cycle in place, numbers cycle curated presets, and nested registries
  open an info panel pointing at `settings.json`.
- **Native advisor & MCP** — a second-opinion advisor wired natively into the
  agent loop, and first-class MCP server support (lazy stdio/http connections)
  managed with `/mcp`.
- **Session & workflow extras** — `/move` (move the current session to another
  working directory), seven-scope skills discovery, `snapcompact`
  snapshot-based context compaction, `toolSelect` dynamic tool gating,
  `modelRoles` per-role model routing, LSP integration, and desktop
  notifications.
- **Independent config home** — MusePi reads/writes `~/.musepi` instead of
  `~/.pi`, so it coexists with a stock pi install. First run migrates
  auth/settings/models/keybindings from `~/.pi/agent`; update checks run
  against MusePi's own GitHub Releases (`musepi.updateCheck`, default on).
- **Native video understanding** — kimi-k3 `video_url` wire support, video
  input through the read tool, and provider capability declarations in
  `@musepi/pi-ai`.
- **MusePi agent core** — goal/plan orchestration, permission, hooks, skills,
  swarm and task logic as a host-independent package.
- **Muselinn renderer** — `packages/musepi/renderer` replaces the upstream TUI
  rendering surface (upstream pi-tui editor hooks remain patched at the seam).
- **Multi-credential auth** — SQLite-backed credential store with identity key
  dedup, session-sticky PHRED routing, and persistent rate-limit blocks. Store
  multiple API keys or OAuth tokens per provider; manage them with
  `/credentials` (list/edit/delete) and route through the `/logout` flow.
  Remote machines share the credential pool via the **auth broker**
  (`musepi auth-broker serve` with AES-256-GCM encrypted snapshot cache).
- **Agent dashboard** — `/agents` full-screen browser with source tabs (All /
  Bundled / User / Project), per-agent detail inspector (model override,
  prewalk, system prompt preview), and enable/disable via settings.
  Bundled agents include `coder`, `explore`, `plan`, `scout`, `designer`,
  `reviewer`, `librarian`, and `task`, auto-discovered from swarm types.

## Relationship with upstream

MusePi tracks `earendil-works/pi` with a **pin + monthly cherry-pick** policy —
no continuous rebase. The pinned base commit, every cherry-pick, and the
conflict-surface rules are recorded in [UPSTREAM.md](UPSTREAM.md). In short:

- MusePi changes live in `packages/musepi/` and the TUI seam of
  `packages/coding-agent`; upstream changes concentrate in the agent/tool
  layer, so file overlap stays small.
- The extension API surface of `@muselinn/musepi` is kept
  compatible — installed extensions such as
  [pi-muselinn-harness](https://www.npmjs.com/package/pi-muselinn-harness) and
  termdraw load unchanged.
- Once a month we review upstream releases and cherry-pick agent-loop
  correctness fixes and extension API additions.

## All Packages

| Package | Description |
|---|:---|
| **[@musepi/coding-agent](packages/coding-agent)** | Interactive coding agent CLI (`musepi` command) |
| **[@musepi/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, Kimi, etc.) |
| **[@musepi/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@musepi/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@musepi/core](packages/musepi/core)** | MusePi agent orchestration core (goal/plan/permission/hooks/skills/swarm/task) |
| **[@musepi/transcript](packages/musepi/transcript)** | MusePi transcript layer |

## Install

### npm (recommended)

Requires **Node.js 22+**:

```sh
npm install -g @musepi/coding-agent
musepi --version    # => MusePi 0.2.0
```

Or run directly without installing:

```sh
npx @musepi/coding-agent
```

Config, sessions, and auth live under `~/.musepi` — a stock pi install is left
untouched.

### From source (Node 24)

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run check         # Lint, format, type check, and lockfile checks
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./musepi-test.sh     # Run MusePi from sources (can be run from any directory)
```

## Update

```sh
npm update -g @musepi/coding-agent
# or
musepi --version          # check current
npm outdated -g           # see what's new
```

Versions are lockstepped — every package shares one version. See
[releases](https://github.com/MuseLinn/MusePi/releases) for changelogs.

## Migration from 0.1.x (binary archives)

v0.2.0 switches distribution from GitHub Release binary archives to npm. If you
installed v0.1.x via the one-line installer, uninstall the old version first:

```sh
# macOS / Linux
rm -rf ~/.local/bin/musepi
sed -i '' '/# MusePi/d; /export PATH.*musepi/d' ~/.zshrc  # or your shell rc

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\musepi"
```

Then install via npm:

```sh
npm install -g @musepi/coding-agent
musepi --version    # => MusePi 0.2.0

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, type check, and lockfile checks
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./musepi-test.sh     # Run MusePi from sources (can be run from any directory)
```

Provider live/E2E tests skip automatically via
`describe.skipIf(!process.env.*_API_KEY)` when no API keys are present;
`PI_NO_LOCAL_LLM=1` additionally skips ollama/lmstudio tests.

### CI / CD

- **CI** (`.github/workflows/ci.yml`) — on every push to `main` and PR:
  `npm ci --ignore-scripts`, `npm run check`, `npm run build:offline`, the
  musepi suite (`@musepi/core` + `@musepi/transcript`) and the `@musepi/pi-ai`
  unit tests on `ubuntu-latest`. A `windows-latest` job runs the same targeted
  subset with `continue-on-error` (33 known pre-existing Windows environment
  failures in the full coding-agent suite keep it informational for now).
- **Release** (`.github/workflows/release.yml`) — pushing a `v*` tag runs
  `npm run build` and creates a GitHub Release with auto-generated release
  notes. Publish to npm is manual (`npm publish --workspaces --access public`).
  Standalone binaries are not yet distributed (follow [#1](https://github.com/MuseLinn/MusePi/issues/1)).

### GitHub Pages

The project site lives at <https://muselinn.github.io/MusePi/> — plain static
HTML in `docs/site/` (including the `install` / `install.ps1` one-liner
scripts), deployed by `.github/workflows/pages.yml` whenever `docs/site/`
changes on `main`.

## Permissions & Containerization

MusePi, like upstream pi, does not include a built-in permission system for
restricting filesystem, process, network, or credential access. By default, it
runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox it. See
[packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md)
for three patterns:

- **Gondolin extension**: keep the agent and provider auth on the host while
  routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole process in a local container for simple isolation.
- **OpenShell**: run the whole process in a policy-controlled sandbox.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- CI installs with `npm ci --ignore-scripts`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and
[AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## License & acknowledgments

MIT — see [LICENSE](LICENSE), retained from upstream.

MusePi is built on the excellent [pi](https://github.com/earendil-works/pi)
agent harness by [@badlogicgames](https://github.com/badlogicgames) and the
earendil-works contributors, and on the [pi.dev](https://pi.dev) ecosystem.
All upstream credit and copyright notices are preserved.
