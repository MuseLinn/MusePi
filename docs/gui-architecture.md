# MusePi GUI 架构设计(草案)

> 状态:设计定稿(综合更新),实施前置条件推进中。TUI 整合与 i18n 全面落地已完成(commit `742e1c2` / `c20b6bd` / `287dd65`),开工前置清单见第 7 节。
> 日期:2026-08-01(2026-08-02 综合更新:新增 BitFun 参照、collab 协议复用决策、远程访问三层架构、四步实施路径;界面布局原型见 `docs/gui-prototype.md`)

> ## ⚠️ 现状更新(2026-08-04):GUI 已交付,本文档为历史设计稿
>
> - 桌面端已作为 **Electron 应用**交付(`packages/gui`,非本文档规划的 Tauri;实现决策记录在 `docs/gui-migration.md` 的现状更新里)。
> - Phase 1-3(协议提取 / SDK / daemon)与 Phase 4-6(工作台、输入通道、设置面板等)已按本文档的方向落地,但具体形态以代码为准。
> - 设置面板 / 主题体系 / 磨砂玻璃的**当前设计参考**见 **`docs/gui-settings.md`**(2026-08-04,与实现同步)。
> - 第 2、3、5、6 节的内容(参照分析、技术选型、里程碑)保留作为设计决策历史;涉及 Tauri、Zustand、"未开工" 的表述均已过时。


## 1. 背景与定位

MusePi 现有产品形态是 TUI(terminal UI)。本设计规划一个**完整桌面级 GUI 应用**,与 TUI 并行,共享同一套 agent 核心。

定位划分:

| 形态 | 定位 | 状态 |
|---|---|---|
| TUI | 主界面,功能完整 | 基本完成(i18n 全面落地) |
| collab-web | 轻量会话分享 guest client | 保留,独立演进 |
| **MusePi GUI**(本设计) | 桌面级完整 GUI,品牌化产品 | 设计完成,未开工 |

## 2. 参照分析(kimi-code / opencode / openchamber / BitFun)

四个参照 repo 的通信架构对比(分析日期 2026-08-02):

| 维度 | kimi-code | opencode | openchamber | BitFun |
|---|---|---|---|---|
| 前端 | Vue 3 + Vite | SolidJS + Astro | React + Vite | React(web-ui)+ Tauri 桌面壳 |
| 后端 | Node + DI Scope | Bun + Effect-TS | Bun + Express | **Rust workspace**(agent runtime) |
| 协议 | REST + 单 WS | REST + SSE + WS | HTTP/2 + SSE + WS | relay WebSocket + 自建 relay-server |
| 进程模型 | 单进程 | CLI + 独立 server daemon | Electron in-process backend | Tauri + embedded relay host |
| 状态 | CRUD,前端重写 wire types | journal + Drizzle + SQLite | sync-state + shared stores | sync_state(多端同步) |
| 多端 | CLI + web + vscode | console + desktop + web | web + electron + vscode + mobile | desktop + web + mobile + miniapp |
| 远程访问 | — | — | **Cloudflare Tunnel**(quick / managed-remote / managed-local + TTL) | **ngrok + LAN 直连 + pairing + 二维码 + 自建 relay** |
| 能力发现 | `/meta`(capabilities + effective experimental_flags) | —(能力隐式) | —(能力隐式) | —(能力隐式) |

> kimi-code 上游同步(2026-08-01,`76488747..e22479a6`):`/meta` 新增 `experimental_flags`(#2417)——flag 状态是**每次请求实时解析**的 effective snapshot;另有暗色 mono composer 主题修复(#2083)。

### BitFun 深入分析(`src/crates/services/services-integrations/src/remote_connect.rs`)

BitFun 是「Rust Agent Runtime + Tauri 桌面壳 + 多端」的平台型 agent 应用,其 remote-connect 模块是远程访问的完整参考实现:

- **ngrok 隧道**:自动发现二进制(which + `/usr/local/bin` + `~/.ngrok/ngrok` 等候选路径)、进程生命周期管理(static PID + 应用退出时同步 kill)、tunnel URL 解析。
- **LAN 直连**:`get_local_ip` / `list_local_ips` + `build_lan_relay_url`——**局域网内不走公网 relay,零依赖**。
- **pairing + encryption**:配对流程 + `KeyPair` 非对称加密;`qr_generator` 生成配对/连接二维码。
- **relay_client / relay_http**:中继 WebSocket 生命周期 + HTTP 通道;`sync_state` 多端状态同步;`device` 设备身份。
- **自建 relay-server**(Rust,含 relay_admin 管理二进制):不依赖第三方中继。
- **多端**:desktop(Tauri,embedded relay host)+ web-ui + mobile-web + miniapp-market-web("Infinite Radius":桌面/浏览器/移动/可穿戴)。

#### 客户端架构(源码验证,2026-08-02)

| 维度 | BitFun | 本设计 |
|---|---|---|
| 前端 | React + Vite(web-ui:Monaco / TanStack Virtual / tiptap) | React + Vite + Zustand |
| 前后端通信 | **Tauri IPC invoke**(进程内) | **JSON-RPC**(unix socket / WS 可插拔) |
| 进程模型 | **in-process**(Tauri 主进程内跑 Rust runtime + embedded relay host;UI 崩 agent 即死) | **独立 daemon**(`musepi serve`;UI 崩 agent 存活) |
| 远程 | 远程端(web/mobile)是独立 web 应用,经 remote_connect(ngrok/LAN/relay)连回 desktop | 同一 daemon 双传输面:本地 unix socket + 远程 relay/tunnel |
| 后端组织 | Rust commands **60+ 领域 API 模块**(`desktop/src/api/`:terminal/lsp/git/mcp/session/subagent/browser/computer_use/remote_connect/canvas/ssh/worktree/cron/dispatch/relay_deploy…) | TS daemon,Phase 2 RPC 方法表按工具领域分组(借鉴其切分法) |

结论:BitFun 的“前后端分离”是**代码层**的(React ↔ Rust commands 按领域切分),**进程层不分**(与 openchamber 的 Electron in-process 同族)。本设计保留 daemon 决策——BitFun 因 in-process 导致多端远程时被迫补 embedded relay;我们一步到位,本地 Tauri 壳与远程 web 连同一 daemon。其领域 API 切分法(每工具一 command 模块)值得 Phase 2 方法表借鉴。

### openchamber 远程访问深入分析(`packages/ui/src/components/sections/openchamber/TunnelSettings.tsx`)

- **Cloudflare Tunnel 三模式**:`quick`(临时 quick tunnel)/ `managed-remote`(CF 面板托管)/ `managed-local`(本地 `~/.cloudflared/config.yml`)。
- **TTL 控制**:bootstrap TTL(30m–24h)+ session TTL(1h–30d)。
- **QRCode 库**生成连接二维码;Electron 壳 + opencode daemon。

结论:四个参照各有侧重——**opencode 的独立 daemon 模型 + openchamber 的多端共享 + kimi-code 的简洁 API + BitFun 的完整远程访问(ngrok/LAN/relay/QR)+ 三者都缺的完整 event sourcing** = 本设计的目标。

## 3. 技术栈选型

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | **Tauri + React** | 体积小;musepi-omp 已有 Rust crates(pi-shell/pi-walker/pi-ast/pi-natives);React 与 collab-web 共享组件与 i18n |
| 前端 | React + Vite + Zustand/Jotai | 生态最大;aicss.dev 组件可直接复用 |
| 协议 | **JSON-RPC 2.0**(唯一方法表) | 会话/流/取消/订阅语义 REST 表达不了 |
| 类型 | **TypeBox schema 单一真源 → 代码生成 TS + Rust** | 前后端类型零漂移,边界运行时校验 |
| 进程 | **独立 daemon**(`musepi serve`) | UI 崩溃不影响 agent;多端并发;远程访问可升级 |
| 状态 | **Event sourcing**(append-only journal + 物化视图) | 增量推送、崩溃恢复、多端一致、可回放 |
| 持久化 | SQLite + WAL(物化视图缓存)+ journal 快照压缩 | 日志与状态分离 |
| 安全 | unix socket / named pipe + token(keychain) | 本地进程间通信;远程访问时才升级 TLS + OAuth |

## 4. 目标架构

```
┌─────────────────────────────────────────────────────────┐
│                     客户端层 (Shells)                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ Tauri    │ │ Web SPA  │ │ CLI/TUI  │ │ 移动端   │    │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘    │
│  ┌────▼────────────▼────────────▼────────────▼─────┐    │
│  │            @musepi/sdk (唯一契约)               │    │
│  │   类型: TypeBox schema → TS + Rust 代码生成      │    │
│  │   方法: JSON-RPC 2.0 方法表 (唯一 API surface)   │    │
│  └────┬────────────┬────────────┬────────────┬─────┘    │
│   (in-proc)    (stdio)     (WS/TCP)     (HTTPS+SSE)     │
└───────┼────────────┼────────────┼────────────┼──────────┘
        │       传输层: 可插拔, 协议不变, 类型不变        │
┌───────▼────────────▼────────────▼────────────▼──────────┐
│                   核心层: musepi daemon                 │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Domain Core (纯逻辑, 零 I/O 依赖)               │   │
│  │  - agent loop 状态机 / 会话 / 消息 / 工具调用      │   │
│  │  - 权限链 / 审批 / goal / plan / todo 编排         │   │
│  └───────────────────────┬──────────────────────────┘   │
│                          │ 命令 → 事件                  │
│  ┌───────────────────────▼──────────────────────────┐   │
│  │  Event Sourcing 核心                             │   │
│  │  - Append-only journal (每条状态变更是一条事件)   │   │
│  │  - 物化视图: 从事件流重建当前状态                 │   │
│  │  - 快照 + 增量: 压缩历史, 保持可回放             │   │
│  └───────────────────────┬──────────────────────────┘   │
│  ┌───────────────────────▼──────────────────────────┐   │
│  │  副作用层 (adapter)                              │   │
│  │  - LLM provider calls / 工具执行 / 文件监听       │   │
│  │  - 持久化: SQLite (物化视图) + journal           │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 设计决策(与参照 repo 的差异)

1. **JSON-RPC 而非 REST**——`session.cancel`、`session.subscribe`、流式 delta 是 agent 场景的一等公民;REST 无法表达。
2. **daemon 而非 in-process**——openchamber 的 Electron in-process 是妥协:UI 崩溃 agent 即死。daemon 让 Tauri 壳/Web/CLI 都只是客户端。
3. **event sourcing 而非 CRUD**——会话本质是事件流(用户消息、assistant delta、tool call、tool result、审批)。journal 是唯一真源,SQLite 只是物化缓存。
4. **类型生成而非手写**——kimi-code 前端被迫重写 wire types 是反面教材;TypeBox 单源生成 TS + Rust。
5. **保留能力发现层**(`system.capabilities` + `system.features` JSON-RPC 方法)——kimi-code 的教训是 UI 侧实验功能必须服务端门控:capabilities 描述能力,feature flags 暴露 effective snapshot(env/配置/默认多源合并、每次请求实时解析,参照 kimi-code `/meta` `experimental_flags`)。GUI 端据此隐藏/禁用未就绪功能,老服务端缺字段视为全部关闭。
6. **传输层复用 collab,不重写**——collab 的协议(`COLLAB_PROTO` + envelope)、E2E 加密(room key 永不出 URL fragment,WebCrypto)、host/guest 状态机、`replication-shrink` 增量压缩同步、TUI 终端二维码(`collab-qrcode.ts`)已是生产级资产,直接提取为独立协议包(`@musepi/collab-proto`)作为 **GUI 远程访问层与 collab guest client 的共用契约**,而不是另写一套。collab-web 保留为「轻量只读/可写分享」形态,与完整 GUI 并行、共享同一协议。
7. **远程访问三层架构**(按需选择,默认 LAN → relay → tunnel):
   - **LAN 直连**(BitFun 模式):`get_local_ip` + 局域网 relay URL,零依赖零穿透;
   - **自建/现有 relay**(collab 现有 `my.omp.sh` 模式,可换 BitFun 式自建 relay-server):端到端加密,数据过中继但不落地;
   - **公网 tunnel**(openchamber Cloudflare Tunnel 三模式 / BitFun ngrok):广域网远程,TTL 控制。
8. **二维码扫码即连,免凭证**——collab 的 room key 在 URL fragment 中永不出网,天然免凭证;登录/配对页打 QR(含 session key + token),扫码即连——直接解决「kimi web --host + tailscale 需提前记凭证」的痛点。

## 5. 实施里程碑(依赖顺序:协议提取 → daemon → 状态 → 端 → 远程)

> 前置条件:**基础 TUI 工程整合调试完成**(Phase 0,进行中;TUI + i18n 已完成,见第 7 节清单)。

| 阶段 | 内容 | 目标 |
|---|---|---|
| Phase 0 | 完善基本 TUI 功能,整合 musepi-omp 基础工程 | **当前进行中** |
| Phase 1 | **提取 collab 传输层**为 `@musepi/collab-proto`:protocol / encryption / relay-client / QR;加 LAN 直连 + 可选 cloudflared/ngrok 隧道适配;collab guest 与 TUI 切到新包(兼容验证) | **✅ 提取完成**:crypto/link/socket/qrcode 已入包(browser-safe 零 agent 依赖),host(coding-agent)与 guest(collab-web)已切换,回归 77+12 全过;⚠️ 同步修复二项:(1) 17.2.4 移植时误删 kill 路径 `tombstone: true`(worker diff 方向读反)导致 read-only 测试超时,已恢复;(2) 机械审计(advisory 建议,逐文件 diff vs 上游 v17.2.4+rename 过滤已知定制)发现 `main.ts` 未吸收上游 17.2.4 的「host 分类提前」fix(DB busy timeout:classify host before opening auth storage)——已按上游顺序重排(分类 → authStorage → settings:init),`--version` 冒烟通过;其余 17 个文件差异全部确认为已知定制(wire-guard/i18n/.musepi/branding);⏳ **LAN 直连 + 隧道适配待立项**(协议层之上:host 端 WS server 模式 + cloudflared/ngrok 生命周期管理,参考 BitFun remote-connect/openchamber TunnelSettings) |
| Phase 2 | `@musepi/sdk` 协议层:TypeBox schema + JSON-RPC 方法表 + 事件类型(覆盖增量/取消/重连/审批/subagent 事件) | **✅ 完成**(48 方法 + 事件契约,见下方索引与事件契约) |
| Phase 3 | `musepi serve` daemon + Event sourcing journal + 物化视图 + SQLite | **✅ Phase 3 全部落地**——daemon 最小面 + wire journal + 物化视图 + resume 续流 + 生命周期 + journal 压缩 + 跨会话查询 |
| Phase 4 | Web SPA(React,复用 collab-web 组件与 i18n)+ Tauri 壳(aicss.dev 组件) | 第一个可运行 GUI |
| Phase 5 | 输入通道(prompt / ask 可视化 / 工具交互 / 审批弹窗)+ 远程连接页(二维码扫码) | 双向可用 + 远程可用 |
| Phase 6 | 文件预览 / 设置面板 / 会话历史 / 多 workspace / subagent 视觉面板 | 完整 GUI |
| Phase 7 | 品牌化:cuelume 音效 + border-beam 高光(仅限 1-2 个场景) | 氛围层,最后做 |

> 界面布局与交互原型(信息架构、页面线框、组件复用映射)见 **`docs/gui-prototype.md`**——原型设计先行,Phase 4 前端开发直接按原型落地。

#### Phase 2 方法表索引(`packages/sdk/src/methods/`,schema 为唯一真源,本表仅索引)

| 领域 | 方法(48) | 鉴权分布 | impl 来源 |
|---|---|---|---|
| system | capabilities / features / meta | public×3 | daemon 自描述(决策 5,kimi /meta 模式) |
| session | list / subscribe / cancel / resume / send / fork / branch / abort / archive / rename / label / tree | session×5, local×7 | `AgentSession.sendUserMessage/steer/followUp/fork/branch/abort` + `SessionManager.getTree()` + replication-shrink(重连) |
| agent | list / progress / attach / message / terminate | session×3, local×2 | `AgentRegistry` / `AgentLifecycleManager` / event bus |
| tool | list / call / approve / deny | session×2, local×2 | 工具注册表 + 18 级权限链审批流 |
| permission | policy / set / grant | session×1, local×2 | 权限链(写仅本地) |
| provider | list / switch / models | session×2, local×1 | `ModelRegistry` / `AgentSession.setModel()` |
| settings | get / set | session×1, local×1 | `config/settings.ts` |
| collab | status / host / stop | session×1, local×2 | `CollabHost` + `collab-qrcode` |
| extended(宽松 schema) | file.read/write/tree、terminal.open/write、goals.list、todo.list、task.submit/progress、stats.usage、autoresearch.dashboard/init/run | 混合 | workspace-tree / autoresearch / omp-stats / task 编排 |

鉴权规则:**状态/生命周期写 = `local`**(tunnel 只读边界由方法表闭环);只读查询与会话内 prompt/approve = `session`;能力发现 = `public`。

**事件契约**(`packages/sdk/src/events.ts`,对齐架构风险第 1 条五种语义):**信封 TypeBox 运行时校验**(kind + 单调 `seq`),**载荷按引用接 pi-wire 类型**(SessionEntry / SessionState / AgentEvent 16 种 / AgentProgress——含 status/currentTool/recentTools 等 subagent 视觉字段 / SubagentLifecyclePayload,不建镜像 schema)。事件:`entry`(增量)/ `event`(AgentEvent)/ `state`(增量)/ `approval-request`(审批,tool.approve/deny 回应)/ `agent-lifecycle` + `agent-progress`(subagent)/ `stream-end`。**取消** = `session.cancel`;**重连** = `subscribe{lastSeq}` 或 `session.resume{cursor}`(seq 游标,快照+增量补齐,`compactedThrough` 标志,镜像 collab replication-shrink)。pi-wire 类型层完整 TypeBox 化 = 决策 4 完全生效路径,列为独立后续工作。

**Phase 3 现状**(2026-08-02):`musepi serve` daemon 最小面已跑通——`src/daemon/server.ts`(unix socket,newline JSON-RPC 帧,复用 launch broker 帧模式)+ `commands/serve.ts`;方法处理器覆盖 system.meta/capabilities/features + session.create/list/subscribe/send/cancel/resume;`DaemonSessionHost` 懒加载真实 `createAgentSession`,事件按 `SessionStreamEvent` 信封(kind+seq)扇出。**TUI 共存决策**(风险第 3 条):首版 daemon 独立于 TUI 运行,会话由 daemon 创建;TUI 是否迁移为 daemon 客户端留待 Phase 4 前定。

**Event sourcing 已落地两段**:
1. **journal**(wire 格式):`src/daemon/journal.ts` — append-only JSONL(`{seq, ts, event}`),事件经 `isWireAgentEvent` 守卫(共享 `collab/wire-guard.ts`)只记 wire AgentEvent,与 SDK 契约/订阅流/物化视图单一格式。`session.send` 驱动真实回合产生事件。
2. **物化视图**:`src/daemon/materialized-view.ts`(投影:wire 事件 → MessageEntry/ThinkingLevelChangeEntry/main-agent 生命周期/isStreaming,message 按 role+timestamp/toolCallId 去重)+ `src/daemon/view-store.ts`(SQLite + WAL 物化缓存,存 snapshot() 产物)。journal 为真源,缓存缺失/落后降级为重放,绝无数据丢失。
3. **重启恢复已验证**:daemon 重启后 `session.list`/`session.resume` 直接读物化缓存(7ms),无需重放 journal。
4. **resume 增量续流**(断线重连):`session.resume{sessionId, cursor}` 返回物化 snapshot 后,按 journal 重放 `seq > cursor` 的增量事件(镜像 replication-shrink 语义),随后才挂接实时订阅——重放与实时严格不重叠(已 E2E 验证:catchup 1..10 → live 从 11 续)。历史会话(已 close)重放 journal 增量但无实时流(`stream: null`,snapshot-only)。
5. **会话生命周期**:`session.close`(sdk 方法表新增)释放运行中 AgentSession(内存/定时器/订阅),journal + 物化视图保留 → 会话转为历史(list 仍可查、resume 走快照);空闲自动回收(live 会话 30 分钟无活动由 host 定时器自动 close);`session.abort` 实现(中止当前回合,不释放会话)。
6. **journal 压缩(快照折叠)**:journal 事件数 > 2000 或 > 4MB 时,把物化 snapshot 折叠为 `<session>.journal.jsonl.checkpoint.json`(原子写),journal 原子截断只留 checkpoint seq 之后的增量;两步顺序保证中途崩溃安全(checkpoint 先写,未截断时重放 = checkpoint + 全量,≤ checkpoint seq 的 apply 为幂等 no-op)。恢复/快照路径统一走 `replaySource()`(checkpoint + 增量);`resume{cursor}` 在 cursor < checkpoint seq 时返回 `compactedThrough: true`(客户端需刷新派生状态)——E2E 验证:折叠到 seq 8 后,resume{cursor:0} → compactedThrough=true + 快照完整 + catchup 补发 9,10;resume{cursor:9} → false + 只补 10。
7. **单测**(`test/daemon/`):materialized-view 投影规则 11 例(message 去重/生命周期/契约形态/持久化往返)+ journal 压缩 7 例(append/readAll 往返、torn-line 容错、compact 折叠、replaySource、幂等压缩、阈值)+ view-store 拆表 7 例。**单测抓到一个真实缺陷**:append 原为 fire-and-forget 异步写,高频事件后立即 readAll/compact 会丢尾部事件——已修为 write 链 + 所有读取前 `flush()`。
8. **跨会话查询物化**(Phase 3 收官):view-store 拆表——`materialized_sessions`(快照 JSON,恢复主路径)+ `sessions`(可查元数据列:cwd/model/message_count/created_at)+ `messages` + `agents`(行级投影,upsert 事务内同步)。查询:引擎拆表与快照同事务写,崩溃时拆表可能滞后于最后快照(节流窗口),但恢复不读拆表——无数据丢失路径。`session.list` 扩展带 model/messageCount/cwd;新增 `session.search{query, limit}`(LIKE 跨会话消息搜索,按会话分组)。E2E:两会话真实回合 → list 带元数据(claude-opus-4-8 / 2 消息 / cwd)、search 命中各自主题、无命中返回空。

**评估结论**(advisory 建议):`agent-storage.ts` 是 auth/stats 的 SQLite,非 journal 候选;SessionManager 的 entries 是物化目标形态但绑定真实 AgentSession 运行时——daemon 物化视图独立实现,不复用 SessionManager。journal 压缩(快照折叠)与跨会话查询物化是下一增量。

## 6. UI 资源评估(来自外部调研)

| 资源 | 用途 | 边界 |
|---|---|---|
| aicss.dev | Agent UI 组件库(实测官网,2026-08-02):Thinking & Reasoning 2 个(Thinking State / Thinking + Reasoning);Tool & Action 3 个(Web Search——带来源列表与链接、File Diff——`+4 -1` 行级 diff、Image Generation);Text Outputs 4 个(Text Response / Streaming Text / Inline Citations——文内引文编号+来源卡 / Code Block);Structured Outputs 3 个(To-do List——`0/5` 勾选进度 / Model / Context)。React/Vue/Svelte 三端,纯 CSS 无 Tailwind | ~70% 可直接用;file diff、image gen 需自研(或对齐其形态) |
| cuelume.dev | 交互音效库(实测官网,2026-08-02):**14 个 cue** —— chime / sparkle / droplet / bloom / whisper / tick / press / release / toggle / success / error / page / loading / ready;Web Audio **实时合成**(无音频文件、零依赖、全部 cue < 5KB);声明式 `data-cuelume-hover/toggle/press/release` 属性 + 一次 `bind()`;`play("success", {volume})` 可编程调用 | Phase 7;仅限 tool 完成 / error / 新消息 / 审批等 1-2 类场景,音量可全局/单次控制 |
| border-beam | 边框光束动画 | 仅限“当前活跃 agent 卡片”等 1-2 个高光场景,禁大面积铺 |
| collab-web 组件(自产) | tool-render 卡片(50+ tool)、Transcript、AgentDrawer、Composer、i18n 框架 | 直接复用为 GUI 对话流与工具卡片;已 78 tests + 346 key 中文 |
| BitFun remote-connect(参考实现) | ngrok 发现/生命周期/LAN 直连/pairing/QR/relay 客户端 | Phase 1 移植,按 musepi 结构重写(不拷 Rust 代码) |
| openchamber TunnelSettings(参考实现) | cloudflared 三模式 + TTL 的 UX 模式 | Phase 1 远程设置面板参照 |

主题 token 经验(来自 kimi-code #2083):**accent 上的前景色不能固定白色**,必须跟随 scheme 背景 token(`color-mix` 或 scheme-bg 映射),否则暗色主题下不可读。GUI 主题系统从第一天就按「accent + on-accent 由 scheme 推导」设计。

## 7. 风险与开放问题

### 启动 GUI 前需完成的前置(Phase 0 收尾清单)

| 前置 | 状态(2026-08-02) | 说明 |
|---|---|---|
| 基础 TUI 整合 | ✅ 基本完成 | 整合调试完成,11865 tests 全绿 |
| i18n 全面落地 | ✅ 完成 | TUI/setup/动画/collab/stats 全量 zh,渲染时求值,双端可切换 |
| 供应商(provider registry) | 🚧 推进中 | 70+ providers 对齐上游 17.2.2;GUI 复用同一 registry |
| 原生视觉理解 | 🚧 推进中 | pi-natives 视觉能力;供 GUI 截图/图像输入使用 |
| swarm 视觉组件 | 🚧 待验证 | 与 OMP 现有 subagent 系统的融合方式待确认(风险见下) |
| 远程访问与二维码 | ✅ 协议已有 | collab 协议/加密/QR 已生产可用;Phase 1 提取为独立包并加 LAN/tunnel |
| 界面原型 | 🚧 设计中 | `docs/gui-prototype.md`(信息架构 + 线框 + 组件映射) |

### 风险

- **协议先行是唯一不返工的路径**:Phase 2 契约必须覆盖 Phase 3+ 的事件语义(增量、取消、重连、审批、subagent),否则后续补协议会破坏类型生成。
- **collab 协议提取的兼容风险**:`@musepi/collab-proto` 提取必须保持 wire 字节级兼容(旧 guest 连新 host 等),否则破坏线上分享。提取后 collab guest 与 TUI 同步切换并回归 78/78。
- **TUI 与 daemon 的共存**:TUI 目前直接驱动 agent loop;引入 daemon 后 TUI 是否改为 daemon 的客户端,还是并行两套驱动,需在 Phase 3 决策。
- **swarm 视觉组件与 subagent 系统的融合**:swarm 的视觉组件(子代理卡片、进度可视化)能否干净地嵌进 OMP 已有 subagent 体系,取决于 subagent 事件流是否暴露视觉所需的状态(阶段/进度/产物缩略)。若事件流缺字段,需在 Phase 2 协议层补事件类型,而不是在 GUI 端打补丁。
- **远程访问的安全边界**:tunnel 暴露的是 daemon 的 RPC 面,必须只开受限方法集(read-only / 会话级),token 在 URL fragment 不落网;tunnel 模式下默认拒绝文件写与设置变更。

### 启动 GUI 前需回答的问题(Phase 0 期间逐步确认)

| 问题 | 选项 | 当前倾向 |
|---|---|---|
| 目标平台 | 纯 Web / Electron / **Tauri** | Tauri(与 Rust crates 协同,体积小) |
| 前端资源 | 专职前端 / 单人全栈 | 未定,影响 Phase 4 排期 |
| GUI 与 TUI 关系 | TUI 替代品 / 并行界面 | 并行,共享 agent 核心 |
| 后端位置 | 本地进程 / 远程 server | 本地 daemon,远程为 Phase 7+ 可选 |
| 数据持久化 | localStorage / SQLite / 云端 | SQLite + journal(本地优先) |
| 桌面打包 | 应用商店分发 / 自托管安装包 | 未定 |

## 8. 文档历史

- 2026-08-01:初始定稿。基于 kimi-code / opencode / openchamber 通信架构调研。**暂缓实施,待 Phase 0(TUI 整合)完成。**
- 2026-08-01:同步 kimi-code 上游 `76488747..e22479a6`(/meta experimental_flags #2417、暗色主题 token #2083)。状态更新:Phase 0 收尾中,开工前置清单见第 7 节。
- 2026-08-02:综合更新——(1) 新增 BitFun 参照(remote-connect 全套:ngrok/LAN/pairing/QR/relay-server)与 openchamber 隧道深入分析;(2) **决策 6:传输层复用 collab 不重写**(提取 `@musepi/collab-proto` 作为 GUI 远程层与 guest client 共用契约);(3) 决策 7/8:远程访问三层架构(LAN → relay → tunnel)+ 二维码扫码免凭证;(4) 里程碑重写为四步路径(协议提取 → SDK/daemon → 壳 → 远程);(5) 界面布局原型拆分为独立文档 `docs/gui-prototype.md`。
- 2026-08-02:**Phase 2 开工**:`packages/sdk` 建包(TypeBox 依赖)+ 方法表 46 方法(9 领域,8 领域完整 schema / extended 宽松),每方法标注 TransportAuth(public/session/local)与 impl 来源(静态面 sdk.ts / 运行时面 AgentSession),鉴权规则「状态写=local」闭环 tunnel 只读边界;tsgo 绿,方法唯一性与鉴权合法性校验通过。Rust codegen 留 Tauri 壳阶段。
- 2026-08-02:BitFun 小节补「客户端架构」分析(源码验证):React+Vite 前端 / Tauri IPC invoke 进程内通信 / in-process 进程模型(与 openchamber 同族,非 daemon)/ 60+ 领域 command 模块;结论:代码层分离但进程层不分,本设计保留 daemon 决策,领域 API 切分法供 Phase 2 RPC 方法表借鉴。
