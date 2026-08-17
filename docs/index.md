---
layout: default
title: Documentation
---

# MusePi Documentation

> 89 documents. Living docs are marked **活文档** — keep them in sync with code changes.

## GUI & Desktop

- [gui-design.md](gui-design.html) — **活文档** GUI design spec: layout / tokens / motion / component patterns / pet visual style
- [gui-implementation.md](gui-implementation.html) — **活文档** GUI implementation notes: daemon RPC contracts, IPC shapes, pitfalls, verification workflows
- [i18n.md](i18n.html) — **活文档** i18n architecture: per-domain locale maps, compile-time en parity, plugin translation registration
- [widget-design-system.md](widget-design-system.html) — widget system design
- [gui-settings.md](gui-settings.html) — settings panel notes

## Sessions & Context

- [session.md](session.html) · [session-operations-export-share-fork-resume.md](session-operations-export-share-fork-resume.html) · [session-switching-and-recent-listing.md](session-switching-and-recent-listing.html) · [session-tree-plan.md](session-tree-plan.html)
- [compaction.md](compaction.html) · [non-compaction-retry-policy.md](non-compaction-retry-policy.html) · [context-files.md](context-files.html)
- [memory.md](memory.html) · [mnemosyne-memory-backend.md](mnemosyne-memory-backend.html) · [install-id.md](install-id.html) · [ttsr-injection-lifecycle.md](ttsr-injection-lifecycle.html)

## Providers & Models

- [providers.md](providers.html) · [models.md](models.html) · [adding-a-provider.md](adding-a-provider.html) · [local-models.md](local-models.html)
- [provider-compat-reference.md](provider-compat-reference.html) · [provider-endpoint-constraints.md](provider-endpoint-constraints.html) · [provider-quirks.md](provider-quirks.html) · [provider-streaming-internals.md](provider-streaming-internals.html)
- [ai-schema-normalize.md](ai-schema-normalize.html) · [arktype-guide.md](arktype-guide.html) · [omptype-guide.md](omptype-guide.html) · [gemini-manifest-extensions.md](gemini-manifest-extensions.html)

## Tools & Runtimes

- [custom-tools.md](custom-tools.html) · [tools/](tools/) (built-in tool docs) · [marketplace.md](marketplace.html)
- [bash-tool-runtime.md](bash-tool-runtime.html) · [python-repl.md](python-repl.html) · [resolve-tool-runtime.md](resolve-tool-runtime.html) · [notebook-tool-runtime.md](notebook-tool-runtime.html)
- [computer-use.md](computer-use.html) · [lsp-config.md](lsp-config.html) · [mcp-config.md](mcp-config.html) · [mcp-protocol-transports.md](mcp-protocol-transports.html) · [mcp-runtime-lifecycle.md](mcp-runtime-lifecycle.html) · [mcp-server-tool-authoring.md](mcp-server-tool-authoring.html)

## Hooks & Extensions

- [hooks.md](hooks.html) · [extensions.md](extensions.html) · [extension-loading.md](extension-loading.html)
- [agent-hub.md](agent-hub.html) · [task-agent-discovery.md](task-agent-discovery.html) · [plugin-manager-installer-plumbing.md](plugin-manager-installer-plumbing.html)

## Board & Automation

- [board-dashboard.md](board-dashboard.html) · [board-dashboard-intro.md](board-dashboard-intro.html) · [advisor-watchdog.md](advisor-watchdog.html)

## TUI

- [tui.md](tui.html) · [tui-core-renderer.md](tui-core-renderer.html) · [tui-runtime-internals.md](tui-runtime-internals.html)
- [keybindings.md](keybindings.html) · [theme.md](theme.html) · [tree.md](tree.html) · [slash-command-internals.md](slash-command-internals.html)

## Architecture

- [blob-artifact-architecture.md](blob-artifact-architecture.html) · [fs-scan-cache-architecture.md](fs-scan-cache-architecture.html)
- [native-crates.md](native-crates.html) · [natives-architecture.md](natives-architecture.html) · [natives-binding-contract.md](natives-binding-contract.html) · [natives-addon-loader-runtime.md](natives-addon-loader-runtime.html) · [natives-build-release-debugging.md](natives-build-release-debugging.html) · [natives-media-system-utils.md](natives-media-system-utils.html) · [natives-rust-task-cancellation.md](natives-rust-task-cancellation.html) · [natives-shell-pty-process.md](natives-shell-pty-process.html) · [natives-text-search-pipeline.md](natives-text-search-pipeline.html)
- [remote-workspace.md](remote-workspace.html) · [rpc.md](rpc.html) · [sdk.md](sdk.html)

## Security & Config

- [secrets.md](secrets.html) · [approval-mode.md](approval-mode.html) · [auth-broker-gateway.md](auth-broker-gateway.html) · [macos-signing-notarization.md](macos-signing-notarization.html)
- [environment-variables.md](environment-variables.html) · [config-usage.md](config-usage.html) · [settings.md](settings.html) · [vibe-mode.md](vibe-mode.html) · [magic-keywords.md](magic-keywords.html)

## Prompting & Pipeline

- [system-prompt-customization.md](system-prompt-customization.html) · [handoff-generation-pipeline.md](handoff-generation-pipeline.html) · [rulebook-matching-pipeline.md](rulebook-matching-pipeline.html)

## Collab & Sync

- [collab.md](collab.html) — incl. musepi LAN/tunnel extras
- [upstream-sync-1722.md](upstream-sync-1722.html) · [user-facing-packages.md](user-facing-packages.html)

## Skills

- [skills.md](skills.html) — skills scanner & management
