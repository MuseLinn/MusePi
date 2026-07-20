# UPSTREAM.md — pi 上游同步记录

## 基点（pin）

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/earendil-works/pi |
| 基点 commit | `ff992261e2ec349e4257a59d052076355ca0b18b` |
| 基点时间 | 2026-07-20T20:00:14Z |
| 对应 npm 版本 | `@earendil-works/pi-coding-agent@0.80.10`（extension peer dep `>=0.80.0` 线） |
| License | MIT（fork 保留原 LICENSE） |

## 同步策略（pin + 月度 cherry-pick，不做持续 rebase）

1. **pin**：fork 以基点 commit 为准，渲染层改动全部落在 `packages/musepi/` 与
   `packages/coding-agent` 的 TUI 层（见下"冲突面"）。
2. **月度窗口**：每月检查一次上游 release，只 cherry-pick 两类变更——
   - agent loop / 工具执行的正确性修复
   - extension API 新增（生态兼容需要，pi-muselinn-harness 及第三方扩展依赖）
3. **直接忽略**：上游 `pi-tui` 渲染层变更（已被 `packages/musepi/renderer` 替换）、
   网站/文档/市场变更（除非影响构建）。
4. **冲突面控制**：MusePi 的改动集中在 TUI 层与 `packages/musepi/` 子树，上游演进
   集中在 agent/工具层，文件交集天然小。若某月上游大改 extension API，优先保
   兼容层，必要时发 MusePi minor 公告。

## 结构约定

- `packages/coding-agent` — pi 核心（agent loop、模型路由、会话、工具执行）。
  **改动只允许在 TUI/渲染接缝处**，方便 cherry-pick。
- `packages/musepi/` — MusePi 自有代码（renderer、core 原生集成、配置系统、
  transcript 层）。上游永不相交。
- extension API 兼容层：`packages/coding-agent` 的扩展加载入口保持
  `@earendil-works` 公开 API 表面不变（termdraw、pi-muselinn-harness 等已装
  扩展可直接加载）。

## 验收线

开仓不等于宣传：0.0.x pre-alpha，直到自研渲染器跑通一轮完整会话
（输入 → 流式输出 → 工具调用 → box editor）。
