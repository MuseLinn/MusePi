# 看板（Board/Dashboard）组件平台 — 立项

> 2026-08-07 立项。目标：kimi work 式可交互、可编辑、可常驻桌面的组件看板；
> 参考 kimi work（产品形态）+ bitfun Agentic Mini Apps / BitFun Canvas（技术范式）。
>
> **状态（2026-08-25 核对）**：M1–M3 已落地（BoardPage + WidgetRegistry + 17 种 widget +
> `board.*`/`widget` RPC + boards.json 持久化）；M4/M5 部分落地；iframe 沙箱按 §7 决策排除；
> **调度执行引擎未实现（无排期）**——详见 §4 里程碑标注。

## 1. 动机与参考

- **kimi work**：可交互可编辑的看板（模板：每日财经 5 组件、Hello World 19 组件），组件
  有真实数据（K 线、A 股盯盘、番茄钟、待办打卡），可加到桌面当常驻卡片。
- **bitfun**（`src/web-ui/src/`，有源码）：
  - `scenes/miniapps/` — Agentic Mini Apps：iframe 沙箱跑编译后 HTML，postMessage
    JSON-RPC bridge（`worker.call`、`ai.*`、`agent.*`、`deck.renderPage`、
    `chat.*`、`clipboard.*`、`appearance`），AI 定制流程
    （notice → draft → preview → permission review → apply）。
  - `tools/bitfun-canvas/` — Canvas：iframe 注入 React 运行时（React/ReactDOM 按需加载），
    SDK 提供 `data-display`（Stat/Table/Timeline/FileTree/ProgressBar/TodoList/DiffView…）、
    `charts`（Bar/Line/Pie）、`hooks`（useHostAppearance/useCanvasState/useCanvasAction）。
  - `tools/generative-widget/` — AI 生成组件面板。
  - **没有**经典 widget 注册表 / 桌面常驻卡；最接近的是 pop-out 面板。

## 2. 目标（MVP）

1. **画布页**：网格看板，可添加/拖动/缩放组件卡；深色/浅色主题跟随 GUI。
2. **内置组件库**（首批 5 个，均为有真实交互/数据的最小实现）：
   - 时钟（MARKET PULSE 式：数字时钟 + 三市场状态）
   - A 股盯盘（K 线 + OHLCV 数据条，走 daemon 数据 API）
   - 番茄钟（25/5 计时器，本地状态）
   - 待办打卡（本地持久化）
   - 行情温度计（三指数量能 gauge）
3. **编辑模式**：修改（改标题/数据源/配色）、整理（拖动排序）、添加组件、删除组件、
   模板市场（每日财经/Hello World 示例模板一键创建）。
4. **AI 生成**：对话框输入需求 → daemon agent 生成组件代码 → 沙箱预览 → 应用。
5. **桌面常驻**：Electron 小窗（复用 pet mini-window 先例）加载指定看板/单组件，
   `frameless + alwaysOnTop` 选项。

## 3. 架构

```
┌─ GUI (packages/gui, Electron) ──────────────────────────────┐
│  BoardPage (React)                                          │
│   ├─ 看板网格（拖放/缩放：dnd-kit 或手写 pointer 状态机）       │
│   ├─ 组件卡 = <WidgetShell> + WidgetRegistry 组件</WidgetShell>│
│   └─ 常驻小窗（新 BrowserWindow，loadFile board-card.html）    │
│  Transcript 内联：同一 registry 渲染 widget 卡（kimi 式）      │
└───────────────┬─────────────────────────────────────────────┘
                │ JSON-RPC (既有 daemon WS 通道)
┌───────────────▼─────────────────────────────────────────────┐
│ Daemon (packages/coding-agent/src/daemon)                   │
│  新 RPC：board.list / board.save / board.template           │
│          widget.data（数据源代理：行情、股票）                │
│          widget.schema（暴露 registry 类型/字段给 agent）     │
│          widget.render（agent 工具：type + data）             │
└─────────────────────────────────────────────────────────────┘
        registry 组件：reactbits 视觉件 + 自研功能件（编译白名单）
        消息内联与看板共用；iframe 沙箱为 M4 后可选升级
```

### 关键设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 组件运行环境 | **白名单组件 registry（首选）**：组件编译进 GUI（reactbits + 自研 + 复用 desktop-web tool-render），agent 经工具**选类型 + 填数据**；**iframe 沙箱（备选升级）**：仅当需要"AI 自由生成任意 HTML"时启用 | ①kimi 式**消息内联 widget** 用 iframe 太重（每条消息一个沙箱）——registry 组件直接渲染在消息流；②reactbits 组件全是声明式受控组件 → **白名单即类型级隔离**（无需运行沙箱）；③schema 校验的数据流比"生成任意 HTML"更可靠、可审计、可 diff |
| 组件格式 | **registry 条目**：`{ type, schema, component }`——组件是 TSX（reactbits 源码式），agent 交互的是 **widget schema**（type + data 字段） | 比单 HTML 文件更易维护；reactbits 组件零改动直接入 registry；`widget.render` 工具按 schema 校验 |
| 组件 SDK | `widget.render { type, data }` 工具 + daemon `widget.schema` RPC（暴露可用类型/字段给 agent） | agent 通过 schema 发现能力，**自动补全组件参数**——"封装好搭好底座暴露给 agent"正是此意 |
| 持久化 | daemon `board.*` RPC → 会话目录 JSON（`~/.musepi/boards/`） | 跨重启、可备份；与 notes/plans 同级 |
| 数据源 | daemon widget.data 代理（首期：行情静态/轮询接口） | 组件不直连外网，数据策略可审计 |
| 消息内联 widget | **同一 registry** 渲染在 transcript（kimi 式）：工具结果 → widget 卡；复用已有 tool-render 管线（30+ 工具渲染器） | 看板组件与内联 widget 共用底座，一份组件两处用 |
| 桌面常驻 | Electron 小窗 + `alwaysOnTop` 可切换 | pet 窗口先例（main.cjs miniWindow） |

### kimi 参考形态（2026-08-07 六张截图提炼）

**会话内联 widget 的组件模式**（kimi 网页端聊天内联，均可交互）：

| 模式 | 参考 | registry 通用组件 |
|---|---|---|
| 参数控制卡 | 眼图实验室：滑块行 = label + 当前值 + slider（噪声/抖动/ISI/上升时间，实时重绘波形） | `SliderCard`（多滑块 + 受控重绘） |
| 多视图切换 | 眼图：叠加视图/叠加过程演示/单比特波形 三个 tab | `TabView`（同一数据多视图） |
| 计算器 | 个税计算器：税前/税后 toggle + 输入 + 进度条（到手 88%）+ 2×2 数据卡（税前/扣税红/到手绿/税率）+ 规则区 | `CalcCard`（toggle + input + 结果卡 + 规则） |
| 数据卡组 | 2×2 指标卡（值 + 语义色：红=扣减/绿=到手） | `DataGrid`（语义色卡） |
| 图表/架构图 | 雷达架构 SVG（可编辑标注、注释框）+ 眼图波形 | `SvgCanvas`（SVG 渲染 + 标注） |
| 运行卡 | 看板 Python 卡：Darwin 体检（CPU/磁盘/系统资源条 + 再测一次按钮 + 耗时统计） | `RunCard`（本地执行 + 资源条 + 重跑） |
| 行情卡 | 汇率 EUR/CNY + A股贵州茅台：值 + 涨跌 ▲ + 迷你图 | `TickerCard`（值 + 涨跌 + 迷你图） |
| K 线/趋势卡 | Hello World 看板的 `+*` ASCII 趋势图 + 迷你线图 | `ChartCard`（迷你线图） |

**看板卡片手势/交互清单**（Hello World 示例看板）：

- **DRAG**：按住顶栏拖动组件位置
- **RESIZE**：拖右下角手柄，尺寸数字实时跟随（357×252），紧凑视图切换
- **OPEN**：点击展开折叠内容（行程卡：20+ 条细节折叠 → 全屏展开）
- **RUN**：点击执行本地代码（Python 体检卡）+ 结果重跑
- **FOCUS**：卡片可聚焦放大（模态/大图）
- **PIN**：固定至桌面（常驻小窗）
- 卡片语言：标题 + 副标题 + tag 标签（`GESTURE · 01 DRAG`）+ 语义色数据

**kimi Work Hello World 示例看板组件**（2026-08-07 第二批截图，7 张存 ui-references/ 对照）：

| 组件 | 形态 | 可复用模式 |
|---|---|---|
| 拖拽手势卡 | 拖一拖/拉一拉/点开看 三卡（GESTURE·01 DRAG / 02 RESIZE / 03 OPEN tag）+ 实时尺寸数字（356×252）+ 紧凑视图 | 手势教学卡语言（标题+副标题+tag）；尺寸数字实时跟 |
| 汇率卡 | 列表型：4 货币对（EUR/USD/JPY/KRW → ¥值）+ 更新于时间 + 每分钟自动刷新 | `TickerList`（多行情列表 + 刷新策略标注） |
| A股盯盘卡 | 3 股票行（代码 + 迷你线图 + 价格 + ▲涨跌%）+ 每交易日刷新 | `WatchList`（盯盘列表 + 迷你图） |
| 番茄钟 | 专注 25/短休 5/长休 15 模式 tag + 圆环进度（25:00）+ 开始/重置 + 今日轮数/专注分钟 + 攒 4 轮长休奖励 | `PomodoroCard`（圆环 + 模式 + 统计 + 奖励规则） |
| 待办+习惯打卡 | 待办（增删勾选 + 0/3 计数）+ 习惯 7 天格（2026-W32 周视图：喝水/运动/阅读/早睡 × 周一~日）+ 本周完成率进度条 | `HabitGrid`（周视图打卡 + 完成率）——todo 组件升级方向 |
| 剩余空间卡 | 可用/总容量/已使用 + ASCII 目录树 + 重新扫描按钮（本机 Python 标准库） | `DiskScanCard`（系统信息 + 扫描动作）——RunCard 具体化 |
| 媒体播放器 | NOW PLAYING + 曲目/艺术家/年代 badge + 播放控制 + 音量滑杆 | `PlayerCard`（播放控制 + 进度） |
| 视频卡 | PROMO REEL 卡片内播放 + 时间戳 + 进度 + 全屏 | `VideoCard`（内嵌视频） |
| 历史卡 | 历史上的今天时间线（年份 + 条目）+ 换一批 + 数据源标注 | `TimelineCard`（时间线 + 刷新 + 数据源） |
| BEETBOX 节拍器 | 16 步序列网格（4 轨）+ BPM/摇摆/音量滑杆 + 频道台 + 播放/清空/随机 + 键盘演奏 + 循环录制 | `SequencerCard`（复杂交互件——交互深度标杆） |
| 提示词市场 | "点击下方 prompt, get 同款"——5 个 widget 生成 prompt 卡（+/- 折叠） | **AI 生成入口**：看板内 prompt 卡 → agent 生成组件（widget.generate 可视化形态） |

> 设计观察（用户 2026-08-07）：卡片**标题是卡内非必要渲染内容**（可编辑/可隐藏），
> **内容呈现灵活自由**（列表/圆环/网格/时间线/序列器混排），组件库优先做**数据形态件**
> （列表/图表/环/网格）而非固定场景件。

（SliderCard/TabView/CalcCard/DataGrid/RunCard/TickerCard/ChartCard）——这些是**自研功能件**（reactbits 提供视觉装饰层：卡 hover 光效/数字滚动/文字效果），两者在 WidgetShell 内组合：`<WidgetShell><ChartCard data={...}/></WidgetShell>`。

### 组件库分层（reactbits 底座,2026-08-07 定）

```
Agent 工具 ──widget.render/board.*──▶ daemon RPC ──▶ GUI
                                                      ├─ WidgetRegistry（type → 组件）
                                                      │   ├─ reactbits 视觉件：CountUp 已入、
                                                      │   │   ShinyText/SpotlightCard 已入、
                                                      │   │   候选 Aurora/Particles(背景型)/Dock(导航型)
                                                      │   ├─ 自研功能件：todo 卡/时钟/番茄钟/K 线(首批 5 个)
                                                      │   └─ 复用 tool-render：diff/goal/todo/ask 渲染器
                                                      ├─ 看板页（网格 + 拖放缩放 + 编辑模式）
                                                      └─ 消息内联（transcript 内 widget 卡，kimi 式）
```

- **reactbits 角色**：**视觉组件库**（白名单来源）——每个组件是一个 registry 条目，与自研功能件并列；不做沙箱运行时（它不是为数据绑定/交互逻辑设计的——数据与状态机自研）。
- **现有基础**：CountUp/BlurText/ShinyText/SpotlightCard 已落地 GUI（2026-08-07）；desktop-web `tool-render/registry.ts`（30+ 工具渲染器）就是消息内联 widget 的雏形——扩展它加通用 `widget.*` 渲染器即达 kimi 式内联。
- **agent 利用路径**：`widget.schema` 列出可用类型 → 工具填数据 → registry 渲染——agent 无需懂 React/动画，只需选类型填字段（schema 驱动自动补全）。

### iframe 沙箱（备选，M4 后评估）

原 bitfun 范式保留为**高级路径**：AI 自由生成单 HTML 组件（带 postMessage bridge + 权限 review）——仅在用户明确要"自由生成"且白名单覆盖不足时启用；两套并存（registry 优先渲染，沙箱组件标记 badge）。

## 4. 里程碑

- **M1 画布骨架 + WidgetRegistry**：BoardPage + 网格 + 添加/删除 + 本地状态 + 模板（每日财经/Hello World
  静态版）+ registry 底座（type→组件映射 + widget.schema）+ **通用交互件优先**（SliderCard/TabView/
  CalcCard/DataGrid/RunCard/TickerCard/ChartCard——kimi 参考形态提炼）+ reactbits 视觉件入列
  （CountUp/ShinyText/SpotlightCard）。~1 周 — **✅ 已落地**
- **M2 组件运行时**：~~iframe 沙箱 + bridge + SDK~~ → 按 §7 决策改为**白名单 registry 替代**
  （类型级隔离，无需沙箱）；内置 17 种 widget（真实数据走 widget.data）。~1 周 — **✅ 已落地（白名单版）**
- **M3 编辑与持久化**：拖放/缩放、编辑模式、daemon board.* RPC + 落盘（`~/.musepi/boards/boards.json`）。~1 周 — **✅ 已落地**
- **M4 AI 生成**：widget 工具已落地（agent 经 schema 选类型填数据渲染）；**AI 生成会话（widget.generate）+ 模板市场未做（无排期）**。~1 周 — **◐ 部分**
- **M5 桌面常驻**：alwaysOnTop 小窗先例存在（main.cjs mini-window 族）；**看板专用小窗（board-card.html）未验证**。~0.5 周 — **◐ 部分**
- **调度执行引擎**（§7 widget `data.task.schedule` 每小时/每天定时执行）：**未实现，列为后续里程碑，无排期** — **❌ 未做**

## 5. 风险与决策待定

- **iframe 沙箱权限**：`allow-scripts` 必须开，`allow-same-origin` 禁（防逃逸）；
  组件数据访问全部经 bridge——bridge 需 origin 白名单校验。
- **组件尺寸规范**：定义 4 档（1×1 / 2×1 / 1×2 / 2×2 grid 单元），统一最小 180×140。
- **数据源范围**：行情接口（免费源选型：腾讯/新浪/雅虎）合规性待确认——MVP 可先
  静态示例数据 + 1 个真实源。
- **AI 生成的组件安全**：生成后强制沙箱预览 + 人工确认（bitfun 的 permission review 流程）。
- **与 desktop-web 关系**：看板放 GUI（desktop）——guest 只读分享暂不排期。

## 5b. 渲染规范

widget 组件的视觉/排版/交互约束见 **`docs/widget-design-system.md`**（kimi 官方设计系统
提炼 + MusePi token 映射：黑白优先/图表色规则/间距圆角阶梯/控件中性化/流式友好/checklist）。

## 6. 参考文件

- bitfun：`src/web-ui/src/scenes/miniapps/`（MiniAppRunner、useMiniAppBridge、MiniAppCustomizePanel）、
  `src/web-ui/src/tools/bitfun-canvas/`（CanvasRuntimeApp、runtime/sdk/*）
- kimi work：产品截图（ui-references/，2026-08-07）
- musepi：`packages/gui/electron/main.cjs`（miniWindow 先例）、daemon RPC 注册表
  （`packages/coding-agent/src/daemon/server.ts`）

## 7. builtin bundle 定位（2026-08-08 定）

**是——看板系统就是 desktop 的内置组件 bundle**，与桌宠（pet bundle）、mini 聊天窗同级：

- **白名单 WidgetRegistry** 编译进 GUI（desktop-web 共享：看板卡 + 消息内联 + pin 窗三处渲染）——类型级隔离，非任意代码
- **daemon 持久化**：`board.list` / `board.save` RPC → `~/.musepi/boards/boards.json`（GUI/agent/多窗口共享一份；localStorage 为离线回退）
- **agent 规范化调用**：
  - `widget` 工具（agent 消息内联渲染，WIDGET_TYPES 表）
  - `widget.schema` RPC（类型 + fields + defaults，agent 可查询后 author 看板）
  - `board.list` / `board.save` RPC（agent 可读写看板）
- **任务系统**：widget `data.task { enabled, name, desc, schedule, runs[] }`——手动运行（卡片/最大化头运行按钮）+ 定时字段（每小时/每天，调度执行引擎为后续里程碑）+ 运行记录持久化（成功/失败态展示）
- **iframe 沙箱**（M4 备选）：第三方组件隔离运行——本 bundle 是白名单内置，不需要

### 组件清单（示例合集展示全）
- clock（深色）/ ticker（深色）/ metric / calc（浅色）/ slider（浅色）/ todo / pomodoro（蓝色）/ video（深色，视频播放）
- 任务演示：汇率抓取（每小时、成功记录）、电脑体检（每天、含失败记录）
- 能力矩阵：tone 样式 / 拖拽 / resize / 最大化 / 固定至桌面 / 运行任务 / 查看任务 / 视频播放 / 内联渲染
