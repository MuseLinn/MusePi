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
## 归档清单（2026-10-04）

一次代码核查后的批量归档。判定依据仍是上面两条规则（结论已落地 / 已被更新文档取代），每条都在归档时于原状态行留下了去向。

| 文档                                              | 归档时的状态                                                                                    | 去向/替代者                                                                                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensibility-architecture.md`                   | 4 条待做 0 条按原路线落地；唯一的硬决策（cordis「高风险待评估」）已被 roadmap §4.3 定案 v3 推翻 | 能力缝口径 → `capability-seams.md`；加载管线 → `capability/` + `discovery/index.ts`；未落地的两条旧债（事件声明面分叉、两套 runner）转入 `docs/review/0.5.0-roadmap.md` §10.2 第 12 条 |
| `review/0.5.1-dsh-trajectory-session-gap.md`      | 16 项差距已转成 P0/P1/P2 编号清单并大量修复                                                     | `review/0.5.1-defect-handoff.md`（承接单，含 2026-10-04 复核段）                                                                                                                |
| `review/0.5.0-m2.9-cordis-spike.md`               | 试点 25/25 + 16/16 通过，5 决策点全批（稿内自带归档指令）                                       | `docs/adr/0001-cordis-adoption-boundary.md` + `scripts/check-cordis-boundary.ts`                                                                                                |
| `review/0.5.0-promo-gap-analysis.md`              | 结论已批复并入 roadmap                                                                          | M1.12 条目在 roadmap §6；设计章节 → `gui-design.md` §5v                                                                                                                         |
| `review/0.5.0-map-redesign/`                      | 已实现（轮级画布 `TurnMapCanvas`）                                                              | 契约见 `gui-implementation.md` §24                                                                                                                                              |
| `review/0.5.0-installer-update-dialogs-design.md` | C 面转正、B 面已实现；A 面（品牌化安装器）**决定不做**，非未落地项                              | `gui-design.md` §5u + `gui-implementation.md` §389                                                                                                                              |
| `review/0.5.0-shell-panels-topbar-design/`        | A/B/C 批次全解锁并落地                                                                          | `gui-design.md` §5t + `gui-implementation.md` §40（`shots/` 为实机走查证据，随稿留存）                                                                                          |
| `review/0.5.0-m1.10-liquid-glass.md`              | §5s 转正；批次 C 全落地，D 剩两件已转入 roadmap §10.2 第 2 条                                   | `gui-design.md` §5s                                                                                                                                                             |
| `review/0.5.0-m1.10c-composer-glass-design.md`    | C1–C4 全落地                                                                                    | `gui-design.md` §5s / §5w                                                                                                                                                       |
| `review/0.5.0-m1-transcript-design.md`            | §5r 转正，实现转 `gui-implementation.md` §39                                                    | 视觉 → `gui-design.md` §5r；语义 → `gui-implementation.md` §39。**同名的 `review/0.5.0-m1-transcript-design/` 目录未归档**（mem-bench 与实机截图仍被虚拟化稿引用）              |
| `ERRATA-GPT5-HARMONY.md`                          | 自述「历史研究笔记，非当前运行时契约」；数据来自本地 stats 快照而非签入测试                                                                                | 无替代者——记录结论已过期，保留仅为溯源；`packages/ai/src/utils/harmony-leak.ts` 的模块头引用它作为背景                                                  |

**仍未归档的三份评审稿，各有明确前置**（写在各自状态行里）：`0.5.0-m2.4-capability-seams.md`（`AGENTS.md` 与 `capability-seams.md` 引其 §3 作格式定义，须先内联）、`0.5.0-sidepanel-browser-rendering.md`（residency 契约只存在于代码注释，须先补 `gui-implementation.md` 章节）、`0.5.0-transcript-virtualization.md`（P1⑥/P1⑦/P2⑧⑨ 仍未动工，命中归档规则第 3 条）。
