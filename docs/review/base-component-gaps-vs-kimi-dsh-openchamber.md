# 基础组件对比：会话管理 / 编排 / 记忆 / 工作流

> 工作文档，不是长期规格。结论稳定后，长期能力搬进对应 `docs/*.md` 或 ADR，本文再删除。
>
> 分析时间：2026-11-06。参考版本：kimi-code `df90d90ec`（2026-11-05）、dsh `fcc0ad4621`（2026-11-04）、openchamber `0137dc30`（2026-11-05）。
> 方法：逐仓读码 + 抽样复核；`路径:行` 为代码锚点，标注「推断」的条目没有直接代码证据。

---

## 0. 结论

**MusePi 不缺功能，缺的是三样底座：并发权威、持久执行、可检索投影。**

- **并发权威**：会话文件只做进程内串行，跨进程没有锁；`peekSessionInit` 的注释声称有 single-writer lock，代码里不存在（`packages/coding-agent/src/session/session-manager.ts:2762`）。CLI、daemon、多客户端同时打开同一会话时会互相覆盖。
- **持久执行**：后台 job、审批、异步结果全是内存态；进程重启后只能把在途 turn 封口成 `aborted`，不续跑。cron 错过只补一次，goal 只在 TUI 定时器里推进。
- **可检索投影**：`session.search` 是 `content LIKE '%q%'`，只覆盖 daemon 物化过的消息；工具调用、命令、文件编辑不可搜，命中无法定位到消息。

三家的长处正好对应这三块：

| 仓库 | 最值得学的一件事 |
| --- | --- |
| kimi-code | **跨进程会话租约 + turn 级 transcript 契约 + 压缩恢复指针** |
| dsh | **事件日志 + surface replace 的可审计压缩 + checkpoint 屏障 + session-query FTS** |
| openchamber | **上游权威 + 客户端修订号覆盖 + 游标分页 + 脚本化 workflow 的确定性重放** |

MusePi 在**记忆**上其实领先三家：kimi-code 与 dsh 都刻意不做长期记忆，openchamber 只有 context 文件；MusePi 有四个后端、抽取/整合流水线、租约与脱敏。问题不是“没有”，而是“不可检索、不可发现、无用户级、无冲突/过期”。

---

## 1. 会话管理

### 1.1 MusePi 现状

已完备：

- JSONL v3 + 双段迁移 + 坏行容忍；`id/parentId` 树；fork/resume/continue；导出/分享/删除；最近列表；非持久会话。
- 压缩是一等条目：`CompactionEntry{firstKeptEntryId}`，另有 `reset_boundary` 与 `BranchSummaryEntry` 三个正交边界（`session/session-entries.ts:99-141`）。
- 持久化工程度高：同步 append、原子重写、`commitGuard`、Windows EPERM 回退、`.bak` 恢复。

半成品 / 缺失：

| 项 | 档位 | 证据 |
| --- | --- | --- |
| 跨进程会话锁 | 缺失 | 全仓 `withFileLock` 未用于 session；`session-manager.ts:2762` 注释与实际不符 |
| leaf 指针落盘 | 半成品 | `branch()` 只改内存；注释自认重载即丢（`session-manager.ts:2512-2517`） |
| 会话归档 | 缺失 | `cli/sessions-cli.ts:16` 明写 “sessions are not archived today; reserved flag” |
| 列表分页 / 头部探测 | 缺失 | `session-listing.ts:634` 全量 glob + 内存排序；无游标、无“未变更即停” |
| 消息检索 | 缺失 | `daemon/view-store.ts:567` LIKE 全表扫；无 FTS、排序、snippet、过滤、分页 |
| 检索覆盖 | 缺失 | 只覆盖 daemon 物化过的会话；CLI/TUI 写的历史搜不到，无回填/重建入口 |
| 跨端 transcript 契约 | 半成品 | 有 journal seq + resync，但没有共享 op 词汇表与 turn 游标 |
| 压缩恢复指针 | 缺失 | 摘要不告诉模型原始日志在哪；snapcompact 有归档但不提供回读协议 |
| 副作用前持久化屏障 | 缺失 | 没有“工具调用已落盘才执行工具体”的 fail-closed 语义 |

### 1.2 三家怎么做

**kimi-code**

- 跨进程 `ISessionLockService`：`{version, token, pid, hostname, startedAt, clientIdentity, clientDisplayName}`，支持 `tryHold/takeover/lease`（`packages/agent-core-v2/src/persistence/interface/sessionLock.ts:13-45`）。
- `lifecycleChains` 按 sessionId 串行化、`pendingResumes` 幂等去重；fork 跨两个 id 时用排序后的多锁链避免死锁（`sessionManagerService.ts:187-247,362-380`）。
- fork 先 `tryAcquireQuiescence`/`tryAcquireHistorySnapshot`，再按 `turnIndex` 截 wire、剪 agent 子目录（`sessionLifecycleService.ts:607-720`）。
- transcript 独立成包：op 词汇表 + 纯 reducer + turn 游标（`packages/transcript/src/ops/operation.ts:18-90`、`pagination/paginate.ts:3-26`）。
- 压缩是“重建”：只保留用户原话 + handoff 摘要，摘要尾部附磁盘恢复指针（行号窗口 + grep 建议）。
- 搜索：minidb 倒排 + trigram，逐行消费 wire 增量建索引，带 `source: live|index` 与 `incomplete`。

**dsh**

- 会话是不可变事件日志 + 可重写投影面：`surfaceOp: {op:'replace',startSeq,endSeq}` 遮蔽旧节点，原始事件永存（`packages/core/session/src/surface.ts:104,363`）。
- `session-checkpoint-policy` 三道屏障：模型请求前、顶层工具体执行前、每个 `agent/pre-step` 前；失败 fail-closed（`packages/session/session-checkpoint-policy/README.md`）。
- `openTurnClosers()` 给未闭合 turn/step 补结束事件，给已记录无结果的工具调用补 `TOOL_OUTCOME_UNKNOWN`，要求“有副作用的先核验再重试”（`packages/core/session/src/repair.ts:18,53`）。
- `session-query` 是独立 seam：SQLite FTS5 + 血缘 + 事件窗口读（`packages/session-query/session-query-sqlite/src/schema.ts:127,226,265`）。
- 格式演进只增代际：`session.vN.jsonl`，已提交代际永不改写（`docs/architecture.md:124`）。

**openchamber**

- 不自己存会话：OpenCode 服务是唯一权威，openchamber 只做折叠、迁移、索引（`archive-store.js:1-14`、`session-metadata-store.js:1-22`）。
- 列表游标分页 + 头部探测：`PAGE_SIZE=500`，`refreshSessionHead` 20 条/页向后读，遇到已知记录即停。
- 修订号覆盖：本地写递增 `mutationRevision`，加载返回后用 `overlayMutationsSince` 把飞行中的本地变更盖回去（`useGlobalSessionsStore.ts:493-516`）。
- 归档、metadata 都是“每会话串行写链 + `decide(current)` 原子读改写”。
- 消息搜索是隔离的 SQLite 索引，turn 结束入队、后台回填、游标增量读。

### 1.3 该补什么

| 优先级 | 动作 | 规模 | 说明 |
| --- | --- | --- | --- |
| P0 | 跨进程会话锁 + 租约接管 | M | 参照 kimi `ISessionLockService`；至少覆盖 CLI/daemon/GUI 三入口 |
| P0 | 消息 FTS5 索引 + 回填 + 重建入口 | M | 复用 `file-index` 的 CJK bigram 样板；投影时把 toolCall/命令/结果扁平化进 content |
| P1 | leaf/branch 指针落盘 | S | header 加 `leafId`，或在 append 时写 branch marker |
| P1 | 列表游标 + 头部探测 + 归档 | M | 先做“首页 20 条 + 未变更即停”，再做 archive/restore |
| P1 | 压缩恢复指针 + origin 保留 + todo 重挂 | S | 低代码量，直接降低压缩后幻觉与重复劳动 |
| P1 | 工具前 checkpoint 屏障 | M | 至少在顶层工具执行前 flush；失败 fail-closed |
| P2 | 共享 transcript op 契约 | L | 为 IM/移动端/桌面统一；可与会话类型改造一起做 |
| P2 | 会话导入（Claude/Codex） | S | 参照 kimi `session-import`：压成一条 user message + 附件 |

---

## 2. 编排

### 2.1 MusePi 现状

已有：subagent + worktree 隔离、`AsyncJobManager`、cron、goals、advisor、plan-mode、ACP 审批、YieldQueue 回注。

缺口：

| 项 | 档位 | 证据 |
| --- | --- | --- |
| 持久 job / 结果 / 投递 | 缺失 | `async/job-manager.ts:239` 纯内存 Map；完成后 5 分钟回收 |
| 持久审批 | 缺失 | `daemon/approval-bridge.ts:113` 内存 Promise，无超时、无断连批量拒绝 |
| 背压语义 | 半成品 | 15 槽满时 `register()` 直接抛错，模型看到 “Failed to schedule” |
| 统一取消层级 | 缺失 | job manager / AgentRegistry / pauseGate / TaskTool 四处 signal |
| cron misfire | 缺失 | 错过 N 次只补 1 次；agent 不结束会永久占住任务 |
| goal 后台推进 | 缺失 | 只有 `interactive-mode.ts:1462` 的 UI 定时器；daemon/GUI 无等价物 |
| 跨 agent 任务板 / DAG | 缺失 | 只有单会话 `todo-tracker`；无 `blockedBy`、`writeScopes`、revision CAS |
| 子代理 provider 抽象 | 缺失 | 单执行器，无可插拔后端、capabilities、深度预算 |
| 沙箱策略 | 缺失 | 只有 plan-mode 写路径守卫；无 read-only/workspace-write/danger 三档 |

### 2.2 三家怎么做

**kimi-code**

- `AgentTaskService`：`running|completed|failed|timed_out|killed|lost`，支持 `detached`、超时自动转后台、输出落盘、`TaskOutput/WaitFor` 回收、终止通知（`agent/task/taskService.ts:216`）。
- `tower`：mission `{status, deps[], tasks[], scope[]}` + 18 种 merge block 原因 + worktree + `bashGuard`（`features/tower/protocol/missionGate.ts:31`、`bashGuard.ts:16`）。
- hooks：20 个事件、外部 shell 进程、可 block、`Stop` 可续跑一次（`features/externalHooks/internal/types.ts:3`）。
- cron：xstate + 持久事件 + 1s 轮询 + jitter + missed 合并 + 7 天 stale 清理。
- goal：token/turn/wallclock 三重预算 + deadline 调度器 + 超预算硬拒工具。

**dsh**

- `team` 任务板：`TeamTaskSnapshot{id,revision,subject,status,ownerId,blockedBy,writeScopes}`，全部 compare-and-set，变更追加 `team/task` 事件并 flush 确认（`packages/team/agent-team/src/types.ts:61-75`、`journal.ts:62-74`）。
- `schedule`：`after/at/every/daily/weekly/cron` + 时区 + 目标 `session/new_once/new` + receipt + `pendingDelivery` 断点（`packages/schedule/schedule/src/storage.ts:134`）。
- `jobs`：内存注册表 + 有界环形缓冲 + 结清后会话内 notice 投递；无 owner 才全局可见。
- `goal-round-driver`：无竞争 prompt 时排下一轮，受 `maxGoalRounds` 与 token 预算约束。
- `sandbox`：`read-only/workspace-write/danger-full-access`，per-execution 策略 + `allowed-once` 升级（`packages/sandbox/sandbox-policy/src/index.ts:60`）。
- `workflow`：模型写 JS，`agent/parallel/pipeline/phase/log` 六个全局函数，在 PTC 子进程 `node:vm` 跑；四道上限；返回值必须纯 JSON。

**openchamber**

- workflow run 是持久文件：`{script, args, state, attempt, agents[], logs[], result}`，状态 `awaiting-approval → running → completed|failed|stopped|declined`。
- 审批是持久状态，不是挂起调用：`workflow.run` 立即返回 runId 并落盘，刷新/多设备/主会话不阻塞都成立。
- 重放键：`callKey = sha256(prompt+options)` + 同参数调用次数；`resume` 从头重跑，命中键直接返回旧答案。沙箱里 `Math.random()/Date.now()` 主动抛错。
- 资源闸门：8 并发、200 agent/run；结构化输出走工具 `openchamber_workflow_answer`，错误当场返回让 agent 同轮修正。
- multi-run：成员身份写在 session metadata，`buildMultiRunIndex` 从活跃 root session 重建；Keep 时用 git ref 快照每个 lane。

### 2.3 该补什么

| 优先级 | 动作 | 规模 | 说明 |
| --- | --- | --- | --- |
| P0 | durable job/effect 表 | L | `(kind,key,value,seq,generation,attempts,due)`；先落库再执行，重启对账 |
| P0 | 审批持久化 + 超时 + 断连批量拒绝 | M | 可直接复制 `pause-sidecar` 的“内存权威 + 磁盘镜像” |
| P1 | 统一取消层级 | M | 一个 `CancelScope` 树，job/agent/tool 都挂上去 |
| P1 | cron misfire 策略 + 运行超时 + 总并发 | S | 明确 `skip/run-once/backfill` 三选一 |
| P1 | host 侧 goal driver | S | 把 TUI 定时器下沉到 daemon，GUI/TUI 共用 |
| P2 | 跨 agent 任务板 | L | 只在需要多 agent 并行时做；先借 dsh 的 revision CAS + blockedBy |
| P2 | 子代理 provider 抽象 | M | 想做外部 agent（Codex/Claude/ACP）时再加 |
| P2 | 沙箱三档 | M | 与权限系统合并，不要另起一套 |

---

## 3. 记忆

### 3.1 MusePi 现状

四个互斥后端 `off|local|hindsight|mnemopi`：

- `local`：启动期两阶段抽取/整合，SQLite 任务表 + 租约 + watermark，产出 `MEMORY.md`、`memory_summary.md`、`skills/`；注入预算 5000 token。
- `hindsight`：bank + retain/recall + mental models；retain 前剥离 `<memories>` 防反馈回路。
- `mnemopi`：working/episodic/fact 三表；`memory_edit` 支持 update/forget/invalidate。
- `autolearn`：`agent_end` 后捕获轮，产出 managed skills。

缺口：

| 项 | 档位 | 证据 |
| --- | --- | --- |
| `local` 不可检索 | 缺失 | `tools/memory-recall.ts:26-31` 只放行 hindsight/mnemopi |
| 生成的 `skills/` 是孤岛 | 缺失 | 技能发现不扫 `getMemoriesDir()`（`discovery/builtin.ts:290-350`） |
| 用户级长期记忆 | 缺失 | `local` 根由 cwd 决定（`memories/index.ts:1325`） |
| 去重/冲突/过期 | 缺失 | 仅 watermark + 逐字行去重；无 TTL/置信度/相似度 |
| 脱敏边界 | 半成品 | 8 条正则；私钥/自定义 token 会漏 |
| context files 无预算 | 缺失 | `project-context.md` 全量注入；memory 有预算，两者不合并 |
| 压缩后记忆重建 | 缺失 | 召回块被裁掉后不会按可见表层重建 |

### 3.2 三家怎么做

- **kimi-code：没有记忆系统**。`rg memory` 只命中进程内 transport 与 minidb WAL 压缩。记忆被拆给三件事：会话压缩（只留用户原话 + 摘要）、项目文件（AGENTS.md/SKILL.md）、服务端全文搜索（不回流模型）。
- **dsh：也没有记忆系统**，且文档明写“交付组合不包含任何记忆服务器”（`docs/user/guide/mcp-memory.md:31`）。它的“记忆”是 session log + 工作区文件 + 用户自带 MCP；AGENTS.md 以带 source 的 user message 进日志，压缩后靠“可见表层检测”重注入。
- **openchamber：没有长期记忆**，只有 `context.json`（notes/todos/plans）+ magic prompts + 项目上下文。

**结论**：三家都不做长期记忆，MusePi 不该为了“对齐”砍掉现有能力；该补的是记忆的**可检索性、可发现性、可治理性**。

### 3.3 该补什么

| 优先级 | 动作 | 规模 | 说明 |
| --- | --- | --- | --- |
| P1 | `local` 支持按 query 召回 | S | 复用 mnemopi 的 FTS/向量接口，或直接给 `MEMORY.md` 建 FTS5 |
| P1 | 生成 `skills/` 注册进技能发现 | S | 要么进 `discovery`，要么只保留 `MEMORY.md` 散文 |
| P1 | 用户级记忆 | M | 新增 `~/.musepi/agent/memory/user/`，与项目级并列注入 |
| P1 | 去重/冲突/过期 | M | 记忆条目加 `{sourceSession, createdAt, confidence, supersedes}`；同 key 新记录覆盖旧记录 |
| P1 | context files 预算与合并 | S | 与 memory 共享预算；超限按“用户级 > 项目级 > 更具体”裁剪 |
| P1 | 压缩后按可见表层重建召回块 | M | 借 dsh 的 surface digest 思路；没有就重注入 |
| P2 | 脱敏接入 secrets 检测 | S | 复用 `packages/secrets`，而不是只靠正则 |
| P2 | 记忆编辑 UI | M | 现在只能手改文件；至少提供 view/forget/rebuild |

---

## 4. 工作流

### 4.1 MusePi 现状

已有：预设继承与展开、skills、slash commands、30+ 扩展注册面、Cordis 插件、hooks、plan-mode、模板。

缺口：

| 项 | 档位 | 证据 |
| --- | --- | --- |
| 声明式 workflow | 缺失 | `modes/workflow.ts:20-43` 只是 `workflowz` 关键词 + 提示词；无 DAG/步骤/状态/重试/持久化 |
| 预设只能组合能力，不能组合流程 | 缺失 | `ModeDefinition` 无阶段/步骤概念 |
| 能力边界靠事后裁剪 | 半成品 | 工具盘先建后删（`sdk.ts:2526-2535`）；热切换非事务 |
| 三套扩展/事件面并存 | 半成品 | extensions / hooks / custom-tools + Cordis + legacy shim |
| 技能不是能力单元 | 缺失 | SKILL.md 无 tools/model/hooks 字段 |
| handoff 只有自然语言 | 缺失 | approved plan → 一段提示，无结构化 task list |
| 用户级 magic prompts | 缺失 | 只有代码级 registry |
| 多模型对照 run | 缺失 | 无 multi-run/fusion |

### 4.2 三家怎么做

- **kimi-code：刻意没有 workflow 引擎**。编排形态是 DI Feature 装配 + 事件溯源 + xstate；控制流由 LLM 决定。最接近引擎的是 `tower`（mission/tasks/deps/merge gate），但“下一步”仍由主 agent 决策。
- **dsh：有 workflow，但是“模型写 JS 脚本”**。`agent/parallel/pipeline/phase/log` 六个全局函数，PTC 子进程执行，四道上限，结果必须纯 JSON；`team` 提供共享任务板，`schedule` 提供持久投递。
- **openchamber：有真正的脚本化 workflow run**。脚本 + 沙箱 + 确定性重放键 + 持久审批 + 报告回注；`multi-run` 用 metadata 派生视图，`Keep` 用 git ref 保命。

**共识**：三家都不做“YAML/DAG 编译器”，而是让模型写脚本或直接调工具。可复用的是**运行时的确定性、持久化、审批与报告**，不是 DSL。

### 4.3 该补什么

| 优先级 | 动作 | 规模 | 说明 |
| --- | --- | --- | --- |
| P1 | 扩展面收敛 | M | 统一事件总线与优先级；明确 extensions/hooks/custom-tools 的职责边界 |
| P1 | 预设切换事务化 | M | 先构建新工具盘/提示，再原子替换；失败回滚 |
| P1 | handoff 结构化 | S | plan 输出 `{tasks[], files[], acceptance[]}`，子代理按结构执行 |
| P2 | 持久 workflow run | L | 脚本 + 重放键 + `awaiting-approval` + 报告回注；前置是 P0 的 durable effect |
| P2 | 技能能力单元 | M | SKILL.md 支持 `tools/model`；与 profile 共用能力集 |
| P2 | 用户级 magic prompts / project actions | S | 成本低，产品收益直接 |
| P2 | multi-run / fusion | M | 只在做模型对照时做 |

---

## 5. 横切可靠性

| 项 | MusePi | 建议 |
| --- | --- | --- |
| 崩溃恢复 | 封口成 `aborted`，不续跑；hard-kill 连封口都做不到 | P1：把 `session_exit` 改成“启动时对账”，不依赖 `process.on("exit")` |
| 持久副作用 | 只有消息队列 durable | P0：effect 表（见编排） |
| 幂等 | 靠“有输出就不重放”的保守否决 | P1：工具级 idempotency key |
| 多客户端 | journal seq + 两档 resync，较稳 | 保持；补 session metadata 的修订号覆盖 |
| 可观测性 | 仅 OTLP，无本地缓冲 | P2：本地 ring buffer，崩溃后可导出 |
| 硬杀 | `postmortem.ts:352` 依赖 `process.on("exit")` | P1：启动时扫描未闭合 turn |

---

## 6. 建议路线

**Sprint 1（2 周，P0，修底座）**

1. 会话跨进程锁 + 租约接管。
2. 消息 FTS5 索引 + 回填/重建入口（复用 `file-index` 的 CJK 样板）。
3. durable effect 表 + 审批持久化（先覆盖 approval/job 两类）。
4. 压缩恢复指针 + origin 保留 + todo 重挂。

**Sprint 2（2–3 周，P1，补体验）**

5. leaf 落盘、列表游标/头部探测、归档。
6. 统一取消层级、审批超时、启动对账替代 `process.on("exit")`。
7. cron misfire、host 侧 goal driver。
8. 记忆可检索、生成 skills 注册、用户级记忆、context 预算。
9. 扩展面收敛、预设事务化、结构化 handoff。

**Sprint 3（按需，P2，扩能力）**

10. 持久 workflow run（脚本 + 重放键 + 审批 + 报告）。
11. 多 agent 任务板 / DAG / 沙箱三档。
12. 多模型对照、会话导入、project actions。

---

## 7. 明确不补 / 不照搬

- **不补**：独立长期记忆的“无记忆”路线（kimi/dsh 是单会话 IDE 假设，MusePi 已有更重的记忆系统，砍掉是倒退）。
- **不补**：YAML/DAG workflow 编译器。三家都用“模型写脚本/调工具”，编译器成本高、模型不会用。
- **不照搬**：kimi 每会话一目录 + 每 agent 一文件的碎片化；dsh 20+ 包与多代际迁移的体量；openchamber 500 条/页的全量列表。
- **不照搬**：kimi `explore` 的“只读”只改 prompt（假只读）；dsh 单进程锁在多客户端场景不够；openchamber 把归档判定下放客户端。

---

## 附录：关键锚点

**MusePi**

- `packages/coding-agent/src/session/session-manager.ts:2512-2517` — leaf 不落盘
- `packages/coding-agent/src/session/session-manager.ts:2762` — 注释声称有 single-writer lock
- `packages/coding-agent/src/daemon/view-store.ts:567` — LIKE 搜索
- `packages/coding-agent/src/async/job-manager.ts:239` — 内存 job Map
- `packages/coding-agent/src/daemon/approval-bridge.ts:113` — 内存审批 Promise
- `packages/coding-agent/src/modes/workflow.ts:20-43` — workflowz 关键词
- `packages/coding-agent/src/memories/index.ts:225` — 记忆注入预算
- `packages/coding-agent/src/tools/memory-recall.ts:26-31` — local 不可召回

**kimi-code**

- `packages/agent-core-v2/src/persistence/interface/sessionLock.ts:13-45` — 会话租约
- `.../sessionLifecycle/sessionLifecycleService.ts:607-720` — fork 静默/截断
- `packages/transcript/src/ops/operation.ts:18-90` — op 契约
- `packages/kap-server/src/search/indexCore.ts:34-38` — 倒排 + trigram
- `.../agent/task/taskService.ts:216` — 后台任务状态机
- `.../features/tower/protocol/missionGate.ts:31` — 18 种 merge block
- `.../agent/fullCompaction/context-recovery-footer.md:1` — 恢复指针

**dsh**

- `packages/core/session/src/surface.ts:104,363` — surface replace + 完整性校验
- `packages/session/session-checkpoint-policy/README.md` — 三道 checkpoint 屏障
- `packages/core/session/src/repair.ts:18,53` — 崩溃尾部闭合
- `packages/session-query/session-query-sqlite/src/schema.ts:127` — FTS5
- `packages/team/agent-team/src/types.ts:61-75` — 任务板 CAS
- `packages/schedule/schedule/src/storage.ts:134` — 持久调度
- `packages/sandbox/sandbox-policy/src/index.ts:60` — 三档沙箱

**openchamber**

- `packages/ui/src/stores/useGlobalSessionsStore.ts:493-516` — 修订号覆盖
- `packages/ui/src/stores/globalSessions.ts:51-122` — 游标分页
- `packages/web/server/lib/workflows/runtime.js:17` — run 生命周期与上限
- `packages/web/server/lib/workflows/store.js:40` — run/agent schema
- `packages/web/server/lib/workflows/sandbox.js:6` — VM 沙箱与 prelude
- `packages/ui/src/lib/multirun/identity.ts:39` — multi-run 元数据
- `packages/web/server/lib/message-search/indexer.js:1-22` — 后台搜索索引
