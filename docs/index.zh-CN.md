---
layout: default
title: 文档
lang: zh-CN
---

# MusePi 文档
[English](index.md) | 中文

> **活文档** 标记表示需随代码变更保持同步。

本索引覆盖两类文档。**开发者记录**以上的内容描述产品本身或其背后的实现——
构建或使用 MusePi 时看这些；**开发者记录**是规划稿、核查笔记与已被取代的旧文档，
仅为留存历史，**不描述任何当前行为**。

## 一键安装

```sh
curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh
```

安装脚本默认下载预编译二进制（`musepi-<os>-<arch>` + `SHA256SUMS.txt`，来自 GitHub Release）。`--source` 强制从源码克隆构建；`--ref <tag>` 固定版本。


## GUI 与桌面

- [gui-design.md](gui-design.html) — **活文档** GUI 设计规范：布局 / token / 动效 / 组件模式 / 桌宠视觉风格
- [gui-implementation.md](gui-implementation.html) — **活文档** GUI 实现笔记：daemon RPC 契约、IPC 形状、踩坑、验证工作流
- [i18n.md](i18n.html) — **活文档** i18n 架构：按域 locale 表、编译期英文对等、插件翻译注册
- [gui-settings.md](gui-settings.html) — 设置面板笔记
- [mobile-design.md](mobile-design.html) — **活文档** 移动端设计规范 · [ota-mobile-design.md](ota-mobile-design.html) OTA / 应用内更新设计

## 会话与上下文

- [session.md](session.html) · [session-operations-export-share-fork-resume.md](session-operations-export-share-fork-resume.html) · [session-switching-and-recent-listing.md](session-switching-and-recent-listing.html)
- [compaction.md](compaction.html) · [non-compaction-retry-policy.md](non-compaction-retry-policy.html) · [context-files.md](context-files.html)
- [memory.md](memory.html) · [mnemosyne-memory-backend.md](mnemosyne-memory-backend.html) · [install-id.md](install-id.html) · [ttsr-injection-lifecycle.md](ttsr-injection-lifecycle.html)

## 供应商与模型

- [providers.md](providers.html) · [models.md](models.html) · [adding-a-provider.md](adding-a-provider.html) · [local-models.md](local-models.html)
- [provider-compat-reference.md](provider-compat-reference.html) · [provider-endpoint-constraints.md](provider-endpoint-constraints.html) · [provider-quirks.md](provider-quirks.html) · [provider-streaming-internals.md](provider-streaming-internals.html)
- [ai-schema-normalize.md](ai-schema-normalize.html) · [arktype-guide.md](arktype-guide.html) · [musepi-type-guide.md](musepi-type-guide.html) · [gemini-manifest-extensions.md](gemini-manifest-extensions.html)

## 工具与运行时

- [custom-tools.md](custom-tools.html) · [tools/](tools/)（内置工具文档）· [toolconv/](toolconv/)（工具 schema 转换说明）· [marketplace.md](marketplace.html)
- [bash-tool-runtime.md](bash-tool-runtime.html) · [python-repl.md](python-repl.html) · [resolve-tool-runtime.md](resolve-tool-runtime.html) · [notebook-tool-runtime.md](notebook-tool-runtime.html)
- [computer-use.md](computer-use.html) · [lsp-config.md](lsp-config.html) · [mcp-config.md](mcp-config.html) · [mcp-protocol-transports.html](mcp-protocol-transports.html) · [mcp-runtime-lifecycle.html](mcp-runtime-lifecycle.html) · [mcp-server-tool-authoring.html](mcp-server-tool-authoring.html)

## Hooks 与扩展

- [hooks.md](hooks.html) · [extensions.md](extensions.html) · [extensions-dev.md](extensions-dev.html)（扩展 API 参考）· [extension-loading.md](extension-loading.html)
- [agent-hub.md](agent-hub.html) · [task-agent-discovery.md](task-agent-discovery.html) · [plugin-manager-installer-plumbing.md](plugin-manager-installer-plumbing.html)

## 看板与自动化

- [board-dashboard-intro.md](board-dashboard-intro.html) · [advisor-watchdog.md](advisor-watchdog.html)

## TUI

- [tui.md](tui.html) · [tui-core-renderer.md](tui-core-renderer.html) · [tui-runtime-internals.md](tui-runtime-internals.html)
- [keybindings.md](keybindings.html) · [theme.md](theme.html) · [tree.md](tree.html) · [slash-command-internals.md](slash-command-internals.html)

## 约定与清单

- [naming.md](naming.html) — **活文档** 命名规范，适用于 GUI / 移动端 / TUI / i18n 文案
- [assembly.md](assembly.html) — **活文档** `musepi.assembly.toml`，声明式产品装配清单

## 架构（内部实现）

面向代码本身的参考。改动或排查 MusePi 时有用，使用产品时不需要。

- [blob-artifact-architecture.md](blob-artifact-architecture.html) · [fs-scan-cache-architecture.md](fs-scan-cache-architecture.html)
- [native-crates.md](native-crates.html) · [natives-architecture.md](natives-architecture.html) · [natives-binding-contract.md](natives-binding-contract.html) · [natives-addon-loader-runtime.md](natives-addon-loader-runtime.html) · [natives-build-release-debugging.md](natives-build-release-debugging.html) · [natives-media-system-utils.md](natives-media-system-utils.html) · [natives-rust-task-cancellation.md](natives-rust-task-cancellation.html) · [natives-shell-pty-process.md](natives-shell-pty-process.html) · [natives-text-search-pipeline.md](natives-text-search-pipeline.html)
- [remote-workspace.md](remote-workspace.html) · [rpc.md](rpc.html) · [sdk.md](sdk.html)

## 安全与配置

- [secrets.md](secrets.html) · [approval-mode.md](approval-mode.html) · [auth-broker-gateway.md](auth-broker-gateway.html) · [macos-signing-notarization.md](macos-signing-notarization.html)
- [environment-variables.md](environment-variables.html) · [config-usage.md](config-usage.html) · [settings.md](settings.html) · [vibe-mode.md](vibe-mode.html) · [magic-keywords.md](magic-keywords.html)

## 提示

- [system-prompt-customization.md](system-prompt-customization.html)
- 内部流水线：[handoff-generation-pipeline.md](handoff-generation-pipeline.html) · [rulebook-matching-pipeline.md](rulebook-matching-pipeline.html)

## Collab 与同步

- [collab.md](collab.html) — 含 musepi LAN/隧道扩展
- [user-facing-packages.md](user-facing-packages.html)

## 技能

- [skills.md](skills.html) — 技能扫描与管理 · [skills/](skills/) 各技能说明

## 开发者记录（非产品文档）

规划、核查与历史。接手工作或还原某项决策时有用；**不描述当前行为**。

- [0.5.0-roadmap.md](0.5.0-roadmap.html) — 路线图 + 真实未完成事项的核查台账
- [capability-seams.md](capability-seams.html) — 能力缝声明索引
- [zcode-absorption-todos.md](zcode-absorption-todos.html) · [openchamber-absorption-todos.md](openchamber-absorption-todos.html) — 带逐项结论的吸收清单
- [porting-to-natives.md](porting-to-natives.html) · [porting-from-pi-mono.md](porting-from-pi-mono.html) — 移植现场笔记
- [windows-development.md](windows-development.html) — Windows 构建环境搭建
- [ERRATA-GPT5-HARMONY.md](ERRATA-GPT5-HARMONY.html) — 历史研究笔记，明确声明不是运行时契约
- [review/](review/) — 评审中的设计稿与验证记录（约 50 份）
- [archive/](archive/) — 已被取代的文档，留存历史（约 47 份；见 [archive/README.md](archive/README.md)）
- [gui-verification/](gui-verification/) — GUI 验证记录与截图（约 28 份）
- [adr/](adr/) — 架构决策记录
