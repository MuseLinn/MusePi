# MusePi 提示词与 Cordis 第一阶段设计

## 目标

修正已确认的错误提示词，建立可逐步承接预设、设计简报和条件内容的提示词注册表，并补齐 Kimi Code 调用 OpenCode Zen/Go 的会话路由。

## 约束

- 保留 block 0 核心契约、工具门控、现有会话格式和输出字节兼容性。
- 新机制先以纯 TypeScript 落在 `packages/coding-agent/src/prompts`，不把 Cordis 引入领域包。
- 现有 `PromptComposer`、`registerPrompt` 和按 source 卸载继续兼容。
- 提示词变化必须有渲染或行为测试，不能只做文本审阅。
- 不整体迁移预设、不改写 Handlebars 主模板、不移植 DSH Loader 或会话 surface 模型。

## 方案

1. 先修事实错误：错误目录、主题类名、不可达 git 模板、无消费者标记和明显冲突。
2. 新增中央 order 表与具名注册表，支持函数文本、遮蔽、唯一 complete、严格变量和 revision；`PromptComposer` 作为兼容适配器。通过现有输出对比证明空注册表不改变行为。
3. Kimi Code 使用协议和订阅感知的 loopback 代理，从请求 `prompt_cache_key` 注入 `x-opencode-session`；无键的连接探测使用一次性 ID，禁止共享静态会话。
4. 后续阶段再把预设 persona、设计/资产简报和易变 context 迁入注册表，并评估 cacheScope 与 diff 式运行时消息。

## 取舍

直接迁移全部提示词会同时改变模型行为、缓存和生命周期，风险过高。只修文案而不建立注册表则无法解决插件顺序、条件归属和卸载问题。采用兼容注册表可以先固定契约，再逐域迁移。
