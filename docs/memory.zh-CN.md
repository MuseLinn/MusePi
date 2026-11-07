# 自主记忆

[English](memory.md) | 中文

MusePi 支持五种记忆模式。记忆默认关闭；通过 `/settings` 或 `config.yml` 选择后端：

| `memory.backend` | 存储与行为                                                                 | 指南                                                    |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------- |
| `off`            | 不运行记忆后端                                                             | —                                                       |
| `local`          | 从已持久化会话生成项目级摘要与经验                                         | 本页                                                    |
| `hindsight`      | 远端、按 bank 隔离的 Hindsight 记忆                                        | [Hindsight](#hindsight-远端后端)                        |
| `mnemopi`        | 本地 Mnemopi SQLite 记忆                                                   | [Mnemopi 记忆后端](./mnemosyne-memory-backend.zh-CN.md) |
| `sharpshooter`   | 按摩擦门槛抽取的项目决策文件（架构/产品/风格），后台合并                   | [Sharpshooter](#sharpshooter-后端)                      |

启用本地摘要流水线：

```yaml
memory:
   backend: local
```

## 使用方式

### 注入内容

会话启动时，如果当前项目存在已合并摘要或手动捕获的经验，它们会作为 **记忆引导** 块注入系统提示。摘要与经验共享 `memories.summaryInjectionTokenLimit`。

如果启动合并晚于首次提示构建，活动会话的摘要快照会刷新。已捕获的经验仍固定在初始快照中，因此并发的 `learn` 调用只影响后续会话。

- 把记忆视为启发式上下文——对流程和既往决策有用，但对当前 repo 状态不具权威性。
- 记忆改变计划时引用记忆产物路径，并在行动前用当前 repo 证据核对。
- 记忆与 repo 状态或用户指令冲突时，优先当前状态和用户指令，把冲突记忆视为过期。

### 读取记忆产物

agent 可以用 `read` 工具直接读取 `memory://` URL：

| URL                                    | 内容                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `memory://root`                        | 启动时注入的紧凑摘要                                                                                              |
| `memory://root/MEMORY.md`              | 完整长期记忆文档                                                                                                  |
| `memory://root/learned.md`             | `learn` 工具捕获的经验                                                                                            |
| `memory://root/skills/<name>/SKILL.md` | 生成的技能手册                                                                                                    |
| `memory://<memory-id>`                 | 完整 Mnemopi 记忆行（working 或 episodic），带 YAML frontmatter 元数据头；仅 `memory.backend` 为 `mnemopi` 时可用 |

`memory://<memory-id>` 返回完整存储行，而不是被裁剪的 recall 预览（超过预览上限的内容以 `…` 结尾）；agent 在 `memory_edit update` 前会先读取它。

`memory://root[/…]` 由文件支撑，仅在 `memory.backend: local` 时存在，由合并流水线写入磁盘记忆根。`hindsight` 或 `mnemopi` 下不会写入该根，这些 URL 无法解析——改用 `recall`/`reflect`（`mnemopi` 还可用 `read memory://<memory-id>`）。

### `/memory` 斜杠命令

| 子命令                | 作用                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `view`                | 显示当前后端的注入内容                                                                               |
| `stats`               | 显示后端特定的记忆统计（受支持时）                                                                   |
| `diagnose`            | 显示后端特定的诊断（受支持时）                                                                       |
| `queue`               | 显示等待合并的记忆增量                                                                               |
| `sync`                | 立即运行记忆合并                                                                                     |
| `clear` / `reset`     | 删除活动后端的记忆数据/产物                                                                          |
| `enqueue` / `rebuild` | 强制活动后端执行合并/保留工作                                                                        |
| `mm …`                | Hindsight mental model 维护（`list`/`show`/`refresh`/`history`/`seed`/`delete`/`reload`）；ACP 模式不支持 |

### 捕获经验

启用 `autolearn.enabled` 后可使用 `learn` 工具：

```yaml
autolearn:
   enabled: true
```

local 后端下，`learn` 把明确的持久经验写入项目的 `learned.md`。经验按最新在前、去重、脱敏，最多 100 条，从下一次会话开始注入；`learn` 调用不会改动活动会话的 prompt-cache 前缀。每条经验正文最多 2,000 字符，可选上下文最多 400 字符。local 后端不提供结构化记忆搜索、`recall`、`retain`、`reflect` 和 `memory_edit`。

## 工作原理

本地摘要记忆由启动时运行的后台流水线构建；`/memory enqueue` 标记合并工作，由下一次启动处理。子 agent 和未持久化到会话文件的会话会跳过该流水线。

**阶段 1——逐会话抽取：** 对每个自上次处理后发生变化的过去会话，模型读取会话历史并抽取持久信号：技术决策、约束、已解决的失败、重复工作流。过新、过旧、当前活动或超出扫描/年龄限制的会话会跳过。每次抽取产出该会话的原始记忆块和简短摘要。

**阶段 2——合并：** 抽取完成后，第二个模型阶段读取全部逐会话抽取结果，写出三类产物：

- `MEMORY.md`——整理后的长期记忆文档
- `memory_summary.md`——会话启动时注入的紧凑文本
- `skills/`——可复用流程手册，每个位于自己的子目录

单独维护的 `learned.md` 不会被合并覆盖。

阶段 2 使用 lease 和 heartbeat，防止多个进程同时启动时重复运行。旧运行遗留的技能目录会自动清理。

写入 `MEMORY.md`、`memory_summary.md` 或生成的技能前，合并输出会按常见密钥/token 模式脱敏。

### 抽取行为

记忆抽取与合并行为由 `packages/coding-agent/src/prompts/memories/` 下的静态提示文件驱动。

| 文件                      | 用途                                 | 变量                                        |
| ------------------------- | ------------------------------------ | ------------------------------------------- |
| `stage_one_system.md`     | 逐会话抽取的系统提示                 | —                                           |
| `stage_one_input.md`      | 包装会话内容的用户轮模板             | `{{thread_id}}`, `{{response_items_json}}`  |
| `consolidation_system.md` | 跨会话合并的系统提示                 | —                                           |
| `consolidation.md`        | 跨会话合并的用户轮提示               | `{{raw_memories}}`, `{{rollout_summaries}}` |
| `read-path.md`            | 注入活动会话的记忆引导               | `{{memory_summary}}`, `{{learned}}`         |

### 模型选择

记忆复用模型角色系统。

| 阶段             | 角色                                                                | 用途             |
| ---------------- | ------------------------------------------------------------------- | ---------------- |
| 阶段 1（抽取）   | `default`                                                           | 逐会话知识抽取   |
| 阶段 2（合并）   | `smol`（回退到 `default`，再回退到当前/首个注册模型）               | 跨会话综合       |

如果请求的记忆角色未配置，记忆模型解析回退到 `default` 角色，再到活动会话模型，最后到注册表中的第一个模型。

## 配置

| 设置                                  | 默认值  | 说明                                                                                                              |
| ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                      | `off`   | 本流水线选择 `local`；未显式设置后端时，旧 `memories.enabled: true` 会迁移为 `memory.backend: local`             |
| `memories.maxRolloutAgeDays`          | `30`    | 更旧的会话不处理                                                                                                  |
| `memories.minRolloutIdleHours`        | `12`    | 最近仍在活动的会话跳过                                                                                            |
| `memories.maxRolloutsPerStartup`      | `64`    | 单次启动处理的会话上限                                                                                            |
| `memories.threadScanLimit`            | `300`   | 启动时扫描的最近会话记录上限                                                                                      |
| `memories.maxRawMemoriesForGlobal`    | `200`   | 提供给全局合并的逐会话抽取上限                                                                                    |
| `memories.stage1Concurrency`          | `8`     | 并发逐会话抽取任务数                                                                                              |
| `memories.stage1LeaseSeconds`         | `120`   | 抽取任务 lease 时长                                                                                               |
| `memories.stage1RetryDelaySeconds`    | `120`   | 失败抽取再次可领取前的延迟                                                                                        |
| `memories.phase2LeaseSeconds`         | `180`   | 合并 lease 时长                                                                                                   |
| `memories.phase2RetryDelaySeconds`    | `180`   | 失败合并重试前的延迟                                                                                              |
| `memories.phase2HeartbeatSeconds`     | `30`    | 合并 lease 心跳间隔                                                                                               |
| `memories.rolloutPayloadPercent`      | `0.7`   | 可用于 rollout 载荷的模型上下文预算比例                                                                           |
| `memories.phase1InputTokenLimit`      | `4000`  | 逐会话抽取输入上限                                                                                                |
| `memories.fallbackTokenLimit`         | `16000` | 模型未声明有限上下文窗口时使用的 token 预算                                                                       |
| `memories.summaryInjectionTokenLimit` | `5000`  | 摘要与已捕获经验注入系统提示的共享近似 token 上限                                                                 |

## Hindsight 远端后端

Hindsight 需要可达的 [Hindsight](https://hindsight.vectorize.io/) 服务。默认端点为 `http://localhost:8888`；服务要求认证时设置 token：

```yaml
memory:
   backend: hindsight
hindsight:
   apiUrl: http://localhost:8888
   apiToken: ${HINDSIGHT_API_TOKEN}
```

`HINDSIGHT_*` 环境变量覆盖 `hindsight.*` 设置，后者覆盖内置默认值。完整覆盖表、取值、解析规则、优先级和默认值见 [Hindsight 环境变量表](./environment-variables.html#hindsight-memory-backend)。

默认使用 `per-project-tagged` 作用域：写入带项目标签的共享 bank，recall 同时包含项目标签记忆和未打标签的全局记忆。开启 `hindsight.globalScope: true`（默认关闭）后，`retain` 和 `learn` 接受 `scope: "global"`，写入不带项目标签的记忆，使适用于所有项目的偏好或经验在每个项目中都能被 recall。每个项目都能 recall 到全局事实本身。按项目刷新的 mental model 使用严格项目标签匹配，因此不会包含全局记忆；未打标签的 `user-preferences` 模型会包含。合并也可能把全局事实并入已有的项目标签 observation，因此其他项目的 observation 结果可能缺少该合并形式。若 bank 配置会给抽取事实打标签（`entity_labels` 组中 `tag: true`），全局事实带上该标签后不再出现在其他项目。`per-project` 把每个工作目录项目隔离到自己的 bank，且不提供 `scope: "global"`；`global` 使用一个共享 bank。显式 `hindsight.bankId` 选择 bank 基名。bank ID、前缀或作用域变化会重建主会话状态，后续操作使用新作用域。

两种项目作用域用同样方式命名项目：取 repo 的主 checkout 根（同一 repo 的所有 linked worktree 解析到同一目录），再小写其 basename。`~/code/General` 因此打上 `project:general`。标签按字面匹配，这一折叠保证同一 repo 无论路径大小写都落在同一记忆作用域。

主会话在首个模型轮 recall（`hindsight.autoRecall: true`），默认每三个用户轮自动 retain 已完成的对话轮。`/memory enqueue` 刷新排队的工具 retain 并强制 retain 当前会话。agent 结束时，主状态按节奏安排 retain 并刷新队列；会话销毁会在释放状态前排空队列。请求失败和配置超时只记录日志，不阻塞编码会话。子 agent 复用父级 client、bank 和作用域执行显式的 `recall`、`retain`、`reflect`，但不运行自己的自动 recall/retain。

工具发起的 `retain` 与 `learn` 写入经过持久 outbox：每条记忆在工具报告“已排队”前写入 `<agentDir>/hindsight-outbox/` 下的私有文件（不包含 bearer token，可识别密钥会脱敏），服务端接受后删除。投递失败的文件留在磁盘并按指数退避重试；同一 API URL 和 bank 的下一个主会话会继续投递先前进程留下的内容。每条记忆的 id 同时作为服务端 `document_id`，重发是替换而不是重复。服务端拒绝（HTTP 400、413、422）、文件损坏或 7 天未投递的事件会带警告移入 `hindsight-outbox/quarantine/`，30 天后删除。2xx 只表示服务端接受，不代表抽取完成。自动 transcript retain 不经过 outbox。

Recall 作为背景上下文注入，而不是指令；recalled 记忆也会作为压缩时的额外上下文。首轮 recall 存入会话文件，因此恢复、切换或 fork 会话会原样发送而不重新 recall；上下文重置、bank 或标签过滤变化、编辑首条提示的分支会重新 recall。Hindsight 记忆无法按 id 查询，因此不报告 recall 之后发生的变化。新进程启动时仍会重新加载 mental model。选择 Hindsight 会暴露 `recall`、`retain`、`reflect`；不提供 `memory_edit`，因为该后端不直接编辑上游 Hindsight 记忆。

`/memory view`、`/memory stats`、`/memory diagnose` 和 `/memory enqueue` 通过活动 Hindsight 状态工作。`/memory clear` 先排空待投递 retain，再只清除本地会话状态和 recall 缓存，**不会删除服务端 bank**；请用 Hindsight UI 或 API 删除。

## Mnemopi 本地后端

Mnemopi 是本地 SQLite 后端：working memory 随时间老化进入 episodic memory，抽取事实形成可 recall 的图谱，recall 在本地运行并可选 ONNX 嵌入。它不需要服务端。它提供 `recall`、`retain`、`reflect` 和 `memory_edit`；首轮 recall 存入会话，恢复会话不会重新查询或改变 prompt cache，并通过隐藏消息报告 recall 之后发生变化的记忆。作用域、排序和完整设置见 [Mnemopi 记忆后端](./mnemosyne-memory-backend.zh-CN.md)。

## Sharpshooter 后端

Sharpshooter 维护三个简短的项目决策文件——`architecture.md`、`product.md`、`style.md`——并注入系统提示。它不需要服务端；文件位于 `<agentDir>/memories/sharpshooter/<bank>/`，bank 由工作目录派生，因此每个项目有自己的决策。

```yaml
memory:
   backend: sharpshooter
sharpshooter:
   minPromptLength: 4
   intervalMinutes: 5
```

**抽取：** 主会话中的每条用户提示（跳过子 agent）都会交给抽取模型，把用户做出的持久决策——架构、产品、风格决策、约束、被否决方案和更正——记录为逐会话队列中的增量。斜杠命令和短于 `sharpshooter.minPromptLength` 字符的提示不会发送；一个会话同时只运行一次抽取，运行期间到达的提示不会被抽取。像“方案二”这样的短回复会结合前一条助手消息解析，但在默认 16 字符门槛下太短而不会发送——调低 `sharpshooter.minPromptLength` 可捕获它们。

**合并：** 调度器每分钟检查一次，距上次运行超过 `sharpshooter.intervalMinutes` 后，用一次模型调用把队列中的增量应用到三个文件并移除。`/memory enqueue` 立即合并；`/memory queue` 列出待处理增量，`/memory clear` 删除项目文件与队列。

| 设置                               | 默认值  | 说明                                                                                                                                                               |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory.backend`                   | `off`   | 设为 `sharpshooter` 启用此后端                                                                                                                                     |
| `sharpshooter.model`               | 未设置  | 抽取与合并的模型选择器；未设置时使用 `smol` 角色                                                                                                                   |
| `sharpshooter.minPromptLength`     | `16`    | 短于此字符数的提示不送去抽取；小于 `2` 按 `2` 处理。字符按显示计数（一个 CJK 字符或 emoji 算一个），各语言一致，中文用户可调低以捕获“用方案二”这类短回复 |
| `sharpshooter.intervalMinutes`     | `5`     | 两次合并之间的最小分钟数                                                                                                                                           |
| `sharpshooter.injectionTokenLimit` | `15000` | 注入系统提示的决策文件的近似 token 上限                                                                                                                           |

## 关键文件

- `packages/coding-agent/src/memories/index.ts`——流水线编排、注入、clear/enqueue 入口（`/memory` 命令经 `packages/coding-agent/src/memory-backend/local-backend.ts` 路由到此）
- `packages/coding-agent/src/memories/storage.ts`——SQLite 任务队列与 thread 注册表
- `packages/coding-agent/src/prompts/memories/`——记忆提示模板
- `packages/coding-agent/src/internal-urls/memory-protocol.ts`——`memory://` URL 处理器
