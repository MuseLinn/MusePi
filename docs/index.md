---
layout: default
title: Documentation
---

# MusePi Documentation

> 91 documents. Living docs are marked **活文档** — keep them in sync with code changes.

## GUI & Desktop

- [gui-design.md](gui-design.md) — **活文档** GUI design spec: layout / tokens / motion / component patterns / pet visual style
- [gui-implementation.md](gui-implementation.md) — **活文档** GUI implementation notes: daemon RPC contracts, IPC shapes, pitfalls, verification workflows
- [widget-design-system.md](widget-design-system.md) — widget system design
- [gui-settings.md](gui-settings.md) — settings panel notes
- [gui-migration.md](gui-migration.md) · [gui-architecture.md](gui-architecture.md) · [gui-prototype.md](gui-prototype.md) — historical drafts

## Sessions & Context

- [session.md](session.md) · [session-operations-export-share-fork-resume.md](session-operations-export-share-fork-resume.md) · [session-switching-and-recent-listing.md](session-switching-and-recent-listing.md) · [session-tree-plan.md](session-tree-plan.md)
- [compaction.md](compaction.md) · [non-compaction-retry-policy.md](non-compaction-retry-policy.md) · [context-files.md](context-files.md)
- [memory.md](memory.md) · [mnemosyne-memory-backend.md](mnemosyne-memory-backend.md) · [install-id.md](install-id.md) · [ttsr-injection-lifecycle.md](ttsr-injection-lifecycle.md)

## Providers & Models

- [providers.md](providers.md) · [models.md](models.md) · [adding-a-provider.md](adding-a-provider.md) · [local-models.md](local-models.md)
- [provider-compat-reference.md](provider-compat-reference.md) · [provider-endpoint-constraints.md](provider-endpoint-constraints.md) · [provider-quirks.md](provider-quirks.md) · [provider-streaming-internals.md](provider-streaming-internals.md)
- [ai-schema-normalize.md](ai-schema-normalize.md) · [arktype-guide.md](arktype-guide.md) · [omptype-guide.md](omptype-guide.md) · [gemini-manifest-extensions.md](gemini-manifest-extensions.md)

## Tools & Runtimes

- [custom-tools.md](custom-tools.md) · [tools/](tools/) (built-in tool docs) · [marketplace.md](marketplace.md)
- [bash-tool-runtime.md](bash-tool-runtime.md) · [python-repl.md](python-repl.md) · [resolve-tool-runtime.md](resolve-tool-runtime.md) · [notebook-tool-runtime.md](notebook-tool-runtime.md)
- [computer-use.md](computer-use.md) · [lsp-config.md](lsp-config.md) · [mcp-config.md](mcp-config.md) · [mcp-protocol-transports.md](mcp-protocol-transports.md) · [mcp-runtime-lifecycle.md](mcp-runtime-lifecycle.md) · [mcp-server-tool-authoring.md](mcp-server-tool-authoring.md)

## Hooks & Extensions

- [hooks.md](hooks.md) · [extensions.md](extensions.md) · [extension-loading.md](extension-loading.md)
- [agent-hub.md](agent-hub.md) · [task-agent-discovery.md](task-agent-discovery.md) · [plugin-manager-installer-plumbing.md](plugin-manager-installer-plumbing.md)

## Board & Automation

- [board-dashboard.md](board-dashboard.md) · [board-dashboard-intro.md](board-dashboard-intro.md) · [advisor-watchdog.md](advisor-watchdog.md)

## TUI

- [tui.md](tui.md) · [tui-core-renderer.md](tui-core-renderer.md) · [tui-runtime-internals.md](tui-runtime-internals.md)
- [keybindings.md](keybindings.md) · [theme.md](theme.md) · [tree.md](tree.md) · [slash-command-internals.md](slash-command-internals.md)

## Architecture

- [blob-artifact-architecture.md](blob-artifact-architecture.md) · [fs-scan-cache-architecture.md](fs-scan-cache-architecture.md)
- [native-crates.md](native-crates.md) · [natives-architecture.md](natives-architecture.md) · [natives-binding-contract.md](natives-binding-contract.md) · [natives-addon-loader-runtime.md](natives-addon-loader-runtime.md) · [natives-build-release-debugging.md](natives-build-release-debugging.md) · [natives-media-system-utils.md](natives-media-system-utils.md) · [natives-rust-task-cancellation.md](natives-rust-task-cancellation.md) · [natives-shell-pty-process.md](natives-shell-pty-process.md) · [natives-text-search-pipeline.md](natives-text-search-pipeline.md)
- [remote-workspace.md](remote-workspace.md) · [rpc.md](rpc.md) · [sdk.md](sdk.md)

## Security & Config

- [secrets.md](secrets.md) · [approval-mode.md](approval-mode.md) · [auth-broker-gateway.md](auth-broker-gateway.md) · [macos-signing-notarization.md](macos-signing-notarization.md)
- [environment-variables.md](environment-variables.md) · [config-usage.md](config-usage.md) · [settings.md](settings.md) · [vibe-mode.md](vibe-mode.md) · [magic-keywords.md](magic-keywords.md)

## Prompting & Pipeline

- [system-prompt-customization.md](system-prompt-customization.md) · [handoff-generation-pipeline.md](handoff-generation-pipeline.md) · [rulebook-matching-pipeline.md](rulebook-matching-pipeline.md)

## Collab & Sync

- [collab.md](collab.md) — incl. musepi LAN/tunnel extras
- [upstream-sync-1722.md](upstream-sync-1722.md) · [user-facing-packages.md](user-facing-packages.md)

## Skills

- [skills.md](skills.md) — skills scanner & management
