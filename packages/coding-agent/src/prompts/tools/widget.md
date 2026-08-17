# widget — 内联交互卡片（kimi inline-widget parity）

在会话中渲染一张**可交互的活卡片**（计算器、滑杆面板、行情、指标、待办、时钟），
而不是用大段文字描述数值/结构。

## 何时使用

回答具有以下结构时**主动**使用（不等用户说"可视化"）：

- **数值/对比**：计算器（个税、费用、换算）、指标对比、价格/汇率
- **交互**：用户需要调参观察（滑杆面板——噪声/抖动对信号的影响）
- **仪表盘感**：一组相关数值（时钟 + 市场状态、行情列表）
- **清单**：待办、检查项

**不要**用于：普通文字回答、逐行代码解释、文件列表、破坏性/阻塞输入流程、
大型长驻应用。

## 任务一致性（硬性约束）

看板卡片可能带 `task` 元数据（运行按钮 + 查看任务）。**任务必须与卡片展示的
可视化内容直接相关**——例如汇率卡的任务是"刷新汇率"，指标卡的任务是"更新指标
快照"。禁止把无关作业（系统体检、文件整理等）挂到展示型卡片上；需要独立作业
时另行设计专用卡片。渲染内联 widget 时如无真实任务则不填 `task` 字段。

## 怎么写

```
widget { type, data, title? }
```

| type | data 字段 | 说明 |
|---|---|---|
| `calc` | `mode: "pre"\|"post"`, `amount: number` | 劳务费个税计算器（≤4000 元规则：收入−800，税率 20%） |
| `slider` | `noise/jitter/freq/amp: number` | 参数滑杆 + 实时波形 |
| `ticker` | `label: string`, `value: string`, `delta: number` | 行情卡（值 + 涨跌 + 迷你图） |
| `metric` | `label: string`, `value: number`, `delta: number` | 指标卡（数字滚动 + 涨跌色） |
| `todo` | `items: [{id, text, done}]` | 待办清单 |
| `clock` | `market: "cn"\|"us"\|"eu"` | 数字时钟 + CN/US/EU 市场状态 |
| `gallery` | `items: [string]` | 手风琴画廊 |
| `pomodoro` | `mode: "focus"\|"short"\|"long"` | 番茄钟（圆环 + 轮次统计） |
| `video` | `url`, `bvid`, `title`, `subtitle` | 视频卡：`bvid` 填 B站视频号（如 `BV1vT411d7QE` 凡人修仙传）→ 封面点击 B站播放器内联播放；`url` 填 mp4 直链 → 自绘控制条（播放/进度/静音/全屏）；都空则装饰封面占位 |
| `music` | `queue: [{id, year, title, artist, file}]` | 黑胶播放器：真音频（Internet Archive 公版录音）+ 频谱 + 播放队列 |
| `history` | `header`, `date`, `events: [{year, text}]` | 历史上的今天：实时数据源 + 8-bit 像素标题 + 可滚动事件列表 |
| `fx` | `chip`, `title`, `pairs: [{code, unit, note}]` | 实时汇率（60s 自动刷新 + 30 日走势） |
| `stocks` | `chip`, `title`, `rows: [{code, label, badge, name}]` | 实时 A 股盯盘（腾讯行情 + 30 日 K 线迷你图） |
| `gauge` | `value`, `status` | 仪表盘读数 |
| `kline` | `candles: [...]` | K 线图（蜡烛 + 均线） |
| `heatwall` | `tiles: [{name, delta}]` | 涨跌热力墙 |
| `indextape` | `indices: [...]` | 指数磁带（三市指数） |
| `html` | `html: string`, `data: object` | 自定义 HTML 面（sandbox 内运行；数据经 `data` 注入 `window.__WIDGET_DATA__`；禁第三方 fetch——远程数据先取好再注入；`<img src>` 可用） |

- `data` 可省略字段——缺省值自动补齐（如 `calc` 缺 `mode` 默认 `post`）。
- `title` 可选，默认组件名。

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
