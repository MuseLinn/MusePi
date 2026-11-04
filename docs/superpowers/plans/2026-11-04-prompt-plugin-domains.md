# 提示词域插件化第二阶段实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将预设 persona 和设计/资产简报迁移为真实 Cordis 所有者，并安全处理易变 context。

**Architecture:** 复用现有 preset fiber 与 registerPrompt 生命周期；宿主只保留选择状态和核心装配，插件拥有文本与清理。

**Tech Stack:** TypeScript、Bun test、Cordis。

**Spec:** `docs/superpowers/specs/2026-11-04-prompt-plugin-domains-design.md`

## Global Constraints

- 不提交、不覆盖其他未提交改动；命令使用 `rtk`。
- 保留历史模板字面量和用户升级路径。
- 每域先 RED 后 GREEN，禁用/切换不得重复或残留。
- 不把易变 context 的迁移变成缓存或会话格式回归。

## Review Focus

- chat/design/creator 的 persona 必须来自各自插件而非 resolve.ts 内联文本。
- 插件停用、模式切换和 HMR 不得留下旧 prompt。
- 设计/资产选择变化必须只产生一份最新简报。
- 易变 context 若未完整迁移必须明确保留 owner，不得双写。

---

### Task 1: 预设 persona 插件包

**Files:**
- Create: `packages/coding-agent/src/bundled-plugins/preset-{chat,design,creator}/**`
- Modify: `packages/coding-agent/src/presets/resolve.ts`
- Test: `packages/coding-agent/test` 中预设与真实会话测试

- [ ] 为 persona 文本 owner、注册/卸载、切换和模板升级写失败测试。
- [ ] 将文本迁入包内 Markdown，预设只保留组合声明并递增 revision，保留历史快照。
- [ ] 运行预设、prompt/session、插件生命周期测试和包 check。

### Task 2: 设计/资产简报插件化

**Files:**
- Create: `packages/coding-agent/src/bundled-plugins/design-guidance/**`
- Modify: 现有 design-system/asset-policy 选择状态适配与测试

- [ ] 为选择状态、函数文本、禁用卸载和重复预防写失败测试。
- [ ] 将渲染和文本 owner 迁入插件，宿主仅提供选择状态；保持 order 与输出。
- [ ] 运行设计/资产、会话重建和生命周期测试。

### Task 3: 易变 context 与文档

**Files:**
- Modify: 经 Task 2 审查确认必要的 context provider/文档/CHANGELOG

- [ ] 先验证重复注入、角色与缓存行为；若无安全迁移路径则仅去重并明确保留 owner。
- [ ] 更新 extensions-dev、capability-seams、plugin-lifecycle 和 CHANGELOG 的当前阶段事实。
- [ ] 运行相关测试、翻译配对与 check:docs。
