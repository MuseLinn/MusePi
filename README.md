<p align="center">
  <strong>MusePi</strong> — a desktop-first AI coding agent
</p>

<p align="center">
  <code>musepi</code> CLI · Electron desktop GUI · always-on desktop pet · daemon service
</p>

<p align="center">
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#screenshots"><strong>Screenshots</strong></a> ·
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="#architecture"><strong>Architecture</strong></a> ·
  <a href="#development"><strong>Development</strong></a> ·
  <a href="#packaging--releases"><strong>Packaging & Releases</strong></a> ·
  <a href="#documentation"><strong>Documentation</strong></a>
</p>

<p align="center">
  <em>中文版见 <a href="README.zh-CN.md">README.zh-CN.md</a></em>
</p>

---

MusePi is a **desktop-first fork of [oh-my-pi](https://github.com/can1357/oh-my-pi)** (OMP; itself a fork of [Pi](https://github.com/badlogic/pi-mono)). It keeps the upstream agent engine intact — 40+ LLM providers, 32 built-in tools, LSP/DAP wiring, subagents, hashline, hindsight, ACP, collab — and builds an **Electron desktop GUI, a daemon service, and an always-on desktop pet** on top. The full TUI command surface (`/` commands, `!`/`!!` shell, `@` file mentions, `#` references) is wired into the GUI.

App version `0.3.1` (independent of upstream versioning; see [UPSTREAM.md](UPSTREAM.md)).

## Features

### Desktop GUI (the core delta vs. OMP)

- **Electron desktop app** (`packages/gui`): three-pane layout (session sidebar + chat stream + context panel), Chinese-first UI, three-axis design tokens (theme / accent / density), frosted-glass vibrancy window.
- **Always-on desktop pet**: an animated companion in the corner of the screen (petdex frame-animation packs, drag positioning, click-through, hover interactions, cross-window activity bridge); task progress surfaces as pet bubbles.
- **Daemon architecture**: the GUI talks JSON-RPC to the daemon (`musepi serve`). Sessions persist via journal + materialized view, idle 30 min sessions become history snapshots and reactivate on demand. The daemon survives GUI exit; reconnecting resumes.
- **Managed browser** (`browser.gui` tool): Electron `WebContentsView` + CDP bridge — the agent can drive an embedded browser page in the GUI, with projected layout and pixel-sampled verification.
- **Integrated terminal**: xterm + bun-pty with tabs (middle-click close), hardened env (strips `ELECTRON_RUN_AS_NODE` etc., injects `APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP`).
- **Full command surface (TUI parity)**:
  - `/` slash commands: the daemon reuses the ACP headless executor (same builtin registry); `//` escapes to literal text; the welcome surface runs commands on session creation with pet-bubble + desktop-notification output.
  - `!cmd` / `!!cmd`: run shell commands (output fed to the model context; `!!` excludes it). The transcript renders a terminal-style bash card with an exit-code badge and collapsible output.
  - `@` file mentions: workspace-tree completion; the daemon's `extractFileMentions` injects file contents.
  - `#` session references: session-list completion that inserts `history://<id>` (a read-tool-resolvable internal URL).
- **Context management**: context donut (`session.contextUsage` live usage), `/compact`-parity manual compaction, snapcompact savings estimate (same planner as TUI `/context`).
- **Settings panel**: all 336 TUI settings merged into the desktop settings (schema-driven via the `settings.schema` RPC, same source of truth as the TUI), 10+ tabs; shared controls (toggle / segmented / select / masked credential inputs).
- **Rich interactions**: image attachments pre-scaled client-side (`images.autoResize` honored on both ends), image lightbox preview (multi-image stacks, zoom/pan), attachment keyboard deletion, voice input, per-session draft persistence, idle recap (`recap.enabled`), reminders panel (live `working`/`live` session states), ⌘K command palette, Board kanban, widget system (custom HTML widgets with theme hot-swap).
- **Relaunch experience**: differentiated splash hold (warm relaunch ~1.1s vs cold 2s), main-window bounds restore (`main-window.json`, work-area clamped, drag/resize debounced), last-session reopen on boot (failed opens never poison the stored id).
- **Right context panel**: file tree (PDF/image/text previews, open-in-system), Git changes & commits (gitmoji, identity injection, GitHub device-flow auth), PR list, embedded browser (viewport presets, element picking), project notes + todos + plan files.
- **Subagent operations** (Agent Hub parity): stop / revive / chat from the AgentsPanel (`agents.kill` / `agents.revive` / `agents.chat` RPC).

### Inherited from upstream OMP

- **40+ LLM providers**, 32 built-in tools, `xd://` device extensions, continuously tuned prompts.
- **LSP** wired into every write (renames, references, code actions); **DAP** debugger driving.
- **task subagents** (parallel fan-out, IRC coordination, worktree isolation, schema-validated outputs), **hashline** content-hash edits, **hindsight** session memory, **ACP** editor-driven mode, **collab** sharing (with musepi extras: self-hosted LAN/tunnel/Tailscale-serve relays, plaintext guest mode).
- **snapcompact** compaction (dense bitmap frames for vision models), **magic keywords** (ultrathink / orchestrate / workflowz), **TTSR** stream rules.

## Screenshots

| Welcome | Session | Settings |
|---|---|---|
| <img src="docs/screenshots/gui-welcome.png" width="420" alt="Welcome"> | <img src="docs/screenshots/gui-session.png" width="420" alt="Session with bash card"> | <img src="docs/screenshots/gui-settings.png" width="420" alt="Settings"> |

## Quick Start

Requires **Bun ≥ 1.3.14** (macOS is the primary development platform; Rust toolchain needed for natives builds).

### Development mode

```sh
# Install deps + build natives + link the CLI
bun run setup

# Terminal TUI (upstream CLI surface)
bun run musepi          # or: bun run dev

# Daemon service (GUI backend; also auto-started by the GUI)
bun --cwd=packages/coding-agent src/cli.ts serve --port 8300

# Desktop GUI (build + launch Electron)
bun --cwd=packages/gui run desktop
```

`musepi` subcommands inherit OMP: `launch` (default chat), `serve` (daemon), `acp`, `agents`, `commit`, `config`, `join`, `models`, `plugin`, `say`, `share`, `setup`, `shell`, `stats`, `update`, `completions`, …

Config lives under `~/.musepi/` (branding delta; override with `PI_CONFIG_DIR`).

## Architecture

```
┌──────────────┐    JSON-RPC (collab-proto)    ┌──────────────────────┐
│  Electron GUI │ ◄────────────────────────────► │  musepi serve (daemon)│
│  packages/gui │   WS event stream (journal)   │  packages/coding-agent│
│  + collab-web │                               │  AgentSession host    │
└──────┬───────┘                               └──────────┬───────────┘
       │                                                    │
       │  pet.html / bubble.html / pin.html                 │ agent engine
       │  (pet / bubble / pinned windows)                   ▼
       │                                         packages/agent · ai · tui
       │                                         natives (Rust N-API)
       ▼
  collab-web: transcript / tool-render / widget / i18n (zh-CN single source)
```

| Package | Role |
|---|---|
| `gui` | Electron desktop app (main window + pet/bubble/pinned windows, xterm, pdf.js, managed-browser bridge) |
| `collab-web` | GUI rendering core (transcript, tool cards, widget system, i18n) and the collab web UI |
| `coding-agent` | CLI entry (`musepi`), daemon server, slash/bash commands, tool implementations |
| `collab-proto` | GUI ↔ daemon transport (WS frames, crypto, links) |
| `agent` / `ai` / `tui` / `catalog` / `wire` / `utils` / `hashline` / `snapcompact` / `mnemopi` / `stats` | Upstream-derived engine / provider registry / TUI / model catalog / wire types / utils |
| `sdk` | Client SDK (MaterializedView, session-stream event contract) |
| `natives` | Rust N-API bindings (Bazel/cargo builds, macOS LINKEDIT alignment post-processing) |
| `swarm-core` / `swarm-extension` / `tool-select` / `browser-relay` / `metaharness` | Subagent orchestration / tool selection / browser relay / harness tooling |

Key contract docs:

- **GUI design spec**: `docs/gui-design.md` (layout / tokens / motion / component patterns / pet visual style)
- **GUI implementation notes**: `docs/gui-implementation.md` (daemon RPC shapes, IPC, pitfalls, verification workflows)
- **Widget design system**: `docs/widget-design-system.md`
- **Collab**: `docs/collab.md` (incl. musepi LAN/tunnel extras)
- **Upstream sync**: `UPSTREAM.md` (baseline v17.2.12, PURE/THREE_WAY/NEW/MANUAL classification, verification records)

## Development

```sh
bun run setup            # install + natives build + link
bun run build            # workspace build (incl. GUI dist)
bun run check            # parallel check:ts (tsgo) + check:rs (cargo)
bun run test             # bun scripts/ci-test-ts.ts local
bun run lint / fmt       # biome + rustfmt
```

Testing notes (recorded in UPSTREAM.md):

- Full test runs prefer `OMP_TEST_CONCURRENCY=4` (default concurrency 8 is memory-heavy on this machine).
- The Rust bucket needs `cargo-nextest` and a PATH with `~/.cargo/bin` first.
- After touching `collab-web`, rebuild the GUI (`bun --cwd=packages/gui run build`) before verifying — browsers cache the old bundle.
- GUI/daemon E2E isolation: run a test daemon on :8310 with `PI_CONFIG_DIR=musepi-test`; launch the test GUI with `--user-data-dir=/tmp/...` + `MUSEPI_MANAGED_BROWSER_PORT=9231` + `--remote-debugging-port=9223`; puppeteer connects to **9223** (the CDP endpoint) only.

Commit convention: `git commit --no-verify` (husky/biome baseline warnings); natives changes need a rebuild (`bun run build:native`, LINKEDIT alignment handled automatically).

## Packaging & Releases

### Desktop app (macOS)

```sh
bun --cwd=packages/gui run pack          # build + electron-builder + codesign
bun --cwd=packages/gui run pack:dir      # electron-builder dir build + codesign (no rebuild)
```

Produces `release/mac-arm64/MusePi.app`. The `pack` scripts ad-hoc sign the bundle so it runs locally. **Distribution builds** need a Developer ID Application certificate + notarization — macOS 26 refuses unsigned/non-notarized apps for several entitlements (notifications, etc.). See `docs/macos-signing-notarization.md` for the CLI-binary flow (hardened runtime + `notarytool`); unlike a bare Mach-O, the `.app` bundle can additionally be **stapled** (the ticket rides inside the bundle), so Gatekeeper assessments pass offline.

### CLI

The npm/GitHub release pipeline is inherited from upstream (`ci:release:*` scripts); `musepi update` self-updates the installed CLI.

## Documentation

- `docs/`: 95+ documents (GUI, providers, tools, hooks/extensions/skills, LSP/DAP, collab, compaction, ACP, settings, i18n, …)
- `docs/gui-design.md` / `docs/gui-implementation.md`: GUI living docs (keep in sync with code changes)
- `UPSTREAM.md`: upstream sync notes (version ripple, manual resolutions, pitfalls)

## Upstream sync

MusePi tracks upstream OMP (current baseline **v17.2.12**, app version 0.3.1). Syncs classify `git diff -M` hunks as PURE (rename+copy) / THREE_WAY (3-way merge) / NEW / MANUAL, renaming `@oh-my-pi` → `@musepi`; musepi-customized files (GUI, daemon, i18n, collab LAN/tunnel, computer-use event passthrough, settings locale, …) are handled as OVERLAP — ours kept, theirs merged in. Full procedure in `UPSTREAM.md`.
