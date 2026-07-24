# Changelog

## [Unreleased]

## [0.1.8] - 2026-07-24

### New Features

- **Foreign Session Import** — Claude Code and Codex session scanners with `[claude]`/`[codex]` badges, a Claude-to-MusePi session converter with native content block passthrough, the `/import-claude` command with a checkbox selector (MCP servers, skills), and a `/setup` 5-step setup wizard (Welcome, Provider, Scanning, Claude Import, Apply). Configure via `musepi.settings.json`: `scanClaudeSessions`, `scanCodexSessions`, `claudeImportHintSeen`. Startup hint detection with persisted `claudeImportHintSeen`.

### Fixed

- **Task browser crash** — `task.usage` being undefined no longer crashes `/tasks`; shows `—` instead.
- **`/swarm` bare text** — non-`on|off|status` arguments are now forwarded to the model as a prompt.

### Changed

- **Package renamed** — `@earendil-works/pi-coding-agent` → `@muselinn/musepi`. The CLI binary is still `musepi`.
- **Orchestrator removed** — deleted `packages/orchestrator/` (unused upstream Radius orchestration service).

### Fixed

- **Windows shrinkwrap validation** — optional platform dependencies (e.g. `clipboard-darwin-arm64`) no longer cause validation failures on Windows.
- **model-data test** — fixed test fixture file ordering; upstream test data format updated to v0.82.0.
- **CI** — removed pi-ai test step (upstream native binding incompatibility with `--ignore-scripts`); removed orchestrator from build:offline.

All notable changes to MusePi are documented in this file.

MusePi is a fork of [pi](https://github.com/earendil-works/pi). The pre-fork
upstream history (pi 0.5.x–0.81.x) lives in the
[upstream changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)
and is mirrored next to this file as `UPSTREAM-CHANGELOG.md`.

## [0.1.6] - 2026-07-24

### Fixed

- **Windows update** — replace detached PowerShell script with in-process file rename (rename running exe, copy new exe, verify, rollback). No more 3-second delay or script failures.
- **Changelog** — v0.1.5 section was empty due to merge corruption; content restored.

### Changed

- **Upstream v0.82.0** — merged 40 upstream commits including constrained sampling API, OpenRouter OAuth, Kimi Code subscription OAuth, bash session metadata, model picker hot-reload, bash_execution_update events, and various fixes.

## [0.1.5] - 2026-07-24

### Added

- **Permission mode badge** — `/mode auto|yolo|manual` now sets a footer badge.
- **Plan mode badge** — `/plan on` sets a `plan` footer badge; `/plan off` clears it.

### Changed

- **Footer layout redesign** — Oh My Pi-inspired hybrid layout: PWD + git branch and model + context percentage now live in the editor top border. Footer shows token/cache/cost stats on line 1 and extension status badges on line 2.

### Fixed

- **macOS tar extraction** — only pass `--force-local` to tar on Windows; macOS tar rejects this flag.
- **Update fallback hint** — when auto-update is unavailable, print the install-script one-liner alongside the manual download link.
- **Windows auto-update** — wait 3 seconds before process exit so the detached PowerShell swap script has time to start watching.

## [0.1.3] - 2026-07-24

### New Features

- **Missing slash commands** — 7 slash commands from the harness extension are now built into the coding-agent TUI.

### Changed

- **Upstream v0.81.1** — merged 50 upstream commits including streamFn compatibility, deferred catalog refresh, llama download progress, sqlite session storage, compaction retries, usage accounting, RPC thinking levels, Qwen Token Plan provider, tui paste registry fix, and video content API.

- **Corrected slash command mappings** — `/mode` now controls permission policy (auto/yolo/manual), `/plan` toggles plan mode on/off/clear, `/goal` gains the `budget` subcommand, `/swarm` reports background task status, `/permission` removed (merged into `/mode`). `/goal` manages the active goal lifecycle (set, status, pause, resume, cancel, replace, next, budget) and the goal queue (add, prioritize, drop, skip); `/mode` switches the permission policy (auto, yolo, manual); `/plan` toggles plan mode on and off; `/swarm` reports background task status; `/tasks` is registered in the command palette (already available via the existing handler and Ctrl+Shift+T keybinding); `/todo` adds list items, marks them done, or shows the todo panel.

## [0.1.2] - 2026-07-23

Binary self-update, and a redesigned project site.

### New Features

- **Binary self-update** — `musepi update` now downloads the platform archive from the fork's GitHub Releases and swaps the install directory in place (interactive confirmation, `--yes` to skip, `--check` to only report, `--force` to reinstall). POSIX installs swap in-process; Windows hands the swap to a detached PowerShell script that runs after the process exits. The previous install is kept as a `musepi.old-*` backup until the next successful update, verification failures roll back automatically, and non-archive or non-writable installs fall back to the manual download link. `musepi update --all` honors `musepi.updateCheck=false`; an explicit `musepi update` always checks.
- **Site redesign** — the Pages site adopts the pi.dev graph-paper look with a pixel mark, a tabbed install box, and a bilingual (EN/中文) toggle.

## [0.1.1] - 2026-07-23

Settings and memory surfaces, the fork's own changelog pipeline, and CI
reliability fixes.

### New Features

- **Grouped settings panel** — the settings list gains section headings (skipped by navigation, matched by search), and the main panel is reorganized from a flat list into Session / Images / Interface / Advanced / MusePi sections.
- **MusePi settings submenu** — all 42 `musepi.*` feature settings are editable from the TUI, grouped Memory / MCP / LSP / Advisor / Model Roles / Tools / Swarm / Interface / Updates & Compat: booleans and enums cycle in place, numbers cycle curated presets, model specs open a text input, and nested registries point at `settings.json`.
- **`/memory` command** — `view` shows the exact startup memory injection, `stats` reports paths/entry counts/BM25 policy, `clear` resets project/global/all behind an interactive confirm, and `enable`/`disable` persist `musepi.memory.enabled` and hot-switch by re-binding the memory tool without a restart.

### Fixed

- **Own CHANGELOG drives What's New** — `packages/coding-agent/CHANGELOG.md` now tracks MusePi releases (pre-fork upstream history preserved as `UPSTREAM-CHANGELOG.md`, mirrored by the repo-root `CHANGELOG.md`), What's New links rewrite to MuseLinn/MusePi, and a last-seen version newer than the running one (e.g. migrating from upstream pi 0.81.x) shows this distribution's entries instead of nothing.
- **goalId same-millisecond collision** — goal ids gain a random suffix, fixing the same-ms collision that flaked the CI goal test.
- **CI reliability** — build runs before check so fresh runners have `@musepi/*` dist output, the Pages checkout gets `contents: read`, and the LSP URI normalization test is platform-independent.

## [0.1.0] - 2026-07-22

First MusePi release: the pi agent harness (`earendil-works/pi` 0.81.x base)
with the muselinn feature set layered on top of the upstream agent loop. See
[UPSTREAM.md](../../UPSTREAM.md) for the pin + cherry-pick policy towards
upstream.

### New Features

- **MusePi branding & independent config home** — the CLI identifies as `musepi` and reads/writes `~/.musepi` instead of `~/.pi`, coexisting with a stock pi install. First run migrates auth/settings/models/keybindings from `~/.pi/agent`.
- **Own update channel** — update checks run against [MusePi GitHub Releases](https://github.com/MuseLinn/MusePi/releases) (`musepi.updateCheck`, default on), with one-line installers for macOS/Linux/Windows and prebuilt binaries for six platform targets.
- **Hashline editing** — hash-anchored edit format (`@musepi/core/hashline`) for robust, retryable file edits by weaker models.
- **Native video understanding** — kimi-k3 `video_url` wire support and video input through the read tool, with provider capability declarations.
- **Native advisor** — a second-opinion advisor wired natively into the agent loop.
- **Native MCP** — first-class MCP server support with an `mcp` command.
- **W5 memory** — MiMo-style Markdown memory store with BM25 retrieval and dedicated memory tools (`musepi.memory.enabled`, default off).
- **Seven-scope skills** — skill discovery across project and user scopes spanning host-native, Kimi Code compat, and `.agents` cross-tool directories.
- **Snap compaction** — `snapcompact` snapshot-based context compaction.
- **`/move` command** — move the current session to another working directory.
- **Tool selection & model roles** — `toolSelect` tool gating and `modelRoles` per-role model assignment.
- **LSP, notifications & compat** — language-server integration, desktop notifications, and the extension compat layer that keeps upstream pi extensions loading unchanged.

### Added

- `@musepi/core` — host-independent MusePi agent orchestration core (goal/plan/permission/hooks/skills/swarm/task).
- `@musepi/transcript` — MusePi transcript layer.
- Muselinn renderer replacing the upstream TUI rendering surface (upstream pi-tui editor hooks remain patched at the seam).
