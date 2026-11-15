# 对话转录折叠对齐（openchamber / Kimi Code 客户端逆向）

范围：回合折叠（活动）、工具段折叠（工具调用汇总）、二者与"交付物行"的归属关系、活动头的呈现、开合动画。
目的：给出一份可执行的统一重构方案，替代当前"两套折叠 + 两种动画策略"的混合态。

## 1. 结论先行

1. **多层折叠是合理的，Kimi 客户端就是三层**：`TurnFold`（回合）→ `ActivityRun`（工具段）→ `ToolCall` / `Think`（行内）。问题不在层数，而在两层各自判断"什么算过程"。
2. **交付物不应该靠豁免名单保住，而应该被提出折叠容器**。openchamber 的卡片、表单、带 UI 块的文本都在折叠容器之外渲染（`TurnPages`），任何一层折叠都碰不到它们。我们现在的 `RoundFold.exempt` + `artifactRowSet` 是在容器内部做例外，判定一旦分叉就会漏。
3. **动画不该用 `height: auto` 插值**。Kimi 客户端统一用 `display: grid; grid-template-rows: minmax(0,0fr) → minmax(0,1fr)`，配"双 rAF 挂载、200ms 后卸载"的两阶段生命周期；openchamber 则完全不动画（瞬间开合 + 滚动意图）。我们目前 `height: 0 ↔ auto` + `interpolate-size` + `useHoldAnchor` 里临时 mute transition，是最不稳定的一种组合。
4. **活动头应当只做"摘要 + 开关"**，回退按钮不属于它（消息行已有回退入口）。

## 2. 证据

### 2.1 openchamber（源码，`D:\Projects\Agents\references\openchamber`）

- 只有一层折叠：`packages/ui/src/components/chat/components/useTurnFold.ts` 把 turn 拆成 `finalMessage` / `activityMessages` / `pages` / `isExpanded = !settled || expanded`。
- 折叠容器不保留内容：`components/chat/components/LiveActivityCollapse.tsx:14` —— 收起时 `height:0; overflow:hidden` 且 `children = null`，无高度动画；注释写明依赖列表的滚动锚定保持阅读位置。
- 交付物提出容器：`lib/turns/liveActivity.ts:78` `getShownPages()` 收集 `openchamber_render` 页面、等待作答的表单、带 UI block 围栏的文本；`LiveTurnActivity.tsx:144` 把它们渲染在折叠容器**之外**（`TurnPages`）。最终回答的正文永不提升。
- 工作态只显示最新 N 行：`LiveTurnActivity.tsx:43` `planActivityTrim`，头部补 `moreRows`。
- 唯一的动效是工作态窗口的 FLIP：`useActivityRowGlide.ts:24`，只改 `transform`，不参与布局。
- 头部信息：`LiveTurnActivity.tsx:90` —— `stack` 图标 + 加粗标题 + 箭头 + 文件变更（含 +/−）+ 一行元信息（`explored · ran N commands · researched · used N subagents`）+ 工作态隐藏行数。

### 2.2 Kimi Code 客户端（shipped bundle，`C:\Users\universe\AppData\Local\Programs\Kimi Code\resources\desktop-dist\assets`）

渲染端是 Vite 产物，`main-BFccKBrK.css` 与 `main-DocEqOi7.js` 为证据载体（静态解析，未执行）。

**折叠 primitive（CSS 原文）**

```css
.tf-body{display:grid;grid-template-rows:minmax(0,0fr);overflow:hidden;
  transition:grid-template-rows var(--duration-base) var(--ease-out)}
.tf-body.open{grid-template-rows:minmax(0,1fr)}
.tf-body-inner{min-height:0;overflow:hidden;display:flex;flex-direction:column}
```

`think-body`（思考块）、`ar-body`（ActivityRun）、`tl-body`（工具行）三处是同一份实现；`ar-body` 额外给 inner 做 `opacity` 过渡，并在 `prefers-reduced-motion` 下关闭全部过渡。

**两阶段生命周期（`__name:"TurnFold"` 反编译片段）**

```js
Me(f, D => {
  if (D) {                      // 展开
    if (m !== null) { clearTimeout(m); m = null; }
    if (h.value) { p.value = true; return; }   // 已挂载：直接置 open
    h.value = true;                              // 先挂载
    requestAnimationFrame(() => requestAnimationFrame(() => { p.value = true; })); // 再置 open
    return;
  }
  p.value = false;                               // 收起：先撤 open
  m = setTimeout(() => { m = null; h.value = false; }, 200);  // 200ms 后卸载
});
```

`ActivityRun` 用完全相同的 `g/y/b` 三变量重写一遍（`__name:"ActivityRun"`），状态为 `running` 时默认展开、结束自动收起，用户覆盖按 run key 持久化（`activity:${firstItemKey}`）；`TurnFold` 的头部是 `已工作 {duration}`（`conversation.fold.worked`），运行中不渲染头部。

**行模型（`bZe`）**：连续 `thinking` / `tool` 归并成 `activity-run`；**单条不折叠**（直接作为行）；`task` 子代理工具与 notify 卡不并入 run（作为独立行）；`text` 行会切断 run；连续 `notification` 合成一行。

**运行中的可见窗口（`wZe`）**：不是"最近 N 行"，而是**从最后一段非空文本行开始**——`folded = rows[0..o)`、`visible = rows[o..)`；没有文本时从第一条独立工具行（或通知）开始。折叠时只渲染 `visible`，其余行留在 `folded` 里（`kZe` 按 `sourceIndex` 合并回序）。

**活动头词汇（i18n 原文）**

- 完成子句：`读取了 N 个文件` / `运行了 N 条命令` / `搜索了 N 个模式` / `网络搜索了 N 次` / `找了 N 次文件` / `列出了 N 个目录` / `抓取了 N 个页面` / `编辑了 N 处` / `写入了 N 个文件` / `执行了 N 次浏览器操作`，另有 `（N 失败）` 与 `执行了 N 次其他操作`。
- 运行中：`正在读取 {subject}` / `正在运行命令` / `正在搜索…` / `正在执行…`，已完成部分加 `已` 前缀，尾部附耗时（faint tone）。
- 列之间用 ` · ` 连接（`TQ`）；头部同时有 `aria-expanded`、body `inert`。

## 3. 三方对照

| | MusePi（现状） | openchamber | Kimi Code 客户端 |
|---|---|---|---|
| 折叠层数 | 2（回合折叠 + 工具汇总） | 1（turn Activity） | 3（TurnFold → ActivityRun → ToolCall/Think） |
| 交付物保护 | 容器内豁免行（`exempt` / `artifactRowSet`） | 提出容器（`TurnPages`） | 行模型上不并入 run（`task` 不并入、单条不折叠）；独立行照常渲染 |
| 活动头 | 变更 · 探索 · 命令；无子代理/联网/工作态行数；无 aria | 变更 · 探索 · 命令 · 调研 · 子代理；有隐藏行数；有 aria | 回合头只有"已工作 X"；run 头承担全部子句与运行态 |
| 开合动画 | `height:0↔auto` + `interpolate-size`；`useHoldAnchor` 临时 mute transition | 无动画，瞬时 + 滚动意图 | grid `0fr↔1fr`，双 rAF 挂载、200ms 卸载 |
| 工作态 | 有 live trim（最近 N 行） | 最新 N 行 + "还有 N 行" | `wZe`：只显示最后一段文本之后的行 |

## 4. 目标模型

### 4.1 一个 primitive：`FoldRegion`

- 结构：`<div class="fold-region" data-open>` → 头部（`button[aria-expanded][aria-controls]`）→ `<div class="fold-body" inert>` → `<div class="fold-body-inner">`。
- 样式：`grid-template-rows: minmax(0,0fr/1fr)`；inner `min-height:0; overflow:hidden`；`--duration-base` + 全局 easing；`prefers-reduced-motion` 下 `transition:none`。
- 生命周期：双 rAF 置 open、`transitionend`（或 200ms 兜底）后卸载；收起时立即 `inert`。
- 所有可折叠面（回合、工具段、思考块、长用户消息）都用它，删除 `.tr-fold-slot` 的 `height:auto` 实现（保留类名作为别名一个版本）。

### 4.2 三层归属（Kimi 同构）

- `buildTimeline(entries)`：产出 `text` / `thinking` / `tool` / `activity-run` / `notification` / `hoisted` 六种行；连续 work 行合并成 run，**单条不合并**，`task`/子代理不并入，`text` 切断。
- 回合折叠拥有 run 与其间的思考；run 自己再折叠；行内卡片自己折叠。三层各自持久化开关，key 用稳定 id（回合 = user message id，run = 首行 id），沿用现有 `roundFoldOpen` / `runsExpanded` 的 key 规则。
- 默认状态：回合——live 展开、settled 收起；run——running 展开、结束收起（Kimi 行为）。

### 4.3 交付物提升（openchamber 同构）

- `artifactRowSet` 改名并升级为 `hoistRows(entries)`：返回需要提出折叠容器的行（artifact 卡、图片结果、进度行、被等待中的 ask 卡）。
- 渲染位置：折叠容器之外、最终回答之前，作为普通行；折叠容器内部不再需要 exempt 概念。
- 工具汇总因此不再需要 `runBlocked` 判定——结构上不可能吞掉卡片。

### 4.4 活动头

- 内容：语义图标 + 标题 + 箭头 + 变更（`改了 N 个文件 +a −d`，diff 完整才显示 +/−）+ 子句行（对齐 Kimi 词汇：读取/运行命令/搜索/抓取/编辑/写入/浏览器操作/失败子句）+ 工作态"另有 N 行"。
- 交互：`aria-expanded` / `aria-controls` / body `inert`；展开时把头部保持原位（滚动意图），收起时一次锚定。
- **移除回退按钮**（消息行已有回退入口，头部只做摘要与开关）。

### 4.5 动画与测量

- 折叠动画期间，被折叠区域对 `shouldAdjustScrollPositionOnItemSizeChange` 返回 false；动画结束 `transitionend` 后调用一次 `virtualizer.resizeItem`/`measureElement`。
- 展开前先测内容高度并显式给外层高度、再置 open；收起时显式给当前高度、reflow、再置 0，避免"从 auto 开始"的不确定起点。
- 删除 `useHoldAnchor` 里的 transition mute；只保留"折叠发生在视口上方时的一次 scrollTop 校正"。

## 5. 实施阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | `FoldRegion` primitive + 单测（双 rAF、卸载时机、reduced-motion、inert/aria） | 组件测试；三类折叠面切换同一 primitive |
| P1 | `buildTimeline` 统一行模型（单条不合并、task 不并入、text 切断） | 单测覆盖运行/结束/单步/子代理/通知；现有 transcript 测试迁移 |
| P2 | `hoistRows` 取代 exempt；汇总去掉 blocked 判定 | 卡片/图片在任意折叠态可见；删除 `RoundFold.exempt` 相关分支 |
| P3 | 活动头信息与可达性（子句、aria、移除回退、展开滚动意图） | 截图对照；键盘可达；无回退按钮 |
| P4 | 测量/动画收口（关闭逐帧补偿、transitionend 后一次测量） | 长回合连续开合 20 次无跳变；滚动位置稳定；reduced-motion 直接切换 |

## 6. 未决

- run 的"结束自动收起"是否与用户覆盖冲突：Kimi 用 `activity:${key}` 记忆用户选择，且新 run 重置。我们沿用"新 run 默认收起、用户覆盖按 key 记"。
- 回合头是否保留"已工作 X"作为主标题（Kimi 是），还是保留"活动 + 子句"（openchamber 是）。建议：主标题"活动"，右侧耗时，子句行在下方；两者兼得。
- 运行中可见窗口：Kimi 按「最后一段文本之后」切分，我们按「最近 N 行 + live trim」。建议对齐 Kimi（文本是阅读锚点，N 行会把刚写出的半句切断），但保留 N 作为无文本时的兜底。

## 7. P0 验收时确认的一点

- 打开回合折叠后，span 内会出现若干**空** `.tr-fold-slot`（`childElementCount: 0`）。核查后确认不是缺陷：这些行是 `toolResult` 行，卡片渲染在配对的那条 assistant 行上（该行是折叠头，展开时正常显示工具卡），结果行本身没有独立内容。`FoldRegion` 的轨道本身工作正常（思考块实测 1521px → 1821px 过渡）。P1 重写行模型时，结果行应显式归并到配对行，而不是留一个空槽。

## 8. 实施进度与偏差（P2/P4）

- **P2 完成（结构层）**：`buildToolRuns` 现在把 `artifactRowSet` 标记的调用行与 artifact 结果行都当作 run 边界——交付物根本不进 `idxs`，因此 `runBlocked` 里对 artifact 的判断删除（只保留 fold 的 tail/hook 豁免）。这与 Kimi 的行模型（task/notify/单步不进 run）同构，比"汇总时再检查"更可靠。
- **P4 完成（补偿窗口）**：折叠/工具段切换时把虚拟列表的 `shouldAdjustScrollPositionOnItemSizeChange` 关闭 260ms（复用 prepend 的 `sizeAdjustSuppressUntilRef`），窗口结束后调用一次 `virtualizer.measure()`。动画期间不再逐帧写 `scrollTop`。
- **P4 偏差（保留 off-screen 瞬收）**：`useHoldAnchor` 里"折叠发生在视口上方时临时 mute transition 再钉一次"的做法**保留**。理由：折叠在视口外时用户看不到动画，瞬收 + 一次 scrollTop 钉住比 220ms 的补偿窗口更稳；若移除 mute，锚点 delta 在首帧近似为 0，反而失去作用。也就是说：可视区内的折叠走动画 + 补偿窗口，视口外的折叠直接落位。
- **P1 投影已收口**：`RoundFold` 的绝对投影抽成 `roundFoldFromSpan`，`buildRoundFolds` 与缓存路径 `turn-derive` 共用一处（此前新增 web/subagent 字段要改两处，正是证据）。仍待做的是完整 `buildTimeline`（`turnUnits` + `folds` + `runs` 一次遍历产出）与 `toolResult` 行的显式归并（当前空槽无害）。
- **P4 真机验证通过**：默认 profile 下打开会话、滚到折叠处连续开合 6 次，`scrollTop` 漂移 0px（验收阈值 40px），`aria-expanded` 每次正确翻转。隔离 `--user-data-dir` 会在新 profile 上触发首次启动引导，导致会话正文不挂载（与本改动无关），验证应使用默认 profile；共享 daemon 端口被占时用 `MUSEPI_GUI_DAEMON_PORT`/`MUSEPI_DAEMON_DIR` 隔离。
