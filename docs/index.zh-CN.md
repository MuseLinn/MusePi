---
layout: default
title: 文档
lang: zh-CN
---

# MusePi 文档

> 147 份文档（含子目录）。**活文档** 标记表示需随代码变更保持同步。

[English](index.md) | 中文

## GUI 与桌面

- [gui-design.md](gui-design.html) — **活文档** GUI 设计规范：布局 / token / 动效 / 组件模式 / 桌宠视觉风格
- [gui-implementation.md](gui-implementation.html) — **活文档** GUI 实现笔记：daemon RPC 契约、IPC 形状、踩坑、验证工作流
- [i18n.md](i18n.html) — **活文档** i18n 架构：按域 locale 表、编译期英文对等、插件翻译注册
- [widget-design-system.md](widget-design-system.html) — 组件系统设计
- [gui-settings.md](gui-settings.html) — 设置面板笔记

## 会话与上下文

- [session.md](session.html) · [session-operations-export-share-fork-resume.md](session-operations-export-share-fork-resume.html) · [session-switching-and-recent-listing.md](session-switching-and-recent-listing.html) · [session-tree-plan.md](session-tree-plan.html)
- [compaction.md](compaction.html) · [non-compaction-retry-policy.md](non-compaction-retry-policy.html) · [context-files.md](context-files.html)
- [memory.md](memory.html) · [mnemosyne-memory-backend.md](mnemosyne-memory-backend.html) · [install-id.md](install-id.html) · [ttsr-injection-lifecycle.md](ttsr-injection-lifecycle.html)

## 供应商与模型

- [providers.md](providers.html) · [models.md](models.html) · [adding-a-provider.md](adding-a-provider.html) · [local-models.md](local-models.html)
- [provider-compat-reference.md](provider-compat-reference.html) · [provider-endpoint-constraints.md](provider-endpoint-constraints.html) · [provider-quirks.md](provider-quirks.html) · [provider-streaming-internals.md](provider-streaming-internals.html)
- [ai-schema-normalize.md](ai-schema-normalize.html) · [arktype-guide.md](arktype-guide.html) · [musepi-type-guide.md](musepi-type-guide.html) · [gemini-manifest-extensions.md](gemini-manifest-extensions.html)

## 工具与运行时

- [custom-tools.md](custom-tools.html) · [tools/](tools/)（内置工具文档）· [marketplace.md](marketplace.html)
- [bash-tool-runtime.md](bash-tool-runtime.html) · [python-repl.md](python-repl.html) · [resolve-tool-runtime.md](resolve-tool-runtime.html) · [notebook-tool-runtime.md](notebook-tool-runtime.html)
- [computer-use.md](computer-use.html) · [lsp-config.md](lsp-config.html) · [mcp-config.md](mcp-config.html) · [mcp-protocol-transports.md](mcp-protocol-transports.html) · [mcp-runtime-lifecycle.md](mcp-runtime-lifecycle.html) · [mcp-server-tool-authoring.md](mcp-server-tool-authoring.html)

## Hooks 与扩展

- [hooks.md](hooks.html) · [extensions.md](extensions.html) · [extension-loading.md](extension-loading.html)
- [agent-hub.md](agent-hub.html) · [task-agent-discovery.md](task-agent-discovery.html) · [plugin-manager-installer-plumbing.md](plugin-manager-installer-plumbing.html)

## 看板与自动化

- [board-dashboard.md](board-dashboard.html) · [board-dashboard-intro.md](board-dashboard-intro.html) · [advisor-watchdog.md](advisor-watchdog.html)

## TUI

- [tui.md](tui.html) · [tui-core-renderer.md](tui-core-renderer.html) · [tui-runtime-internals.md](tui-runtime-internals.html)
- [keybindings.md](keybindings.html) · [theme.md](theme.html) · [tree.md](tree.html) · [slash-command-internals.md](slash-command-internals.html)

## 架构

- [blob-artifact-architecture.md](blob-artifact-architecture.html) · [fs-scan-cache-architecture.md](fs-scan-cache-architecture.html)
- [native-crates.md](native-crates.html) · [natives-architecture.md](natives-architecture.html) · [natives-binding-contract.md](natives-binding-contract.html) · [natives-addon-loader-runtime.md](natives-addon-loader-runtime.html) · [natives-build-release-debugging.md](natives-build-release-debugging.html) · [natives-media-system-utils.md](natives-media-system-utils.html) · [natives-rust-task-cancellation.md](natives-rust-task-cancellation.html) · [natives-shell-pty-process.md](natives-shell-pty-process.html) · [natives-text-search-pipeline.md](natives-text-search-pipeline.html)
- [remote-workspace.md](remote-workspace.html) · [rpc.md](rpc.html) · [sdk.md](sdk.html)

## 安全与配置

- [secrets.md](secrets.html) · [approval-mode.md](approval-mode.html) · [auth-broker-gateway.md](auth-broker-gateway.html) · [macos-signing-notarization.md](macos-signing-notarization.html)
- [environment-variables.md](environment-variables.html) · [config-usage.md](config-usage.html) · [settings.md](settings.html) · [vibe-mode.md](vibe-mode.html) · [magic-keywords.md](magic-keywords.html)

## 提示与流水线

- [system-prompt-customization.md](system-prompt-customization.html) · [handoff-generation-pipeline.md](handoff-generation-pipeline.html) · [rulebook-matching-pipeline.md](rulebook-matching-pipeline.html)

## Collab 与同步

- [collab.md](collab.html) — 含 musepi LAN/隧道扩展
- [user-facing-packages.md](user-facing-packages.html)

## 技能

- [skills.md](skills.html) — 技能扫描与管理
