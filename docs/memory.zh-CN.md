[English](memory.md) | 中文

当本地记忆后端启用时，agent 会自动从过往会话中提取持久化知识，并在同项目后续会话开始时注入一份紧凑摘要。随着时间推移，它会构建一个项目级记忆库——技术决策、 recurring workflows、踩坑记录——无需人工维护即可持续传承。

当本地记忆后端启用时，agent 会自动从过往会话中提取持久化知识，并在同项目后续会话开始时注入一份紧凑摘要。随着时间推移，它会构建一个项目级记忆库——技术决策、 recurring workflows、踩坑记录——无需人工维护即可持续传承。

默认禁用。通过 `/settings` 或 `config.yml` 启用本地摘要流水线：

```yaml
memory:
  backend: local
```

## 使用方式

### 注入内容

会话启动时，如果当前项目存在记忆摘要，它会被注入到系统提示中，作为 **记忆引导** 块。agent 被指示：

- 把记忆视为启发式上下文——对流程和既往决策有用，但对当前 repo 状态不具权威性。
- 当记忆改变计划时，要引用记忆产物路径，并在行动前与当前 repo 证据配对。
- 当记忆与 repo 状态或用户指令冲突时，优先相信后者，并把冲突记忆视为过期内容。

### 读取记忆产物

agent 可以直接用 `read` 工具读取 `memory://` URL 形式的记忆文件：

| URL | 内容 |
|---|---|
| `memory://root` | 启动时注入的紧凑摘要 |
| `memory://root/MEMORY.md` | 完整长期记忆文档 |
| `memory://root/skills/<name>/SKILL.md` | 生成的技能 playbook |

### `/memory` 斜杠命令

| 子命令 | 效果 |
|---|---|
| `view` | 显示当前后端注入载荷 |
| `stats` | 显示后端专用记忆统计（若支持） |
| `diagnose` | 显示后端专用诊断信息（若支持） |
| `clear` / `reset` | 删除活跃后端记忆数据/产物 |
| `enqueue` / `rebuild` | 强制活跃后端执行整理/保留工作 |

## 工作原理

本地摘要记忆由启动时的后台流水线构建；`/memory enqueue` 标记整理工作，由下次启动拾取。该流水线对子代理和不持久化到会话文件的会话跳过。

**第一阶段——逐会话提取：** 对每个自上次处理后发生变更的过往会话，模型读取会话历史并提取持久信号：技术决策、约束、已解决故障、recurring workflows。过于新、过于旧、当前活跃或超出配置扫描/年龄限制的会话会被跳过。每次提取产出该会话的原始记忆块和简短概要。

**第二阶段——整合：** 提取完成后，第二遍模型读取所有逐会话提取结果，产出三个写入磁盘的输出：

- `MEMORY.md` — 一份精选的长期记忆文档
- `memory_summary.md` — 会话启动时注入的紧凑文本
- `skills/` — 可复用的程序性 playbook，每个在其自己的子目录中

阶段 2 使用租约和心跳，防止多进程同时启动时重复运行。来自先前运行的陈旧技能目录会被自动清理。

整合输出在写入 `MEMORY.md`、`memory_summary.md` 或生成的技能之前，会先对常见 secret/token 模式做脱敏处理。

### 提取行为

记忆提取和整合行为由 `packages/coding-agent/src/prompts/memories/` 下的静态提示文件驱动。

| 文件 | 用途 | 变量 |
|---|---|---|
| `stage_one_system.md` | 逐会话提取的系统提示 | — |
| `stage_one_input.md` | 包装会话内容的用户轮次模板 | `{{thread_id}}`、`{{response_items_json}}` |
| `consolidation_system.md` | 跨会话整合的系统提示 | — |
| `consolidation.md` | 跨会话整合的用户轮次提示 | `{{raw_memories}}`、`{{rollout_summaries}}` |
| `read-path.md` | 注入活跃会话的记忆引导 | `{{memory_summary}}`、`{{learned}}` |

### 模型选择

记忆复用在模型角色系统之上。

| 阶段 | 角色 | 用途 |
|---|---|---|
| 阶段 1（提取） | `default` | 逐会话知识提取 |
| 阶段 2（整合） | `smol`（回退到 `default`，再回退到当前/注册表中首个模型） | 跨会话综合 |

如果请求的记忆角色未配置，记忆模型解析会回退到 `default` 角色，然后是活跃会话模型，再是注册表中的第一个模型。

## 配置

| 设置 | 默认值 | 描述 |
|---|---|---|
| `memory.backend` | `off` | 选择 `local` 以启用此流水线；未显式设置 backend 时，遗留的 `memories.enabled: true` 会迁移为 `memory.backend: local` |
| `memories.maxRolloutAgeDays` | `30` | 早于此天数的会话不会被处理 |
| `memories.minRolloutIdleHours` | `12` | 活跃时间晚于此小时数的会话会被跳过 |
| `memories.maxRolloutsPerStartup` | `64` | 单次启动中处理会话的上限 |
| `memories.threadScanLimit` | `300` | 启动时扫描的最近会话记录上限 |
| `memories.maxRawMemoriesForGlobal` | `200` | 提供给全局整合的逐会话提取上限 |
| `memories.stage1Concurrency` | `8` | 逐会话提取并发数 |
| `memories.stage1LeaseSeconds` | `120` | 提取任务租约时长 |
| `memories.stage1RetryDelaySeconds` | `120` | 失败的提取可被重新认领前的延迟 |
| `memories.phase2LeaseSeconds` | `180` | 整合租约时长 |
| `memories.phase2RetryDelaySeconds` | `180` | 失败的整合重试延迟 |
| `memories.phase2HeartbeatSeconds` | `30` | 整合租约心跳间隔 |
| `memories.rolloutPayloadPercent` | `0.7` | rollout 载荷可用模型上下文窗口的占比 |
| `memories.phase1InputTokenLimit` | `4000` | 逐会话提取的输入上限 |
| `memories.fallbackTokenLimit` | `16000` | 模型无有限上下文窗口声明时使用的 token 预算 |
| `memories.summaryInjectionTokenLimit` | `5000` | 注入系统提示的摘要与经验教训的共享近似 token 上限 |

## Hindsight 远程后端

Hindsight 需要一个可达的 [Hindsight](https://hindsight.vectorize.io/) 服务器。默认端点为 `http://localhost:8888`；服务器需要认证时设置 token：

```yaml
memory:
  backend: hindsight
hindsight:
  apiUrl: http://localhost:8888
  apiToken: ${HINDSIGHT_API_TOKEN}
```

`HINDSIGHT_*` 环境变量会覆盖 `hindsight.*` 设置，后者再覆盖内置默认值。所有 18 个受支持的覆盖项、接受值、解析规则、优先级和默认值，见 [完整 Hindsight 环境变量表](./environment-variables.html#hindsight-memory-backend)。

默认情况下，Hindsight 使用 `per-project-tagged` 作用域：写入走带项目标签的共享库，召回包含带项目标签和无标签的全局记忆。`per-project` 将每个工作目录项目隔离到自己的库；`global` 使用一个共享库。显式 `hindsight.bankId` 选择库基础。变更库 ID、前缀或作用域会重建主会话状态，使后续操作使用新作用域。

两种项目级作用域的项目命名方式相同：取 repository 的主 checkout 根目录（因此一个仓库的所有 linked worktree 解析到同一个目录），然后将其 basename 转小写。位于 `~/code/General` 的 checkout 因此会标记为 `project:general`。标签按字面量匹配，因此这个折叠确保一个仓库无论路径大小写如何都保持在同一个记忆作用域内。

主会话在第一个模型轮次时召回（`hindsight.autoRecall: true`），并默认每隔三个用户轮次自动保留已完成的对话轮次。`/memory enqueue` 刷新排队的 tool retain 并强制保留当前会话。agent 结束时，主状态按节奏安排保留并刷新保留队列；会话释放前排空该队列。请求失败和配置超时会被记录，且不会使会话不可用。子代理复用父级的 client、bank 和 scope，用于显式的 `recall`、`retain` 和 `reflect` 调用，但不运行自己的自动召回或保留。

召回作为后台上下文注入，而非指令，且召回的记忆在压缩期间也可用作额外上下文。选择 Hindsight 会暴露 `recall`、`retain` 和 `reflect`；`memory_edit` 不可用，因为上游 Hindsight 记忆不通过此后端编辑。
高级用法还有更多调优参数（并发、租约时长、token 预算）可在 config 中配置。

## 关键文件

- `packages/coding-agent/src/memories/index.ts` — 流水线编排、注入、clear/enqueue 入口（`/memory` 命令通过 `packages/coding-agent/src/memory-backend/local-backend.ts` 路由到这里）
- `packages/coding-agent/src/memories/storage.ts` — SQLite 支持的任务队列和线程注册表
- `packages/coding-agent/src/prompts/memories/` — 记忆提示模板
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — `memory://` URL 处理器
