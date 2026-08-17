# board — 桌面看板读写（kimi board parity）

读写 desktop GUI 的看板（同一存储：`~/.musepi/boards/boards.json`，GUI 实时渲染）。
看板组件由你设计：查 schema → 构造/修改 widget → save 保存。

## 何时使用

- 用户要求"把 X 放进看板 / 添加番茄钟卡 / 修改看板"
- 需要先了解现有看板内容（list / get）
- 设计新卡前先 `schema` 查类型、字段、默认值、卡面风格（tone）

## 怎么写

```
board { action, id?, board? }
```

| action | 参数 | 说明 |
|---|---|---|
| `list` | — | 全部看板（id + 标题 + 组件数） |
| `get` | `id` | 单个看板完整内容（含每个 widget 的 data/pos） |
| `schema` | — | widget 类型表：fields + defaults + tones |
| `save` | `id` + `board` | 整板替换/新建（**校验**：类型必须已知、pos 必须整数像素） |

## 何时使用

- 用户要求"把 X 放进看板 / 添加番茄钟卡 / 修改看板"
- 需要先了解现有看板内容（list / get）
- 设计新卡前先 `schema` 查类型、字段、默认值、卡面风格（tone）

## 组件选型（按数据性质挑类型，别全用 metric）

`schema` 返回的 widget 类型各有适用场景——**不同数据用不同卡面**，避免整板都是同一种数字卡：

| 数据 | 组件 |
|---|---|
| 单个大数字 + 涨跌（温度/湿度/卡路里/步数/心率） | `metric` |
| 市场/汇率行情（label + 数值 + 波动） | `ticker` |
| 时间/市场状态（CN/US/EU 开收盘） | `clock` |
| 仪表盘读数（市场温度、进度） | `gauge` |
| K 线/分时（行情主图） | `kline` |
| 板块涨跌墙（一堆股票/币种涨跌幅） | `heatwall` |
| 指数磁带（上证/深证/恒生滚动） | `indextape` |
| 待办/清单 | `todo` |
| 番茄钟 | `pomodoro` |
| 滑块（噪声/振幅调节） | `slider` |
| 计算器 | `calc` |
| 媒体播放列表（黑胶播放器：队列/波形/进度/音量） | `music`（queue 数组：title/artist/year/disc/dur） |
| 历史上的今天（8-bit 头 + 年份事件列表） | `history`（events 数组：year/text） |
| 视频（有源播放 / 无源封面 + title/subtitle/duration） | `video` |
| 图库 | `gallery` |
| 自定义 HTML（sandbox 内联） | `html` |

- **tone 决定卡壳底色**（dark/blue/light/default——见 schema）：每个组件自带卡面（行情/时钟类深色渐变、工具/清单类浅色磨砂、番茄钟蓝色——自动匹配），tone 是透明组件（html）的兜底壳 + 合集预览配色；混搭 2–3 种 tone 更接近真实产品（参考内置示例「每日财经」深色 + 「一块活的看板」混合）。
- 主题相近的卡（行情/财经）用 `dark`；工具/日常卡（计算器/番茄钟）用 `light`/`blue`。

## 布局设计（铺满画布）

画布规格（GUI 同源）：**BASE_W = 1092px（12 列 × 92px − 12px gutter）**，卡间距 GAP = 12。
尺寸公式：**卡宽 = 92n − 12、卡高 = 44n 步进**（n=1 → 80×44，n=2 → 172×88，n=3 → 264×132…）；
**x/y 用 8px 细粒度**（不必对齐列），但 pos 必须整数。

**渲染提示**：画布按窗口宽度等比缩放（`scale = 窗口宽 / 1092`）——pos 网格不变、
整数像素照旧；画布有 ChromaGrid 组级光效（鼠标驱动的 RGB 色散光晕，暗色大卡上读感好），
所以**卡面数据完整比背景装饰重要**——光效是氛围，卡面内容才是主体。

搭建一块新看板的流程：

1. **先定主卡**：信息密度最高的组件给最大尺寸（宽 2–4 列、高 2–4 格），放画布左上。
2. **填空隙**：其余组件按视觉权重降序摆放，贴边/贴卡放（间隙 ≤ 12px），
   用不同尺寸组合（大卡 + 2 小卡并排、竖排双卡等）**尽量铺满画布，不留大块空洞**。
3. **完整填数据**：每个 widget 的 data 字段全部填真实值（标题、数值、涨跌、列表项），
   不要留空让 UI 猜；卡面精致靠数据完整 + 类型自带 tone，不手动改风格。
4. 尺寸要配内容：长列表（待办/行情）给高卡，趋势图/热力墙给宽卡，
   时钟/指标这类单数值卡用小卡即可，别撑满。
5. 画布放不下的组件：先保证主卡 + 次要卡，删冗余，或缩小次要卡尺寸。

## 自定义 HTML 组件（html 类型）

`schema` 里的 `html` 类型接受**任意 HTML 面**（内联 CSS/JS）——做类型化组件
表达不了的可视化（数据大屏、仪表、动画徽标、自定义图表）。规则（与 kimi
blueprint-widget 一致）：

- **face 在 opaque-origin sandbox 里运行**：禁 localStorage/cookie；
  **不要 fetch 第三方 API**（null-origin CORS 会拦截）——远程/定时数据在
  任务里取好，通过 `data` 注入；`<img src="https://…">` 可以直接用
- **数据注入**：`data` 对象会作为 `window.__WIDGET_DATA__` 在 face 运行前
  注入，每次数据更新都会 postMessage 推送（face 里监听
  `omp-widget-data` 事件重渲染）；`window.DaimonCanvas` 提供
  `{canvasId, mountId}`
- **初始化幂等**：face 脚本可重复执行（数据更新不重载页面），不要
  append 元素到自身/后代
- 字体/视觉：默认继承卡片底色（深色），浅色面请自带背景
- html 字段 ≤ 64KB；`data` 只放数据（不做模板字符串拼接——face 里直接
  读 `window.__WIDGET_DATA__`）

示例（数据驱动的仪表）：

```
board { action: "save", id: "dash", board: { title: "仪表", widgets: [
  { type: "html", title: "驾驶舱", pos: { x: 0, y: 0, w: 540, h: 264 },
    data: { html: "<div id='rpm'></div><style>body{color:#e8e8e8;font-family:monospace}#rpm{font-size:34px;font-weight:700}</style><script>function paint(){var d=window.__WIDGET_DATA__;document.getElementById('rpm').textContent=(d.rpm??0).toFixed(1)}window.addEventListener('omp-widget-data',paint);paint()</script>",
            data: { rpm: 3200 } } },
] } }
```

## 完成后：给会话跳转入口

搭建/修改完成、看板已有内容时，在**回复末尾**附一个 daimon-canvas 围栏块
（kimi parity——聊天里直接打开刚创建的看板），用**真实** board id 和标题，不要编造：

```daimon-canvas
canvasId: <board id>
title: <board title>
```

（这就是唯一格式：三反引号 + `daimon-canvas` 语言标签 + `canvasId:`/`title:` 两行。
GUI 会把它渲染成"打开看板"卡片；不要在围栏外再重复标题链接。）

## 约束

- **save 是全量替换**：先 `get` 目标板 → 修改 → 整体写回，不要凭空构造（会丢其他卡）
- **pos 必须整数**（8px 网格对齐；`{x,y,w,h}` 全部整数）
- 组件类型必须来自 `schema` 的可用列表；字段缺省用 defaults 补齐
- **任务一致性**：`data.task`（如给卡加运行任务）必须描述该卡自身的可视化内容，
  禁止把无关作业挂到展示卡上
- 卡片 title 用中文；tone 由类型决定（schema 可查），不要手动改卡面风格

## 示例（新建汇率看板）

```
board { action: "save", id: "fx", board: {
  title: "汇率看板", widgets: [
    { type: "ticker", title: "美元人民币", pos: { x: 0, y: 0, w: 172, h: 88 },
      data: { label: "USD/CNY", value: "7.2481", delta: 0.0046 } },
    { type: "ticker", title: "欧元人民币", pos: { x: 184, y: 0, w: 172, h: 88 },
      data: { label: "EUR/CNY", value: "7.7945", delta: -0.0012 } },
    { type: "metric", title: "日元人民币", pos: { x: 368, y: 0, w: 172, h: 88 },
      data: { label: "JPY/CNY", value: 0.0485, delta: 0.0003 } },
    { type: "clock", title: "市场状态", pos: { x: 552, y: 0, w: 264, h: 132 },
      data: {} },
    { type: "metric", title: "综合汇率指数", pos: { x: 828, y: 0, w: 264, h: 132 },
      data: { label: "FX Index", value: 102.34, delta: 0.85 } },
  ] } }
```
