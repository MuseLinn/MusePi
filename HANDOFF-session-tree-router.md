# 会话树 + 常驻编排（Session Tree + Orchestrator）交接文档

> 用途：交给 KimiWork 继续做原型构思与开发推进。
> 性质：**证据与需求整理**，不是最终设计。第 11 节的三条决策未拍板前，不要开始写实现。
> 整理时间：2026-11-01
> 证据来源：本地源码 + 官方仓库源码 + 本机安装版逆向。全部可复现，命令见第 13 节。

---

## 0. 给 KimiWork 的任务边界

要做的：
1. 基于本文的证据和需求，产出**原型**（信息架构 + 关键界面 + 状态机）。
2. 给出**落地路线**（分阶段、可验收、尽量复用现有能力）。
3. 明确指出哪些需求与现有代码冲突，以及冲突的代价。

不要做的：
- 不要重新论证"要不要做三层 agent"。这个问题已经收敛，结论见第 9 节。
- 不要引入新的 agent 运行时。复用 `packages/coding-agent` 现有执行体。
- 不要做"两种模式"的切换开关（原因见 9.3）。

---

## 1. 用户的需求（原始意图，不要改写）

用户的原始表述：

> "我的 agent 应该设计一个**正常的多会话模式类似 codex**，以及一个**能够编排会话的单一 router 会话**的模式，作为一个**个人长期助理**。"

拆成可执行的需求：

| 编号 | 需求 | 说明 |
|---|---|---|
| R1 | 普通多会话模式 | 像 Codex/Claude Code 那样，一个会话一件事，用户自己开、自己管，互不相干 |
| R2 | 常驻编排会话（router） | 一条长期存在的对话，用户对它说话，它负责拆活、派活、汇报，自己不动手 |
| R3 | 可续的主题会话（thread） | 一件事做一周，就该有一个会话从头活到尾，而不是折成十几个互不相干的短会话 |
| R4 | 短命执行 | 真正干活的部分可以并行、可以换机器、跑完就丢，不背记忆 |
| R5 | "待我决定"队列 | 需要人拍板的事要能被看见、被集中处理，不能埋在聊天记录里 |
| R6 | 双向直连 | 用户能直接对某个 thread 说话绕过 router；thread 也能把 router 叫下来 |
| R7 | 自然语言找回 | "回到那个迁移的事"要能定位到会话，不能只有随机 ID |
| R8 | 降级 | router 挂了，thread 还能进，不能整个助理一起下班 |
| R9 | 单一会话树、两个入口 | **不要**做成"普通模式 / 助理模式"两个割裂的东西（见 9.3） |

---

## 2. 结论摘要

1. **"两层不够、要三层"这个说法在事实层面站不住**：Comma 本身就是三层（Router / Task / Worker Session），它的 Task 就是中间层，持久、可续、可被人直接说话。它后半段自己也承认了。
2. **"一条该做一周的事被折成十几个 Task"是结案语义问题，不是缺层**：Task 不结案就一直活着，问题在产品把结案条件定得太激进。
3. **我们的缺口不是"层"，是"台账"**：子会话文件已经落盘、能冷复活、能寻址、能被消息唤醒；但没有一份持久记录说明"这个会话为了什么、现在什么状态、要不要人看"。现有 run 记录是刻意不留的（`RUN_HISTORY_LIMIT = 200`，最老的直接丢）。
4. **不要做成两种模式，要做成一个会话树 + 两个入口**。理由是我们已经犯过同类错误（能力中心与扩展与插件重复挂载同一组件）。
5. **最容易做错、而外部建议没提的一条是授权**：直连必须带授权模型，否则"双向直连"就是越权通道。

---

## 3. 证据 A：dsh 的插件体系（设置「内置插件」vs 侧栏「插件」）

源码：`D:\Projects\Agents\references\dsh`

| | 侧栏 → 插件（`packages/client/ui-plugin-manager`） | 设置 → 内置插件（`ui-settings-plugins` + `ui-settings-plugin-inventory`） |
|---|---|---|
| 定位 | 写操作面：安装/卸载/启停 bundle 与单行插件，跑 pnpm，看安装输出 | 只读投影：回答"这台机器现在由什么组成" |
| 数据源 | `pluginManager.listBundles / listPlugins` + 写 API（`setBundleEnabled` / `setPluginEnabled` / `installBundle` / `removeBundle`） | 只调 `pluginInventory.list()`；不读 Remote、不写设置 |
| 组织方式 | 按 **bundle（npm 包/仓库）** 分组；每个官方插件的配置页由它自己的 companion 包注册到 `plugins.row.config` | 按 **作用域** 分组：先「会话插件」（Agent 预设组合，含 `include:` 条目），再折叠的「内置插件」全局平面 |
| 额外信息 | 版本、更新、市场、实验标记 | 启用态标签（停用/条件/由预设提供/失败）、root fiber 运行时相位点、稳定 entry id |

关键事实（`ui-settings-plugins/README.md` 原文）：**"Configuring a built-in plugin happens on the sidebar's Plugins page"**。设置页本身是个空壳，只声明 slot `settings.plugins.tab`，当前唯一贡献者是只读清单。

因此用户截图里「Bash 命令工具 · 已停用」是**显示**，不是开关。

截图里的「会话插件 · 由 Agent 预设按会话组成 · 标准模式」是该 tab 的**预设切换器**，行为有坑（`ui-settings-plugin-inventory/README.md:41-43`）：**切换只改变列表显示哪套组合，不写任何设置**。

**结论**：一份 Host 插件图，两个读者视角——侧栏管"装了什么、开没开"，设置管"运行时由什么构成、为什么这行是停用的"。

---

## 4. 证据 B：MusePi「扩展与插件」vs「能力中心」

源码：`D:\Projects\Agents\MusePi\packages\desktop-app\src`

| 面 | 位置 | 视图 | 数据源 |
|---|---|---|---|
| 设置 → 扩展与插件 | `components/ExtensionsCenter.tsx` | `overview / inventory / plugins / marketplace / diagnostics`（`:564-615`） | `extensions.list`（单例 `useExtensionRegistry`，10s 轮询 + `extensions.changed`，`lib/slot-host.tsx:609-629`）、`plugins.packages`（`:294`） |
| 左侧 → 能力中心 | `plugins/capability-center/page.tsx` | `skills（发现 / 我安装的 N） / plugins / marketplace`（`:14`） | `skills.list`（`CapabilityCenter.tsx:690`）、`plugins.packages`（`page.tsx:82`） |

同一批组件在两处挂载：
- `UnifiedPluginsView`：`ExtensionsCenter.tsx:638`（`variant="cards"`）与 `page.tsx:195`（默认 variant）。
- `MarketplaceView`：`ExtensionsCenter.tsx:648` 与 `page.tsx:205`。

问题（这是 R9 的现实依据）：
- `plugins.packages` 被请求两次，状态各存一份。
- 同一个组件贴两遍，`variant` 还不一致。
- 职责靠"技能 vs 全量"划分，但「插件」「市场」正好落在缝里，两边都能装。

**结论**：这不是"两种投影"，是同一投影贴了两遍。dsh 靠"设置只读 / 侧栏可写"划清职责避开了这个问题。

---

## 5. 证据 C：dsh-superagent 的"双层"是怎么实现的

源码：`D:\Projects\Agents\references\dsh-superagent-prototype`（3.9 MB，已 clone）

**它没有改 dsh 一行代码**，全部通过 bundle 注入：

1. `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`，`engines.dsh: ^0.2.1-alpha.2`。
2. `cordis.patch.yml` 插入 **3 个插件条目**：`dsh-superagent`、`dsh-superagent/github-watch`、`dsh-superagent/feishu-watch`（默认 `disabled: true`）。
3. `cordis.patch.yml` 插入 **2 个 Agent 预设**——这就是"双层"的全部秘密：
   - `dsh-superagent-worker`（order 90）：执行器 Session 专用；前台命令 5 秒转后台；只含干活工具。
   - `dsh-superagent-router`（order 91）：主 Session 专用；无 persona、无 subagent/web/写文件/todo；只含路由工具。
   这两个预设就是用户在 dsh「Agent 预设」里能看到的东西，也是「会话插件」分组的来源。
4. 创建会话时按角色选 preset（`src/app/sessions.ts:48, 127, 144-146`）：
   `create({ agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })`。
5. 编排层只拿到 `orchestrator_*` 工具（`src/app/tools/main.ts:127-279`）：`orchestrator_route`、`orchestrator_eval`、`orchestrator_eval_decide`、`orchestrator_ticket_retry`、`orchestrator_reply`……**没有一个动手的工具**。
6. UI 走 dsh slot（`src/client/index.tsx:53-56`）：`sidebar.panellist`（侧栏多一个图标）、`main`（管理面板）、`plugins.row.config`（插件管理器里的配置页）。

域模型（`docs/001-domain.md`）：
`Source → Trigger → Thread → Eval（gate + assessment）→ Mandate → Ticket → Assignment → Executor`。
`Ticket` 是持久工作单元，`Assignment` 把 Ticket 绑到一个 Executor 实例，Report 有 `progress / waiting / ready / blocked / failed / dropped`。

**核心洞察**：双层 agent 不是两套 runtime，是**一个 runtime + 两份 preset（工具子集）+ 一层工单状态机**。preset 的作用是让编排层**物理上无法干活**。

---

## 6. 证据 D：Comma 的域模型

源码：`D:\Projects\Agents\references\comma`（224 MB，Elixir + Lean + TypeScript 客户端）

`docs/architecture/PRODUCT_MODEL.md` 的主干：

```
用户 → Workspace
  ├─ Router [0..1；chat-ready 时恰好 1] → Canonical Runtime Session（1:1）
  ├─ Worker [0..N] → Task Runtime Session [0..N]
  ├─ Assistant Chat（每个 Group 一条固定 Router 会话）
  └─ Agent Task [0..N] → 一个 agent_task Conversation
       ├─ status（唯一权威，不跟 Session 终止走）
       ├─ Gate / Progress（可分叉、汇合、有界循环）
       └─ Artifact
```

关键事实：

| 事实 | 出处 |
|---|---|
| `Task` 是一个 `agent_task` Conversation，不是 Session | `DOMAIN_CONCEPTS.md:616-618` |
| `Task Lifecycle` 由 `Conversation.status` 独家拥有；`Session termination does not establish Task completion` | 同上 |
| Task 结束后仍保留 Subscription，人的一条消息可续上 | `DOMAIN_CONCEPTS.md:70` |
| Router 可在"已验证投递、无待办、无需人决定"时自行结案；人工接受是另一条路径且要版本校验 | `DOMAIN_CONCEPTS.md:648-656` |
| 委派走 `internal.task.create` + `execution_requests` / `task_payload_params`，不是专用工具 | `systems/apps/salix_agent/lib/salix_agent/tools/im_router.ex:605, 809` |
| `Condensed Workspace`：Group 级有序短句 + 单调 revision，Router 与所有 Worker Session 都带 | `DOMAIN_CONCEPTS.md:181` |
| Loop Task = Task + 一个 Background Loop（`every_minutes` 5-1440 / `cron`+IANA tz / `events`）；Loop 不改任务状态，只把每次 run 作为 result Message 交给 Worker | `DOMAIN_CONCEPTS.md:657-700` |

---

## 7. 证据 E：Comma 安装版（45.0.0）逆向结果

被测对象：用户从官网下载安装的版本。

| 项 | 值 |
|---|---|
| 安装路径 | `C:\Users\universe\AppData\Local\surf.comma.desktop\current` |
| 应用版本 | `45.0.0`（Electron 45）；包 `surf.comma.desktop 1.0.10`（Squirrel/velopack，channel prod） |
| `comma.exe` | 249,812,992 bytes，SHA-256 `a8aa977a838933e91e20b2957dd64c1c5cb10d7e7c5ba0c4233cf48e031b702c` |
| `resources/app.asar` | 37,941,640 bytes，568 个文件 |
| Electron fuse | `EnableEmbeddedAsarIntegrityValidation=enabled`、`OnlyLoadAppFromAsar=enabled`、`RunAsNode=disabled`、`EnableNodeOptionsEnvironmentVariable=disabled`、`EnableNodeCliInspectArguments=disabled` |
| 渲染层形态 | Vite 代码分割的 React 19 SPA。`main-DqYgZ2EB.js` 2.6 MB（主进程）、`useTimeLabel-v9IOTvnq.js` 3.8 MB（应用壳，chunk 名误导）、`renderComma-I1H8OKZf.js` 2.2 MB |
| 自定义协议 | CSP 中出现 `comma-file:` / `comma-drive:` / `comma-ui:` / `comma-app:` |
| 会话凭据 | 入口脚本把 `document.cookie` 读写置空，走 bearer + `session-host.ts` 的 gate，不用 cookie |
| 主导航 | 主页 / 搜索 / 收件箱 / 云盘 / 任务 / 插件 / 设置（bundle 内 i18n 表逐字对应） |

**截图那一屏的实现**（= HomeLayout 三段拼接）：

1. **左列上「例程」** = `clients/packages/app/src/components/recommendations/RecommendationRail.tsx`。数据是 `@comma/recommendation-contract` 的 `RecommendationEnvelope`（source + 引用行 + 卡片 + actions），用 `MarkdownStream` 流式渲染。它是**服务端算好的 briefing 投影**；action 只把文本塞进 composer，不自动发送。
2. **左列下「任务」** = `components/home/HomeTasksRail.tsx`，绑 `useWorkspaceTasks` → `useProductInboxProjection`。状态桶 `in_progress → needs_review → done → cancelled`，空桶往后落（`FOLLOW_PRIORITY`，`:22`），归档的不上 rail。注释原文：**"tasks created through the Comma Router agent appear here too"**——同一个 projection 喂 Home rail、Tasks 页、Inbox 三处。
3. **右侧常驻 Router 会话** = 「你起个头，剩下的交给 Comma」空态 + composer。**一条**对话，不是每次新开。

另有离线快照层：`Synced / Sync failed / Unavailable / Showing local`，文案"连接中断，显示的是最近同步的内容。"

补充：Comma 的「插件」是 **Plugin Definition + Plugin Installation + Group 级凭据/MCP 绑定**，是集成包，不是 UI 扩展系统。和我们的插件语义不同，不要为对齐命名去改现有体系。

**逆向方法限制（诚实记录）**：
- `analyze_javascript_application` 对 3.8 MB 单行压缩 bundle **解析失败**（`parse_failures: 1`，`visited_ast_nodes: 0`，Evidence `ev_c8a12cbc…f3a3`）。因此渲染层结构结论来自 asar 索引 + 字符串/结构证据 + 同版本源码交叉验证，不是 AST 语义图。
- 入口 6 KB 那层解析成功（`ev_542838a2…b9c9`），fuse 证据 `ev_85f4bdf7…3dbc`。
- asar 完整性开启，所以采用"按 asar 索引直接解析"而非解包重打包。

---

## 8. 证据 F：MusePi 现有能力盘点（能复用什么）

源码：`D:\Projects\Agents\MusePi\packages\coding-agent\src`

| 能力 | 位置 | 现状 |
|---|---|---|
| 会话内派生子智能体 | `task/index.ts:1-13` | 支持单次 spawn / batch / async job / worktree 隔离 / `spawns` 递归上限 |
| 子会话落盘 + 冷复活 | `task/persisted-revive.ts:41-60` | 子会话写成 JSONL，带 `session_init` 契约，能像 `--resume` 一样重放重建。注释原文："This rebuilds the subagent the same way `--resume` rebuilds a session" |
| 子智能体寻址与控制 | `modes/components/agent-hub.ts`、`daemon/server.ts:5711-5752` | Agent Hub 名单，`ensureLive` / `focusAgent` / kill / revive / chat |
| 消息唤醒 | `irc/bus.ts:148` | IRC 消息能唤醒冷掉的子智能体（`lifecycle.ensureLive`） |
| 子会话轨迹 UI | `components/SubagentPanel.tsx:26` | 快照 + 增量 transcript 轮询（1200 ms）+ kill/revive/chat |
| 编排提示词 | `modes/orchestrate.ts` | `orchestrate` 关键字切多智能体 fan-out（同一会话内） |
| 定时任务 | `TaskCenterViews.tsx` | CronTask 列表 + 日历 + 状态看板 |
| 会话命名 | `task/name-generator.ts` | 自动生成任务名 |
| 会话检索 | `components/SessionSearchBar.tsx` | 已有搜索 |
| 会话树 | `components/SessionTreeNav.tsx`、`GroupedSessionList.tsx` | 已有树/分组概念 |

**关键发现（`task/run-record.ts:12-17` 注释原文）**：

> `Runs are ephemeral by design. They are not session state and not a log`
> `RUN_HISTORY_LIMIT = 200`，最老的直接丢
> `nothing may depend on one being there`

`RunMember` 里**有** `sessionFile`，也就是说：**会话文件在，索引不在，状态不在。**

---

## 9. 分析

### 9.1 "三层"说法的事实修正

Comma 的 Task 就是中间层：持久（`agent_task` Conversation）、可续（`Session termination does not establish Task completion`）、可被人直接说话（`A person can also start a turn by writing directly in the Executor Session`）。

所以"只有薄 router 和一次性 Task，没有中间那层"是错的。它后半段自己也说："Task 本来就能当线程用——不结案、持续回同一个 Task，就等价于第二层。缺的是这块的界面和心智模型，而不是引擎。"**这两句自相矛盾，正确的是后一句。**

"一条该做一周的事被折成十几个 Task"——是**结案语义定得太激进**（PR 关了、ready 了就结案），不是缺层。加一层治不了。

### 9.2 真正的缺口

不是"层"，是三样东西：

1. **一份持久台账**：`这个会话为了什么 / 现在什么状态 / 要不要人看 / 上次到哪`。现有 run 记录刻意不留。
2. **待我决定队列**：结果现在回到父会话 transcript 里，没有独立状态桶。
3. **唤醒路径的语义**：技术上能唤醒（`ensureLive`），但没有"什么事件该唤醒谁"的规则。

### 9.3 为什么不要做成"两种模式"

"普通多会话模式 + router 模式"会复制我们已经犯过的错误：能力中心与扩展与插件把同一个 `UnifiedPluginsView` 贴了两遍、`plugins.packages` 请求两次。

正确形状：**一个会话树 + 两个入口**。router 只是"parentId 为空的根会话"，thread 是它的子会话，普通会话是另一种根。用户从侧栏进，或从任务卡进，进的是同一个对象。

### 9.4 对三条外部建议的评估

| 建议 | 评估 |
|---|---|
| 记忆只能一个写入者 | **方向对，结论过强**。Comma 实际是"单一 owner + 单调 revision + CAS"（Condensed Workspace），不是全局单写入者；dsh 更彻底，根本没有共享记忆。只让 router 落盘会把 router 变成瓶颈和单点，违反 R6 和 R8。建议：**按作用域分文件、每个文件单一 owner** |
| 下发原始消息加指针，不要概括 | **对，但漏了半句**。两家都是投递原文（Comma 的 Trigger fan-out 带 Source metadata；dsh 直接投递 Trigger 本体）。但透传原文会打爆上下文，真正的规则是**"指针 + 按需读取"**：dsh 的 worker 是被告知去看哪个 Thread，自己去读 |
| 两个方向都要能直连 | **对，但必须配授权**。dsh 划得很死：主 Session 对 follow-up **只能"按人的要求停止工作"**，不能顺手接管；人的消息进 Ticket 要带 Mandate 和 Policy version 重新校验。没有这层，"直连"就是越权通道 |

### 9.5 成本模型修正

"缓存和零交接省下来的钱全在第二层"只在**第二层存决策、不存 transcript** 时成立。第二层会话越活越长，每轮都在付全量 context + 压缩损耗，最后最贵的就是它。Comma 的对策正是 Condensed Workspace + 小上下文。

正确表述：**省在"第三层不继承上下文 + 第二层只留决策和指针"。**

---

## 10. 需求规格

### 10.1 功能需求

| ID | 需求 | 验收标准（可测） |
|---|---|---|
| FR-1 | 一个会话树 | 任意会话有 `parentId`；树视图能展开 router → 其 thread → 其执行会话；普通会话是独立根 |
| FR-2 | 两个入口，同一对象 | 从侧栏进和从任务卡进，落到同一个 session id；不存在"模式"开关 |
| FR-3 | 常驻编排会话 | 该会话的工具集**不含** bash / write / edit；只有编排类工具（创建/查询/重试/取消/回复 thread） |
| FR-4 | 主题会话可续 | thread 关闭后再打开，历史与决策都在；父会话已结束也能打开（复用冷复活） |
| FR-5 | 待我决定队列 | 独立视图，聚合所有 `needs_review` / 阻塞的 thread；处理完从队列消失 |
| FR-6 | 双向直连 | 用户能在 thread 内直接发言并推进；thread 能请求 router 介入；**两条路径都记录授权来源** |
| FR-7 | 自然语言找回 | "回到那个迁移的事"能命中；依赖稳定的人类可读标题 + 可检索字段 |
| FR-8 | 降级 | router 会话不可用时，thread 仍可进入并继续 |
| FR-9 | 台账持久 | 进程重启后，thread 的状态/标题/归属不丢 |

### 10.2 非功能约束

| ID | 约束 | 理由 |
|---|---|---|
| NF-1 | thread 状态权威在 daemon store，不在任何会话上下文 | 否则 R8 无法满足 |
| NF-2 | thread 只存决策 + 指针 + 验收标准，不存 transcript | 见 9.5 |
| NF-3 | 台账只存指针和状态，不存内容 | 与 `run-record` 的"不留内容"原则一致，只是把"不留"改成"持久" |
| NF-4 | 不得新增 agent 运行时 | 复用 `packages/coding-agent` |
| NF-5 | 不得出现第三个"插件/能力"入口 | 见 9.3 |

### 10.3 数据结构草案（供讨论，不是定稿）

```ts
type ThreadStatus =
  | "active"        // 在做
  | "needs_review"  // 等人决定
  | "blocked"       // 被外部阻塞
  | "done"
  | "cancelled"
  | "failed";

interface ThreadRecord {
  id: string;
  /** 人类可读、稳定、可检索（FR-7） */
  title: string;
  goal: string;
  status: ThreadStatus;
  /** 树结构（FR-1） */
  parentId: string | null;
  /** 执行体会话（已存在的能力，见第 8 节） */
  workerSessionId: string | null;
  sessionFile: string | null;
  /** 指针，不是内容（NF-2/NF-3） */
  decisionRefs: string[];
  acceptanceCriteria?: string;
  /** 授权来源，FR-6 必需 */
  authorization: {
    grantedBy: "user" | "router";
    grantedAt: string;
    scope: string;
  };
  createdAt: string;
  lastActivityAt: string;
  /** 乐观并发 */
  version: number;
}
```

---

## 11. 待定决策（**未拍板前不要写实现**）

| ID | 决策 | 选项 | 影响 |
|---|---|---|---|
| D1 | 状态权威放哪 | (a) daemon store（推荐）(b) router 会话上下文 (c) 独立服务 | 直接决定 FR-8 / NF-1 能否满足。(b) 会让 router 变单点 |
| D2 | 第二层存什么 | (a) 决策 + 指针 + 验收标准（推荐）(b) 完整 transcript (c) 只存标题 | 决定长期成本曲线（9.5） |
| D3 | 直连授权模型 | (a) 用户直连全权、router 直连需显式 scope（推荐）(b) 都需授权 (c) 都不需 | 最容易做错的一条。选 (c) 后面全是越权补丁 |

建议先定 D3，再写文档；否则会写成一份"什么都能连"的方案。

---

## 12. 原型与推进建议

### P0｜台账与状态机（后端，无 UI）
- 落 `ThreadRecord`（第 10.3 节），存 daemon store。
- router 用**现有 agent 定义的 `tools` frontmatter** 砍能力，零新机制。
- 派工复用 `task` 工具，把子会话登记到 ThreadRecord（`agents.*` 已支持，只差登记）。

### P1｜UI（最该先做的一屏）
- **任务 rail**：`进行中 / 待我决定 / 已完成`，空桶往后落（`FOLLOW_PRIORITY` 那个"手动选择后 8 秒不自动跟随"的细节值得抄）。
- **卡片直进 worker 会话**：复用 `SubagentPanel` 的 transcript 轮询 + kill/revive/chat，不新写。
- **一个 projection 喂三处**：rail、任务页、通知中心。不要再犯 `plugins.packages` 请求两次的错。

### P2｜唤醒与恢复
- 人说话 / 定时事件 / CI 结果都能唤醒 thread；唤醒必须幂等。
- **Task 状态不跟 Session 走**——这条一开始不立，后面全是补丁。

### P3｜主动性（例程）
- 已有 CronTask，缺"briefing 投影"：把定时结果整理成可读卡片 + 一键塞进 composer，而不是丢一条原始消息。

### 并行要做的清理
- 把设置侧「插件」「市场」改成指向能力中心的入口，或降级为纯包管理。否则 NF-5 不成立。

---

## 13. 参考资源与复现

| 资源 | 路径 |
|---|---|
| dsh 源码 | `D:\Projects\Agents\references\dsh` |
| dsh-superagent 源码 | `D:\Projects\Agents\references\dsh-superagent-prototype` |
| Comma 源码 | `D:\Projects\Agents\references\comma` |
| Comma 安装版解包 | `%LOCALAPPDATA%\Temp\comma_asar`（可随时删） |
| 解包脚本 | `%LOCALAPPDATA%\Temp\comma_extract.py` |
| MusePi 源码 | `D:\Projects\Agents\MusePi` |

复现命令：

```bash
git clone --depth 1 https://github.com/deepseek-ai/dsh-superagent-prototype.git
git clone --depth 1 https://github.com/AFK-surf/Comma.git
```

REA 证据 ID（可在会话内用 `inspect_analysis_view` 取回）：
- fuse 状态：`ev_85f4bdf745c05b3badc25876d4a0e7a0ecf1ed5f5c778b4757a99551ab003dbc`
- 渲染层入口图：`ev_542838a23900046c1329d06c2548e75974f7a494354887c5f0f931fff501b9c9`
- 应用壳（解析失败）：`ev_c8a12cbcfacc17496f4b8af8c30f5da626f2f265ffa4e3f9aaa58150d3f7f3a3`

---

## 14. 未验证项与风险

| 项 | 状态 |
|---|---|
| Comma 渲染层 AST 语义图 | **未取得**（3.8 MB 压缩 bundle 解析失败）。现有结论依赖 asar 索引 + 字符串 + 同版本源码 |
| Comma 运行时行为（是否真的按上述路径跑） | **未观测**。只有静态证据，没有 attach 运行中的进程 |
| `internal.task.create` 的完整参数契约 | **未完整读**，只确认了 `execution_requests` / `task_payload_params` 的存在 |
| MusePi 冷复活在长链上的稳定性 | **未验证**。`persisted-revive` 的注释提到"bare reopen 会复活出错误的顶层会话"，需要实测 |
| 三个截图的界面细节 | 已 OCR，但 UI 文案随版本变化，不要当作契约 |

---

## 15. 一句话交接

**要补的不是第三层，是一份台账 + 一个队列 + 一条授权规则。** 会话能力我们已经有（落盘、冷复活、寻址、唤醒），缺的是让这些会话"有身份、有状态、有人能找到它"的那层薄薄的记录。
