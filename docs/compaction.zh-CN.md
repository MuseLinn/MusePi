# 压缩与分支摘要

[English](compaction.md) | 中文

压缩与分支摘要是两种将长会话保持可用、同时不丢失先前上下文信息的机制。

- **压缩**：把旧历史重写为当前分支上的摘要。
- **分支摘要**：在 `/tree` 导航时捕获被放弃的分支上下文。

两者都作为会话条目持久化，并在重建 LLM 输入时转回用户上下文消息。

## 关键实现文件

- `packages/agent/src/compaction/compaction.ts`（完整上下文总结与 handoff 生成）
- `packages/snapcompact/src/snapcompact.ts`（snapcompact 策略：历史归档为稠密位图）
- `packages/agent/src/compaction/branch-summarization.ts`
- `packages/agent/src/compaction/pruning.ts`
- `packages/agent/src/compaction/utils.ts`
- `packages/agent/src/compaction/openai.ts`
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/messages.ts`
- `packages/coding-agent/src/extensibility/hooks/types.ts`
- `packages/coding-agent/src/config/settings-schema.ts`

## 会话条目模型

压缩与分支摘要是**一等会话条目**，不是普通 assistant/user 消息。

- `CompactionEntry`
  - `type: "compaction"`
  - `summary`，可选 `shortSummary`
  - `firstKeptEntryId`（压缩边界）
  - `tokensBefore`
  - 可选 `details`、`preserveData`、`fromExtension`
- `BranchSummaryEntry`
  - `type: "branch_summary"`
  - `fromId`、`summary`
  - 可选 `details`、`fromExtension`

重建上下文（`buildSessionContext`）时：

1. 活动路径上最新的压缩条目被转换成一条 `compactionSummary` 消息。
2. 从 `firstKeptEntryId` 到压缩点的保留条目被重新包含。
3. 路径上此后的条目被追加。
4. `branch_summary` 条目被转换成 `branchSummary` 消息。
5. `custom_message` 条目被转换成 `custom` 消息。

这些自定义角色随后在 `convertToLlm()` 中被转换为面向 LLM 的消息：`compactionSummary` 和 `branchSummary` 变成通过静态模板渲染的用户消息：

- `packages/agent/src/compaction/prompts/compaction-summary-context.md`
- `packages/agent/src/compaction/prompts/branch-summary-context.md`

而 `custom` 消息以 developer 消息形式透传原始内容（无模板）。

## 压缩流水线

### 触发方式

压缩/上下文维护可按六种方式运行：

1. **手动上下文压缩**：`/compact [instructions]` 调用 `AgentSession.compact(...)`。
2. **自动溢出恢复**：当同模型 assistant 错误被判定为上下文溢出后触发。
3. **自动不完整输出恢复**：当同模型 assistant 消息以 `stopReason === "length"` 结束时触发（OpenAI/Codex 的 `response.incomplete`）。
4. **自动阈值维护**：一次成功对话后，当上下文超过已解析阈值时触发。
5. **轮中阈值维护**：在下次 provider 请求前，若工具循环轮次越过了阈值且 `compaction.midTurnEnabled !== false` 则触发。
6. **空闲维护**：`runIdleCompaction()` 可以同样的自动维护路径触发，reason 为 `"idle"`。

### 压缩形状（图示）

```text
压缩前：

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

压缩后（新条目追加）：

  entry:  0     1     2     3      4     5     6      7      8     9      10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │ cmp │
        └─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

LLM 看到的内容：

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

### 溢出/不完整恢复与阈值/空闲维护的区别

自动路径被有意设计得不同：

- **溢出恢复**
  - 触发条件：当前模型 assistant 错误被检测为上下文溢出，且该错误不早于最新压缩条目。
  - 重试前先从活跃 agent 状态中移除失败的 assistant 错误消息。
  - 优先尝试上下文提升；如果配置了更大的模型可用，agent 切换模型并重试，不压缩。
  - 如果没有可用提升且压缩已启用，则以 `reason: "overflow"` 和 `willRetry: true` 执行上下文完整压缩；溢出不采用 handoff 策略，因为 handoff 请求会复用溢出的输入。
  - 成功后，调度 `agent.continue()` 重试该轮次。

- **不完整输出恢复**
  - 触发条件：同模型 assistant 消息以 `stopReason === "length"` 结束，且该消息不早于最新压缩条目。
  - 恢复前先从活跃 agent 状态中移除不完整的 assistant 消息。
  - 优先尝试上下文提升。
  - 如果没有可用提升且压缩已启用，则以 `reason: "incomplete"` 和 `willRetry: true` 执行自动维护。
  - 与溢出不同，`compaction.strategy: "handoff"` 被允许用于不完整输出恢复，因为输入上下文仍可用。
  - 上下文完整压缩成功后，调度 `agent.continue()` 重试该轮次。

- **阈值维护**
  - 触发条件：成功的、无错误的 assistant 消息，其调整后的上下文 token 数超过 `resolveThresholdTokens(...)`。
  - 轮中维护还在下一次 provider 请求前、工具循环轮次穿越阈值且 `compaction.midTurnEnabled !== false` 时检查安全的工具循环边界。
  - 工具输出剪枝可在阈值比较前降低测得的 token 数。
  - 轮后压缩前优先尝试上下文提升。
  - 如果没有可用提升，则以 `reason: "threshold"` 和 `willRetry: false` 执行自动维护。
  - 当 `compaction.strategy: "handoff"` 时，轮后阈值维护通常调度一个 post-prompt 自动 handoff 任务，而不是写入压缩条目；pre-prompt 和轮中检查内联执行以避免与下轮竞争。轮中检查会抑制 handoff 会话重置，并回退到上下文完整压缩。
  - 成功后，若 `compaction.autoContinue !== false`，轮后维护会调度一条由 agent 编写的 developer 自动继续提示词（来自 `prompts/system/auto-continue.md`）；轮中维护不会调度单独的继续，因为核心循环已经掌控了下一次 provider 请求。

- **空闲维护**
  - 触发条件：`runIdleCompaction()` 在不流式传输或已在压缩时调用。
  - 使用 `reason: "idle"`，之后不自动继续。

### Snapcompact 策略

`compaction.strategy: "snapcompact"` 用本地确定性归档过程替代 LLM 总结调用（来自 `@musepi/snapcompact` 的 `compact`）：

- 被丢弃的历史被序列化、空白折叠后打印到感知模型的 PNG 帧上（帧宽度按形状固定；帧高度紧贴实际打印的行），使用捆绑的公共领域像素字体。形状——以及帧大小——在**模型行被测量时**从**模型 id** 解析：Claude 读取 X.org `8x13` 字形，字距 11px（额外字间距，黑色墨迹 —— `11on16-bw`；高分辨率行——Opus 4.7+、Fable、Mythos——得到 1932px 帧，受 Anthropic 的 4,784 视觉 token 上限约束，旧行保持 1568px），Gemini 读取 `8x13` 字形，行距 22px（额外前导，黑色墨迹 —— `8on22-bw` 在 2048px，因为 Gemini 3.x 按每张图像固定 1,120 token 预算计费，无论像素尺寸），GPT/Codex 在 1568px 读取相同的 `8on22-bw` 形状（…
- 序列化使归档对话高密度：工具结果按头+尾截断（默认 2,000 字符，0.6 头部比例），工具调用参数值按值上限（500）和每次调用上限（2,000）限制，工具输出以暗灰色墨迹打印，使对话内容比工具噪声更突出。所有预算和淡化都可通过 `SerializeOptions` 配置（`toolResultMaxChars`、`toolArgMaxChars`、`toolCallMaxChars`、`truncateHeadRatio`、`dimToolResults`）。
- snapcompact 归档持久化在 `CompactionEntry.preserveData.snapcompact` 下，作为带渲染帧的有限源文本。每次重建上下文时，它被重构为有序压缩块：最旧边缘为纯文本，中间为图像，最新边缘为纯文本。条目的 `summary` 只是简短的前导摘要和通常的文件操作列表。
- 后续压缩从该有限源文本（`Archive.text`）重新渲染，而不是盲目地携带旧 PNG 前进。`maxFrames` 现在默认是 `MAX_FRAMES_DEFAULT`（80），仅作为上限；当图像中间区域较大时，它在内部进行焦点化（HQ/LQ/HQ），而两个时间边缘保持逐字文本。
- 没有模型、API key 或网络参与，因此 snapcompact 也适用于溢出恢复。它要求当前模型具备视觉能力（`model.input` 包含 `"image"`）；否则运行回退到上下文完整压缩并发出警告通知（自动和手动路径）。手动 `/compact` 遵守策略，除非给出自定义指令（这意味着定向的 LLM 摘要）。

### 显示转录

压缩不再让对话在视觉上重新开始。TUI 渲染**显示转录**（`buildSessionContext({ transcript: true })` / `AgentSession.buildTranscriptSessionContext()`）：按时间顺序排列路径上的每个条目，每条压缩内联显示为一条精简分隔符 —— `── 📷 compacted · ctrl+o ──` —— 在其触发点。展开（ctrl+o）显示摘要。只有 LLM 上下文在压缩边界处重置；分隔符上方的回滚保持完整，跨会话恢复也是如此。

### 压缩前剪枝

压缩检查前，工具结果剪枝可能运行（`pruneToolOutputs`）。

默认剪枝策略：

- 保护最新的 `40_000` 个工具输出 token。
- 要求至少 `20_000` 总估算节省。
- 绝不清空低于 `50` token 的结果（`MIN_PRUNE_TOKENS`）：`[Output truncated - N tokens]` 占位符大约占 8 个 token，因此剪枝低于下限的结果会增加上下文并空转 prompt cache（无用且已过时的结果有它们自己的规则——无用收集器已经丢弃无节省候选项；已过时读取无论大小都为正确性剪枝）。
- 绝不剪枝 `skill` 工具结果、`skill://` 路径的 `read` 结果，或活动计划参考文件的读取（通过 `AgentSession` 的计划保护添加）。

被剪枝的工具结果被替换为：

- `[Output truncated - N tokens]`

如果剪枝改变了条目，会话存储会在压缩决策前被重写，并且 agent 消息状态被刷新。

### 无意义结果剔除

工具可以将已完成的结果标记为上下文无意义——零匹配的搜索、超时且仍有内容在运行的 `hub` wait、空的 `hub` 收件箱清空。该标记起源于工具结果（`AgentToolResult.useless`，通过 `ToolResultBuilder.useless()` 设置或直接在返回的对象上设置），被 agent 循环复制到持久化的 `ToolResultMessage` 上（绝不与 `isError` 一起——错误总是优先），并在三个位置被消费：

- **每轮过时结果通道**（`pruneSupersededToolResults`，由 `compaction.dropUseless` 控制，默认开启）：被标记的结果被清空为精确占位符 `[Uneventful result elided]`（`USELESS_NOTICE`），时机与已过时读取相同的缓存感知策略——仅当候选后面的后缀较小（≤ 约 8k token）或会话空闲时间超过 provider prompt cache 生命周期时。结果本身小于通知的不会被清空（无节省），受保护的工具豁免。
- **阈值剪枝**（`pruneToolOutputs`）：被标记的结果绕过保护最近窗口，与已过时读取相同，收到 `USELESS_NOTICE` 而非 token 计数占位符。
- **摘要序列化**：`serializeConversation`（agent 和 snapcompact）将整个工具调用/结果对从总结器/归档输入中移除——该区域在总结后无论如何会被丢弃，因此排除不会损耗缓存。

该标记不会到达 provider 线格式，被标记的对也不会从历史中移除（仅原地清空），因此工具调用/结果配对和 provider 原生历史重放保持完整。

### 边界与切点逻辑

`prepareCompaction()` 只考虑自上一个压缩条目（如果存在）以来的条目。

1. 找到上一个压缩索引。
2. 计算 `boundaryStart = prevCompactionIndex + 1`。
3. 在可用时使用测量到的使用率调整 `keepRecentTokens`。
4. 在边界窗口上运行 `findCutPoint()`。

有效切点包括：

- 角色为：`user`、`assistant`、`bashExecution`、`hookMessage`、`branchSummary`、`compactionSummary` 的消息条目
- `custom_message` 条目
- `branch_summary` 条目

硬规则：绝不切在 `toolResult`。

如果切点前有非消息元数据条目（`model_change`、`thinking_level_change`、标签等），它们会被拉入保留区域——将切点索引向后移动，直到命中消息或压缩边界。

### 分轮次处理

如果切点不在用户轮次开始处，压缩将其视为分轮次。

轮次开始检测将这些视为用户轮次边界：

- `message.role === "user"`
- `message.role === "bashExecution"`
- `custom_message` 条目
- `branch_summary` 条目

分轮次压缩生成两条摘要：

1. 历史摘要（`messagesToSummarize`）
2. 轮次前缀摘要（`turnPrefixMessages`）

最终存储的摘要合并为：

```markdown
<history summary>

---

**Turn Context (split turn):**

<turn prefix summary>
```

### 摘要生成

`compact(...)` 从序列化后的对话文本构建摘要：

1. 通过 `convertToLlm()` 转换消息。
2. 通过 `serializeConversation()` 序列化。
3. 包装在 `<conversation>...</conversation>` 中。
4. 可选包含 `<previous-summary>...</previous-summary>`。
5. 可选注入扩展 hook 上下文和活动内存后端压缩上下文作为 `<additional-context>` 条目。
6. 使用 `SUMMARIZATION_SYSTEM_PROMPT` 执行总结提示词。

提示词选择：

- 第一次压缩：`compaction-summary.md`
- 带先前摘要的迭代压缩：`compaction-update-summary.md`
- 分轮次第二遍：`compaction-turn-prefix.md`
- 短 UI 摘要：`compaction-short-summary.md`
- handoff 文档：`handoff-document.md`（由 `generateHandoff(...)` 使用，不序列化到压缩中）

远程摘要模式：

- 如果 `compaction.remoteEndpoint` 已设置且启用了远程压缩，本地摘要生成会向两种线格式之一 POST：
  - 自定义 musepi 摘要器端点接收 `{ systemPrompt, prompt }`，必须返回包含至少 `{ summary }` 的 JSON。
  - 路径以 `/chat/completions` 结尾的 OpenAI 兼容端点接收 `{ model, messages, stream: false }`，其中 `messages` 包含一个系统提示词和一个用户提示词。摘要从 `choices[0].message.content` 读取，这使得 llama.cpp 和 vLLM 等自托管服务器无需单独的摘要 shim 即可充当远程压缩器。
- 对于 OpenAI/OpenAI Codex 模型，在启用远程压缩时，压缩首先尝试 provider 原生的 `/responses/compact` 端点。它在 `preserveData.openaiRemoteCompaction` 中保留 provider 替换历史，如果该原生请求失败则回退到本地摘要。

### Handoff 生成

`packages/agent/src/compaction/compaction.ts` 还导出 `generateHandoff(...)`。Handoff 生成使用与摘要相同的 `completeSimple(...)` 单次风格，但它通过发送活跃系统提示词、工具数组和真实 LLM 消息历史，随后附加一条带有 handoff 提示词的 agent 归属 `user` 消息来保留实时 agent 缓存前缀。它强制使用 `toolChoice: "none"` 并直接返回连接的文本块。

Handoff 不会写入 `CompactionEntry`。`AgentSession.handoff()` 负责会话过渡：它启动一个新会话，将生成的文档作为可见 `custom_message` 注入（`customType: "handoff"`），然后从该新会话重建 agent 消息。

### 摘要中的文件操作上下文

压缩使用 assistant 工具调用跟踪累计文件活动：

- `read(path)` → 读取集合
- `write(path)` → 修改集合
- `edit(path)` → 修改集合

累计行为：

- 仅当先前条目是 pi 生成的（`fromExtension !== true`）时才包含先前压缩详情。
- 在分轮次中，也包含轮次前缀文件操作。
- `details.readFiles` 排除同时被修改的文件；`details.modifiedFiles` 保留其余部分（持久化形状不变）。

文件列表是一个分组、前缀折叠的目录树（find-tool 形状），每个文件带有访问标记 —— `(Read)` 表示只读文件，`(Write)` 表示从未读取的修改文件，`(RW)` 表示已修改且也在累计读取集中的文件。上限为 20 个文件，带有 `[…N files elided…]` 行。LLM 摘要策略将其作为 `<files>` 标签追加（通过 `upsertFileOperations`）；snapcompact 在其摘要模板中作为 `FILES` 部分渲染。

```xml
<files>
# packages/agent/src/compaction/
compaction.ts (Read)
utils.ts (RW)
## prompts/
file-operations.md (Write)
</files>
```

早期版本写入的旧 `<read-files>`/`<modified-files>` 标签会在重新附加之前被剥离（连同 `<files>` 一起），因此旧摘要在下次压缩时会自愈。

### 持久化与重载

摘要生成（或 hook 提供的摘要）后，agent session：

1. 通过 `appendCompaction(...)` 追加 `CompactionEntry` 以进行上下文完整维护；handoff 策略创建新会话并注入 handoff `custom_message`。
2. 从活跃叶节点通过 `buildDisplaySessionContext()` 重建显示上下文。
3. 用重建的上下文替换实时 agent 消息。
4. 从重建的分支同步活跃 todo 阶段，并关闭历史被重写的 provider 会话。
5. 发出 `session_compact` hook 事件。

## 分支摘要流水线

分支摘要与 `/tree` 导航相关，而非 token 溢出。

### 触发

在 `navigateTree(...)` 期间：

1. 使用 `collectEntriesForBranchSummary(...)` 从旧叶节点到公共祖先计算被放弃的条目。
2. 如果调用方请求了摘要（`options.summarize`），则在切换叶节点前生成摘要。
3. 如果摘要存在，则使用 `branchWithSummary(...)` 将其附加到导航目标。

操作上，这通常由 `branchSummary.enabled` 启用时的 `/tree` 流驱动。

### 分支切换形状（图示）

```text
导航前的树：

         ┌─ B ─ C ─ D (旧叶节点，被放弃)
    A ───┤
         └─ E ─ F (目标)

公共祖先：A
要总结的条目：B、C、D

带摘要导航后：

         ┌─ B ─ C ─ D ─ [B,C,D 摘要]
    A ───┤
         └─ E ─ F (新叶节点)
```

### 准备与 token 预算

`generateBranchSummary(...)` 计算预算为：

- `tokenBudget = model.contextWindow - branchSummary.reserveTokens`

`prepareBranchEntries(...)` 随后：

1. 第一遍：从所有要总结的条目中收集累计文件操作，包括先前 pi 生成的 `branch_summary` 详情。
2. 第二遍：从最新到最旧遍历，添加消息直到达到 token 预算。
3. 优先保留近期上下文。
4. 在预算边缘附近仍可能包含大型摘要条目以保证连续性。

压缩条目作为消息（`compactionSummary`）包含在分支摘要输入中。

### 摘要生成与持久化

分支摘要：

1. 转换并序列化选定的消息。
2. 包装在 `<conversation>` 中。
3. 如果提供了自定义指令则使用，否则使用 `branch-summary.md`。
4. 使用 `SUMMARIZATION_SYSTEM_PROMPT` 调用总结模型。
5. 前置 `branch-summary-preamble.md`。
6. 附加文件操作标签。

结果作为 `BranchSummaryEntry` 存储，带有可选详情（`readFiles`、`modifiedFiles`）。

## 扩展与 hook 触点

### `session_before_compact`

压缩前的 hook。

可以：

- 取消压缩（`{ cancel: true }`）
- 提供完整的自定义压缩负载（`{ compaction: CompactionResult }`）

### `session.compacting`

默认压缩的提示词/上下文自定义 hook。

可以返回：

- `prompt`（覆盖基础摘要提示词）
- `context`（注入到 `<additional-context>` 的额外上下文行）
- `preserveData`（存储在压缩条目上）

### `session_compact`

保存了 `compactionEntry` 和 `fromExtension` 标志的压缩后通知。

### `session_before_tree`

在默认分支摘要生成前的树导航上运行。

可以：

- 取消导航
- 提供自定义 `{ summary: { summary, details } }`，在用户请求摘要时使用

### `session_tree`

暴露新/旧叶节点和可选摘要条目的导航后事件。

## 运行时行为与故障语义

- 手动压缩首先中止当前 agent 操作。
- `abortCompaction()` 取消手动压缩、自动压缩和 handoff 生成的控制器。
- 自动压缩为 UI/状态更新发出开始/结束会话事件。
- 自动压缩可以尝试多个模型候选项并重试瞬时故障；长重试延迟在有可用候选项时优先选择下一个。
- 溢出错误被排除在通用重试路径之外，因为它们由上下文提升/压缩处理。
- 如果自动压缩失败：
  - 溢出路径发出 `Context overflow recovery failed: ...`
  - 不完整输出路径发出 `Incomplete response recovery failed: ...`
  - 阈值/空闲路径发出 `Auto-compaction failed: ...`
- 分支摘要可以通过中止信号（如 Escape）取消，返回 canceled/aborted 导航结果。

## 设置与默认值

来自 `settings-schema.ts`：

- `compaction.enabled` = `true`
- `compaction.strategy` = `"snapcompact"`（也支持 `"context-full"`、`"handoff"`、`"shake"` 和 `"off"`）
- `compaction.reserveTokens` = `16384`
- `compaction.keepRecentTokens` = `20000`
- `compaction.autoContinue` = `true`
- `compaction.midTurnEnabled` = `true`
- `compaction.remoteEnabled` = `true`
- `compaction.remoteEndpoint` = `undefined`
- `compaction.thresholdPercent` = `-1` 且 `compaction.thresholdTokens` = `-1`；当未设置正覆盖时，阈值为 `contextWindow - max(15% of contextWindow, reserveTokens)`
- `compaction.idleEnabled` = `false`
- `compaction.idleThresholdTokens` = `200000`
- `compaction.idleTimeoutSeconds` = `300`
- `branchSummary.enabled` = `false`
- `branchSummary.reserveTokens` = `16384`

这些值在运行时由 `AgentSession` 和压缩/分支摘要模块消费。
