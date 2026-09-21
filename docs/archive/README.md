# docs/archive

已完成的一次性计划、审计与评估文档的归宿。

## 这里的文档为什么不删

它们记录的不是代码现状，而是**当初为什么这么决策**——包括哪些方案被调研过、被否决，以及否决的理由
（例如右面板改造里 TabBar / 多实例被架构否决、会话树改造里跳过 indexeddb 缓存）。
源码和活文档（`gui-design.md`、`gui-implementation.md`、`extensions-dev.md` 等）已经吸收了结论，
但删掉这些原文，下次就会有人重新提出同一个被否决过的方案。

它们不再出现在 `docs/` 顶层，是因为那层应该只留给**活文档**：还在约束当前实现的规范。

## 归档规则

- **收**：`<name>-plan.md`、`*-redesign.md`、`*-assessment.md`，以及针对某次外部对照的一次性审计报告
  —— 前提是其结论已落地、或已被更新的替代文档取代。
- **不收**：活文档（`gui-design.md`、`gui-implementation.md`、`mobile-design.md`、`ota-mobile-design.md`）、
  参考手册类文档（`extensions-dev.md`、`adding-a-provider.md`、`git-changelog-based-release-checklist.md` 等）、
  以及仍有未落地项的设计文档。
- **双语三件套必须整组移动**：`<name>.md` + `<name>.zh-CN.md` + `<name>.i18n.yaml` 一起进本目录，
  移动后重跑 `bun run verify-translation-pairing` 确认门禁仍过。
- **移动前必须查引用**：`grep -rn "<doc-stem>" --include=*.md --include=*.ts .`，把路径一起改掉
  （`AGENTS.md` 的状态表、`.agents/skills/*/SKILL.md` 的文档清单这类常见悬挂引用）。

## 归档清单（2026-09-17）

| 文档 | 归档时的状态 | 去向/替代者 |
| --- | --- | --- |
| `modes-plan.md` | v1+v2 已实现（2026-08-21） | 实现在 `packages/coding-agent/src/presets/`；命令行入口 `--preset` |
| `tui-trace-plan.md` | 已实现（2026-08-26） | `/trace` 叠加在 `/tree` 上（`modes/components/tree-selector.ts`） |
| `session-tree-plan.md` + zh-CN | 已被取代 | 见下一行 |
| `session-tree-redesign.md` | Phase 0–5 已实现 | `session.tree` RPC = 会话列表树；会话内拓扑走 `snap.entries` + daemon journal |
| `plugin-design.md` | P0–P4 全部实现 | 扩展 API 契约写在活文档 `extensions-dev.md` |
| `widget-design-system.md` | registry 层已实现（18 种 widget） | `packages/client-core` 的 widget registry + parity 测试 |
| `board-dashboard.md` + zh-CN | M1–M3 已落地 | BoardPage + WidgetRegistry |
| `ota-update-design.md` | 已实现（v0.4.4） | 更新通道见 `gui-implementation.md` §17 |
| `client-gaps-plan.md` | 一次性对照审计完成 | 结论已吸收进 FilePane 编辑器/预览等实现 |
| `opentui-migration-assessment.md` | 评估完成，未采纳 | — |
| `gui-right-panel-redesign.md` | 草案；TabBar / 多实例被架构否决 | 落地部分见 `gui-implementation.md` §11 及相关章节 |
