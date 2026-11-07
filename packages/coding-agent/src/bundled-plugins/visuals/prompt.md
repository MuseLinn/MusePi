# widget — 内联交互卡片 / 内联页面

两种东西，一个工具：

- **card**（默认）：结构化活卡片（计算器、滑杆面板、行情、指标、待办、时钟）
- **page**：一页自包含 HTML，直接在对话里摊开给用户看

## 何时使用

回答具有以下结构时**主动**使用（不等用户说"可视化"）：

- **数值/对比**：计算器（个税、费用、换算）、指标对比、价格/汇率
- **交互**：用户需要调参观察（滑杆面板——噪声/抖动对信号的影响）
- **仪表盘感**：一组相关数值（时钟 + 市场状态、行情列表）
- **清单**：待办、检查项

### card 还是 page？

有对应结构类型就用 **card**（有 schema、有默认值、更省 token）。
只有当答案需要自由布局时才用 **page**：

<!-- WIDGET_RENDER_WHEN: injected from when.ts, the same text the system prompt carries -->

**不要**用于：普通文字回答、逐行代码解释、文件列表、破坏性/阻塞输入流程、
大型长驻应用。

### page 怎么写

一页自包含 HTML（≤64KB），在沙箱里运行：没有网络会话、没有 localStorage，
远程数据先取好注入 `data`。宿主注入主题类与配色变量，页面必须跟随深浅色。

- **版式**：宽度随回复栏（桌面约 720px、手机约 360px），最外层不要左右 padding，
  内容不得超宽；宽表格放进 `.musepi-table` 自己横向滚动；图表给固定像素高度；
  `html`/`body` 不要用 `100vh` 或 `height:100%`（宿主按内容撑高）。
- **字号用 rem/em**：沙箱根字号 = 对话正文，跟随界面字号设置；px 写死会不跟随。
- **先用成品类，不要自己重写一套**（宿主已注入样式与配色）：
  - `.musepi-box` 面板（嵌套一层降一个色调）、`.musepi-muted` 次要文字
  - `.musepi-table` 包住 `<table>`（宽了横向滚动）、`.musepi-num` 数字等宽右对齐
  - `.musepi-badge`（`data-tone="success|warning|danger|info"`）、`.musepi-dot`
  - `.musepi-bar` 横条：`style="--value:62%;--color:var(--chart-2)"`
  - `.musepi-steps` 包 `<ol>` 编号步骤
  - `.musepi-form` / `.musepi-field` / `.musepi-input` / `.musepi-switch` / `.musepi-segmented`
  - `.musepi-options` / `.musepi-option` / `.musepi-option-sub` / `.musepi-button`
- **图表**用内联 SVG（部分客户端不加载远程脚本），系列色取 `--chart-1`…`--chart-5`，
  同一图表最多 5 色，超出用线型区分。
- 只画成品类覆盖不到的东西时才自己写 CSS；**设了背景色的元素必须同时设文字色**。
- **让用户选**：选项用 `.musepi-options`，或表单收集后用 `.musepi-button` 调
  `musepiSubmit(text, data)` 一次交回。`text` 用用户语言写清全部选择（它进模型
  上下文）；`data` 只回显给页面自己。`musepiSubmit` 非阻塞——本轮已结束，答案
  作为下一条用户消息到达；同一轮内必须拿到答案时用 `ask` 工具。

## 任务一致性（硬性约束）

卡片可带 `task` 元数据（运行按钮 + 查看任务）。**任务必须与卡片展示的
可视化内容直接相关**——例如汇率卡的任务是"刷新汇率"，指标卡的任务是"更新指标
快照"。禁止把无关作业（系统体检、文件整理等）挂到展示型卡片上；需要独立作业
时另行设计专用卡片。渲染内联 widget 时如无真实任务则不填 `task` 字段。

## 怎么写

```
widget { action?, type?, data?, title?, html? }
```

`action` 省略或 `"card"` → 用 `type` + `data`（结构化卡片）。
`action: "page"` → 用 `title` + `html`（自由页面），忽略 `type`/`data`。

|type|data 字段|说明|
|---|---|---|
|`calc`|`mode: "pre"\|"post"`, `amount: number`|劳务费个税计算器（≤4000 元规则：收入−800，税率 20%）|
|`slider`|`noise/jitter/freq/amp: number`|参数滑杆 + 实时波形|
|`ticker`|`label: string`, `value: string`, `delta: number`|行情卡（值 + 涨跌 + 迷你图）|
|`metric`|`label: string`, `value: number`, `delta: number`|指标卡（数字滚动 + 涨跌色）|
|`todo`|`items: [{id, text, done}]`|待办清单|
|`clock`|`market: "cn"\|"us"\|"eu"`|数字时钟 + CN/US/EU 市场状态|
|`gallery`|`items: [string]`|手风琴画廊|
|`pomodoro`|`mode: "focus"\|"short"\|"long"`|番茄钟（圆环 + 轮次统计）|
|`video`|`url`, `bvid`, `title`, `subtitle`|视频卡：`bvid` 填 B站视频号（如 `BV1vT411d7QE`）→ 封面点击内联播放；`url` 填 mp4 直链 → 自绘控制条；都空则装饰封面占位|
|`music`|`queue: [{id, year, title, artist, file}]`|黑胶播放器：真音频（Internet Archive 公版录音）+ 频谱 + 播放队列|
|`history`|`header`, `date`, `events: [{year, text}]`|历史上的今天：实时数据源 + 8-bit 像素标题 + 可滚动事件列表|
|`fx`|`chip`, `title`, `pairs: [{code, unit, note}]`|实时汇率（60s 自动刷新 + 30 日走势）|
|`stocks`|`chip`, `title`, `rows: [{code, label, badge, name}]`|实时 A 股盯盘（腾讯行情 + 30 日 K 线迷你图）|
|`gauge`|`value`, `status`|仪表盘读数|
|`kline`|`candles: [{o, h, l, c, v}]`|K 线图（蜡烛 + 均线）；`price`/`delta`/`stocks` 可选|
|`heatwall`|`tiles: [{name, delta}]`|涨跌热力墙|
|`indextape`|`indices: […]`|指数磁带（三市指数）|
|`html`|`html: string`, `data: object`|自定义 HTML 面（sandbox 内运行；数据经 `data` 注入 `window.musepiWidgetData`；主题经 `window.__WIDGET_THEME__` 与 `<html class="musepi-theme-dark\|light">` 注入；禁第三方 fetch——远程数据先取好再注入；`<img src>` 可用；需要用户选择时用 `musepiSubmit(text, data)` 把答案交回会话；版式、成品类与表单写法见下方「page 怎么写」；必须在同一轮内拿到答案时用 `ask` 工具而不是这个）|

- `data` 可省略字段——缺省值自动补齐（如 `calc` 缺 `mode` 默认 `post`）。
- `title` 可选，默认组件名。

## html 类型：主题自适应（硬性要求）

桌面端支持深浅色热切换，自定义 HTML 面**必须跟随，禁止单一固定配色**。

```
bash: cat skill://widget-design/SKILL.md
```

该 skill 里有完整的两套配色写法、对比度自检清单，以及"凡是设了背景色的元素
必须同时显式设文字色"这条最容易踩的坑（iframe 里未设 `color` 的文字默认黑色，
深色主题下黑字+深底=整段不可读）。要点：

- 用 `.musepi-theme-dark` / `.musepi-theme-light` 两套 CSS，或运行时读 `window.__WIDGET_THEME__`
- 不要用纯白底+黑字（深色界面刺眼）或透明底+深字（深色界面不可读）
- 主题切换时 iframe 会以新主题重建，无需自己监听
- 宿主注入的 `var(--bg)`/`var(--fg)`/`var(--accent)`/`--chart-*` 等变量**直接可用**，
  深浅主题各一套；沙箱是 null origin，读不到应用自身的变量，这些是宿主解析后送进来的

## 铁律

1. **文字在响应，视觉在 widget**：解释性文字/总结放在 widget 外的回复里。
2. **渲染后不复述**：widget 渲染完成就不再重复卡里已有的内容，只说 widget 表达不了的。
3. 数据要真实算好填进去（如个税：税前 2000 → `{mode:"pre", amount:2000}`），
   不要留空让 UI 猜。
4. 一个回答里结构分散时可以用多个 widget，但别为单个数字滥用。

## 示例

```
widget { type: "calc", data: { mode: "pre", amount: 2000 } }
→ 卡片显示：税前 2000 → 扣税 240、到手 1760、税率 12%（+ 规则说明）
```
