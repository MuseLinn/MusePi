# Mnemopi 记忆后端

[English](mnemosyne-memory-backend.md) | 中文

MusePi 可以把 `@musepi/pi-mnemopi` 用作本地长期记忆后端。

设置：

```yaml
memory:
   backend: mnemopi
```

示例：

```yaml
memory:
   backend: mnemopi
mnemopi:
   scoping: per-project-tagged
```

启用后，编码 agent 会：

1. 按配置的 bank 作用域打开一个或多个本地 Mnemopi SQLite 数据库。
2. 在会话首个模型轮把相关记忆 recall 为 `<memories>` 块；如果 recall 由 `agent_start` 监听器触发，会刷新基础提示。
3. 在 agent 轮之后把完成的对话轮 retain 到 retain bank，频率不高于 `mnemopi.retainEveryNTurns`。
4. 压缩请求 `preCompactionContext` 时，把 recalled 记忆作为额外压缩上下文。
5. 通过共享记忆后端接口使用常规的 `/memory view`、`/memory stats`、`/memory diagnose`、`/memory clear` 和 `/memory enqueue` 命令。

Recalled 记忆是背景上下文，不是指令。冲突时当前用户消息和工具输出优先。

## Agent 工具

选择 Mnemopi 后会提供这些可发现工具：

- `recall`——搜索作用域内记忆。结果是预览并带 memory ID。
- `retain`——显式存储持久事实。
- `reflect`——跨 recalled 记忆综合回答。
- `memory_edit`——按 ID 对可编辑记忆执行 `update`、`forget` 或 `invalidate`。fact 表行只读。

替换前先用 `read memory://<memory-id>` 读取 recalled 结果的完整内容和元数据；被裁剪的 recall 预览不是安全的 update 载荷。启用 `autolearn.enabled: true` 时，可选的 `learn` 工具也能 retain 到 Mnemopi。

首轮 recall 属于 transcript 历史，以 `memory_recall` 条目存入会话文件。恢复、切换或 fork 会话会原样发送该块而不重新 recall，因此系统提示（以及基于它的 provider prompt cache）跨进程保持一致。如果 recalled 记忆之后被删除、失效、过期或其 recall 预览改变（包括 `/memory clear` 或 `memory_edit`），从提示开始的下一个轮次会带一条一次性隐藏消息列出变化；原块不会被改写。上下文重置、切换到不同记忆数据库、编辑首条提示的分支会重新 recall。即使记忆已从存储删除，recalled 文本仍留在会话文件中。

## 设置

| 设置                          | 默认值             | 说明                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`              | `off`              | 设为 `mnemopi` 启用此后端。                                                                                                                                                                                                                                   |
| `mnemopi.dbPath`              | agent 记忆目录     | 可选 SQLite 数据库路径。                                                                                                                                                                                                                                      |
| `mnemopi.bank`                | 未设置             | 传给 `Mnemopi` 的可选共享 bank 基名；coding-agent 包装层按 `mnemopi.scoping` 从此基名派生作用域。未设置 → 共享 bank `default`；按项目模式从工作目录 basename 加绝对路径稳定哈希派生项目 bank。                                                                |
| `mnemopi.scoping`             | `per-project`      | 记忆可见性：`global` = 一个共享 bank，`per-project` = 隔离的项目记忆，`per-project-tagged` = 项目本地写入加全局 recall 可见性。                                                                                                                                 |
| `mnemopi.autoRecall`          | `true`             | 在会话首轮 recall 记忆。                                                                                                                                                                                                                                      |
| `mnemopi.autoRetain`          | `true`             | 自动 retain 完成的轮次。                                                                                                                                                                                                                                      |
| `mnemopi.polyphonicRecall`    | `false`            | 用 reciprocal rank 融合标准排序与 vector、graph、fact、temporal 声部，使通过 episodic graph（由 `mnemopi.proactiveLinking` 或合并建立）或合并抽取事实关联的记忆无需关键词命中也能浮现。`MNEMOPI_POLYPHONIC_RECALL` 设置时覆盖。                                |
| `mnemopi.enhancedRecall`      | `false`            | 按查询缓存 recall 结果最多 5 分钟。缓存键包含所有 recall 选项（limit、facts、channel、time、bank），相似查询只在选项完全一致时复用，任何 bank 写入都会清缓存。`MNEMOPI_ENHANCED_RECALL` 设置时覆盖。                                                            |
| `mnemopi.proactiveLinking`    | `false`            | 存储新记忆时写入 episodic graph 并链接到相关实体/记忆；`MNEMOPI_PROACTIVE_LINKING` 设置时覆盖。                                                                                                                                                              |
| `mnemopi.retainEveryNTurns`   | `4`                | 自动 retain 写入之间的最小用户轮数。                                                                                                                                                                                                                          |
| `mnemopi.recallLimit`         | `8`                | 提示块中 recalled 记忆的最大数量。                                                                                                                                                                                                                            |
| `mnemopi.recallContextTurns`  | `3`                | recall 查询包含的先前用户轮数。                                                                                                                                                                                                                               |
| `mnemopi.recallMaxQueryChars` | `4000`             | 组合 recall 查询的最大长度。                                                                                                                                                                                                                                  |
| `mnemopi.injectionTokenLimit` | `5000`             | 记忆提示注入的近似 token 预算。                                                                                                                                                                                                                               |
| `mnemopi.debug`               | `false`            | 为后端失败启用 debug 日志。                                                                                                                                                                                                                                   |
| `mnemopi.noEmbeddings`        | `false`            | 向 `Mnemopi` 传 `noEmbeddings`，强制仅 FTS recall。                                                                                                                                                                                                          |
| `mnemopi.embeddingVariant`    | `en`               | 本地嵌入模型变体：`en` = `BAAI/bge-base-en-v1.5`（768 维），`multilingual` = `intfloat/multilingual-e5-large`（1024 维）。`mnemopi.embeddingModel`/`MNEMOPI_EMBEDDING_MODEL` 覆盖；变更会在下次可写启动时重建存储的嵌入。                                      |
| `mnemopi.embeddingModel`      | 变体默认           | 显式嵌入模型 id，覆盖 `mnemopi.embeddingVariant`。优先级：本设置 > `MNEMOPI_EMBEDDING_MODEL` 环境变量 > 变体默认；空白或 `null` 视为未设置。                                                                                                                  |
| `mnemopi.embeddingApiUrl`     | 环境/默认          | 传给 `Mnemopi` 的 OpenAI 兼容嵌入端点。                                                                                                                                                                                                                       |
| `mnemopi.embeddingApiKey`     | 环境/默认          | 传给 `Mnemopi` 的嵌入 API key。                                                                                                                                                                                                                               |
| `mnemopi.llmMode`             | `smol`             | `smol` 解析 `memory` 模型角色及其重试链；`remote` 使用下方设置；`none` 禁用 LLM 调用。                                                                                                                                                                          |
| `mnemopi.llmBaseUrl`          | 环境/默认          | `llmMode: remote` 的 OpenAI 兼容 LLM 端点。                                                                                                                                                                                                                   |
| `mnemopi.llmApiKey`           | 环境/默认          | `llmMode: remote` 的 LLM API key。                                                                                                                                                                                                                            |
| `mnemopi.llmModel`            | 环境/默认          | `llmMode: remote` 的 LLM 模型 id。                                                                                                                                                                                                                            |

嵌入模型变化时，bank 在打开时重建已存嵌入。它先用新模型嵌入整个语料，只有每个批次都成功后才替换已存向量，因此缺少 key、端点不可达或请求被拒都不会擦除旧向量；下次打开会重试。嵌入 API 请求最多携带 `MNEMOPI_EMBEDDING_BATCH_SIZE` 条文本（默认 `64`）；供应商上限更低时（例如 DashScope 为 `10`）按上限设置。

## 作用域

coding-agent 包装层在底层 `Mnemopi` 包之上应用作用域：

- `global` 用同一个共享 bank 读写。
- `per-project` 只根据当前工作目录派生 bank——basename 加绝对路径的稳定哈希，与周边 git 布局无关。
- `per-project-tagged` 写入项目本地 bank，同时从项目本地 bank 和共享全局 bank recall，去重合并结果。

`global` 和 `per-project-tagged` 下，`retain` 和 `learn` 工具还接受 `scope: "global"`，把条目或经验写入共享 bank，使每个项目都能 recall。`per-project` 不提供该选项，因为没有会被每个项目 recall 的 bank。

非全局模式还会 recall 旧的 sibling bank：其 working-memory 行的 `metadata.cwd` 全部为当前绝对 cwd；混合 cwd、空、损坏或不可读的 bank 会被排除。启动最多探测 64 个额外 bank 目录。新写入仍使用当前项目 bank。

项目加全局的组合行为位于包装层。`@musepi/pi-mnemopi` 包本身仍直接暴露 bank 和构造选项，包括用于选择 bank 名称的 `bank`。共享 bank 之外的项目本地 bank 作为 sibling 数据库由 Mnemopi 的 `BankManager` 管理。

## Recall 预览与完整行读取

Recall 结果携带裁剪后的内容预览，而不是完整行。超过预览上限的内容以 `…` 结尾；结果还设置 `truncated: true` 和 `full_length`（原始字符数），调用方无需解析标记即可检测裁剪。上限为 `RecallOptions.contentPreviewChars`（默认 `500`；`0` 禁用裁剪）。

完整行始终可以通过 `memory://<memory-id>` 读取，它解析活动 working 或 episodic 行，并在小型 YAML frontmatter 头（`id`、`bank`、`store`、`memory_type`、时间戳、`importance`、`veracity`、`session_id`、`metadata`）后返回完整内容。coding-agent 面向模型的提示要求在任何 `memory_edit update` 前先读取，因为 `update` 整体替换内容，否则会丢弃裁剪预览中未看到的尾部。

Retain 写入无标记 transcript 投影：宿主在存储 transcript 之外提供 `embedText` 覆盖时，该投影用于嵌入、working-memory FTS 索引（`COALESCE(embed_text, content)`）和重建重嵌入，因此存储 transcript 中的 retain 协议标记不会污染向量和全文 recall。

## Recall 排序权重

Recall 会把每条记忆的分数乘以存储 `veracity` 标签的权重；对 episodic 记忆再乘以退化层级权重。每次 recall 都从环境变量读取这些权重：

| 变量                      | 默认值 | 适用                                                                                             |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `MNEMOPI_STATED_WEIGHT`   | `1.0`  | `veracity: stated`，由 coding agent 显式记忆保存（扩展 `memory.save` API）写入                   |
| `MNEMOPI_UNKNOWN_WEIGHT`  | `0.8`  | `veracity: unknown`，由 coding agent 自动 transcript retain 写入，以及任何未命名标签的写入       |
| `MNEMOPI_INFERRED_WEIGHT` | `0.7`  | `veracity: inferred`                                                                             |
| `MNEMOPI_IMPORTED_WEIGHT` | `0.6`  | `veracity: imported`                                                                             |
| `MNEMOPI_TOOL_WEIGHT`     | `0.5`  | `veracity: tool`，由 coding agent 的 `retain` 和 `learn` 工具写入                               |
| `MNEMOPI_TIER1_WEIGHT`    | `1.0`  | 退化层级 1 的 episodic 记忆                                                                      |
| `MNEMOPI_TIER2_WEIGHT`    | `0.85` | 退化层级 2 的 episodic 记忆                                                                      |
| `MNEMOPI_TIER3_WEIGHT`    | `0.7`  | 退化层级 3 及以上的 episodic 记忆                                                                |

Sleep 合并会把 working 记忆的标签带到它生成的 episodic 记忆上。

标记为 `true` 或 `likely_true` 的记忆权重始终为 `1.0`，`false` 为 `0`。启用 `mnemopi.polyphonicRecall` 时，这些权重决定标准排序，标准排序成为融合后的 `hybrid` 声部；vector、graph、fact 和 temporal 声部不应用这些权重。

## LLM 与嵌入

FTS 和嵌入路径使用下方设置。`llmMode: smol` 解析 `memory` 角色及其配置的重试链，调用时获取凭据。未设置时，该角色复用 `tiny`，再回退到 fast（`smol`）默认值。它支持本地推理和在线模型。`llmMode: remote` 使用 OpenAI 兼容端点设置；`llmMode: none` 禁用 LLM 调用。如果没有可用模型或凭据，Mnemopi 在没有 LLM 支持的情况下继续工作。旧 `providers.memoryModel` 设置会迁移到 `memory` 角色。

仅 FTS：

```yaml
memory:
   backend: mnemopi
mnemopi:
   noEmbeddings: true
```

等价构造形式：

```ts
new Mnemopi({ noEmbeddings: true });
```

远端嵌入：

```yaml
mnemopi:
   embeddingModel: text-embedding-3-small
   embeddingApiUrl: https://api.openai.com/v1
   embeddingApiKey: ${OPENAI_API_KEY}
```

等价构造形式：

```ts
new Mnemopi({
	embeddingModel: "text-embedding-3-small",
	embeddingApiUrl: "https://api.openai.com/v1",
	embeddingApiKey,
});
```

远端 LLM：

```yaml
mnemopi:
   llmMode: remote
   llmBaseUrl: https://api.openai.com/v1
   llmApiKey: ${OPENAI_API_KEY}
   llmModel: gpt-4.1-mini
```

等价构造形式：

```ts
new Mnemopi({ llm: { baseUrl, apiKey, model } });
new Mnemopi({ llmBaseUrl: baseUrl, llmApiKey: apiKey, llmModel: model });
```

用于轮换 OAuth token 的动态函数 LLM：

```ts
new Mnemopi({
	llm: async (prompt, opts) => {
		const token = await getFreshOauthToken();
		return await completeWithPiAi(prompt, {
			token,
			maxTokens: opts?.maxTokens,
			temperature: opts?.temperature,
		});
	},
});
```

托管 memory 角色 LLM：

```yaml
mnemopi:
   llmMode: smol
```

coding agent 解析 `memory` 角色并传入动态 completion 函数，使每次 Mnemopi LLM 调用都能在调用时获取当前 provider 凭据并尝试角色的回退候选：

```ts
new Mnemopi({
	llm: async (prompt, opts) => completeMemoryRoleWithCurrentAuth(prompt, opts),
});
```

## 运行说明

- 默认共享数据库位于 agent 记忆目录下的 `mnemopi/mnemopi.db`；项目作用域 bank 使用该 Mnemopi 目录下的 sibling 数据库路径。
- `/memory clear` 删除活动配置的每个作用域 Mnemopi SQLite 数据库及 sidecar WAL/SHM 文件。
- `/memory enqueue` 强制 retain 当前会话、刷新待处理事实抽取，并对符合条件的 working-memory 行运行 Mnemopi sleep/合并。
- `mnemopi` 后端活动时，`/memory stats` 和 `/memory diagnose` 渲染后端特定的 bank 统计/诊断。
- 子 agent 不拥有单独的 Mnemopi retain 循环；存在父 Mnemopi 状态时它们复用父状态，否则保持惰性。
- 主后端启动时，符合条件的 working-memory 行会在首次写入可能触发 TTL 裁剪前跨拥有的 bank 提升。提升失败会记录日志，但不会禁用后端。
- 后端启动是尽力而为。数据库/模型初始化失败时会话继续，Mnemopi 惰性运行并记录警告；记忆工具随后报告后端未初始化。
- 本地嵌入模型每台机器只加载一次，而不是每个会话一次：每个 (模型, fastembed 缓存目录) 对由一个分离的 `__omp_worker_mnemopi_embed_server` 进程服务。它在 `<state>/run/mnemopi-embed/<model>-<hash>.json` 发布回环端点和仅所有者可读的 token；第一个需要它的 MusePi 进程启动它，后续进程连接。推理运行在服务端私有的 `onnxruntime` 子进程中。服务端 15 分钟无请求后退出并释放模型内存；另一版本的进程连接时会替换它。稳态嵌入超过 2 分钟视为失败，服务端会杀死并重启其推理子进程。共享服务端无法启动时，客户端回退到每进程 worker。

## 关闭与持久性

正常交互和 print 模式退出使用比 `/memory enqueue` 更轻的路径：

1. 主状态 retain 当前 transcript，并禁用新事实抽取。
2. 它刷新已在飞行中的抽取，但不运行逐会话 sleep 或完整跨会话提升。
3. 只有排空完成后才关闭拥有的 SQLite bank 句柄；进程在状态销毁后断开嵌入服务端连接，因为排空仍可能嵌入。服务端继续为其他会话运行（并完成已在进行的模型下载），直到空闲退出。

复用的子 agent 状态不拥有也不关闭共享 bank；父状态负责最终 retain、刷新和句柄关闭。

交互和 print 退出给这次排空 1.5 秒。预算耗尽时，关闭会分离在途排空，并在其完成时关闭句柄，而不是与已关闭数据库竞争写入。进程可能先退出。已写入的 working-memory 行仍然持久，但最后几轮的提升或嵌入可能不完整；agent 结束时执行的更早轮次 retain 不受影响。

`/memory enqueue` 是显式更强的持久性边界：它强制 retain、刷新待处理抽取，并在拥有的 bank 上运行完整 sleep/合并。它不会绕过 Mnemopi 的年龄门槛：`sleepAllSessions` 选择超过 `Math.floor(workingMemoryTtlHours / 2)` 小时（默认 24 小时 TTL 下为 12 小时）的未合并 working-memory 行。因此立即 enqueue 后，新行仍留在 working memory。退出前用该命令强制 retain 和刷新待处理工作，或在过了年龄门槛后提升符合条件的行；正常关闭不会提升它们。
