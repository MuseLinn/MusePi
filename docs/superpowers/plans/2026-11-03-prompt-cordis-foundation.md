# MusePi 提示词与 Cordis 第一阶段实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正提示词事实错误，建立兼容的具名注册表，并补齐 Kimi Code 的 OpenCode 路由。

**Architecture:** 核心提示词保持原样；新增纯 TS 注册表并由现有 composer 适配。Kimi Code 的代理由本地配置独立承载。

**Tech Stack:** TypeScript、Bun test、Node.js loopback HTTP proxy。

**Spec:** `docs/superpowers/specs/2026-11-03-prompt-cordis-foundation-design.md`

## Global Constraints

- 不提交、不覆盖工作区已有修改；shell 命令使用 `rtk` 前缀。
- 每项生产修改先运行新增测试并看到预期失败，再实现到通过。
- 不做全量提示词迁移，不改变现有会话存储格式。

## Review Focus

- 空注册表不得改变现有 prompt 输出。
- 插件卸载必须移除对应 section，双 complete 必须失败。
- 显式 `x-opencode-session` 优先；无缓存键的请求不得共享静态 ID。
- Zen/Go 的 OpenAI 与 Anthropic 路径必须分别映射到正确上游。

---

### Task 1: 提示词事实修复

**Files:**
- Modify: `packages/coding-agent/src/prompts/system/{autolearn-guidance.md,custom-system-prompt.md,system-prompt.md,subagent-system-prompt.md}`
- Modify: `packages/coding-agent/src/prompts/tools/{learn.md,manage-skill.md,widget.md}`
- Test: `packages/coding-agent/test` 中现有提示词测试

- [ ] 添加目录、主题、死模板和无消费者标记的回归断言并看到失败。
- [ ] 修正错误文本，删除不可达 git 段与无消费者的裸 `§` 标记；不重组核心规则。
- [ ] 运行相关提示词测试和 `packages/coding-agent` check。

### Task 2: 具名提示词注册表

**Files:**
- Create: `packages/coding-agent/src/prompts/{orders.ts,registry.ts}`
- Modify: `packages/coding-agent/src/prompts/composer.ts`
- Modify: `packages/coding-agent/src/extensibility/extensions/types.ts`
- Test: `packages/coding-agent/test/prompts-*.test.ts`

**Interfaces:**
- `registerSection({name, order, text, complete?})` 返回 disposer；`text` 支持字符串或返回字符串的函数。
- `registerVariable(name, resolver)` 返回 disposer。
- `assemble(ctx)` 处理顺序、遮蔽、唯一 complete 与严格插值；`revision` 单调递增。
- 现有 `PromptComposer` API 与按 source 卸载保持不变。

- [ ] 为 order、函数条件段、complete 冲突、严格变量、revision 和 composer 兼容写失败测试。
- [ ] 实现注册表与兼容适配，保持空注册表输出不变。
- [ ] 运行 prompt 测试、相关 session/sdk 测试和包 check。

### Task 3: Kimi Code OpenCode 代理补全

**Files:**
- Modify: `C:/Users/universe/.kimi-code/hooks/opencode-go-proxy.mjs`
- Modify: `C:/Users/universe/.kimi-code/config.toml`
- Test: 临时目录中的代理测试，完成后删除

**Interfaces:**
- 本地 `/go/openai/v1/*`、`/go/anthropic/*`、`/zen/openai/v1/*`、`/zen/anthropic/*` 映射到对应官方上游。
- OpenAI chat/responses 与 Anthropic messages 都动态注入会话头；无键请求使用一次性 ID。
- 显式会话头优先；不记录消息或凭据。

- [ ] 写路径映射、动态 ID、无键探测和显式覆盖测试并看到失败。
- [ ] 实现代理，更新 Zen/Go 及逐模型 Anthropic base URL，删除任何静态共享会话头。
- [ ] 运行代理测试、配置校验和最小真实 Go/Zen 调用；清理临时测试产物。
