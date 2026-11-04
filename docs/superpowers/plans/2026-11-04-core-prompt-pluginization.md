# 核心提示词与易变 Context 插件化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 DSH SystemPrompt/Scope 模型完成核心工具与易变 context 的可靠插件化。

**Architecture:** 每 session 一个 prompt host，以 scope 管继承、lane 管来源优先级、owner 管释放；PromptComposer 保留 legacy facade，稳定 section 与 snapshot/turn context 分离。

**Tech Stack:** TypeScript、Bun test、Cordis、ExtensionAPI。

**Spec:** `docs/superpowers/specs/2026-11-04-core-prompt-pluginization-design.md`

## Global Constraints

- 不提交、不覆盖其他未提交改动；命令使用 `rtk`，实施只用 DeepSeek/CodeBuddy。
- 每个生产变更先 RED 后 GREEN；禁用一个任务必须只改其独立范围。
- 保留 legacy 字面量、模板升级、OpenCode affinity、权限和缓存前缀。
- 不移植 DSH Loader、sandbox 或会话 surface，不引入第二套工具/提示词 owner。

## Review Focus

- 子代理与主代理都必须经过 composer，不能丢工具段。
- 插件启停/HMR/preset 切换不得复活旧 section 或工具。
- 易变 context 只在变化时投递，不能改坏缓存前缀或权限拒绝路径。
- persona 挂载失败不得静默回退完整默认 prompt。

---

### Task 1: Prompt host 与贡献契约

**Files:**
- Create: `packages/coding-agent/src/prompts/{types,scope,store,host}.ts`
- Modify: `prompts/{orders,registry,composer}.ts`、`extensibility/extensions/types.ts`
- Test: `packages/coding-agent/test/prompts-host.test.ts` 与现有 composer 测试

- [ ] 为空 host、scope/lane 遮蔽、四类贡献、cacheScope、revision、close 和 legacy 字节写失败测试。
- [ ] 实现纯 TS host，ExtensionAPI 暴露 section/context/variable/tool provider；Composer 保持旧行为。
- [ ] 运行机制测试和包 check。

### Task 2: 核心工具提示词迁移

**Files:**
- Modify: `packages/coding-agent/src/prompts/system/system-prompt.md`
- Modify: `packages/coding-agent/src/bundled-plugins/{file-tools,lsp,computer,browser}/**`
- Create: `packages/coding-agent/src/bundled-plugins/{delegation,host-integrations}/**`
- Modify: `sdk.ts`、`system-prompt.ts` 的装配上下文

- [ ] 为每段 owner、active tool 门控、wire 名和子代理到达写失败测试。
- [ ] 迁移 read/write/edit/grep/glob/AST/LSP/task/computer/browser/host integrations；核心只保留跨工具契约。
- [ ] 运行工具、inventory、子代理、输出字节和缓存测试。

### Task 3: 项目与易变 context

**Files:**
- Modify: `system-prompt.ts`、`sdk.ts`、`session/agent-session.ts` 及对应 context provider

- [ ] 为 AGENTS/workspace/repo 的缓存和权限、plan/goal/vibe 去重、memory/MCP 权限与截断写失败测试。
- [ ] 按证据迁移 snapshot/turn context；不应迁移的保留唯一宿主 owner，禁止双写。
- [ ] 运行恢复、权限、去重、缓存和会话测试。

### Task 4: 预设生命周期缺陷

**Files:**
- Modify: `sdk.ts`、`session/agent-session.ts`、CLI/daemon resume 路径及相关测试

- [ ] 为切换工具 slate、resume mode、切走后 reload 不复活、persona 失败 fail-closed 写失败测试。
- [ ] 修复真实生命周期并覆盖首条消息前切换、CLI 与 daemon 恢复。
- [ ] 运行预设、插件、恢复和 smoke 测试。

### Task 5: 清理与最终验收

**Files:**
- Modify: `docs/extensions-dev*`、`docs/plugin-lifecycle*`、`docs/capability-seams.md`、`packages/coding-agent/CHANGELOG.musepi.md`

- [ ] 清理旧 owner 和过时注释，文档写明当前 owner、保留项和生命周期。
- [ ] 运行全量相关测试、包检查、双语检查与最终只读审查。
