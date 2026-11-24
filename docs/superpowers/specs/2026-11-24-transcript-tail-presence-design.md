# 转录尾部在场行（Tail Presence）设计

## 意图

参考 OpenMausBot 与 ds-bot 的做法：会话正在工作时，在转录末尾、也就是回复将要落下的位置，显示一行「agent 头像 + 一句会轮换的状态文案 + 计时」，文案带扫光动效；长步骤沉默时可读出「多久没有新输出」，并可展开看清正在跑什么。

现在 MusePi 这个位置只有一个 spinner 加「已工作 N 秒」（`WorkingLine`），它报时间不报在做什么。用户看到的是一根转圈，而不是一个正在干活的 agent。

这一行同时是 bot lane 的地基：bot lane 会有多个并行会话，每个会话各自的转录末尾都需要一个「谁、在做什么、多久了」。组件必须按转录实例化，不持有全局单例。

## 目标

- 转录末尾那一行说明**正在做什么**（读文件 / 搜索 / 写代码 / 跑命令 / 浏览器 / 思考 / 回复），而不只是「在工作」。
- 文案在同一个阶段内轮换同义句，每 4–6 秒一句，不会闪烁、不会跳回主句。
- 计时仍然锚定本轮 user 消息时间戳，切会话不重置（沿用现有 `WorkingLine` 语义）。
- 长步骤沉默时能读出「多久没有新输出」，措辞只陈述事实，不诊断、不报错、不给恢复按钮。
- 行可展开，显示这一轮正在跑的工具与步数。
- 头像由宿主注入，client-core 不依赖桌面端的 `AgentAvatar`。
- bot lane 无需改动本组件即可复用。

## 非目标

- 不改顶栏胶囊、不改 Agent tab、不改 `AgentAvatar` 的绘制。
- 不做「克隆从输入框飞出」这类跨元素飞行。
- 不改多 bot 的会话模型，不引入 bot 身份数据源。
- 不新增用户设置项（见「假设」）。

## 反目标

- 尾部同时出现两个「活的」表面（例如一行 presence 加一条流式计时同时转圈）。
- 用累计计时把正常的长步骤渲染成故障。
- 轮换文案每 5 秒触发一次屏幕阅读器播报。
- 为这一行新造一套浮动层或第二套头像。

## 约束

- `Transcript` 位于 `packages/client-core`，被桌面 `ChatView`、移动端 `TranscriptPane`（`packages/client-core/src/app.tsx`）、`SubagentPanel` 共用；client-core 不得 import `apps/`。
- 动效必须同时受 `.gui-motion-off` 与 `prefers-reduced-motion` 约束，两者都退化为静态。
- 文案全部走 i18n，中英双语成对。
- 计时器只允许一个全局 1s ticker（`useWorkingNow` 已实现）。
- 长时间运行的指示器不得每帧重绘（参考实现的注释里也把这条列为硬要求）。

## 方案

### 采用的方案：尾部在场行，挂在共享 `Transcript` 里

新增 `TailPresence` 组件与 `live-phrase` 引擎，都放在 `packages/client-core/src/components/transcript/`，替换掉「本轮还没有回复」时那个只有计时的 `tr-ghost-working` 槽位。头像与可展开内容由宿主以 props 注入。

```
◐  正在四处查找 · 12s
   ↑ 扫光自左向右扫过文案
```

展开后：

```
◐  正在四处查找 · 12s              ⌄
   ┌────────────────────────────┐
   │ 读取 3 个文件 · 运行 2 条命令 │
   │ Reading  src/app.tsx       │
   └────────────────────────────┘
```

### 已评估但只借动效语言的件

`packages/client/ui-status` 的 `StatusText` 已经实现「两段文案共用一个格子、交叉淡入、`role=status`、motion-off 瞬时切换」。它的语义是**替换**（旧句离场、新句入场），而尾部需要的是**轮换**（同一阶段内来回换同义句、且不能被屏幕阅读器反复播报），两者对 live region 的要求相反。因此不直接复用它，但沿用它的两个做法：同一格承载新旧两句、motion-off 时不播放离场层。

### 未采用的方案

**只升级 `WorkingLine`（原方案 A）**：改动更小，但拿不到进出场、安静态与展开卡，用户明确选择了更完整的一套。

**独立移植 OpenMausBot 的 `TurnPresence` 到桌面端**：功能最全，但与 `Transcript` 的尾部槽位重复了一份，且桌面端的 composer 是浮层，底部再挂一条要重算 inset，容易和现有 tail spacer 打架；移动端与 bot lane 拿不到。

**只改顶部胶囊的文案**：改动最小，但工作时视线在底部，位置不对，也不解决「回复还没出现时那一行是什么」。

## 关键改动

### 1. 工具 → 动词映射下沉到 client-core

`apps/desktop/src/lib/agent-signals.ts` 里的 `activityVerbForTool()` 与 `AgentActivityVerb` 是纯函数与纯类型，现在被头像的动效选择使用，新的文案引擎也要用。按「同一事实出现第二处就收敛」的约束，移到 `packages/client-core/src/lib/tool-activity.ts`，桌面端改为 import 并 re-export，保持既有调用点不变。

映射表沿用现有的：search/grep/glob → searching，read/view/inspect → reading，edit/write/patch/apply → writing，bash/shell/exec/command → running-commands，browser/fetch/http → browsing，computer/mouse/keyboard → using-computer，message/chat/reply → messaging，todo/ask/approval/wait → waiting，其余 → working。

### 2. 文案引擎 `live-phrase.ts`

纯函数，无 React 依赖，便于单测。

```ts
export interface LivePhrase {
  /** 稳定阶段键：同一阶段内轮换，阶段变了才重置。 */
  phase: string;
  /** 首项是规范句（无障碍播报用），其余是同义句（视觉轮换用）。 */
  phrases: readonly string[];
}

export function livePhraseFor(signals: TailSignals): LivePhrase;
export function phraseAt(phrases: readonly string[], seed: string, step: number): string;
export function phraseHoldMs(seed: string, step: number): number;
```

阶段优先级（高到低）：

1. `paused` — 会话暂停
2. `awaiting` — 有待批准项
3. `reply` — 正在流式输出
4. `tool` — 有运行中的工具，按 `activityVerbForTool` 细分
5. `thinking` — 只有 `working`

同义句轮换沿用参考实现的确定性做法：FNV-1a 哈希对「seed + 序号」排序得到固定顺序，`step` 每轮 +1，走完一轮回到规范句，因此同一会话同一阶段的重放顺序稳定、不会两次出现同一句。`phraseHoldMs` 在 4000–6000ms 之间由哈希决定，避免所有会话整齐划一地同时换句。

seed 用 `sessionKey + phase`，保证不同会话、不同阶段的节奏互相错开。

### 3. 扫光动效

文案之上叠一层静态遮罩 + `transform` 位移的亮带，只走合成层，不重绘文字：

- 结构：文案本体 + `aria-hidden` 的遮罩层，遮罩层内一个位移元素，`mask-image: linear-gradient(90deg, transparent 30%, #000 50%, transparent 70%)`，内部用 `transform: translateX()` 扫过。
- 周期 2200ms，线性无限循环。
- 文档不可见时 `animation-play-state: paused`。
- `.gui-motion-off` 与 `prefers-reduced-motion: reduce` 下整层 `display: none`，文案保持常规颜色。

不使用 `background-clip: text` 的位移方案：它每帧重绘文字，长回合（数分钟）下代价明显。

### 4. 安静态

分三档，措辞只陈述事实：

| 距最近一次活动 | 追加文案 |
|---|---|
| < 30s | 不显示 |
| 30s–90s | 「暂无新输出」 |
| ≥ 90s | 「已 N 分钟没有新输出」 |

不出现「卡住」「失败」「重试」等字样，也不出现恢复按钮——这是 `docs/gui-design.md` §3a 已确立的规则：状态行只报正在运行，异常行才报停止，累计计时不得把进行中的操作读成诊断。

计时继续用 `useWorkingNow`，锚点是本轮 user 消息时间戳（`lastUserMessageTs`）。

### 5. 组件 `TailPresence`

```tsx
export function TailPresence(props: {
  avatar?: ReactNode;         // 宿主注入；移动端可省略
  visible: boolean;
  label?: string;             // 阶段词，如「工作中」
  phrase: LivePhrase;
  seed: string;
  since?: number;
  quietMs?: number;
  detail?: ReactNode;         // 可展开卡内容
  detailLabel?: string;
  className?: string;
}): ReactNode;
```

行为：

- **进出场**：进入 220ms（4px 上移 + 淡入，`cubic-bezier(0.22, 1, 0.36, 1)`）；退出 140ms 淡出后卸载。行是列表最后一项，下面没有内容，因此退出不需要滚动补偿。减弱动效下两者都不播放。
- **可展开**：只有传了 `detail` 时文案区是按钮（`aria-expanded` / `aria-controls`），展开区用 `useCollapseHeight`（`packages/client-core/src/lib/use-collapse.ts`）做高度动画，符合「同一高度属性只由一处驱动」的既有规范。Escape 折叠并把焦点还给按钮。
- **无障碍**：可见的轮换文案标 `aria-hidden`；同一行内有一个视觉隐藏的 live region，只装规范句 + 计时，且**仅在阶段变化时**更新，轮换本身不触发播报。整行不重复 `role="status"`。
- **头像**：`avatar` 为空时整行不预留头像位（移动端与无头像宿主）。

### 6. `Transcript` 的接入

- 只在「`working` 且本轮还没有 assistant 条目」时渲染（现在的 `tr-ghost-working` 分支，`Transcript.tsx:3101`），替换其中的 `WorkingLine`。
- 正在流式输出时**不**渲染本行，那条计时继续留在流式消息下方（沿用现有 `WorkingLine`）。理由见「假设」。
- `agentGutter` / `tailOwnsOrb` 的既有逻辑不变：头像归尾部时本行带头像，否则只带文案与计时。
- `Transcript` 新增两个可选 props：`tailAvatar?: ReactNode`、`tailDetail?: ReactNode`。不传则退化为无头像、无展开卡，移动端与 `SubagentPanel` 无需改动即可编译通过。

### 7. 宿主注入

- `ChatView` 传 `tailAvatar={<AgentAvatar state={orb} size={28} signals={agentSignals} seed={store.sessionId} />}`，与胶囊同一档 28px，保持「一个身份」的视觉。
- `tailDetail` 传本轮尚未渲染的工具摘要：复用 `tailTools`（`Transcript.tsx:2652` 已算出「尚未出现在已提交行或流式行里的运行中工具」）与 `RoundFold` 的计数，渲染成「读取 N 个文件 · 运行 M 条命令」加当前工具名，不新造数据管线。

### 8. i18n

`packages/client/locale/src/client/{zh-CN,en-US}/transcript.ts` 新增：

- `transcript.phase.*`：thinking / reading / searching / writing / commands / browsing / computer / messaging / waiting / reply
- `transcript.phase.*.alt`：每阶段的同义句（中英各 2–3 句）
- `transcript.workingQuiet`：暂无新输出
- `transcript.workingSilent`：已 {minutes} 分钟没有新输出
- `transcript.presenceDetailLabel`：这一轮正在做什么
- `transcript.presenceSteps`：读取 {files} 个文件 · 运行 {commands} 条命令

现有 `settings.workingSWithSeconds` 继续作为计时文案。

## 验证

1. `live-phrase` 单测：阶段优先级；同一 seed 的轮换顺序稳定；相邻两句不同；hold 落在 4000–6000ms。
2. `tail-presence` 组件测试：进入/退出类名与卸载时机；可见文案 `aria-hidden` 且 live region 只在阶段变化时更新；`detail` 存在时按钮可展开、Escape 折叠并回焦；无 `detail` 时不是按钮。
3. `Transcript` 集成测试：working 且无回复时出现本行并替代 `tr-ghost-working`；流式时不存在本行；`tailAvatar`/`tailDetail` 不传时仍渲染。
4. 动效：`.gui-motion-off` 与 `prefers-reduced-motion` 下无扫光、无进出场。
5. 实机：`bun check`；桌面端跑一轮带工具调用的回合，确认文案随工具切换、计时不因切换会话重置、长静默出现安静态、展开卡列出工具；移动端确认无头像时布局不塌。
6. 性能：一个 5 分钟回合期间，`Performance` 面板确认没有每帧文字重绘（扫光只走合成层）。

## 假设（我替你做的决定）

1. **流式输出时让位。** 参考实现里 ds-bot 的做法是「有文本就让位，但还在跑工具就保留」。MusePi 现有结构下，流式开始后计时挂在流式消息下方；再叠一行会在同一屏出现两个「活的」表面。因此本行只在「还没有回复」的窗口出现。如果之后想改成「跑工具时保留」，只需放宽 `Transcript.tsx:3101` 的条件。
2. **文案刻意模糊，细节放 tooltip 与展开卡。** 编码 agent 的精确动作已经在工具卡与 `liveProcessDetail` 里；尾部这一行的职责是让人一眼知道「在动、在动什么类别」，所以用「正在四处查找」而不是文件路径。工具名与参数进 `title`。
3. **不新增用户设置项。** 这一行替换的是已有的计时行，没有额外噪音需要关闭；如果实测有人嫌轮换文案吵，再加开关（那会牵动 daemon settings-def，单独做）。
4. **轮换不发散到随机。** 用确定性哈希而非 `Math.random()`，这样同一回合重放一致、测试可断言，也避免同一屏多个 bot 的行同时换句。
5. **头像尺寸 28px。** 与顶部胶囊一致；行高按 36px 预留，避免出现时推动转录。
