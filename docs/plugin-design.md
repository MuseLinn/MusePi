# DSH 式插件化设计(MusePi)

> 状态:方向设计稿。2026-08-20 调研 dsh-TUI(Cordis 插件生态)后立项;
> 本文件定义核心边界、接缝清单、可逆卸载契约与阶段路线,供后续实现对齐。

## 1. 背景与目标

dsh-TUI(ccch1mneyyy/dsh-TUI)证明了一件事:agent TUI 可以靠 Cordis 插件
profile 挂载获得 UI 与行为扩展,且零核心改动 —— 插件契约仅三面:
`name` / Config Schema / `apply(ctx, config)`,接缝 13 类。

但 DSH 生态有两条不可接受的缺陷:

1. **卸载不可逆**:ledger 存在 `cleanup-failed` 路径;`cordis.patch.yml`
   补丁面本质上是核心代码的补丁,没有卸载语义。
2. **改写型决策事件**:拦截/改写输入、rewind、压缩等事件允许插件
   mutate 核心状态,边界靠约定而非机制。

MusePi 的目标不是"复刻 Cordis",而是**在已有的扩展体系之上**,按
"核心有边界、插件不触碰核心、卸载必可逆"三原则,把插件化推进到
TUI 与核心决策面,同时保留现有更强保障:

- 回滚快照(`~/.musepi/extension-backups/`,load/reload 成功即快照,保留 5 份)
- slot 命名空间(内核级 `panel.tab.` / `settings.tab.` 等前缀)
- fail-loud 错误展示(`.gui-slot-error` 块,编译错误可见可滚动)
- `node:vm` 受限 realm 沙箱(process/require 天然缺席)
- `extension_rollback` RPC(恢复最新快照 + 重载会话)

## 2. 核心边界(不可触碰清单)

以下能力**不在任何接缝中**,插件没有读写入口,卸载即彻底消失:

| 能力 | 现有实现 | 插件接触方式 |
|---|---|---|
| 会话生命周期 | daemon `DaemonSessionHost`(create/resume/close/delete) | 无 |
| agent loop | `@musepi/pi-agent-core` agent-loop | 无 |
| 暂停 gate | `AgentPauseGate` + sidecar 持久化 | 只读状态(观察) |
| 权限链 | `pi-muselinn-harness` 18 级链 + daemon approval bridge | 只 veto / observe |
| 压缩策略 | `compaction/` 模块 | 无(或配置项,不改实现) |
| journal / MaterializedView | `AppendJournal` + sdk view | 只读(观察事件) |

原则:**接缝封闭、只增不改**。新增接缝走白名单评审;任何补丁面
(改核心源码后加载、`patch.yml` 形态)一律禁止 —— 这是与 cordis 的
根本分界。

## 3. 现有基础(已具备的接缝)

| 接缝 | 形态 | 位置 |
|---|---|---|
| GUI 面板 tab | `panel.tab.<id>` slot 组件 | `packages/gui/src/lib/slot-host.tsx`(前缀常量 :35-45) |
| GUI 设置 tab / item / action | `settings.tab.` / `settings.item.` / `settings.action.` | 同上 |
| GUI rail | `rail.<id>` | 同上 |
| 扩展装载 | daemon `extension_load/reload/unload` RPC | `server.ts` |
| 扩展扫描根 | `<agentDir>/extensions` + `<cwd>/.musepi/extensions` | `server.ts:2848` |
| 沙箱 | `node:vm` realm,async 悬挂宿主竞速 | `extension-sandbox.ts` |
| 编译 | 扩展源码 → dist bundle | `extension-artifact-compiler.ts` |
| 回滚 | sha1(入口)12 位 bucket,最近 5 份,`extension_rollback` | `extension-lifecycle-tools.ts` |
| 审批 | `approval-request` envelope(天然 veto 点) | `approval-bridge.ts` |
| 设置贡献 | `registerSetting`(扩展合并进 settings.schema) | daemon host 级 |

## 4. 接缝清单(目标态,按 DSH 13 类映射)

DSH 的 13 类接缝映射到 MusePi 目标接缝(新增标 ★,核心观察类标 ◈):

| 类别 | MusePi 接缝 | 现有/新增 | 插件能力 | 卸载 |
|---|---|---|---|---|
| 命令 | slash 命令注册(`discovery.slashCommands`) | 现有(CLI) | 追加命令 | 移除即消失 |
| 设置 | settings.schema 扩展键 | 现有(GUI) | 追加 schema | 移除即消失 |
| 状态行 | 状态行组件贡献 | ★ | 追加段 | 移除即消失 |
| 主题 | theme token 覆盖 | ★(只增 key) | 追加 token | 移除即消失 |
| 快捷键 | keybindings 追加 | ★ | 追加绑定(不可覆盖内建,冲突拒绝) | 移除即消失 |
| 面板 | GUI slot 体系 | 现有 | 追加组件 | 卸载即摘 |
| 通知 | 通知通道 | ★ | 追加通道 | 移除即消失 |
| 决策(veto) | approval/拦截事件 | 现有 + ★ | **只返回放行/否决/注入** | 移除即失效 |
| 决策(observe) ◈ | agent/journal 事件流只读订阅 | ★ | 观察不 mutate | 移除即失效 |
| 工具 | 自定义工具注册(`customTools`) | 现有 | 追加工具 | 移除即消失 |
| 技能 | skills 目录 + 扩展 `_source` | 现有 | 追加技能 | 移除即消失 |
| 服务 | 后台任务/定时器 | ★(隔离域) | 追加任务 | 停止+移除 |
| 渲染 | 渲染器替换 | **禁止** | — | — |

### 决策点契约(核心)

- 决策点只允许三种返回:`pass`(放行)/ `veto`(否决,附理由)/ `inject`(注入参数,
  如工具参数覆写,但核心语义字段只读)。
- **禁止**:改写会话状态、改暂停 gate、改权限链判定结果、改压缩阈值、
  替换渲染器、拦截消息后吞掉不转发。
- 同一决策点多个插件:veto 优先,冲突拒绝(本地优先纪律,DSH 同款)。

### 文件型贡献的卸载语义

- 命令/settings/技能/主题/工具:贡献来自扩展目录文件 → **删目录即消失**,
  无注册表残留(与 DSH 的"本地优先 + 卸载即摘"一致,但比 cordis 更干净:
  无 cleanup-failed 概念,因为无中心 ledger)。
- 运行时贡献(组件挂载、任务、服务):卸载 RPC 触发 detach/stop,
  失败 = 挂载点残留 + fail-loud,绝不静默。

## 5. 可逆卸载契约

1. **快照先行**:每次 `extension_load/reload` 成功即快照到
   `~/.musepi/extension-backups/<sha1(入口)12>/<ts>/`,保留 5 份(现有)。
2. **回滚 = 恢复 + 重载**:`extension_rollback` 恢复最新快照并重载会话,
   修复损坏的新版本(现有,已 E2E)。
3. **TUI 同权**:上述 RPC 已可被 TUI 调用;阶段二为 TUI 补齐卸载确认流
   (影响面预估 + 快照提示)。
4. **无补丁面**:回滚只作用于扩展产物目录,永不触碰核心源码。

## 6. 阶段路线

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0(现状基线) | GUI slot + extension 装载/回滚/沙箱已可用 | E2E 已覆盖 |
| P1 | 决策 veto/observe 接缝(approval 扩展化 + agent 事件只读订阅) | 插件可 veto 工具执行;卸载后核心行为逐位不变 |
| P2 | TUI 接缝:状态行/快捷键/命令追加 | TUI 与 GUI 同源扩展装载 |
| P3 | 主题 token 追加 + 通知通道 | 主题贡献删除即还原 |
| P4 | 服务/定时器隔离域 | 卸载即停,无残留进程 |

每阶段验收必须含:**回滚/卸载后核心行为快照对比**(会话创建、暂停、
权限链判定、压缩触发各跑一次对照)。

## 7. 非目标(明确不做)

- cordis.patch.yml 式补丁面(核心源码补丁) —— **禁止**。
- 渲染器替换/核心组件覆写。
- 插件可改暂停/权限/压缩的判定逻辑。
- 插件持久化共享状态进入 journal 主键空间(状态只进插件自己的
  隔离域,卸载即弃)。

## 8. 风险与已知边界

- `node:vm` 沙箱是**行为约束,非安全边界**(同进程信任模型,文档明示)。
- 同 slot 多扩展冲突:拒绝加载并告警(本地优先纪律),不静默覆盖。
- 回滚快照只覆盖扩展产物,不含插件自建数据 —— 插件数据域文档要求
  自含清理入口,卸载 RPC 调用之,失败 fail-loud。
