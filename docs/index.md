---
layout: default
title: Documentation
---

# MusePi Documentation

English | [中文](index.zh-CN.md)

> Living docs are marked **活文档** — keep them in sync with code changes.

This index covers two different kinds of document. Everything above
**Developer records** describes the product or the implementation behind it —
use those when you are building or using MusePi. **Developer records** are
planning drafts, audit notes and superseded documents kept for history; they
are not a description of how anything currently works.

## Install (one command)

```sh
curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh
```

Installer defaults to the prebuilt release binary (`musepi-<os>-<arch>` + `SHA256SUMS.txt` on the GitHub release). `--source` forces a from-source clone + build; `--ref <tag>` pins a version.

## GUI & Desktop

- [gui-design.md](gui-design.html) — **活文档** GUI design spec: layout / tokens / motion / component patterns / pet visual style
- [gui-implementation.md](gui-implementation.html) — **活文档** GUI implementation notes: daemon RPC contracts, IPC shapes, pitfalls, verification workflows
- [i18n.md](i18n.html) — **活文档** i18n architecture: per-domain locale maps, compile-time en parity, plugin translation registration
- [gui-settings.md](gui-settings.html) — settings panel notes
- [mobile-design.md](mobile-design.html) — **活文档** mobile companion design spec · [ota-mobile-design.md](ota-mobile-design.html) OTA / in-app update design

## Sessions & Context

- [session.md](session.html) · [session-operations-export-share-fork-resume.md](session-operations-export-share-fork-resume.html) · [session-switching-and-recent-listing.md](session-switching-and-recent-listing.html)
- [compaction.md](compaction.html) · [non-compaction-retry-policy.md](non-compaction-retry-policy.html) · [context-files.md](context-files.html)
- [memory.md](memory.html) · [mnemosyne-memory-backend.md](mnemosyne-memory-backend.html) · [install-id.md](install-id.html) · [ttsr-injection-lifecycle.md](ttsr-injection-lifecycle.html)

## Providers & Models

- [providers.md](providers.html) · [models.md](models.html) · [adding-a-provider.md](adding-a-provider.html) · [local-models.md](local-models.html)
- [provider-compat-reference.md](provider-compat-reference.html) · [provider-endpoint-constraints.md](provider-endpoint-constraints.html) · [provider-quirks.md](provider-quirks.html) · [provider-streaming-internals.md](provider-streaming-internals.html)
- [ai-schema-normalize.md](ai-schema-normalize.html) · [arktype-guide.md](arktype-guide.html) · [musepi-type-guide.md](musepi-type-guide.html) · [gemini-manifest-extensions.md](gemini-manifest-extensions.html)

## Tools & Runtimes

- [custom-tools.md](custom-tools.html) · [tools/](tools/) (built-in tool docs) · [toolconv/](toolconv/) (tool-schema conversion notes) · [marketplace.md](marketplace.html)
- [bash-tool-runtime.md](bash-tool-runtime.html) · [python-repl.md](python-repl.html) · [resolve-tool-runtime.md](resolve-tool-runtime.html) · [notebook-tool-runtime.md](notebook-tool-runtime.html)
- [computer-use.md](computer-use.html) · [lsp-config.md](lsp-config.html) · [mcp-config.md](mcp-config.html) · [mcp-protocol-transports.html](mcp-protocol-transports.html) · [mcp-runtime-lifecycle.html](mcp-runtime-lifecycle.html) · [mcp-server-tool-authoring.html](mcp-server-tool-authoring.html)

## Hooks & Extensions

- [hooks.md](hooks.html) · [extensions.md](extensions.html) · [extensions-dev.md](extensions-dev.html) (extension API reference) · [extension-loading.md](extension-loading.html)
- [agent-hub.md](agent-hub.html) · [task-agent-discovery.md](task-agent-discovery.html) · [plugin-manager-installer-plumbing.md](plugin-manager-installer-plumbing.html)

## Board & Automation

- [board-dashboard-intro.md](board-dashboard-intro.html) · [advisor-watchdog.md](advisor-watchdog.html)

## TUI

- [tui.md](tui.html) · [tui-core-renderer.md](tui-core-renderer.html) · [tui-runtime-internals.md](tui-runtime-internals.html)
- [keybindings.md](keybindings.html) · [theme.md](theme.html) · [tree.md](tree.html) · [slash-command-internals.md](slash-command-internals.html)

## Conventions & Manifests

- [naming.md](naming.html) — **活文档** naming convention, applies to GUI / mobile / TUI / i18n strings
- [assembly.md](assembly.html) — **活文档** `musepi.assembly.toml`, the declarative product assembly manifest

## Architecture (internal implementation)

Reference for the code itself. Useful when changing or debugging MusePi; not
needed to use it.

- [blob-artifact-architecture.md](blob-artifact-architecture.html) · [fs-scan-cache-architecture.md](fs-scan-cache-architecture.html)
- [native-crates.md](native-crates.html) · [natives-architecture.md](natives-architecture.html) · [natives-binding-contract.md](natives-binding-contract.html) · [natives-addon-loader-runtime.md](natives-addon-loader-runtime.html) · [natives-build-release-debugging.md](natives-build-release-debugging.html) · [natives-media-system-utils.md](natives-media-system-utils.html) · [natives-rust-task-cancellation.md](natives-rust-task-cancellation.html) · [natives-shell-pty-process.md](natives-shell-pty-process.html) · [natives-text-search-pipeline.md](natives-text-search-pipeline.html)
- [remote-workspace.md](remote-workspace.html) · [rpc.md](rpc.html) · [sdk.md](sdk.html)

## Security & Config

- [secrets.md](secrets.html) · [approval-mode.md](approval-mode.html) · [auth-broker-gateway.md](auth-broker-gateway.html) · [macos-signing-notarization.md](macos-signing-notarization.html)
- [environment-variables.md](environment-variables.html) · [config-usage.md](config-usage.html) · [settings.md](settings.html) · [vibe-mode.md](vibe-mode.html) · [magic-keywords.md](magic-keywords.html)

## Prompting

- [system-prompt-customization.md](system-prompt-customization.html)
- Internal pipelines: [handoff-generation-pipeline.md](handoff-generation-pipeline.html) · [rulebook-matching-pipeline.md](rulebook-matching-pipeline.html)

## Collab & Sync

- [collab.md](collab.html) — incl. musepi LAN/tunnel extras
- [user-facing-packages.md](user-facing-packages.html)

## Skills

- [skills.md](skills.html) — skills scanner & management · [skills/](skills/) per-skill notes

## Developer records (not product documentation)

Planning, audit and history. Useful when picking work up or reconstructing a
decision; **not** a description of current behaviour.

- [0.5.0-roadmap.md](0.5.0-roadmap.html) — roadmap plus the verification ledger of what is genuinely outstanding
- [capability-seams.md](capability-seams.html) — index of declared capability seams
- [zcode-absorption-todos.md](zcode-absorption-todos.html) · [openchamber-absorption-todos.md](openchamber-absorption-todos.html) — absorption checklists with per-item verdicts
- [porting-to-natives.md](porting-to-natives.html) · [porting-from-pi-mono.md](porting-from-pi-mono.html) — porting field notes
- [windows-development.md](windows-development.html) — Windows build environment setup
- [ERRATA-GPT5-HARMONY.md](ERRATA-GPT5-HARMONY.html) — historical research note, explicitly not a runtime contract
- [review/](review/) — design drafts under review and verification write-ups (~50 files)
- [archive/](archive/) — superseded documents, kept for history (~47 files; see [archive/README.md](archive/README.md))
- [gui-verification/](gui-verification/) — GUI verification runs and screenshots (~28 files)
- [adr/](adr/) — architecture decision records
