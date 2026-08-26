# Advisor, WATCHDOG.md, and WATCHDOG.yml


[English](advisor-watchdog.md) | 中文
Advisor 是可选的第二个模型，附加到某个会话上。它会在每轮结束后复查主代理的 transcript，用自己的工具检查工作区，并将简洁建议注入回主会话。

Advisor 不是第二个执行器：它不能批准操作，也不能直接更改主会话状态。其默认工具集是只读的（`read`、`grep`、`glob`）加上 `advise`，但 `WATCHDOG.yml` 的 roster 条目可以将 `tools:` 扩展到任意内置工具——包括 `edit`、`write`、`bash`、`eval` 和 `browser` 等可变工具——因此只有当 advisor 模型和工作区都受信任时才授予这些工具（见 [Tools and isolation](#tools-and-isolation)）。

## 实现文件

- [`src/advisor/runtime.ts`](../packages/coding-agent/src/advisor/runtime.ts)
- [`src/advisor/advise-tool.ts`](../packages/coding-agent/src/advisor/advise-tool.ts)
- [`src/advisor/emission-guard.ts`](../packages/coding-agent/src/advisor/emission-guard.ts)
- [`src/advisor/watchdog.ts`](../packages/coding-agent/src/advisor/watchdog.ts)
- [`src/advisor/transcript-recorder.ts`](../packages/coding-agent/src/advisor/transcript-recorder.ts)
- [`src/prompts/advisor/system.md`](../packages/coding-agent/src/prompts/advisor/system.html)
- [`src/prompts/advisor/advise-tool.md`](../packages/coding-agent/src/prompts/advisor/advise-tool.html)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/config/settings-schema.ts`](../packages/coding-agent/src/config/settings-schema.ts)

---

## 启用 Advisor

Advisor 需要同时满足：

1. `advisor.enabled: true`
2. 为 `advisor` 模型角色分配了一个模型

示例：

```yaml
modelRoles:
  advisor: anthropic/claude-sonnet-4-5:medium

advisor:
  enabled: true
```

Advisor 角色使用常规 model-role 解析，包括带 provider 前缀的 id、canonical id 和可选的 thinking 后缀。

### 无头运行

使用 `--advisor` 在单次 print-mode 进程中启用 advisor，且不持久化 `advisor.enabled`：

```sh
musepi -p --advisor "Review this task."
```

在主 prompt 运行期间，advisor 的 concern 和 blocker 会继续 steer 该 live turn。最终 prompt 结束后，print mode 会保留最后的 advisor notes，而不会启动隐藏的主 turn，然后会等待最多十分钟进行最终复查，再释放该会话。错误退出使用 30 秒 drain 预算，以便失败的自动化任务可以终止。如果任一截止时间到期，OMP 会记录将要释放但尚未完成的 review；已完成的 review 保留其 transcript 以及 token/cost 用量。

斜杠命令：

| 命令 | 效果 |
| --- | --- |
| `/advisor` | 切换当前会话的 advisor（会话级覆盖；不会更改持久化的 `advisor.enabled` 设置）。 |
| `/advisor on` | 为当前会话启用 advisor，并在分配 advisor 模型时启动 runtime。仅限会话级；不会持久化到配置。 |
| `/advisor off` | 为当前会话禁用 advisor 并停止 runtime。仅限会话级；不会持久化到配置。 |
| `/advisor status` | 显示活动模型、上下文用量、token 用量和成本。 |
| `/advisor dump` | 将 advisor 的压缩 transcript 复制到剪贴板。 |
| `/advisor dump raw` | 将 advisor 的完整 dump（system prompt、tools、thinking 和 calls）复制到剪贴板。 |

如果 `advisor.enabled` 为 true，但没有 `modelRoles.advisor` 值解析到可用模型，status 会报告该设置已启用但未分配 advisor 模型。

## Advisor 能看到什么

在每个主 turn 结束时，`AdvisorRuntime` 只会收到自上次 advisor 更新以来的新 transcript delta。Delta 使用 `formatSessionHistoryMarkdown(..., { includeThinking: true, includeToolIntent: true, watchedRoles: true, expandPrimaryContext: true })` 渲染，因此 advisor 不仅能审查 assistant 推理，还能审查用户可见文本、tool call 和 tool result。

大多数隐藏的 `custom` 消息在 delta 中会折叠为一行摘要。例外是主代理注入的 constraint context——即 `PRIMARY_CONTEXT_CUSTOM_TYPES` 中的类型（`plan-mode-context`、`plan-mode-reference`）。`expandPrimaryContext` 会将这些内容原样渲染在 `<primary-context kind="…">` 包装内（经过 XML 转义，因此 plan/objective 文本不能逃逸或被误读为 advisor 指令）。否则 advisor 之前只能看到 plan-mode 规则的 120 字符截断——它在 `NEVER create, edit, or delete files — excep…` 处被截断，隐藏了“除了单个 plan 文件”的例外，导致代理撰写自己的 plan 文件时产生错误 blocker。由于这些 prompt 会在每个主 turn 中重新注入，`Advi...`

已注入主 transcript 的 advisor 消息会在渲染下一个 delta 之前被过滤掉。这可以防止 advisor 递归复查自己的建议。

当主 transcript 被重写时，advisor runtime 会被重置：

- compaction
- session switch/resume
- branch/fork 风格的历史替换
- advisor 自身上下文无法容纳时的 context-maintenance re-prime

重置会清除 advisor 的私有内存 transcript 并回绕其光标。下一次 advisor 更新会重放当前有界的主 transcript，而不是继续使用陈旧的重写前上下文。

如果在会话中途启用 advisor，光标会以当前主 transcript 长度作为种子，从而避免在首次启用 turn 时重放整段旧对话。

## 工具与隔离

Advisor 是一个完整的 agent，拥有自己的 `Agent` 实例，以及一个以 `-advisor` 为后缀的独立 `ToolSession`。因此 advisor 不会共享主代理的文件快照、seen-lines 跟踪、conflict 状态、summary cache，或 edit/yield 能力。

每个 advisor 都有 `advise` 工具，用于将 notes  surfaced 到主 transcript。其调查池默认为只读子集：

- `read`
- `grep`
- `glob`

`WATCHDOG.yml` 的 roster 条目可以通过 `tools: [...]` 对其进行扩展，选择会话实际构建的内置工具池中的任意子集（返回 `null` 的 factory 不在其中，例如没有匹配服务器的 `lsp`）。可授予的工具包括可变工具：`edit`、`write`、`bash`、`eval`、`browser`、`debug`、`ast_edit`、`task`、`hub` 以及 memory 工具。不在 [`BUILTIN_TOOL_NAMES`](../packages/coding-agent/src/tools/builtin-names.ts) 中的工具名会被丢弃并给出警告。

Advisor 的授予不会路由到主代理的 approval wrapper。advisor pool 是使用内置工具工厂、基于其自己的 `-advisor` `ToolSession` 构建，然后按 `WATCHDOG.yml` 过滤；它不是用 `ExtensionToolWrapper` 包装的主 `toolRegistry`。因此，授予 write 或 exec 级工具会让 advisor 直接调用这些工具，受工具自身 runtime guard 约束，但不受 `tools.approvalMode` / `tools.approval.<tool>` 提示约束。请保持可变授予范围狭窄且可信。

`advise` 工具接受一条 note 和一个可选的 severity：

| Severity | 投递 | 预期用途 |
| --- | --- | --- |
| 省略 / `nit` | 非中断旁注，在下一个 step boundary 批量合并进主 transcript。 | 清理、简化、低风险边界情况。 |
| `concern` | 在以下投递约束允许时，以中断 steering 消息形式发出。迟到的 terminal-answer `concern` 会保留为可见卡片。 | 重大风险、可能的方向错误、缺失约束、幻觉 API。 |
| `blocker` | 在以下投递约束允许时，以中断 steering 消息形式发出。与 `concern` 不同，单独的 terminal answer 不会阻止它触发 turn。 | 继续下去显然会浪费工作或产出破损输出。 |

中断建议通过 steering 通道发出，并可以在下一个 steering boundary 中止进行中的工具。每条 note（中断或批量）都会被渲染到主 transcript 中，成为一个 `<advisory>` 元素——severity 通过 `severity` 属性传递，`guidance` 属性携带“权衡，不要盲目服从”的 framing（主代理的 system prompt 从不提及 advisories，因此该标签是其唯一线索）。Note 正文经过 XML 转义，因此包含 `<`、`>` 或 `&` 的建议不会破坏包装：

```text
<advisory severity="concern" guidance="weigh, don't blindly obey">
note text
</advisory>
```

当你主动中断 agent 时（Esc，或来自 collab、ACP、RPC、SDK 或 extension 的取消），advisor 会停止自动恢复它。在运行已停止时提出的 interrupting `concern`/`blocker` 会被记录为可见 advisor 卡片，而不是重启 turn；同样，当中断发生时已在飞行中的 concern 也会被保留，而不是驱动意外恢复。建议会在你下次恢复时重新进入上下文——新消息、`.`/`c` 继续快捷键，或 steer/follow-up。

agent 自身驱动的正常 yield 与主动中断的处理方式不同，但它不是笼统的“总是 steer 并恢复”。loop 状态和已完成的 turn 会首先决定正常投递路径：

- **当 loop 仍在 streaming 中时**（raise 在 yield 之前到达，或在你已驱动的 resume 期间到达），该 note 通常会 steer 到 live turn。
- **一旦 loop 已 yield 并进入 idle**，投递取决于 turn 的结束方式：
  - 如果主会话尾部是**没有排队工作的 terminal text answer**，迟到的 `concern` 会保留为可见卡片，而不会唤醒 agent 去重述已完成的 turn (#4840)——它会在下次恢复时重新进入上下文（新消息、`.`/`c` 或 steer/follow-up），与中断情况相同。`blocker` 是例外：它通常会 steer 一个被触发的 turn，因为这意味着 agent 移交了破损或未验证的工作，必须在 turn 被视为完成前得到确认 (#5628)。
  - 否则（agent 在未完成工作时 yield，没有 terminal answer），空闲的 `concern`/`blocker` 通常会触发新 turn，使建议立即被处理。

两个 session/client 约束仍可能将 note 保留在正常的 steering 投递路径之外：

- **Plan mode：**每一个本应发生的 advisor steer 都会保留为可见卡片，即使主 loop 正在 streaming，因为只有用户驱动的 turn 才会收敛到 ask/resolve。
- **带有 deferred agent-initiated turns 的 ACP：**当 `deferAgentInitiatedTurns` 启用且 bridge 尚未允许 agent-initiated turns 时，空闲的本应 steer 会被保留，因为客户端无法将触发的 turn 表示为 busy。在主 loop 已在 streaming 时提出的建议仍然可以 steer 到该 live turn。

因此，advisor 可以在 agent 自行结束运行后 steer 并恢复一个 run，**前提是该 run 仍在运行、或在未完成工作时 yield，且当前 mode/client 允许 steering**。当 steering 被阻止时，note 要么被保留为卡片（上述 terminal-answer、plan-mode 和 deferred-ACP 情况），要么降级为非中断旁注（下面的 `advisor.immuneTurns` 冷却）；无论哪种方式，它都会等待下一个 step boundary 或 resume，而不会唤醒 agent。

`advisor.immuneTurns` 限制中断频率。在 advisor 成功通过 steering 通道投递一条 `concern` 或 `blocker` 之后，后续的 concern/blocker 会被路由为非中断旁注，直到配置的主 turn 数完成。默认值为 `3`。`nit` notes 不受影响，且在用户中断自动恢复抑制处于活动状态期间提出的建议仍会被保留，而不是重启已停止的运行。

### Emission guard

`AdvisorEmissionGuard`（位于 `src/advisor/emission-guard.ts`）位于 `AgentSession` 中的 `enqueueAdvice` 边界，在代码中强制执行 advisor system prompt 的“每次更新最多一次 `advise`”和“绝不发送相同建议两次”规则。advisor 的 `advise` 工具的每次调用都会先经过该 guard，然后才路由到 YieldQueue / steer channel：

1. **规范化。** 小写、NFKC，将每段非字母数字字符压缩为单个空格，trim。`"Stop."`、`"*Stop*"` 和 `"  stop  "` 都会 key 到 `stop`。
2. **无内容短语过滤。** 一小撮规范化短语的允许列表包含 advisor 偶尔发出但无具体实质的内容——`stop`、`done`、`complete`、`no issue continue`、`lgtm`、`nothing to add`、`no further input` 等——会被静默抑制。沉默是“没有 concern”的正确表达。
3. **精确文本去重。** 当前 session 中已接受的任何规范化 note 都会被丢弃。去重历史由 FIFO ring 限制大小（默认 4096 条）。
4. **每次更新频率限制。** 每个 advisor 模型 `prompt()` 周期最多接受一条 note；runtime 会在每个周期前调用 `host.beginAdvisorUpdate?.()` 来重置 gate。被抑制的调用永远不会消耗预算——噪音调用不会挤占同一更新中随后出现的真实 concern。

抑制对 advisor 模型是不可见的：`AdviseTool` 对被丢弃的调用仍然返回 `Recorded.`。将“suppressed” surfaced 回 advisor 上下文存在模型通过改写同一无意义 note 来绕过去重的风险。

guard 的完整状态——去重历史和每更新 gate——会在每次 advisor reset 时清空（compaction、session switch、`/new`），因此重新 prime 的审查者可以针对重写后的 transcript 重新提出它之前已经提出的问题。

## `advisor.syncBacklog` 的有界追赶

`advisor.syncBacklog` 不是 lockstep turn 执行。它是主代理在 advisor 落后时的有界追赶延迟。

允许值：

- `off`——永远不等 advisor 追赶
- `1`
- `3`
- `5`

在主 turn 结束时：

1. 主 turn delta 被排队给 advisor。
2. advisor drain loop 在后台启动或继续。
3. 如果 `advisor.syncBacklog` 不是 `off`，主代理只会在 advisor backlog 大于等于配置阈值时等待。
4. 等待上限为 30 秒。
5. 如果 advisor 在低于阈值时赶上，主代理立即继续。
6. 如果上限到期，主代理仍继续。

实际含义：

- `off` 优先保证最大主吞吐量。
- `1` 最接近同步复查：每个排队的 advisor delta 后，主代理最多等待 30 秒等待 backlog 回到零。
- `3` 和 `5` 允许更多 advisor 滞后，然后主代理才暂停。

Advisor 失败不会永久阻塞主代理。失败的 advisor prompt 会被重试；连续三次 advisor 失败后，runtime 记录警告、丢弃 backlog，并让会话继续。

## WATCHDOG.md

`WATCHDOG.md` 是 advisor-only 的指导。它会被附加到 advisor system prompt；它不会被注入主代理的正常上下文，也不表现为 `AGENTS.md`、`RULES.md` 或其他 context files 那样。

用它来记录复查重点：advisor 应该关注的 risk、项目特定陷阱、危险 API、架构边界，以及对审查者有用但对主执行器来说过于嘈杂的质量门槛。

示例：

```markdown
# Watchdog notes

Especially watch for:

- Changes that bypass the durable queue in `src/jobs/`.
- UI renderer paths that display unsanitized tool output.
- New worker spawns that do not re-enter the CLI host.
```

### 发现位置

`discoverWatchdogFiles(cwd, agentDir)` 从以下位置加载所有可读候选：

1. user level：`<active agent dir>/WATCHDOG.md`（默认 `~/.musepi/agent/WATCHDOG.md`；可通过 `PI_CODING_AGENT_DIR` 重定位）
2. project levels：从 `cwd` 向上遍历到 git repo root，或在找不到 repo root 时遍历到 home directory：
   - `<dir>/WATCHDOG.md`
   - `<dir>/.musepi/WATCHDOG.md`

与原生 context files 不同，watchdog discovery 不会在最近的项目文件处停止；多个项目 watchdog 文件可以同时加载。

隐藏 owner 目录中的候选会被忽略，除非文件位于 `.musepi` 目录内。这样可以避免意外拾取无关的 dot-directory 约定，同时仍然允许 `.musepi/WATCHDOG.md`。

### `@` 导入

`WATCHDOG.md` 内容使用与 context files 相同的 `@` 导入助手展开：

- 相对导入从导入文件所在目录解析
- `~/` 从用户 home 目录解析
- 围栏代码块和行内代码 span 内的导入保持字面量
- 循环会被跳过
- 缺失或不可读的导入会保留原 `@path` 文本

### Prompt 顺序

加载的 watchdog 块按以下顺序排序：

1. user-level `WATCHDOG.md`
2. project-level 文件从更远的祖先目录到 `cwd`

每个文件作为以下内容附加到 advisor system prompt：

```xml
Especially pay attention to:
<attention>
...expanded watchdog content...
</attention>
```

较近的 project 文件更靠近 advisor prompt 的末尾，因此更窄目录的指导比宽泛祖先指导更突出。

## WATCHDOG.yml

`WATCHDOG.yml`（或 `WATCHDOG.yaml`）是 advisor roster。`WATCHDOG.md` 提供复查重点，`WATCHDOG.yml` 则声明 advisor 本身——每个名称一个条目，各自拥有模型、工具授予和 specialization prompt。`/advisor configure` overlay 会原地编辑此文件。解析失败或 schema 验证失败的文件会被记录并跳过，因此一个损坏的项目配置不会导致会话崩溃。

示例：

```yaml
instructions: |
  Everyone: prefer diffs that keep tests unified.

advisors:
  - name: Architecture
    model: anthropic/claude-sonnet-4-5:medium
    tools: [read, grep, glob]
    instructions: |
      Watch cross-module coupling and public-API growth.

  - name: Fixer
    model: anthropic/claude-sonnet-4-5:high
    tools: [read, grep, glob, edit, bash]
    instructions: |
      You may edit and run tests to prove a fix locally, then advise.
```

字段：

- `instructions`（顶层）：共享 prompt，与 `WATCHDOG.md` 一起前置到每个 advisor 的 system prompt。跨所有发现的 `WATCHDOG.yml` 文件拼接。
- `advisors[].name`：人工标签；slugify 后用于 session id 和 `<session>/__advisor.jsonl` 文件名。跨文件的重复 slug 通过与 `WATCHDOG.md` 发现相同的特异性规则解析（project leaf > project ancestor > user）。
- `advisors[].model`：可选模型选择器，可带 `:level` thinking 后缀（例如 `x-ai/grok-code-fast:high`）。省略时使用 `modelRoles.advisor`。
- `advisors[].tools`：可选内置工具名列表。省略或为空时使用默认 `read`/`grep`/`glob` 子集。接受 [`BUILTIN_TOOL_NAMES`](../packages/coding-agent/src/tools/builtin-names.ts) 中的任意名称，包括可变工具（`edit`、`write`、`bash`、`eval`、`browser`、`debug`、`ast_edit`、`task`、`hub` 和 memory tools）。旧别名（`search`→`grep`、`find`→`glob`）会被规范化。未知名称会被丢弃并给出警告。授予可变工具的安全影响见 [Tools and isolation](#tools-and-isolation)。
- `advisors[].instructions`：该 advisor 的 specialization，在共享 baseline 之后追加。两个指令字段都像 `WATCHDOG.md` 一样展开 `@path` 导入。

### 发现位置

`WATCHDOG.yml`/`WATCHDOG.yaml` 与 `WATCHDOG.md` 共享相同的 user + project 搜索路径：user-level 的 `<active agent dir>/WATCHDOG.yml` 加上从 `cwd` 向上遍历到 repo root（或找不到 repo root 时到 home directory）过程中遇到的每个 `WATCHDOG.yml`/`.musepi/WATCHDOG.yml`。所有发现文件会一起加载；更具体的文件（project leaf > project ancestor > user）会替换更早的相同 advisor slug 条目。

## Subagents

子代理默认不受 advisor 复查；advisor 是**按代理选择加入**的，而不是通过全局开关：

- Agent 定义 frontmatter 中的 `advisor: true` 会为派生的该代理会话启用 advisor，使用为 `advisor` 角色解析的模型；字符串值（例如 `advisor: "deepseek/deepseek-v4-flash"` 或 `advisor: "@smol:high"`）设置显式 advisor 模型模式，并支持可选的 `:level` thinking 后缀。
- `task.agentAdvisor` 设置记录（agent name → `"on"` / `"off"` / model pattern）会覆盖 frontmatter，并可以通过 `/agents` hub 按 agent 配置：在某个 agent 上按 Enter 打开其 property strip；advisor strip 提供 on/off、model-browser pick 或 raw pattern。
遗留的 `advisor.subagents: true` 设置迁移为 `task.agentAdvisor: { task: "on" }`——捆绑的通用 `task` agent 保持其 advisor，其他代理默认不受复查。

被 advisor 的子代理会话会建立自己的 advisor 子系统，使用相同的 settings/model-role 解析（显式模式会落在派生会话的 `modelRoles.advisor` 上），然后重新运行该子代理会话 `cwd` 和 agent directory 下的 `WATCHDOG.md` 与 `WATCHDOG.yml` 发现。子代理 advisor 与子代理主 tool session 保持隔离，方式与主 advisor 和主 agent 之间的隔离相同。

## 成本与上下文行为

Advisor 用量是独立的模型用量。`/advisor status` 从 advisor agent 自己的 transcript 报告 advisor token 数和成本。

Advisor 拥有自己独立的 append-only 上下文。在每次 advisor prompt 前，`AgentSession` 会估算输入 token，并可能维护 advisor context：

1. 在启用且存在更大的兼容模型时，尝试 model-level context promotion。
2. 如果 promotion 无法容纳足够上下文，则压缩 advisor 自身的消息历史。
3. 如果 compaction 没有候选项，或仍然无法容纳，则从当前有界主 transcript 重新 prime。

Advisor 的实时上下文是内存中 append-only；会话运行期间会保留，以便 `/advisor dump` 检查，并独立地进行 promotion/compaction/re-prime（如上）。它不是主持久化 transcript 的替代品。

## Transcript 持久化与可观测性

Advisor 是被动审查者，拥有自己的模型用量，因此——和 task subagent 一样——每个已定案的 advisor turn 都会被追加到所属会话 artifacts 目录中的 JSONL 文件内：

- legacy/default advisor：`<session>/__advisor.jsonl`
- named advisor：`<session>/__advisor.<slug>.jsonl`
- subagent advisor（frontmatter `advisor` / `task.agentAdvisor`）：`<session>/<SubId>/__advisor[.<slug>].jsonl`

路径派生自 session 文件（不是 artifacts dir，后者被子代理与其父代理共享），因此每个 advisor 写入不同的文件。保留的 `__advisor` 词干不会与 task subagent 的 `<id>.jsonl` 冲突（task id 分配会保留该词干）。

为何使用文件：

...

Advisor 从来不是 peer。`advisor` 类型的 registry ref 被排除在所有面向 agent 的界面之外——`hub` peer roster 和广播目标、subagent peer prompt，以及 `history://` 的 index/lookup/completions——并且不能被发消息（`hub` send 和 collab chat 都会拒绝），也不能从 Agent Hub 或 collab 被 [revived or killed](./agent-hub.html#persisted-agents-and-advisors)。无论它被授予了什么工具，它都不可作为 peer 被寻址。
