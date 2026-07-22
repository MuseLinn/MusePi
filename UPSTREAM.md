# UPSTREAM.md — pi 上游同步记录

## 基点（pin）

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/earendil-works/pi |
| 基点 commit | `ff992261e2ec349e4257a59d052076355ca0b18b` + 2026-07-21 cherry-pick 9 个（见下"同步日志"） |
| 基点时间 | 2026-07-20T20:00:14Z（首次 pin）；2026-07-21 同步至 v0.81.1 选定项 |
| 对应 npm 版本 | `@earendil-works/pi-coding-agent@0.80.10` + 0.81.1 选定修复（extension peer dep `>=0.80.0` 线） |
| License | MIT（fork 保留原 LICENSE） |

## 同步日志

### 2026-07-21 → v0.81.1（提前窗口：K3 修正 + compaction 重试）

核查发现 0.81 发布说明中的大部分项目（#6844/#6790/#6764/#6730/#6727/#6671/
#6793/#6854/#6812/#6865/K3 thinking levels/full provider extensions）**已包含在
基点 ff992261 中**（基点仅比 0.81.0 早一天）。实际 cherry-pick 9 个：

- `4185d398` brace-expansion 5.0.7（含 lockfile）
- `6a4b52d7` ai: 构建前校验生成的模型数据（根 package.json 冲突：build 脚本并入 musepi 路径 + 新增 build:offline）
- `9ddde88d` coding-agent: 优先使用较新的生成模型目录
- `3f29a78c`+`b1c89b5a`+`273fb67f`+`ea1cfa35` compaction/branch-summary 失败走重试策略（#6901 套件，snapcompact 的 default LLM 摘要路径受益）
- `0f6eaf44` K3 compat: thinkingFormat=openai + supportsReasoningEffort
- `42027bf6` agent: 恢复 streamFn 扩展兼容（#6915；CHANGELOG 冲突取上游版）

验证：全量 build 绿；core 185 + tui 712 + musepi 套件 64 断言绿；K3（kimi-coding/k3）
冒烟 `k3-ok`。

**明确跳过**（记录在案，后续需要再评）：`9e7582aa` SQLite 会话存储（#6594，
大特性）、`8495f9d0` orchestrator→server 改名（大 rename，会扩大冲突面）、
`b1425041` 目录刷新移出启动（行为变化）、llama.cpp/Qwen provider/发布归档。

## 同步策略（pin + 月度 cherry-pick，不做持续 rebase）

1. **pin**：fork 以基点 commit 为准，渲染层改动全部落在 `packages/musepi/` 与
   `packages/coding-agent` 的 TUI 层（见下"冲突面"）。
2. **月度窗口**：每月检查一次上游 release，只 cherry-pick 两类变更——
   - agent loop / 工具执行的正确性修复
   - extension API 新增（生态兼容需要，pi-muselinn-harness 及第三方扩展依赖）
3. **按冲突面过滤**：上游 `pi-tui` 渲染层变更**不再一律忽略**——W1 起
   `packages/tui/src/components/editor.ts` 有我们的 4 钩子补丁（historyFilter/
   onRecall/onHistoryDraftSave/Restore），编辑器相关修复需手工合并。其余
   pi-tui 渲染变更仍可忽略（已被 `packages/musepi/renderer` 替换）。
   网站/文档/市场变更一律忽略（除非影响构建）。
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
