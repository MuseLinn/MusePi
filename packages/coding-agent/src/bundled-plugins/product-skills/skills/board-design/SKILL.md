---
name: board-design
description: 桌面看板（board）的设计与读写规范——何时建板、怎么规划卡片布局、如何选 widget 类型并配 data/pos（避免类型数据错配和不可用布局）。触发：用户要求"看板/桌面卡片墙/把 X 放上看板/添加卡片"。
---

# 看板设计规范

MusePi 看板是**桌面卡片墙**（GUI 实时渲染）：`board` 工具读写（action:
list/get/schema/save），卡片是 `widget` 类型的活卡片（同一套类型表，见
`widget-design` skill 的映射）。**先 `board schema` 查类型表，再设计，最后
save**——schema 是唯一事实源，不要凭记忆猜字段。

## 看板数据结构

```
board { action, id?, board? }
```

- `list` — 全部看板（id + 标题 + 组件数）
- `get <id>` — 单个看板完整内容（widget 的 data/pos）
- `schema` — widget 类型表（fields + defaults + tones）
- `save <id> <board>` — 整板替换/新建（校验：类型已知、pos 整数像素）

board 形状：`{ id, title, widgets: [{ id, type, title?, data?, pos }] }`

## 布局原则（像素网格，kimi-work parity）

- **画布网格**：列宽 92px × 行高 44px，gutter 12px——卡片位置/尺寸用
  整数像素（`pos: {x, y, w, h}`），**绝不允许小数**（校验直接拒绝）。
- **最小卡片** 2 列 × 2 行（172×76）；推荐起步 356×296（4×7）。
- **对齐网格**：x/y 尽量落在网格线上（92 的倍数 ± gutter），整板观感整齐；
  卡片之间留 12px gutter，不要贴边/重叠。
- **尺寸与内容匹配**：视频/图库/仪表这类"展示型"卡给大方块
  （≥356×296）；ticker/metric/clock 这类"信息型"给细长或小方块；
  todo/pomodoro 给中块。**别让信息卡空占大块，也别让图表卡挤成小条**。

## 类型选择（避免"A 给 B 乱给"）

| 用户要什么 | 用哪个 widget | data 要点 |
|---|---|---|
| 时钟/三市状态 | `clock` | `market: "cn"/"us"/"hk"` |
| 计算/换算/对比 | `calc` | 表达式/参数（缺省自动补） |
| 待办/检查项/打卡 | `todo` | 列表项 |
| 专注计时 | `pomodoro` | 时长等 |
| 股票/汇率盯盘 | `stocks`/`fx` | `pairs`/`symbols`（**自动拉真实数据，别塞快照**）|
| K线/热图/指数 | `kline`/`heatwall`/`indextape` | 标的/板块描述 |
| 仪表读数 | `gauge` | 数值/阈值 |
| 视频介绍 | `video` | B站 `bvid` 或直链 `url` |
| 相册/合集 | `gallery` | 图片列表 |
| 音乐 | `music` | 曲目/播放列表 |
| 历史上的今天 | `history` | 主题词（自动刷新真实数据）|
| 调参观察 | `slider` | 参数范围/步长 |
| 自定义/嵌入 | `html` | `data.html` 字符串（**≤64KB**）|
| 指标/刻度 | `metric`/`ticker` | 数值/刻度项 |

**关键**：类型与 data **必须匹配**——`ticker` 塞文字段落、`video` 塞数字、
`gallery` 塞单个字符串，都会渲染成不可用的卡。拿不准就 `board schema`
看该类型的 fields 再填。

## 内置板保护

`builtin: true` 的板（如 finance/hello 示例）是种子示例，**agent 不可修改**
（save 会被拒绝）——用户要改示例内容时，**新建一块板**再填。

## 渲染提示（GUI 同源）

- **画布自适应**：看板画布按窗口宽度等比缩放（`scale = 窗口宽 / 1092`，
  pos 网格不变、整数像素照旧）——小窗口看板整体缩小，不要为了"填满"
  硬塞卡片。
- **ChromaGrid 组光效**：画布有鼠标驱动的 RGB 色散光晕（暗色大卡上读感好）——
  光效是氛围，**卡面数据完整才是主体**，别依赖背景装饰。
- **删除确认有动画**：删除看板/组件走标准弹窗（进入/退出动画 + Esc 取消）——
  破坏性操作本就该确认，不要绕过。

## 验收清单（save 前自查）

1. `id`/`title` 是字符串，`widgets` 是数组
2. 每个 widget 的 `type` 在 schema 中（先 `schema` 查过）
3. `pos` 四值全是整数像素，卡片在画布内、不重叠、间距合理
4. `data` 与类型匹配（看板工具校验类型/pos，data 靠自觉——错配就不可用）
5. html 卡 ≤64KB
6. 不是试图改 builtin 板
