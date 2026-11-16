# widget — 一页自包含 HTML

在对话里摊开一页 HTML，给用户**看**或**选**。

**数据不要走这里。** 表格、对比、步骤、流程、趋势、关键数字、以及需要用户勾选的决定，
都用回复里的 ` ```ui ` 块（OpenUI Lang，见系统提示的「Visual answers」）。块是可读的、
可作答的、随回复流式长出的；页面只负责「看起来必须像成品」这件事。

## 何时使用

只有当答案的**样子本身就是答案**时才用：

- 版式式样的提案：改版前后并排、几个方案的样子对比
- 必须精确呈现的图稿、示意图、自绘图形
- 让用户在一个成型的界面上拍板（`awaitAnswer`）

其余情况一律不要用：普通文字回答、数据对比、清单、步骤、需要逐项决定的多选题。

<!-- WIDGET_RENDER_WHEN: injected from when.ts, the same text the system prompt carries -->

## 怎么写

```
widget { title?, html?, awaitAnswer? }
```

一页自包含 HTML（≤64KB），在沙箱里运行：没有网络会话、没有 localStorage，
远程数据先取好注入页面。宿主注入主题类与配色变量，页面必须跟随深浅色。

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
- **选中即引用**：页面里的选区由宿主转成对话引用（页面自己是沙箱，够不到转写记录）。
- **卡片工作区**：看板上的卡可以读自己目录里的文件——`window.musepiResources.list()` 与
  `window.musepiResources.read(path)` 返回 Promise；路径锁在这张卡的工作区内，越界会被宿主拒绝。
  页面本身没有文件系统，这是唯一的数据来源。
- **让用户选**：`awaitAnswer: true` 时，选项用 `.musepi-options` 或表单收集后用
  `.musepi-button` 调 `musepiSubmit(text, data)` 一次交回。`text` 用用户语言写清全部选择
  （它进模型上下文）；`data` 只回显给页面自己。`musepiSubmit` 非阻塞——本轮已结束，
  答案作为下一条用户消息到达；需要逐项决定许多条目时用 UI 块的 `Choice` / `Button`。

## html 主题自适应（硬性要求）

桌面端支持深浅色热切换，页面**必须跟随，禁止单一固定配色**。

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

1. **文字在响应，页面在对话里**：解释性文字放在页面外的回复里。
2. **渲染后不复述**：页面渲染完成就不再重复页里已有的内容，只说页面表达不了的。
3. 数据要真实算好填进去，不要让页面去猜。
4. 一页只讲一件事；一个回答里需要很多页时，先想想是不是该用 UI 块。

## 示例

```
widget { title: "改版前后", html: "<!doctype html><html><body>…</body></html>" }
→ 对话里直接摊开两栏对比图
```
