# Changelog

All notable changes to MusePi are documented in this file.

MusePi is a fork of [pi](https://github.com/earendil-works/pi). The pre-fork
upstream history (pi 0.5.x–0.81.x) is preserved at
[packages/coding-agent/UPSTREAM-CHANGELOG.md](packages/coding-agent/UPSTREAM-CHANGELOG.md)
and in the
[upstream changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md).

## [Unreleased]

## [0.1.0] - 2026-07-22

First MusePi release: the pi agent harness (`earendil-works/pi` 0.81.x base)
with the muselinn feature set layered on top of the upstream agent loop. See
[UPSTREAM.md](UPSTREAM.md) for the pin + cherry-pick policy towards upstream.

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
