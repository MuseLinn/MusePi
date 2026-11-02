---
name: widget-design
description: 看板与对话内联 widget 卡片的设计与使用规范——何时主动生成活卡片、怎么写 data、卡面与布局原则（活卡片设计规范）。触发：用户要求可视化/看板/交互卡片，或回答包含数值对比、清单、流程、行情、时序数据时。
---

# Widget 设计规范

MusePi 的 widget 是**活卡片**：渲染在对话内联或看板网格里，带真实数据和交互，
而不是静态文字排版。`widget` 工具负责生成（参数表见工具描述），本 skill 负责
**判断何时用、怎么设计得像样**。

## 何时主动用（不等用户说"可视化"）

- **数值/对比**：个税、费用换算、指标对比、价格/汇率 → `calc`/`metric`/`ticker`/`fx`
- **清单/流程**：待办、检查项、打卡 → `todo`；专注计时 → `pomodoro`
- **行情/时序**：股价/汇率实时盯盘 → `stocks`/`fx`/`kline`/`heatwall`/`indextape`
- **系统状态**：时钟 + 三市状态 → `clock`；仪表读数 → `gauge`
- **介绍/媒体**：产品介绍视频 → `video`（可填 B站 bvid）；音乐 → `music`
- **历史/事实**：历史上的今天 → `history`（真实数据源自动刷新）
- **调参观察**：用户需要拖滑杆看效果 → `slider`（噪声/抖动/频率）
- **相册/合集**：多张图 → `gallery`

**不要**用于：普通文字回答、逐行代码解释、文件列表、破坏性/阻塞输入流程、
大型长驻应用。

## 怎么写 data

- 字段可省略——缺省值自动补齐（如 `calc` 缺 `mode` 默认 `post`）。
- 数据卡（fx/stocks/history）**自动拉真实数据**（60s 刷新），data 里只需
  `chip`/`title`/`pairs`/`rows` 等描述性字段——**不要**在 data 里塞快照值。
- 内容有真实信息就填真实信息（`video` 填真实 bvid/url；`music` 填真实曲目），
  不要给演示假数据。
- `title` 可选，默认组件名；写有辨识度的标题（如"今日汇率"而非"汇率卡"）。

## 卡面原则（组件即卡）

- **每个组件自带卡面**（深色渐变/浅色磨砂/蓝色系）——不要给卡片再套外框。
- 尺寸：宽 340×200 起（网格 92×44，最小 172×76，画布 1092）；数据多的卡
  拉高（如 history/fx/stocks 常用 560+ 高），视频/音乐卡常用 4:3。
- 卡内滚动：列表内容超卡高时用卡内滚动（history 事件列表），不要撑破卡片。
- 聚焦交互：点击封面播放（video）、拖滑杆（slider）、勾选（todo）——交互
  都要即时反馈，禁止无响应的装饰按钮。
- **渲染提示**：聊天内联与看板画布共用同一卡面——内联宽度随消息自适应；
  看板上卡片受 ChromaGrid 组光效（鼠标 RGB 色散光晕）氛围影响，暗色大卡
  读感好——卡面数据完整是主体，光效只是氛围，不要为光效改变配色。

## 自定义 HTML 组件（html 类型）

`html` 卡是"自由面"——sandbox 内运行你的 HTML/CSS/JS，覆盖内置组件
之外的场景（统计面板、流程可视化、复合交互）。写得像 kimiwork
blueprint 组件一样可用的要点：

### 结构（自包含单文件）
- **一个 `<style>` + body 内一个根元素**；所有 CSS 写进 `<style>`
  （沙箱无外部 CSS 文件）。
- 根元素撑满视口：`html, body { height: 100%; margin: 0; }`，内容用
  flex/grid 布局——**不要固定像素宽**（卡尺寸可变）。
- 数据从 `window.musepiWidgetData` 读（agent 塞的 `data` 字段），不要
  硬编码。旧名 `window.__WIDGET_DATA__` 仍然可用，但新写的面一律用
  `musepiWidgetData`；数据更新时宿主推 `musepi-widget-data` 消息并
  派发同名 CustomEvent（旧的 `omp-widget-data` 仍会派发一次）。

### 样式
- **两套主题**（深色为主）：`.musepi-theme-dark body { … }` +
  `.musepi-theme-light body { … }`，所有有颜色的元素都要两套（铁律，
  宿主热切换会重建 iframe）。旧的 `.omp-theme-*` 类名仍在，但新写的
  面一律用 `musepi-theme-*`。
- 深底配浅字、浅底配深字（对比度 ≥4.5:1）；设了 `background` 的元素
  必须同时设 `color`。
- 配色用 CSS 变量组织（`:root { --bg; --fg; --accent }`，两套主题换值），
  比到处硬编码好维护；字号 12-14px，卡内边距 12-16px。

### 交互（JS）
- 按钮/滑杆/勾选**即时反馈**（hover/点击态），禁止无响应装饰。
- 需要外部数据：**先取好注入 data**（沙箱禁第三方 fetch）；`<img src="https://…">`
  可用（不回读字节，不受 CORS 限制）。
- 高度自适应：内容变化后调一次注入的 `ompReportHeight()`，宿主自动
  跟随，别让内容溢出卡片。
- 主题切换宿主重建 iframe，无需自己监听。

### 让用户选：直接用宿主给的类

做「让用户挑」的面时**不要自己写一整套组件**，宿主已经注好了：

- `.musepi-options` — 网格容器；加 `data-columns="2"` 变两列
- `.musepi-option` — 一张选项卡（用 `<button>`），选中时加 `aria-pressed="true"`
- `.musepi-option-sub` — 选项下方的补充说明
- `.musepi-button` — 主操作按钮

配色用宿主注入的变量，不要自己挑颜色：`var(--bg)`、`var(--bg-raised)`、
`var(--fg)`、`var(--fg-muted)`、`var(--fg-faint)`、`var(--border)`、
`var(--border-strong)`、`var(--accent)`、`var(--radius-sm|md|lg)`。
沙箱是 null origin，读不到应用的 CSS 变量，这些值是宿主解析后注入的，
深浅主题各一套、会跟着宿主实时切换。

```
<div class="musepi-options" data-columns="2">
  <button class="musepi-option" onclick="pick(this)">
    A 档 · 抬升色 74%
    <span class="musepi-option-sub">保留磨砂感，透出 26% 背景</span>
  </button>
  <button class="musepi-option" onclick="pick(this)">B 档 · 实心面板</button>
</div>
```

### 把选择交回会话（可交互面）

当这个面需要用户做选择（选密度、挑方案、确认取舍）而不是纯展示时，用
注入的 `musepiSubmit(text)` 把答案交回会话——它会作为一条用户消息发出
去，下一轮你就拿到了用户的选择：

```
button.onclick = function () { musepiSubmit("用户选了 A 档：74% 抬升色"); };
```

- **非阻塞**：你的这一轮已经结束，答案作为下一条用户消息到达。要卡住这一
  轮等答案，用 `ask` 工具，别用这个。
- `text` 会进入你的上下文，等于给了模型生成的代码一条注入通道：只放你
  自己写的选项文案，不要回显用户的自由输入（上限 8KB）。
- 一个面**只能提交一次**：宿主在首次提交后会加上 `html[data-musepi-answered]`、
  派发 `musepi-widget-answered` 事件并把控件变灰，重复点击不会发出第二条消息。
  想显示「已提交」就监听该事件读 `window.musepiWidgetAnswered`。

### 选哪一种提问方式

| 情况 | 用什么 |
|---|---|
| 同一轮内必须拿到答案才能继续 | **`ask` 工具**——它会卡住这一轮 |
| 答案可以晚点回，本轮先结束 | HTML 面 + `musepiSubmit` |

`musepiSubmit` 不阻塞：你的这一轮已经结束，答案作为下一条用户消息到达。
**需要在同一轮里据答案调整后续步骤时，用 `ask`，不要用这个。**

### 检查清单
- [ ] 两套主题都有、对比度够
- [ ] 数据来自 `__WIDGET_DATA__` 而非硬编码
- [ ] 布局自适应卡尺寸（flex/grid，无固定像素墙）
- [ ] 交互有反馈、高度上报正确
- [ ] 选择类面用了 `.musepi-options` / `.musepi-option` 和宿主注入的配色变量
- [ ] 需要同一轮内拿到答案时用 `ask`，而不是 `musepiSubmit`
- [ ] 需要用户选择时用 `musepiSubmit`；纯展示则不提交
- [ ] 总长 ≤64KB（超了宿主不渲染这张卡）

## 组合成板（看板）

- 一屏 3-4 卡：数据类并排（fx + stocks + history），媒体类单独大卡
  （music/video）。
- 相关数值放一组：时钟 + 市场状态、汇率 + 走势。
- 卡与卡之间留 12px gutter，右缘对齐画布右缘。
- 任务一致性：卡片带 `task` 元数据时任务必须与卡展示内容直接相关
  （如汇率卡任务="刷新汇率"），禁止挂无关作业。

## 反模式

- ❌ 用大段文字描述本来可以可视化的数值/清单。
- ❌ 给组件卡再套边框/卡片壳（组件本身就是卡）。
- ❌ 把过时快照写进 data（能自动刷新的数据让组件自己拉）。
- ❌ 塞满一屏卡片没有主次（一个主题 ≤ 4 卡）。
