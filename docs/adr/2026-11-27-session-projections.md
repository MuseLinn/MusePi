# ADR: Host-computed session projections

- Status: accepted

## English

## 50a. Session projections: host-computed read models

**Contract:** a surface that needs log-derived session state (context occupancy,
spend, counts) reads a host-computed projection — it never polls an RPC and never
folds domain events itself.

- **Unit** (`packages/coding-agent/src/session/session-projections.ts`): a `key`,
  `init(seed)`, pure `apply(state, event)`, `view(state)`, optional `viewEquals`,
  and an optional `sample(state, source)` gated by `sampleOn`. Unrelated events
  must return the same state reference.
- **Who registers**: the registry is an L2 **service**
  (`daemon/services/session-projection-service.ts`, key `sessionProjections`),
  named after dsh's `ctx.sessionProjections`. It owns driving and storage and
  names no domain. Each domain service registers the unit it owns, from its own
  `start`, reading the registry straight off the host context the way dsh's
  `static inject` works: `goals` and `planMode` both contribute `sessionMode`,
  `session-tree` contributes `contextUsage`. An unresolvable dependency throws,
  so the mount fails instead of the service running without its read-model
  contribution.
- **A handle, not a disposer**: `register` returns dsh's
  `ProjectionHandle` — `stateOf(sessionId)`, `viewOf(sessionId)`, `dispose()`.
  `stateOf` is what stops a domain from keeping a second copy of the facts it
  declared; a withdrawn unit serves nothing, so a disabled domain reads as
  absent rather than stale. Goal and plan mode are recorded in the journal like
  the TUI does (`appendModeChange` on every switch) and folded back on resume by
  `restoreModeFromJournal`, because the switches live only on the live
  AgentSession and a fresh resume starts with both off. Every restored value is
  treated as untrusted: plan without a path stays off (the proposal flow could
  never complete) and a half-written goal record restores nothing.
- **Isolation**: `seed` and `applyEvent` catch per unit. A throw
  inside one unit used to abort the whole loop, so every later unit silently
  vanished from the baseline — a partial `SessionStats` object was enough to
  lose the mode badges entirely. A unit that cannot seed is absent for that
  session and the next `applyEvent` gives it another chance.
- **Drive**: `SessionProjectionRegistry.applyEvent` folds every unit once per
  committed wire event; only a changed view yields a change. `sampleOn` is the
  boundary set (`turn_end`, `agent_end`, `auto_compaction_end`,
  `session_leaf_moved`, `model_changed`) where the unit may read live anchored
  stats — never per streaming tick.
- **Carrier**: a baseline (`SessionProjectionSnapshot`) rides `session.resume` /
  `session.subscribe`; every later change travels as a `kind:"projection"`
  stream envelope with whole values (`{ changes: [{ key, value }] }`).
- **Client**: `GuiSessionStore` keeps `projections: ReadonlyMap<string, unknown>`
  in `GuiSessionState`; `useSessionProjection(store, key)` is the key-addressed
  reader. `undefined` means the key has not landed.
- **What it replaces**: `contextUsage` is now pushed; the wide `/context` facets
  (threshold, snapcompact, breakdown) stay a one-off user-initiated RPC.
- **State with no journal record still rides the seam**: goal and
  plan switches live only on the live `AgentSession` — `session.setGoal` /
  `session.setPlan` write them with no wire event — so a unit that folds
  committed events would never see them. The `sessionMode` unit therefore has an
  empty `apply` and does all its work in `sample`, gated on a daemon-only
  `session_mode_changed` boundary (the same shape as `model_changed`). The RPC
  handlers call `DaemonSessionHost.publishSessionModeProjection` after writing,
  so the change is pushed in the same tick that answered the caller — including
  a switch flipped by the TUI or another device, which a client previously could
  only learn by polling `session.modes`. `init` seeds from the live source so a
  freshly opened surface shows the real switches in its baseline instead of
  "no goal, no plan" until the next write. Goal off projects as `null`, not as a
  disabled record, because the badge keys off `goal === null`.

**Verification:** `packages/coding-agent/test/session-projections.test.ts`
(fold, retry replacement, boundary sample),
`packages/coding-agent/test/daemon/session-mode-projection.test.ts` (mode write
publishes, unrelated events stay quiet, unchanged sample publishes nothing),
`apps/desktop/test/session-projection-store.test.tsx` (resume seed, pushed
change, keyed re-render).

## 中文

## 50a. 会话投影：host 计算的读模型

**契约**：需要日志派生状态的界面（上下文占用、花费、计数）读取 host 计算的投影，
既不轮询 RPC，也不在客户端折叠域事件。

- **单元**（`packages/coding-agent/src/session/session-projections.ts`）：`key`、
  `init(seed)`、纯函数 `apply(state, event)`、`view(state)`、可选 `viewEquals`，
  以及由 `sampleOn` 门槛控制的可选 `sample(state, source)`。无关事件必须返回同一
  state 引用。
- **谁负责注册**：注册表是一个 L2 **服务**
  （`daemon/services/session-projection-service.ts`，key `sessionProjections`），
  命名对齐 dsh 的 `ctx.sessionProjections`：负责驱动与存放，不认识任何具体域。
  每个域服务在自己的 `start` 里注册它拥有的单元，注册表直接从宿主 Context 上读——
  与 dsh 的 `static inject` 同一语义：`goals` 与 `planMode` 各自贡献
  `sessionMode`，`session-tree` 贡献 `contextUsage`。依赖解析不到时直接抛错，
  挂载失败，绝不让服务在缺读模型贡献的状态下跑起来。
- **返回的是句柄，不是 disposer**：`register` 返回 dsh 的
  `ProjectionHandle`——`stateOf(sessionId)`、`viewOf(sessionId)`、`dispose()`。
  `stateOf` 正是让域不必在单元旁边再存一份自己声明的事实的机制；撤销后的单元什么
  都不返回，因此停用的域读起来是「缺席」而不是「过期」。goal 与 plan 模式现在和
  TUI 一样写进日志（每次切换 `appendModeChange`），并由 `restoreModeFromJournal`
  在恢复时折叠回来——因为这两个开关只存在于 live AgentSession 上，新恢复的会话两者
  都是关闭的。恢复的每个值都当作不可信输入：没有路径的 plan 保持关闭（提案流程无法
  完成），写到一半的 goal 记录什么都不恢复。
- **隔离**：`seed` 与 `applyEvent` 都按单元捕获异常。此前一个单元抛错
  会中断整个循环，于是它之后的每个单元都从基线里静默消失——一个不完整的
  `SessionStats` 就足以让模式徽标全部消失。无法播种的单元在该会话里缺席，下一次
  `applyEvent` 会再给它一次机会。
- **驱动**：`SessionProjectionRegistry.applyEvent` 对每个已提交 wire 事件把全部单元
  折叠一次；只有 view 变化才产出 change。`sampleOn` 是边界集合（`turn_end`、
  `agent_end`、`auto_compaction_end`、`session_leaf_moved`、`model_changed`），
  单元只在这些边界读取实时锚定统计，绝不在流式 tick 上采样。
- **载体**：baseline（`SessionProjectionSnapshot`）随 `session.resume` /
  `session.subscribe` 下发；之后每个变化走 `kind:"projection"` 流信封，携带整值
  （`{ changes: [{ key, value }] }`）。
- **客户端**：`GuiSessionStore` 在 `GuiSessionState.projections` 保存
  `ReadonlyMap<string, unknown>`；`useSessionProjection(store, key)` 是按键读取器，
  `undefined` 表示该 key 尚未落地。
- **取代关系**：`contextUsage` 现在走推送；更宽的 `/context` 字段（阈值、
  snapcompact、breakdown）仍是用户显式打开时的一次性 RPC。
- **没有 journal 记录的状态也走这条缝**：goal 与 plan 开关只存在于
  live `AgentSession` 上——`session.setGoal` / `session.setPlan` 写入时不产生任何
  wire 事件——所以「折叠已提交事件」的单元永远看不到它们。`sessionMode` 单元的
  `apply` 因此是空的，全部工作在 `sample` 里完成，由 daemon 私有的
  `session_mode_changed` 边界触发（与 `model_changed` 同一形状）。RPC handler 写完后
  调用 `DaemonSessionHost.publishSessionModeProjection`，所以变化与被调用方拿到应答
  在同一 tick 内推送——包括由 TUI 或另一台设备翻动的开关，而此前客户端只能靠轮询
  `session.modes` 才知道。`init` 从实时源播种，新打开的界面在 baseline 里就是真实
  开关状态，而不是等到下次写入前一直显示「无目标、无计划」。goal 关闭时投影为
  `null` 而非一条 disabled 记录，因为徽标以 `goal === null` 判型。

**验证**：`packages/coding-agent/test/session-projections.test.ts`（折叠、重试替换、
边界采样）、`packages/coding-agent/test/daemon/session-mode-projection.test.ts`
（模式写入即推送、无关事件保持安静、同值不重复推送）、
`apps/desktop/test/session-projection-store.test.tsx`（resume 播种、推送变更、按键
重渲染）。
