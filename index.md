---
layout: default
title: MusePi
---

# MusePi

**MusePi** — a desktop-first AI coding agent, forked from [oh-my-pi](https://github.com/can1357/oh-my-pi).

`musepi` CLI · Electron desktop GUI · always-on desktop pet · daemon service

- **Desktop GUI**: three-pane layout, Chinese-first UI, frosted-glass vibrancy window, 336 TUI settings merged into the desktop settings panel, always-on pet (petdex frame-animation packs), managed browser, integrated terminal, Board kanban, widget system.
- **Daemon architecture**: JSON-RPC over WS (`collab-proto`); sessions persist via journal + materialized view; idle sessions become history snapshots; the daemon survives GUI exit.
- **Agent engine**: 40+ LLM providers, 32 built-in tools, LSP/DAP wiring, task subagents, hashline, hindsight, ACP, collab sharing.

## Documentation

The full document set lives in [`docs/`](docs/) — rendered below.

## Quick Start

```sh
bun run setup
bun run musepi          # terminal TUI
bun --cwd=packages/coding-agent src/cli.ts serve --port 8300   # daemon
bun --cwd=packages/gui run desktop    # desktop GUI
```

See [README.md](README.md) for the complete guide.

## Key Docs

- [GUI design spec](docs/gui-design.md) — layout / tokens / motion / component patterns / pet visual style
- [GUI implementation notes](docs/gui-implementation.md) — daemon RPC shapes, IPC, pitfalls, verification workflows
- [Widget design system](docs/widget-design-system.md)
- [Collab](docs/collab.md) — incl. musepi LAN/tunnel extras
- [Upstream sync](UPSTREAM.md) — baseline v17.2.12, PURE/THREE_WAY/NEW/MANUAL classification
