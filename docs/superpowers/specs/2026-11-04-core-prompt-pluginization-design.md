# 核心提示词与易变 Context 插件化设计

## 目标

以 DSH 最新 SystemPrompt/Scope 为参照，将核心工具提示词和适合迁移的易变 context 纳入统一的 Cordis 生命周期，同时保持模型行为、权限、缓存亲和性和旧会话兼容。

## 原则

- 是否保留宿主实现由所有权和缓存收益决定，不以保留代替设计，也不为形式插件化而迁移。
- 每段提示词只有一个权威 owner、一个命名 section 和一个可释放注册。
- 稳定 section 与易变 context 分离；context 只在内容变化时生成新消息，不重写稳定前缀。
- 插件停用、HMR、preset 切换和工具禁用必须同步移除对应内容，禁止静态 fallback 和双 owner。
- 旧 `PromptComposer` 入口、字面量、历史模板、会话恢复和 OpenCode affinity 保持兼容。
- 不把 DSH 的 Loader、pnpm profile、sandbox 或会话 surface 模型一并移植。

## 阶段

1. 建立会话级 section/context/variable/tool provider 贡献契约与验收矩阵。
2. 核心工具提示词按工具 owner 迁移，主模板只保留跨工具核心契约。
3. 项目指令、工作区与仓库 context 按缓存和权限归属迁移。
4. plan/goal/vibe、memory、MCP instructions 按变化语义迁移或保留宿主，并记录证据。
5. 清理旧 owner、重复路径和文档，执行完整生命周期验收。

## 已确认的实施边界

- 每 session 一个 prompt host，section/context/variable/tool provider 统一归属；scope 管继承，lane 管来源优先级，owner 管释放。
- `PromptComposer` 保持 legacy facade，不强制旧字符串插值或同名恢复。
- 工具段必须能读取 active tool set 与 wire 名；子代理与主代理都经过同一 composer，不能因 options.systemPrompt 分支丢段。
- 暂不引入 Cordis 到领域包；先通过 ExtensionAPI 暴露 host，确有桌面 Cordis 消费者时再加 adapter。
- 同时修复已发现的预设生命周期缺陷：切换后工具 slate 必须恢复、resume 必须保留 mode、切走后的旧注册不得复活，persona 挂载失败不得静默回退完整 prompt。

## 验收

- 空注册和旧 compose 行为不变；各迁移域有输出对照。
- 启停、切换、重载、恢复和权限拒绝均无重复或残留。
- 缓存键不因无用 revision 或易变 context 抖动；确需变化时原因明确。
- 相关单元、集成、SDK、AgentSession 和真实生命周期测试通过。
