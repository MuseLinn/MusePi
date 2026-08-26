# MusePi 看板介绍：让 AI 亲手设计你的桌面组件墙

[English](board-dashboard-intro.md) | 中文

> 本文是看板（Board/Dashboard）组件平台的通俗介绍文档，面向使用与理解系统的人。
> 架构立项见 `docs/board-dashboard.md`，组件渲染规范见 `docs/widget-design-system.md`。

MusePi 看板是 musepi-omp 在 2026 年 8 月立项的"组件看板"平台——它不是传统意义上的仪表盘，而是一块可交互、可编辑、可常驻桌面的组件画布，用户既可以直接使用，也可以让 AI 代理（agent）通过工具亲手为你排版、填数据、甚至生成新组件。它参考了 Kimi Work 的产品形态（可交互可编辑的看板卡片、消息内联 widget）与 BitFun Canvas 的技术范式（Agentic Mini Apps、iframe 沙箱桥接），但最终走出了一条属于自己的路线：**白名单组件注册表 + schema 驱动的数据流**。

## 一、三端一体的架构：GUI、daemon 与 agent

看板系统的代码横跨三个进程。最上层是 Electron GUI 里的 `BoardPage`（React）：它渲染看板网格，支持拖放与缩放，每个组件卡由 `<WidgetShell>` 包裹注册表中的组件，还可以打开独立的小窗把看板"钉"到桌面常驻。中间层是 daemon（`packages/coding-agent/src/daemon`），它通过既有的 WebSocket JSON-RPC 通道暴露一组新方法：`board.list`、`board.save`、`board.template`，以及 `widget.data`（行情、股票等数据源代理）、`widget.schema`（向 agent 暴露组件类型/字段）与 `widget.render`。最底层是 agent 本身——模型不直接读写 DOM，而是通过 `board` 与 `widget` 两个工具与看板交互，GUI 与 agent 共享同一份权威存储，验证逻辑也完全一致。

## 二、白名单组件注册表：一次开发、三处渲染

看板最核心的设计决策是**组件运行环境**。团队没有选择"AI 自由生成任意 HTML"的开放模式作为首选，而是维护一个编译进 GUI 的白名单组件注册表（`WidgetRegistry`）：组件是 TSX 源码，来自 reactbits 视觉件（CountUp、ShinyText、SpotlightCard 等已落地）加自研功能件，agent 只能通过工具**选类型 + 填数据**。理由很实在：其一，Kimi 式的消息内联 widget 若每条消息都开一个 iframe 沙箱代价太重，注册表组件可以直接渲染在消息流里；其二，reactbits 组件全是声明式受控组件，白名单本身就是**类型级隔离**，无需运行沙箱；其三，经过 schema 校验的数据流比任意 HTML 更可靠、可审计、可 diff。

一份组件可以三处复用：看板卡、transcript 消息内联卡（kimi 式），以及钉在桌面的常驻小窗。desktop-web 里已有的 `tool-render/registry.ts`（30+ 工具渲染器）正是消息内联 widget 的雏形，扩展它加入通用 `widget.*` 渲染器即可复用整条管线。

## 三、组件库：十七种类型与四种色调

当前组件清单相当丰富，`WIDGET_TYPES` 表里定义了 17 种类型，每种都带有字段与默认值：`clock`（数字时钟 + 市场状态，深色）、`ticker`（汇率卡，值 + 涨跌 + 迷你线图，深色）、`metric`（指标卡）、`calc`（个税计算器式的 toggle + 输入 + 进度条，浅色）、`slider`（参数控制卡，多滑块实时重绘，浅色）、`todo`（待办增删勾选）、`pomodoro`（番茄钟，圆环进度 + 专注/短休/长休模式 + 今日轮数统计，蓝色）、`video`（内嵌视频播放）、`gallery`、`gauge`（行情温度计）、`kline`（A 股 K 线 + 盯盘列表）、`heatwall`（涨跌热力墙）、`indextape`（指数行情条）、`music`（复古黑胶播放器，含 78 RPM 唱片队列）、`history`（历史上的今天时间线）、`html`（自由 HTML 卡）与 `fx`（多货币对汇率列表）。每种类型还带 `tone` 标注——default/dark/light/blue 四种卡壳色调，让 agent 在填数据前就知道这张卡的视觉风格。

## 四、画布交互：拖拽、缩放、编辑与模板

看板页是一张网格画布，卡片默认四档尺寸（1×1 / 2×1 / 1×2 / 2×2 grid 单元，统一最小 180×140）。交互清单参考了 Kimi Work Hello World 示例看板：按住顶栏 **DRAG** 拖动位置、拖右下角手柄 **RESIZE**（尺寸数字实时跟随）、点击 **OPEN** 展开折叠内容、点击 **RUN** 执行卡片上的本地代码并重跑、**FOCUS** 聚焦放大为模态大图、**PIN** 固定到桌面成为常驻小窗。编辑模式下可以改标题、换数据源、调配色、拖动排序、增删组件；模板市场提供"每日财经""Hello World"等示例模板一键创建。

## 五、agent 亲手设计看板

这是整个系统最有意思的部分：**agent 不需要懂 React 或动画**，只需要通过两个工具操作看板。`board` 工具提供四种 action——`list`（列出所有看板）、`get`（读取某看板完整布局）、`save`（整体替换看板，写入前按 schema 校验）、`schema`（返回 widget 类型/字段/默认值/色调表）。`widget` 工具则用于在对话流中内联渲染可交互卡片。工具示例里就有一条"给 hello 看板加一张番茄钟卡"的调用：

```json
{
  "action": "save",
  "id": "hello",
  "board": {
    "id": "hello",
    "title": "一块活的看板",
    "widgets": [
      { "id": "w1", "type": "pomodoro", "title": "番茄钟", "data": {}, "pos": { "x": 0, "y": 0, "w": 300, "h": 300 } }
    ]
  }
}
```

一次调用，卡片就出现在看板上。`widget.schema` 是关键：agent 先查询可用的类型与字段，再由工具按 schema 自动补全参数，形成"封装好底座、暴露给 agent"的能力闭环。

## 六、任务系统与数据源代理

看板卡不止是展示。widget 的 `data.task` 字段可以给卡片挂一个可运行任务：`{enabled, name, desc, schedule, runs[]}`——既可以点卡片上的运行按钮手动执行，也可以设每小时/每天定时执行（调度引擎列为后续里程碑），运行记录会持久化并展示成功/失败状态。典型例子是"汇率抓取（每小时，成功记录）"和"电脑体检（每天，含失败记录）"。数据方面，组件不直连外网：行情、股票数据统一走 daemon 的 `widget.data` 代理，数据策略可审计；MVP 阶段允许静态示例数据加一个真实数据源。

## 七、持久化与示例保护

所有看板落在 `~/.musepi/boards/boards.json`，与 notes、plans 同级，跨重启可备份。读写层（`daemon/boards.ts`）做了三件值得注意的事：写入采用 tmp + rename 的**原子写**；读取时强制把位置坐标取整为整数像素，保证画布不出现半像素错位；`validateBoards` 在落盘前校验 widget 类型是否在注册表内、`html` 卡的 HTML 是否 ≤ 64KB、id/title 是否为字符串。内置示例看板带 `builtin` 标记，agent 和 GUI 都无权修改或删除它们——想改只能新建一张自己的看板。

## 八、设计系统：kimi 规范到 MusePi token

组件视觉不是各画各的，而是共用一份从 kimi 官方 widget 设计系统提炼、映射到 MusePi token 的规范（`widget-design-system.md`）。核心原则是**黑白优先、灰为层级**：交互强调用 text-primary 加灰色 tint，accent 蓝只用于数据可视化与语义强调，绝不拿彩色当"可交互"标记；组件不设默认背景，宿主背景透出，禁用渐变光球、bokeh、重阴影等装饰。图表色遵循色盲安全规则（红绿不同图、灰度可辨、不单靠颜色），数字显示强制 `tabular-nums` 且不换 mono 字体，间距/圆角全部落在固定阶梯上（4/8/12/16/20/24/32 与 4/6/8/10/12/16/full），嵌套圆角外大内小，动效限 60–300ms 且有目的。规范同时约束了流式渲染：内容早出、样式短、控件用 inline style、`<script>` 放最后，保证在流式 DOM diff 中不闪烁。

## 九、安全边界与未来路线

安全上，iframe 沙箱仍保留为高级路径：AI 自由生成的单 HTML 组件会被隔离运行，通过带 origin 白名单校验的 postMessage bridge 访问数据，并走 bitfun 式的"notice → draft → preview → permission review → apply"流程，强制预览与人工确认后才生效。`allow-scripts` 必须开、`allow-same-origin` 必须禁，防止逃逸。白名单与沙箱两套并存，沙箱组件会打上专属 badge。里程碑上，M1 画布骨架 + WidgetRegistry（约 1 周）、M2 组件运行时与内置五组件、M3 编辑与持久化（拖放缩放、daemon RPC 落盘）、M4 AI 生成与模板市场、M5 桌面常驻小窗——一个让用户和 AI 共同创作桌面组件墙的平台，正按这条路线稳步推进。
