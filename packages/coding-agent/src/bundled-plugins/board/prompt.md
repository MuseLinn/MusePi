# board — 桌面看板读写

读写 desktop GUI 的看板（存储：`~/.musepi/boards/boards.json`，GUI 实时渲染）。
看板是一面卡片墙，每张卡是一个 `widget`。

## 何时使用

- 用户要求"把 X 放进看板 / 添加番茄钟卡 / 修改看板"
- 需要先了解现有看板内容（`list` / `get`）
- 设计新卡前先 `schema` 查类型、字段、默认值、卡面风格（tone）

## 怎么写

```
board { action, id?, board? }
```

|action|参数|说明|
|---|---|---|
|`list`|—|全部看板（id + 标题 + 组件数）|
|`get`|`id`|单个看板完整内容（含每个 widget 的 data/pos）|
|`schema`|—|widget 类型表：fields + defaults + tones|
|`resource.list`|`id` + `widgetId`|卡片工作区里的文件（卡目录内，一层）|
|`resource.read`|`id` + `widgetId` + `resourcePath`|读卡内文本资源（≤512KB，二进制拒绝）|
|`resource.write`|`id` + `widgetId` + `resourcePath` + `resourceText`|写卡内文本资源（原子替换，≤512KB）|
|`save`|`id` + `board`|整板替换/新建（**校验**：类型必须已知、pos 必须整数像素）|

组件类型与 `widget` 工具同源；各类型的 data 字段见 `widget` 工具签名。

## 约束

- **save 是全量替换**：先 `get` 目标板 → 修改 → 整体写回，不要凭空构造（会丢其他卡）
- **pos 必须整数**（8px 网格对齐；`{x,y,w,h}` 全部整数）
- 组件类型必须来自 `schema` 的可用列表；字段缺省用 defaults 补齐
- **改板先读板**：`get` 会带 `rev`，`save` 时把它作为 `expectedRev` 传回；别人在这之间改过就会拒绝并告诉你差了几版，重新读再改
- **任务一致性**：`data.task`（如给卡加运行任务）必须描述该卡自身的可视化内容，
  禁止把无关作业挂到展示卡上
- 卡片 title 用中文；tone 由类型决定（schema 可查），不要手动改卡面风格

## 看板设计规范 → `skill://board-design`

**布局、类型选择、卡面配色、html 组件规则、内置板保护、验收清单**都在
`skill://board-design`。新建一块板或重排布局前先读它：

```
bash: cat skill://board-design/SKILL.md
```

要点速记（细节见该 skill）：

- 画布 `BASE_W = 1092px`（12 列 × 92px − 12px gutter），卡间距 12；
  卡宽 = `92n − 12`、卡高 = `44n` 步进——**尽量铺满，不留大块空洞**
- 卡面只有两种：`block`（回复里的 `ui` 块）与 `html`（一页 HTML）。没有内置卡可选——
  数据长什么样，就用块里的 `Table`/`Stat`/`Steps`/`BarChart` 画出来
- `block` 类型把**回复里的 `ui` 块原样放到看板上**（`data.source` = 那段 OpenUI Lang，≤12KB）：
  生成出来的图、对比、步骤不必重写成 HTML；看板与回复里的块由同一个渲染器画出，样子一致。
- `html` 类型可放任意 HTML 面（sandbox 内运行、≤64KB、禁第三方 fetch、
  数据经 `data` 注入）——深浅色两套配色，见 `skill://widget-design`

## 完成后：给会话跳转入口

搭建/修改完成、看板已有内容时，在**回复末尾**附一个 daimon-canvas 围栏块
（聊天里直接打开刚创建的看板），用**真实** board id 和标题，不要编造：

```daimon-canvas
canvasId: <board id>
title: <board title>
```

（三反引号 + `daimon-canvas` 语言标签 + `canvasId:`/`title:` 两行。GUI 会把它
渲染成"打开看板"卡片；不要在围栏外再重复标题链接。）

## 示例（新建一块进度看板）

```
board { action: "save", id: "migrate", expectedRev: 0, board: {
  id: "migrate", title: "数据库迁移", widgets: [
    { id: "w1", type: "block", title: "迁移顺序", pos: { x: 0, y: 0, w: 452, h: 200 },
      data: { source: "root = Stack([Steps([{title: \"影子写\", status: \"done\"}, {title: \"双读\", status: \"current\"}, {title: \"切主\"}])])" } },
    { id: "w2", type: "block", title: "延迟与错误率", pos: { x: 464, y: 0, w: 452, h: 200 },
      data: { source: "root = Stack([Row([Stat(\"P95\", \"38ms\", \"-12%\", \"success\"), Stat(\"错误率\", \"0.4%\", \"+0.1%\", \"warning\")])])" } },
  ] } }
```

第一次保存不需要 `expectedRev`；之后改板先 `get` 拿 `rev`，再把它作为 `expectedRev` 传回。
