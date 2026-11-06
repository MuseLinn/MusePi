# 个人助理会话与多设备编排：参考实现与 MusePi 落地路径

> 工作文档，不是长期规格。结论稳定后，长期能力搬进 `docs/mobile-design.md`、`docs/extensions-dev.md`、`docs/capability-seams.md` 或 ADR，本文再删除。
>
> 分析时间：2026-11-05。参考版本：comma `66ab3dc`、bitfun `c4f0be956`（2026-11-05）、dsh-superagent-prototype `8c32a9d`（上游 force-push 后已重置）。
> 方法：读码 + 抽样复核；`路径:行` 为代码锚点，标注「推断」的条目没有直接代码证据。

---

## 0. 一页结论

1. **comma 不需要云厂商，但需要一台常在线的主机。** 根 `compose.yaml` 是完整单节点产品；默认只绑回环，局域网可用，公网才需要反代、域名与真实 SMTP。真正缺席的是 Cloudflare 云电脑、会议和 Agent VMM，不是主会话/多设备能力。
2. **comma 的“多设备同一主会话”不是同步做得好，而是只有一条会话。** 每个 Group 固定一条 Router Conversation，所有端解析到同一个 `conversation_id`；同步只是“失效提示 + 按 id 重读”，不是增量日志。
3. **dsh-superagent 的价值是把“授权/去向”从 Session 里拆出来。** 长期主 Session 只做评估与路由；每个 Ticket 有不可变 Mandate，执行由独立 Assignment + Worker Session 承担，人可以靠订阅的消息复活旧 Ticket。
4. **bitfun 的价值是把“个人助理”做成一种工作区，而不是新实体。** `WorkspaceKind.Assistant` + `assistantId` + persona 文件 + 主助理指针，复用同一套会话/存储/导航；定时任务按工作区而不是按会话归属。
5. **MusePi 的零件比预期多，缺的是三样地基**：会话类型/归属键、显式的 AgentProfile（提示 + 工具 + 记忆 + 通道）、以及 daemon 侧的持久任务/效果队列。
6. **建议顺序**：先把 `SessionKind + ownerKey + AgentProfile + ChannelContract v2` 做出来（接口与插件地基），再做个人助理会话 MVP，最后才做 Ticket/多设备编排。不要先造第二套 agent loop。

---

## 1. comma 是否需要云服务器

### 1.1 三档结论

| 档位 | 能否 | 需要什么 | 缺什么 |
| --- | --- | --- | --- |
| 纯局域网 | 可以 | Docker + `cp .env.example .env` + `docker compose up -d --build`；`COMMA_PUBLIC_URL` 保持 localhost，或内网 HTTPS | 登录码只能从 Mailpit `:8025` 读 |
| 公网 | 可以 | 自备 HTTPS 反代；Web/Admin/API/Salix 四个子域同站；真实 SMTP；`COMMA_OWNER_EMAIL` | 域名变更要重新 build web 镜像；SSE 要关反代缓冲 |
| 完整体验 | 不完整 | 额外 Cloudflare 账号、会议运行时、Agent VMM 镜像 | 仓库不含 `meetnative` 与 ARM VMM；`sites_domain` 与 `transfer.advertise_host` 默认值在公网会失效 |

### 1.2 单机 compose 实际起了什么

`compose.yaml` 共 10 个服务，其中 3 个是一次性任务：

- 一次性：`configure`（生成密钥/config）、`buckets`（建 MinIO bucket）、`migrate`。
- 常驻：`comma`（Salix + Product + Billing + BFT，4000）、`web`（Caddy + Web/Admin，8080/8081/8082）、`postgres`、`redis`、`minio`、`clickhouse`、`mailpit`。
- 默认暴露面：`127.0.0.1:4000`、`127.0.0.1:8080/8081/8082`、`127.0.0.1:8025`；其余只在 compose 内网（`compose.yaml:125,149,170-172`）。

启动链是“配置即启动条件”：`configure` 校验失败会 `SystemExit`，Postgres/MinIO 以 `service_completed_successfully` 依赖它（`compose.yaml:46-48,83-85`）。公网的四条硬校验在 `selfhost/configure.py:26-46`：必须 HTTPS、四个源站互不相同且同可注册域、SMTP 不能是 Mailpit、owner 邮箱或显式开放注册。

### 1.3 资源与边界

- 官方没有给最低 CPU/RAM（未确认）。可推断的压力点：单容器内跑 BEAM 全子系统 + spinfoam 后台循环，外加 Postgres/Redis/MinIO/ClickHouse 四套状态服务；首次构建要拉 Lean/Elixir/Go/Rust/Node 工具链。实践建议（推断）：≥4 vCPU / 8–16 GB RAM，构建期 ≥30–40 GB 磁盘。
- 自托管把计费替换成 `selfhost:unlimited:v1` 授权（`systems/apps/comma_core/lib/comma/workspaces.ex` 附近），不需要 Stripe。
- 许可为 AGPL-3.0，Web 镜像强制内嵌 `/source.tar.gz`（`selfhost/Web.Dockerfile:10-12`）。做商业产品时应复用架构，不要复制代码。

### 1.4 对你“个人 agent”计划的意义

你体验到的“所有设备同一主会话 + 不同设备上的 task + Tailscale 调设备”，**不依赖 comma 的云**，依赖的是四件事：

1. 一台常在线的主机持有 canonical 会话与设备注册表。
2. 设备主动出站长连（comma 是 gRPC 隧道），所以设备侧不需要公网入站。
3. 主会话与 Task 是平行 Conversation，Task 的执行位置在创建时定格。
4. 服务端按 Group 运行 Tailscale 节点，客户端完全不装 VPN。

这四件事都可以在家庭 NAS / 迷你主机上复现。手机单独当 hub 不行：手机会休眠、会被杀后台，无法承担 canonical 存储与常在线设备注册。

---

## 2. comma 的产品模型：为什么体验好

### 2.1 一条 canonical 会话，多端只是投影

- 每个 Group 恰好一条固定 Router Conversation（`docs/architecture/PRODUCT_MODEL.md:128`）。Web/Electron/iOS/Watch/SSH/TUI 都解析到同一 `conversation_id`。
- canonical 历史只在服务端；客户端是投影，本地只保留有限窗口（`clients/packages/core/src/chat/persist.ts:1-12,309`）。
- SSE 首帧是 `resync_required` + `version`，服务端明确不暴露序列号或持久游标（`systems/apps/comma_core/lib/comma/conversations.ex:1010-1018`）。客户端把 version 当提示，帧对不上就重启流。
- 读失败就关闭流，强制下次 resync（`systems/apps/salix_web/lib/salix_web/conversation_sse.ex:78-88`）。

**设计取舍**：用“重连即全量”换掉多端合并与重放日志。代价是断线期间只能靠重读找回，收益是永远不会出现“两端各自合并出不同历史”。

### 2.2 Task 是平行 Conversation，不是子会话

- 主会话委派 → `agent_task` Conversation → Worker 执行；`Conversation.status` 是唯一生命周期权威（`docs/architecture/DOMAIN_CONCEPTS.md:617-630`）。
- 执行位置由 `runs_on` / Worker 的 `station_binding` / Group 默认依次裁决（`systems/apps/salix_im/lib/salix_im/task_placement.ex:1-30`）；位置写入创建回执，重试不换机。
- 正文与 Session 留在被选中的 Station，云端只留摘要索引（`systems/station/docs/tasks.md:4-8`）。
- 设备侧任务用 `epoch + rev` 增量上行，Salix 只存“已收到到哪”，错代/跳号整页作废（`systems/apps/salix_store/lib/salix_store/station_task_index.ex:1-19`）。

### 2.3 未读与通知不是设备状态

- 读位是 Workspace 单行 `read_seq/read_count`，按 canonical message_id ACK；`unread_count` 由投影算出（`systems/apps/comma_core/lib/comma/router_notifications.ex:79,284,345`）。
- 推送按 Auth Session 一槽位，payload 只带 ID，前台呈现前再校验权限（`docs/clients.md`、`systems/apps/comma_core/lib/comma/notifications.ex:18,213`）。

### 2.4 设备调用：一条工具，多种传输

- Agent 先从 `device.list` 或 `tailnet.peers` 取 `device_id`/MagicDNS 名，再在 `ssh.open` 里传 `via_device_id`（经局域网 gateway）或 `via_tailnet: true`（经 Group 的 tsnet 节点）（`systems/apps/salix_agent/lib/salix_agent/tools/ssh.ex:52,62-71,257-271`）。
- 身份是 Group 级：全 Group 一把 SSH key；一个 Group 在一个 tailnet 最多一个 tsnet 节点，由 tailnet 管理员一次性批准（`systems/apps/salix_agent/lib/salix_agent/tailnet.ex:7-13`）。
- 在线状态来自 connector 注册表，不主动探测；心跳 15 s，45 s 无心跳断开（`systems/apps/salix_web/lib/salix_web/env_dispatch.ex:150-167`）。
- 失败码即产品体验：离线、不存在、权限不足、目标不在 netmap 各有独立错误码和给模型的操作建议（`docs/compute-devices.md:190-198`）。

**可借用**：显式设备身份、能力广告、注册表即在线真相、一条工具多种传输、错误码带下一步。**不要借用**：Group 级共享 SSH key（无法区分成员）、一个节点覆盖全 Group 的爆炸半径。

---

## 3. dsh-superagent：把授权与执行拆开

### 3.1 领域流转

```
Source → Trigger → Thread → Eval → Decision + Mandate → Ticket → Assignment → Executor
                                                    ↘ Subscription（线程订阅，扇出/复活）
```

- **Source**：事件流，持有读位置与自己的 bot 身份，负责过滤与翻译成 Thread。
- **Thread**：时间有序的 Trigger 集合；同一时刻最多一个 Eval；持有 Subscription。
- **Eval**：gate（确定性策略）+ assessment（模型）；产出 accept/stop/ignore/unavailable。
- **Mandate**：accept 时写入的不可变授权（Policy 版本、范围、强度、匹配规则、发送者身份）。只有人 stop 能撤回；Policy 变更只通知，不撤销。
- **Ticket**：授权的工作单元；open ↔ ended；人消息经订阅复活时复用原 Mandate。
- **Assignment**：一次执行尝试；Ticket 可以有多次；Executor 在领域之外。
- **Subscription**：Ticket ↔ Thread 多对多；命中线程的每个订阅 Ticket 都收到；`ended` 只被“人消息且非人 stop”唤醒；context 订阅只送上下文不授权。

### 3.2 长期主 Session 与短命执行如何解耦

- 主 Session 只拿 `candidate/decide/attach/reply/note/requestStatus` 这些能力（`src/core/engine.ts:263`），工具被限制到 `skill/bash/read/read_image/job_*`，并禁 `sleep`/长等待（`src/app/sessions.ts:255-264`）。
- Worker 是 `worker-<ticketId>` 的持久 Session + 一 Ticket 一目录；Ticket 结束后 Session 还在，但工具被 guard 拒绝（`src/app/sessions.ts:289-296`）。
- `retry`/`restart` 只是“结束旧 Assignment、开新 Assignment”，Session、目录、分支、Mandate 全部沿用（`src/core/tickets.ts:168-180,318-327`）。
- 人对旧工作的追问不重新评估：`wake()` 删 `ended`、开新 Assignment、复用原 Mandate（`src/core/tickets.ts:252-270`）。

### 3.3 可靠性设计

- Engine 每个公开方法一个事务（`src/core/engine.ts:48,100,239`）。
- 跨进程副作用先写 `effect` 表、提交后执行；`(kind,key)` upsert，`seq+generation` 防旧结果覆盖新 payload（`src/app/effects.ts:61-66,130-146`）。
- 重启只对账“运行中/待启动”，不重放日志（`src/executor/dsh.ts:524-537`）。
- 三级幂等：Trigger id、Input id、副作用 `(kind,key)`。
- 失败分三层：passing failure 重试 3 次；prepare 失败立即 failed 且不自动重试；blocked/failed 只冻结自动输入，保留人工通道（`src/executor/dsh.ts:30,281-283,548-553`、`src/core/tickets.ts:238`）。

### 3.4 注意力协议（最值得抄的部分）

- 只在被请求或有书面规则时动手；只在“人要行动/能用结果”时说话；一次只问一个具体问题（`docs/000-philosophy.md:5-13`）。
- 三条出口：`result`（可评审）、`attention`（必须决策）、`answer`（回答原问题）；其余一律内部 `progress`。发送前由 `purpose` 闸门校验（`src/core/replies.ts:69-82`）。
- 问题是带 ID 的一等实体：同问复用、换问撤回、解决显式清除（`src/core/assignments.ts:114-121`）。
- 问题回到“提问者所在会话”，不是回到工单原始会话（`prompts/handoff-worker.md:1`）。
- 默认静默：模糊意图、纯偏好、设计争论一律静默，等后续消息自证（`prompts/admission.md:23,52`）。
- 不做传话压缩：主 Session 提取事实后重写，不逐点转述 worker 报告（`prompts/replies.md:31-33`）。

### 3.5 不要照搬

- 单租户、单仓库、单 stateDir 锁；60 s 轮询、评估 120 s 超时；tmux 常驻 + 另一个 profile 巡检；worker 与宿主同用户、`danger-full-access`；无删除/归档。它是研究原型，不是生产件（`README.md:3`）。

---

## 4. bitfun：助理是一种工作区

### 4.1 模型

- `WorkspaceKind = Normal | Assistant | Remote`（`src/web-ui/src/shared/types/global-state.ts:62-66`）。
- 助理复用工作区结构：`assistantId` 区分内置/具名，`identity`（name/creature/vibe/avatar/emoji）做展示。
- 目录即身份：内置助理 `~/.openbitfun/personal_assistant/workspace`，具名 `workspace-<id>`（`src/crates/assembly/core/src/infrastructure/app_paths/path_manager.rs:143-168`）。
- 人格即文件：`BOOTSTRAP.md` / `SOUL.md` / `USER.md` / `IDENTITY.md`（`src/crates/assembly/core/src/service/bootstrap/bootstrap_impl.rs:5-19`）；`IDENTITY.md` 的 name 覆盖一切，文件监听 350 ms 防抖后刷新名称/头像并广播。
- 主助理是语义键 `PrimaryAssistantKey{BuiltIn | Named{assistant_id}}`，不是 id 指针（`src/crates/services/services-core/src/workspace_records.rs:40-68`），目录迁移/记录重建后仍可解析。

### 4.2 会话归属

- `create_session` 以 `workspaceId` 为权威归属，`workspacePath` 只是 IO 投影（`src/web-ui/src/app/utils/projectSessionWorkspace.ts:53-66`）。
- 项目会话（Code/Cowork）只属于非 Assistant 工作区；助理走 `Claw` agent 类型和自己的存储（`projectSessionWorkspace.ts:18-26`）。
- 后端按目录分区：`~/.openbitfun/projects/<24-hex>/sessions/`（`path_manager.rs:608-610`），`list_sessions(workspace_path)` 只接受一个工作区。
- 切换工作区不丢会话：会话集是全局 `sessionId` 字典，切换只改 `currentWorkspace` 并刷新列表；打开别的工作区的会话时先激活其归属工作区再 hydrate（`sessionActivation.ts:57-69`）。
- 移动端把 recent workspaces + assistants 合并成一份 catalog，助理行插在项目前（`src/mobile-web/src/services/workspaceIdentity.ts:10-25`）。

### 4.3 定时任务

- `CronWorkspaceRef` + target 二分：`session`（续某会话）vs `workspace`（在工作区起新会话，带 `agentType/model`）（`src/crates/.../cron/types.rs:79-126`）。
- 助理侧强制 `workspace` + `Claw`，使定时任务不依赖某个会话存活。

### 4.4 删除与修复

- 必须 `Assistant` kind；主助理拒删；路径不在受管根且目录仍存在则拒删；目录已消失降级为只删记录（`src/apps/desktop/src/api/commands.rs:1662-1704`）。
- 主助理切换先写库、失败回滚旧键；身份文件读取失败只 warn 不改记录。

### 4.5 可借用与边界

**借用**：kind + 语义键建模、人格即文件、命名账本、文件监听刷新、cron 按工作区、主助理指针、移动端助理优先。**注意**：bitfun 的助理仍是“同一个 session runtime + persona + 定时任务”，没有 Ticket/订阅/授权层；它给的是产品外壳，不是编排内核。

---

## 5. 三者怎么组合

| 层 | comma | dsh-superagent | bitfun | MusePi 目标 |
| --- | --- | --- | --- | --- |
| 通道/入口 | Web/Electron/iOS/Watch/SSH/TUI | Feishu/GitHub Source | 桌面/移动/CLI | IM channels + 桌面 + 移动 |
| 长期会话 | 固定 Router Conversation | Main Session（路由器） | Assistant workspace | Assistant Session |
| 授权 | 产品租约 + 会话作用域 | Mandate + Policy gate | 工作区/会话归属 | `AgentProfile` + 任务授权 |
| 任务 | 平行 agent_task Conversation | Ticket + Assignment | 子会话/定时任务 | Task + Assignment（后续） |
| 执行 | Salix Worker / Station | DSH Worker Session | Claw session | 现有 coding session/subagent |
| 多设备 | 出站隧道 + 设备注册表 | 单机 | 远程工作区 | 现有 collab + 后续 relay |
| 记忆 | 服务端 canonical + 读位 | 无（宿主负责） | persona 文件 | hindsight + persona 文件 |
| 注意力 | 推送只带 ID，前台复检 | purpose 闸门 + 问题实体 | 无显式模型 | 可移植 purpose/attention |

组合建议：**用 bitfun 的产品外壳（工作区 kind + persona）包住 dsh 的编排内核（Mandate/Ticket/Subscription），用 comma 的多端契约（单 canonical + 失效重读 + 读位）做跨设备。**

---

## 6. MusePi 现状：零件与缺口

### 6.1 已有零件

| 零件 | 位置 | 现状 |
| --- | --- | --- |
| 会话 | `packages/coding-agent/src/session/*` | 单一 `kind:"session"`，靠 `modeId` 区分预设 |
| 预设 | `packages/coding-agent/src/presets/resolve.ts` | `chat` 已能表达非编码会话：`promptComplete` + `extensions: []` + `tools.disabled` + 关压缩 |
| 子智能体 | `packages/coding-agent/src/task/*` | `AgentDefinition` 自带 systemPrompt/tools/model |
| 插件 | `packages/coding-agent/src/extensibility/*` | 21 个 `register*` 面，含 `registerMode`、`registerTool`、`registerChannel` |
| IM 通道 | `packages/coding-agent/src/channels/*` | 微信/飞书/Telegram/Discord/华为；每窗口一绑定；首条消息自动建会话 |
| 通道插件 | `packages/coding-agent/src/channels/plugins.ts` | `~/.musepi/agent/channels/*.ts` 热插拔 |
| Advisor | `packages/coding-agent/src/advisor/*` | 同会话旁路第二 Agent，独立模型/工具会话 |
| Goals | `packages/coding-agent/src/goals/*` | 会话内单目标状态机 |
| 长期记忆 | `packages/coding-agent/src/hindsight/*` | bank + retain/recall + mental models；recall 每会话一次 |
| 后台任务 | `packages/coding-agent/src/async/job-manager.ts` | 已有 job 管理，但无持久效果队列 |

### 6.2 缺口

| 优先级 | 缺口 | 证据 | 影响 |
| --- | --- | --- | --- |
| P0 | 没有会话类型：`session.list` 的 `kind` 恒为 `"session"` | `packages/coding-agent/src/daemon/server.ts:2034` | 侧栏无法分组；IM 无法区分助理/项目 |
| P0 | 没有归属键：会话只按全局目录存，项目靠 cwd 反查 | `packages/utils/src/dirs.ts:844-846`；`packages/wire/src/index.ts:893-907` | 助理/项目/设备无法稳定归属；移动端只能按目录猜 |
| P0 | 通道建会话不传类型 | `packages/coding-agent/src/channels/handler.ts:4-8` | IM 进来的永远是默认编码预设 |
| P0 | 无审批/提问桥：通道内无 `approval`/`ask` 引用 | `channels/` 全目录 | IM 里触发审批会静默卡住 |
| P0 | 出站附件是死代码 | `ChannelSendPayload` 有 images/files，daemon 三处 `send` 只传 text（`server.ts:1090,1189,1320`） | 截图/文档交付不了 |
| P1 | `/stop` 关闭整会话而非中止当前轮；`unbindSession` 无调用点 | `server.ts:1079`；`handler.ts:159` | 用户觉得“停不掉” |
| P1 | 无 owner 白名单/配对；同群成员共享会话 | `channels/` 无 allowlist | 任何人可驱动本机会话 |
| P1 | 无入站队列/去重/幂等；绑定在 `await startSession` 后才写 | `handler.ts:204-205` | 并发可建两个会话；重启可能重放 |
| P1 | 后台推进绑 UI 定时器 | `modes/interactive-mode.ts:1462` | 关客户端即停摆 |
| P1 | hindsight recall 每会话只一次；无 person 轴 | `hindsight/state.ts:419` | 长会话内偏好变化不生效 |
| P2 | `channels.json` 明文在 tmpdir；插件只注册不注销 | `session-host.ts:341`；`server.ts:5149-5152` | 凭据与运维风险 |

---

## 7. 目标架构

```
L3  Channels        IM / 桌面 / 移动 / 语音 / 深链
L2  Assistant       Assistant Session（长期、人格、记忆、注意力策略）
L2  Orchestration   Task/Ticket · Subscription · Assignment · Durable Effects
L1  Execution       coding session · subagent · job · device task
L0  Runtime         daemon · models · tools · storage · remote transport
```

- L0/L1 已有，不重写。
- L2 是新增层：先做“助理会话 + 轻任务”，再做 Ticket/Assignment。
- L3 的 adapter 契约保留，扩展交互能力与归属解析。

### 7.1 核心对象

```ts
type SessionKind = "coding" | "assistant" | "task";

interface SessionOwner {
  kind: "project" | "assistant" | "device";
  id: string;            // projectId / assistantId / deviceId
}

interface AgentProfile {
  id: string;
  kind: SessionKind;
  prompt: { complete?: string; sections?: string[] };
  tools: { allow: string[] } | { deny: string[] };
  model?: { pattern?: string; thinkingLevel?: string };
  skills?: string[];
  memory?: { bank?: string; recall: "first-turn" | "every-n" | "manual" };
  channels?: { replies: "result" | "attention" | "answer" | "all" };
}
```

- **Session 只承担 transcript 与执行载体**；授权、任务状态、去向不塞进 Session。
- **AgentProfile 是插件可注册的**：`registerProfile()`；`registerMode` 保留兼容，但新代码走 profile。
- **OwnerKey 独立于路径**：`SessionHeader.owner = {kind,id}`；`workspacePath` 降级为执行目录。

### 7.2 个人助理会话

- 一个助理 = 一个 `assistantId` + 一个长期 Assistant Session + 一组 persona 文件。
- 文件布局（对齐 bitfun）：
  ```
  ~/.musepi/assistants/<assistantId>/
    IDENTITY.md   # frontmatter: name, avatar, emoji
    SOUL.md       # 风格与边界
    USER.md       # 用户画像
    BOOTSTRAP.md  # 首次引导，读取后删除
    memory/       # 可选：本地笔记
  ```
- 提示装配：base → `SOUL` → `USER` → `IDENTITY` → 当前时间/时区 → 活跃任务摘要 → 注意力策略。复用 `PromptHost` 的 lane/owner，避免字符串拼接。
- 工具面（MVP）：`ask`、`read`、`web_search`、`notes`、`cron`、`delegate_task`、`remember`、`recall`。`bash` 默认关闭，由 profile 显式开启。
- 记忆：hindsight bank 以 `assistantId` 为 scope；`recall` 支持 `every-n`；`USER.md` 作为稳定画像，优先于逐轮 recall。

### 7.3 IM 单聊天窗口的交互契约

目标：一个聊天窗口 = 一个助理 + 多个话题/任务，而不是每条消息一个新会话。

| 事件 | 行为 |
| --- | --- |
| 首条私聊 | 解析 peer → 找 owner 绑定 → 无则绑定主助理；`/start` 可显式选择助理 |
| 普通消息 | 追加到 Assistant Session 的当前 topic；助理直接答或 `delegate_task` |
| 长任务 | 立刻回一条“已接单 + 任务名 + 预计下一步”，之后静默；工具进度不刷屏 |
| 需要审批 | `attention` 消息，带选项/按钮（平台支持时）；文本平台用编号回复 |
| 任务完成 | `result` 消息，引用原任务消息；附件走 outbound 附件 |
| `/new` | 新 topic，不换助理、不清记忆 |
| `/list` | 活跃任务 + 最近 topic，带状态与“在等谁” |
| `/stop` | 中止当前活跃任务；无任务时提示；不关闭助理会话 |
| 群聊 | 默认只响应 @；绑定到群 + 发起人；无 owner 白名单时拒绝写操作 |

发送闸门（对齐 dsh 的 purpose）：

```ts
type ReplyPurpose = "ack" | "progress" | "attention" | "result" | "answer";
```

- `progress` 默认不推 IM，只进 desktop/mobile 的 activity。
- `attention` 必须对应一个未解决的 `questionId`。
- `result` 必须对应一个已进入 `ready_for_review/completed` 的任务。
- 同一 `questionId` 只发一次；换问题要撤回未发出的旧消息。

### 7.4 任务与编排（Phase C）

MVP 可以先用现有 subagent/job 模拟，但接口要按 Ticket 形状预留：

```ts
interface Task {
  id: string;
  owner: SessionOwner;
  assistantId: string;
  mandate: { profileId: string; scope: "answer" | "workspace" | "device"; policyVersion: number };
  state: "open" | "ended";
  assignments: Assignment[];
  subscriptions: string[];   // thread/topic ids
}
```

- `delegate_task` 创建 Task + 首个 Assignment；执行器可以是 coding session、subagent 或设备任务。
- 任务结果通过 durable effect 回注 Assistant Session；重启后按 `pending/running` 对账。
- 人回复订阅的 topic 时，复用原 Mandate 复活 Task；不重新评估。
- 多设备时，Task 增加 `runsOn`（deviceId / workspaceId），创建时定格，重试不换机。

---

## 8. 分阶段落地

### Phase A：接口与插件地基（现在，2–3 周）

1. **SessionKind + ownerKey**
   - `packages/wire/src/index.ts`：`SessionHeader` 加 `kind`、`owner`；`session.create` 加 `profileId`；`session.list` 返回真实 `kind`。
   - `packages/coding-agent/src/daemon/session-host.ts`：创建时写入 owner；迁移旧会话为 `kind:"coding"` + `owner:{kind:"project",id:<cwd hash>}`。
2. **AgentProfile**
   - `packages/coding-agent/src/extensibility/extensions/types.ts`：新增 `registerProfile`；内部先映射到现有 mode + tools + prompt，避免一次性改 runtime。
   - `presets/resolve.ts`：profile 解析优先于 mode；`chat` 预设改写成内置 profile。
3. **ChannelContract v2**
   - `ChannelOps.startSession(profileId, prompt)`；绑定结构升级为 `{assistantId, topicId, sessionId}`，带 v1 迁移。
   - `ChannelAdapter` 增加可选 `sendInteractive`（按钮/选项）与 `sendAttachment`；daemon 的 `send` 传递 images/files。
   - 增加 owner allowlist、每 peer 限流、入站 `messageId` 去重。
4. **发送闸门与持久队列**
   - 新增 `ReplyPurpose` 与 `replyGate`；通道回推只接受 `ack/attention/result/answer`，`progress` 进本地活动流。
   - 用现有 `async/job-manager` 或新表实现 outbound 队列：`(peer, messageId)` 幂等、失败退避、重启续跑。
5. **提示装配**
   - `PromptHost` 增加 `assistant` lane；`buildSystemPrompt` 不再硬拼 persona，改由 profile 提供 section。

**验收**：现有编码会话行为不变；新增一个 `chat` profile 能通过 `session.create` 创建；IM 首条消息落到指定 profile；出站图片能到达 Telegram/Discord；`/stop` 只中止当前轮。

### Phase B：个人助理会话 MVP（3–4 周）

1. `assistant.create/list/setPrimary/delete` RPC；persona 文件初始化/重置/监听。
2. Assistant Session 创建与恢复；`primaryAssistantId` 指针 + 确定性兜底。
3. `delegate_task` 工具 → 现有 subagent/job；结果回注。
4. `remember/recall` 接 hindsight，scope 到 assistant；`USER.md` 注入。
5. 注意力策略提示 + `replyGate`；IM `/new` `/list` `/stop` 语义修正。
6. 记忆与人格的桌面/移动端编辑页（可先只读）。

**验收**：同一个 IM 窗口连续聊 100 条不换会话；`/new` 只开新 topic；`delegate_task` 的结果回到原窗口并引用原消息；重启后任务继续；群聊非 @ 不响应。

### Phase C：任务编排与多设备（4–6 周）

1. Task/Assignment/Subscription 表与 durable effect；`delegate_task` 改走 Task。
2. Task 复活、重试、restart、stop；人工通道优先。
3. 设备注册表 + presence + capability（承接上一份远程文档的 relay/transport 设计）。
4. Task placement（`runsOn` 定格）、设备任务索引上行。
5. 推送与未读：服务端读位 + 通知只带 ID。

**验收**：人在 IM 里追问一个已结束的任务，能复用原授权继续；桌面关掉后任务仍在 daemon 推进；两台设备看到同一 Task 状态。

---

## 9. 关键取舍

1. **助理会话不是“更大的编码会话”。** 它是路由器 + 记忆 + 人格；执行仍交给 coding session/subagent。否则上下文会无限膨胀，工具权限也无法收敛。
2. **先有 ownerKey，再谈多助理。** 没有归属键，IM 绑定、移动端分组、多设备任务都会退化成“按目录猜”。
3. **IM 单窗口要“少说话”。** 默认静默、只在 result/attention/answer 时发言；进度留在桌面/移动端。这是 dsh-superagent 最值得抄的产品判断。
4. **任务授权与执行分离要尽早定型。** 即使 MVP 只有一个 `delegate_task`，也应按 `Task + Mandate + Assignment` 的字段设计，避免以后迁移。
5. **不要照搬 dsh 的部署形态。** 单租户、60 s 轮询、tmux、同用户 worker 都不适合 MusePi 的多设备/常在线场景。

---

## 10. 风险与未确认

- **comma 资源数字**：官方未给最低 CPU/RAM；4 vCPU/8–16 GB 是推断。
- **comma 自托管传输**：`transfer.advertise_host=comma` 且 4400 未发布，自托管跨设备大文件传输基本不可用（代码事实 + 推断）。
- **dsh-superagent 生产性**：README 自述研究原型；无删除/归档、无预算硬上限、无崩溃自拉起。
- **bitfun 悬空引用**：删除助理不级联删会话/定时任务；具名 id 从目录名反推，改名会丢身份。
- **MusePi mode 热切换**：`session.setMode` 非事务，已应用部分不会回滚；新增 profile 切换需要“重建 + 回滚”，不能直接复用它。
- **MusePi 通道状态可信度**：Telegram 轮询失败仍显示 connected；微信 token 失效要等第一次 getUpdates 才暴露。
- **未确认**：MusePi 桌面 GUI 是否有独立于 `interactive-mode` 的 goal 续跑；IM 适配器对群聊身份的实际处理；hindsight bank 的并发写行为。

---

## 附录：关键锚点

**comma**

- `compose.yaml:125,149,170-172` — 默认只绑回环
- `selfhost/configure.py:26-46` — 公网启动校验
- `docs/architecture/PRODUCT_MODEL.md:128` — 每 Group 一条 Router Conversation
- `systems/apps/comma_core/lib/comma/conversations.ex:1010-1018` — 失效提示 + version
- `systems/apps/salix_im/lib/salix_im/task_placement.ex:1-30` — Task 位置裁决
- `systems/apps/salix_agent/lib/salix_agent/tools/ssh.ex:52,62-71` — `via_device_id` / `via_tailnet`
- `systems/tailnet-gateway/node.go:324-350` — netstack-only 拨号

**dsh-superagent**

- `docs/001-domain.md` — Source/Thread/Eval/Mandate/Ticket/Subscription
- `src/core/intake.ts:19-62` — 去重、扇出、入队
- `src/core/evals.ts:71-131` — 批处理与决策
- `src/core/tickets.ts:252-270` — 人消息复活 Ticket
- `src/executor/dsh.ts:171-198` — WorkerSlots
- `src/app/effects.ts:61-66,130-146` — 持久效果队列
- `src/core/replies.ts:69-82` — purpose 发送闸门
- `prompts/admission.md:17-24` — 三事实准入

**bitfun**

- `src/web-ui/src/shared/types/global-state.ts:62-66` — WorkspaceKind
- `src/crates/assembly/core/src/infrastructure/app_paths/path_manager.rs:143-168` — 助理目录
- `src/crates/assembly/core/src/service/bootstrap/bootstrap_impl.rs:5-19` — persona 文件
- `src/crates/services/services-core/src/workspace_records.rs:40-68` — PrimaryAssistantKey
- `src/web-ui/src/app/utils/projectSessionWorkspace.ts:53-66` — workspaceId 权威归属
- `src/crates/.../cron/types.rs:79-126` — cron target 二分

**MusePi**

- `packages/coding-agent/src/daemon/server.ts:2034` — `kind:"session"`
- `packages/coding-agent/src/presets/resolve.ts:350-390` — chat 预设
- `packages/coding-agent/src/task/types.ts:419,447` — AgentDefinition
- `packages/coding-agent/src/extensibility/extensions/types.ts:1610` — registerMode
- `packages/coding-agent/src/channels/handler.ts:175-214` — 入站绑定
- `packages/coding-agent/src/channels/types.ts:20-100` — ChannelAdapter 契约
- `packages/coding-agent/src/advisor/runtime.ts:405` — advisor 增量输入
- `packages/coding-agent/src/goals/runtime.ts:312` — goal 记账
- `packages/coding-agent/src/hindsight/state.ts:419` — 首轮 recall
