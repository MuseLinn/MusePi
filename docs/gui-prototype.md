# MusePi GUI 界面原型设计(布局规划)

> 状态:规划中(2026-08-02 综合更新:新增会话交互设计参考(Claude Desktop / Codex)、看板组件化界面(BitFun)分析)。配套 `docs/gui-architecture.md`。
> 依据:collab-web 现有组件(78 tests / 346 key 中文)直接复用;TUI 交互语义平移为 GUI 控件;参照 Claude Code Desktop / Codex / BitFun / openchamber / aicss.dev。

> ## ⚠️ 现状更新(2026-08-04):布局已按 openchamber 风格落地,本文档为历史线稿
>
> - 三栏布局与折叠行为已实现(会话列表 | 对话流 | 详情面板,`packages/gui`),最终视觉以 openchamber 1.18 为基底(玻璃质感 shell + 圆角卡片),与本线稿的细节(边距、控件形态)有出入。
> - 设置面板最终形态见 **`docs/gui-settings.md`**(2026-08-04,与实现同步)。
> - 看板/组件化界面(第 5 节)、科学工作流(4.7)、cuelume 音效(5.5)等仍属规划,未实施。


## 1. 设计原则

1. **三栏主界面,双栏折叠**:会话列表 | 对话流 | 详情面板。窄窗口自动折叠(断点 1100px / 720px)。
2. **会话即 session**(Claude Desktop Code tab 模型):每个会话独立 chat history / 工作目录 / 变更集,Git 隔离,多会话并行;侧栏列出会话 + 运行状态。
3. **面板化工作区**(Claude Desktop pane 模型):chat / diff / browser / terminal / file / plan / subagent 是可拖拽重排、可缩放的 pane;对话流是主 pane,其余按需从 Views 菜单或上下文动作打开。
4. **文件直达**:会话中出现的每个文件路径都是交互入口——点击打开(file pane / diff / browser 按类型分发),右键有上下文菜单(attach as context / open in / reveal / copy path)。
5. **agent 活动可见**:thinking / tool call / subagent 永远有视觉位置,不靠滚动猜;视图模式可折叠细节。
6. **审批内联化**:权限审批以卡片出现在工具调用位置;权限模式选择器(Manual / Accept edits / Plan / Auto)随时可切。
7. **远程与本地同构**:本地 / relay / tunnel 连接渲染同一套界面,顶栏只换连接方式指示;二维码扫码即连。
8. **主题 token 由 scheme 推导**(kimi-code #2083):accent 前景色跟随 scheme 背景,不固定白色。
9. **对话即构建**(BitFun 看板):任何「界面/看板/报表」类需求,直接在会话里描述即生成组件化布局,不离开会话流。
10. **主题体系正交化**(参考 kimi-code web,源码已验证 `apps/kimi-web/src/style.css`;实现再参考 opencode,源码已验证 `packages/ui/src/theme/` + `v2/styles/colors.css`):配色方案 × 强调色两条正交轴——`data-color-scheme`(light/dark)+ `data-accent`(brand/mono/ocean/jade 四预设,opencode 的 `data-theme` × `data-color-scheme` 双轴同构);v2 语义 token(`--color-accent` / `--color-accent-soft` / `--color-accent-bd` / `--color-bg` / `--color-warning` / `--color-danger` / `--color-ok`)+ 半径阶梯(`--radius-*`)+ 字号阶梯(`--ui-font-size-*`)+ safe-area 变量(移动端刘海)。**accent 前景色由 scheme 推导**(kimi #2083 教训):dark 下 accent 亮、前景深;light 下 accent 深、前景白,四预设各带 light/dark 成对值(同 opencode oc-2.json 的 light/dark palette 结构)。✅ 已落地(commit 待定):collab-web `tokens.css` + `lib/theme.ts`(`useAccentPreference`/`ACCENT_PRESETS`),gui 顶栏 AccentToggle 循环切四预设;计算样式 9 组合验证通过。

## 2. 信息架构

```
顶层(左侧导航栏,窄图标 + 宽标签)
├── 会话 Sessions        → 会话列表(左栏)+ 对话流(主 pane)
├── 看板 Boards          → 组件化看板工作区(模板市场 + 自定义)(Phase 6+)
├── Agents               → 运行中/历史 subagent 聚合视图
├── 统计 Stats           → 复用 @musepi/omp-stats 看板
├── 设置 Settings
│   ├── 供应商 Providers   → provider registry 配置 UI
│   ├── 权限 Permission   → 18 级权限链可视化 + 审批策略
│   ├── 远程 Remote       → 连接方式:LAN / relay / tunnel + 二维码
│   ├── 主题 Theme        → 深浅/高对比 + accent 色
│   └── 语言 Language     → en-US / zh-CN(复用 collab i18n 切换)
└── 连接状态条(全局顶部)
    [● 本地 daemon] / [● relay] / [◐ tunnel] + [扫码连接]
```

## 3. 主界面线框(桌面,1280px+;pane 布局)

```
┌────────────────────────────────────────────────────────────────────────┐
│ ⌘ M u s e P i   ● 本地 daemon   ● fix-auth · gpt-5   [Manual▾]  [中]   │ ← 顶栏(连接/会话/模型/权限模式/语言)
├───────────────┬────────────────────────────────────────────────────────┤
│ 会话树(260px) │ 对话流(主 pane)                        │ 详情面板(300px) │
│               │                                        │                │
│ 🔍 搜索 · 过滤▾ │ ┌────────────────────────────────────┐ │ Agent         │
│ ┌───────────┐ │ │ 你: 把登录 TTL 修复了               │ │ ┌────────────┐ │
│ │ ▶ fix-auth │ │ ├────────────────────────────────────┤ │ │ 主代理 阶段 │ │
│ │   ├─ 分支A  │ │ │ 思考(折叠,默认 3 行)…              │ │ ├────────────┤ │
│ │   └─ 子代理 │ │ ├────────────────────────────────────┤ │ │ 子代理进度  │ │
│ ├───────────┤ │ │ 🔧 edit · src/auth.ts:112          │ │ │ ① 侦察 ✓   │ │
│ │ design-api │ │ │  ~/…/auth.ts +10 -3    [打开 diff] │ │ │ ② 实施 …   │ │
│ ├───────────┤ │ ├────────────────────────────────────┤ │ ├────────────┤ │
│ │ ✎ 新会话   │ │ │ ⚠ 审批: write ~/.config/app.toml   │ │ │ 文件(diff)  │ │
│ └───────────┘ │ │   [批准] [拒绝] [本次会话允许]       │ │ ├────────────┤ │
│               │ ├────────────────────────────────────┤ │ │ 上下文 42k  │ │
│               │ │ Agent: 修复完成,12 测试全绿…         │ │ └────────────┘ │
│               │ ├────────────────────────────────────┤ │                │
│               │ │ 输入… [✨附] [模型▾]   [ctrl+⏎ 发送] │ │                │
│               │ └────────────────────────────────────┘ │                │
│               │ 视图: Normal▾ (Normal/Verbose/Summary)  │                │
└───────────────┴────────────────────────────────────────┴────────────────┘
```

**Pane 扩展(从 Views 菜单或会话动作打开,拖拽重排/缩放,`Cmd+\` 关闭)**:

```
┌──────────────┬──────────────────────────────┬──────────────┐
│ 对话流        │ Diff pane                    │ Terminal     │
│ …             │ 文件列表 | 变更              │ npm test     │
│               │ src/auth.ts  +10 -3          │ …            │
│               │   -if (!expired)             │              │
│               │   +if (now > expiresAt)  ←行 │              │
│               │   评论框(点击行弹出)         │              │
├──────────────┴──────────────────────────────┴──────────────┤
│ Browser pane(dev server 预览 / 外部站点 / Claude 自验证)    │
│ File pane(spot edit + Save,磁盘变更检测)                    │
└─────────────────────────────────────────────────────────────┘
```

## 4. 会话交互设计(参考 Claude Code Desktop / Codex)

### 4.1 文件交互(会话中出现的每个路径都是入口)

| 交互 | 行为 |
|---|---|
| 点击文件路径(chat / diff / 工具卡) | 代码 → file pane;HTML/PDF/图片/视频 → Browser pane |
| 右键路径 | **Attach as context**(加入下一条 prompt)/ **Open in**(VS Code/Cursor/Zed)/ **在 Finder 显示** / **复制路径** |
| file pane 编辑 | spot edit + Save;磁盘变更检测(文件被外部改过 → 警告 override/discard) |
| `@` 提及 | 输入 `@` + 文件名,把文件加入会话上下文 |
| 拖放 / 附件 | 截图、PDF、设计稿直接拖入输入区(配合原生视觉理解) |

### 4.2 Diff 审查

- 工具卡上的 **diff stats 指示器**(`+10 -3`)→ 点击打开 diff pane(左文件列表、右变更)。
- **行级评论**:点击 diff 任意行弹评论框,Enter 提交,`Cmd+Enter` 批量提交;Claude 读评论后修改,产出新 diff。
- **Review code**:diff 顶栏一键让 agent 自审,评论直接落在 diff 视图。
- PR 监控(Phase 6+):CI 状态条 + auto-fix / auto-merge。

### 4.3 权限模式选择器(顶栏,会话中可切)

| 模式 | 行为(对齐 TUI 权限链) |
|---|---|
| Manual(默认) | 改文件/跑命令前先问,出 diff 逐个 accept/reject |
| Accept edits | 自动接受文件编辑,命令仍问 |
| Plan | 只读探索 + 计划,不改源码(对齐 TUI plan 模式) |
| Auto | 后台安全检查,减少审批弹窗 |
| Bypass | 沙箱/容器专用 |

### 4.4 视图模式(对话流右上,`Ctrl+O` 循环)

| 模式 | 显示 |
|---|---|
| Normal | 工具调用折叠为摘要卡,完整文本回复 |
| Verbose | 每个工具调用/文件读/中间步骤 |
| Summary | 只留最终回复 + 变更(多会话巡检时用) |

### 4.5 扩展功能(输入区 `+` 按钮)

- **附件**:文件 / 图片(截图、设计稿)/ PDF。
- **Skills**:复用 musepi 的 skills 体系(`/技能名` 或 `+` 菜单)。
- **Connectors / MCP**:MCP 服务器列表 + 工具可查(对齐 TUI `/mcp` 命令)。
- **插件**:OMP 插件生态(GUI 壳复用)。
- `@` 文件提及;斜杠命令词表与 TUI 同源。

### 4.6 会话组织

- **会话即树**(OMP `/tree` 设计,第一方资产,源码已验证 `modes/components/tree-selector.ts` + `session/session-entries.ts`):会话不是平铺时间线——每个会话条目(`SessionEntry` 带 `id/parentId`)按层级挂树,子代理启动、分支切换、复用会话都成为子树节点;`getTree()` 返回 `SessionTreeNode[]` 防御拷贝。**GUI 左栏直接升级为会话树**(Claude Desktop 只是平铺列表,这是我们的差异化优势)。
  - 渲染策略(TreeList 复用):扁平缩进——单子链不加深缩进(防楼梯效应),仅分支时 +1;连接符 ├─/└─ + 垂直延续。
  - 导航语义保留:Enter 切换会话、Shift+Enter summarize & switch、Shift+L 打标签、Ctrl+O 过滤、输入即搜索、Alt+D/T/U/L/A 按类型过滤(消息/工具/思考/…)。
  - 标签系统:节点显示 label;标签可作为左栏分组视图。
- **多会话并行**:侧栏会话树 + 运行状态徽章;`Ctrl+Tab` 切换。
- **Side chat**(`Cmd+;`):不打扰主会话的旁路提问(对齐 TUI `/btw`)。
- **跨会话**:agent 可检查/消息/归档其他会话(对齐 TUI 的 agent 间消息)。
- **会话生命周期**:`Cmd+N` 新建 / `Cmd+W` 关闭 / 自动归档;草稿保留(对齐 TUI Ctrl+D 存草稿)。
- **延续**:`codex resume` 语义——从历史/其他 surface 恢复会话(远程降级后增量补齐)。

**会话树 GUI 落点**:

| tree 资产(已有) | GUI 集成 |
|---|---|
| `SessionTreeNode` / `getTree()` | 左栏会话树数据源(经 RPC,零重写) |
| TreeList 扁平缩进渲染 | React 树组件沿用同策略(紧凑、防楼梯效应) |
| 标签(Shift+L)/ 过滤(Alt+字母)/ 搜索 | 左栏工具条:标签编辑、类型过滤、即时搜索 |
| 子代理子树 | 点击子树节点 → 展开为内嵌只读流(与 swarm 视觉组件协同) |
| workspace-tree.ts(native 单扫 / per-dir 截断 recent+oldest / AGENTS.md 收集 / prompt 缓存稳定) | 文件 pane 的目录浏览器:复用截断策略防目录爆炸;AGENTS.md 文件高亮为规则作用域 |

### 4.7 科学工作流(Claude for Science 参考 + autoresearch 第一方集成)

> 来源标注:Claude for Life Sciences 来自 Anthropic 官方新闻页(已验证,2025-10-20,其 UI 参考价值有限——主要是模型能力公告,可借鉴的是「研究会话」产品形态);autoresearch 为 **musepi-omp 第一方资产**(源码已验证,`packages/coding-agent/src/autoresearch/`,2667 行)——按**直接集成**写,不是外部参照。

**Claude for Life Sciences(外部参考,研究会话形态)**:科学 Connectors(Benchling/BioRender/PubMed/Scholar Gateway/Synapse/10x Genomics)、科学 Skills(`single-cell-rna-qc`)、Prompt library、产出 slides/docs/notebook、工作流(文献综述+假设 → 协议 → 生信 → 合规)。可借鉴点:**「研究 = 有状态的工作流」而非一次性问答**,这与 autoresearch 的实验状态机同构。

**autoresearch 第一方集成路径(Phase 4+ 即可落地,不必等 Phase 7)**:

| autoresearch 资产(已有) | GUI 集成方式 | 阶段 |
|---|---|---|
| 4 实验工具 `init/run/log/update_notes` | 直接映射为 GUI RPC 方法(工具卡 + `+` 菜单入口) | Phase 4 |
| SQLite 存储(storage.ts:RunRow/SessionRow) | GUI 看板数据源(不经 TUI 的 widget,直接读存储/经 RPC) | Phase 4 |
| git 分支隔离 + auto-resume | 会话恢复语义:切分支→看板无缝切换(现有状态机原样复用) | Phase 4 |
| `ExperimentState` 状态机(goal/metricName/bestMetric/bestDirection/secondaryMetrics/currentSegment/maxExperiments/confidence/scopePaths/offLimits/constraints/notes/baselineCommit) | 研究计划卡的字段来源;新建「实验」表单直接映射这些字段 | Phase 4 |
| TUI dashboard.ts(437 行:spinner 动画/折叠-展开两态/baseline 对比/isBetter 指标排序) | **升级为 React 视觉组件**:run 列表(keep/discard/crash/checks_failed 徽章)、指标趋势线 + 方向箭头、baseline 对比条、confidence 环、分段进度(currentSegment/maxExperiments);保留两态(折叠单行 ↔ 展开仪表) | Phase 4 |
| run→commit/notes 关联 | 详情面板「实验」tab:点 run 看 commit diff + notes(复用 §4.2 diff 审查) | Phase 5 |
| 来源/文献(Claude for Science 形态)[INF] | 研究计划卡内「来源面板」(复用 aicss Web Search 组件)+ 引文报告(aicss Inline Citations);科学连接器走 MCP 注册表(与 TUI `/mcp` 同源) | Phase 6 |

**落点总结**:autoresearch 已给出实验数据模型 + 后端工具 + 渲染逻辑,GUI 的工作是**视觉化升级与集成**,不重写后端。研究计划卡 + 实验仪表盘是核心新增组件,全部字段来自 `ExperimentState`。

## 4.8 文件类型支持(office / drawio / 网页元素选取 / 图片标注)

> 参考:kimi-code web `FilePreview.vue`(源码验证,1015 行)——预览 markdown/json/html/pdf/csv/image/video/text/binary,但**不含 office/drawio**(印证 Web 端原生编辑成本高);元素选取锚点:Claude Desktop Browser pane `Cmd+Shift+S`「Select an element in the Browser」(官方文档已验证)。

### 分层决策(避免「编辑」成为隐式承诺)

| 层 | Phase 4(首发) | Phase 6(可选增强) |
|---|---|---|
| **查看** | 纯前端预览库:docx-preview / SheetJS(xlsx)/ pptxjs(word/ppt/excel 只读渲染);markdown/json/html/pdf/csv/image/video 复用 kimi `FilePreview` 形态 | 不变 |
| **批注** | 覆盖在预览之上的批注层(锚定文本/区域 + 评论线程,数据独立于原文件) | 批注导出(docx 批注 / 侧栏报告) |
| **原生编辑** | ✗ 不做 | 决策树:① **drawio 官方 embed 模式**(成本最低,纯前端,优先);② 轻量富文本(prosemirror/tip-tap,能力有限);③ 自托管 OnlyOffice DocumentServer(重型,需服务端,最后选项) |

### 文件 pane 分派(按扩展名)

```
代码/文本        → CodeMirror 6(§9 定稿)
markdown         → 渲染预览(引用解析,同 kimi)
json/csv/html    → 格式化预览
pdf              → 内嵌 pdf 预览(pdf.js)
word/ppt/excel   → docx-preview / pptxjs / SheetJS 只读渲染 + 批注层
图片             → 预览 + 标注编辑(见下)
drawio           → 嵌入 drawio(Phase 6)
其他二进制       → 元信息 + 大小/类型
```

### 网页预览与元素选取

- **Browser pane**(已有,§4 面板):dev server 预览 + 外部站点 + Claude 自验证。
- **元素选取**(Phase 5):对齐 Claude Desktop `Cmd+Shift+S`——点击页面元素 → 定位其 HTML/CSS 选区 + 截图反馈给 agent(供修复/改样式);选取模式高亮悬停元素,`Esc` 退出。
- 选取结果产出:**元素快照**(outerHTML + computed style 摘要)+ 截图,作为下一条 prompt 的附件(配合原生视觉理解)。

### 图片标注编辑(Phase 5)

- **标注层**:框选 / 箭头 / 文字 / 高亮 / 马赛克,画布覆盖在图片上,标注数据 JSON 存储(独立于原图),一键隐藏/展示。
- **基础编辑**:裁剪 / 旋转 / 缩放 / 滤镜(亮度对比度),作用于导出副本(不破坏原文件)。
- 用途:截图标注反馈给 agent(code review、UI bug)、设计稿标注(配合 §4.1 拖放附件 + 原生视觉理解)。
- 实现:canvas 标注层 + 简单编辑(不引重型图像编辑器);标注工具条与 collab-web tool-render 的 image 卡片联动。

### kimi-code UI 参考(主题与组件)

- **组件库**(源码验证,35+):TopBar / Sidebar / CommandBar(命令面板)/ ContextRing / SegmentedControl / Sheet / Tabs / Toast / Tooltip / Kbd / Menu / FilePreview / ResizeHandle / WorkspaceGroup——GUI 组件可直接参照实现(React 重写,Vue 源码作形态参考)。
- **移动端**:MobileTopBar / MobileSettingsSheet / MobileSwitcherSheet + safe-area 变量——三栏 → 单栏的响应式方案参照。
- **主题**:正交配色(见设计原则 10);`data-accent="mono"` 单色强调模式可作 GUI 的 accent 预设之一。

## 5. 看板 / 组件化界面(参考 BitFun)

BitFun 看板(截图分析,2026-08-02)是「对话生成组件化看板」的代表实现:

### 5.1 对话创建(核心交互)

- 看板页顶部 **「对话创建」** 按钮:描述需求 → agent 生成看板(组件布局 + 数据绑定),不离开会话流。
- 示例卡片带 **prompt 快捷按钮**(10 个一组的迷你 prompt):点击即把「get 同款」prompt 填入会话,一键复刻模板。
- 「比追踪」类操作:基于现有看板追加组件。

### 5.2 组件类型库(模板市场可复用)

| 组件 | 说明 |
|---|---|
| 时钟 / 数字 | 大号数字时钟(MARKET WATCH 风格) |
| 仪表盘 gauge | 圆环指针 |
| K 线 / 走势图 | SSE 指数图、涨跌标签 |
| 股票/列表 | 股票行(名称/代码/价格/涨跌%) |
| 番茄钟 / 待办 | 专注计时 + 打卡列表 |
| 运行代码卡 | 卡片内跑 Python,「再测一次」按钮(本地执行) |
| 系统体检卡 | CPU/磁盘/系统指标 + 进度条,可定时刷新 |
| 色块网格 | 2x3 彩色瓦片(数据映射) |

### 5.3 手势与排版

- **拖一拖**:按住顶栏拖动换位; **拉一拉**:拖右下角缩放(尺寸数字实时变); **点开看**:折叠内容全屏展开; **Pin 到窗口/桌面**(组件可钉到桌面)。
- 模板市场:标题 + 组件数徽章(5 个组件 / 19 个组件)+ 组件缩略预览。
- 看板 = 独立 workspace(示例看板「Hello World」演示拖/拉/开/运行四种手势)。

### 5.4 与 GUI 的关系(规划)

- **看板作为 GUI 的一种 workspace 视图**(Phase 6+):导航栏「看板」入口 = 模板市场 + 我的看板;「对话创建」复用主会话流,生成结果落为看板。
- 组件 = 会话产物的一种(agent 输出的结构化组件而非纯文本):tool 卡片的自然延伸——从「展示工具结果」升级为「可编辑/可组合的组件」。
- 移动端:看板只读 + 二维码进入;组件渲染沿用 collab-web 的 tool-render 模式。

## 5.5 氛围与动效(Phase 7,音效/光效落地映射)

| 素材 | 落地场景(仅限高光时刻,禁大面积铺) |
|---|---|
| cuelume(14 cue,Web Audio 实时合成,零依赖) | tool 完成 → `success` / `sparkle`;tool 失败 → `error`;新消息 → `bloom`;审批弹卡 → `press`+`release`(两段按压);审批通过/拒绝 → `toggle`;页面/会话切换 → `page`;加载 → `loading`;AI 就绪 → `ready`;悬停可点元素 → `tick`(默认关,设置里开) |
| aicss 动效 | thinking 折叠/展开、tool 卡状态切换、streaming 光标动效,作为组件自带样式复用 |
| border-beam 光效 | 仅「当前活跃 agent 卡片」边框光束(1 处);不用于列表/按钮 |
| 主题 token | accent 前景色由 scheme 推导(kimi #2083),音效开关并入设置(默认静音,尊重 OS 静音) |

## 6. 关键页面线框

### 6.1 连接 / 配对页(首启与远程入口)

```
┌──────────────────────────────────────────────────┐
│            M u s e   P i  (splash 品牌字)        │
│                                                  │
│        ┌────────────────────────┐                │
│        │      ▛▀▀▀▀▀▀▜          │                │
│        │      ▌ █▀█▀█ ▌   ← QR  │                │
│        │      ▌ █▄█▄█ ▌         │                │
│        │      ▙▄▄▄▄▄▄▟          │                │
│        └────────────────────────┘                │
│  手机扫码,立即连接本机会话                        │
│  ─ 或 ─                                          │
│  [ 粘贴 collab 链接 ]  [ 选择连接方式 ▾ ]         │
│  连接方式: ● LAN ○ relay ○ tunnel                 │
│  状态: 已生成临时链接,5 分钟内有效                │
└──────────────────────────────────────────────────┘
```

### 6.2 远程设置页

```
设置 > 远程
┌──────────────────────────────────────────────┐
│ 远程访问                                      │
│ ┌──────────────────────────────────────────┐ │
│ │ 当前: relay · my.omp.sh · 已加密 ✓        │ │
│ │ 二维码:  [ 显示二维码 ]  [ 刷新 ]         │ │
│ └──────────────────────────────────────────┘ │
│ ○ LAN 直连   ○ Relay(默认/自建)  ○ Tunnel     │
│    └ Tunnel: [quick | managed-remote | managed-local] + TTL(bootstrap/session)
│ 安全: tunnel 默认只读 + 会话级,禁止文件写      │
└──────────────────────────────────────────────┘
```

### 6.3 审批卡(对话流内联,参考 Claude Desktop Manual 模式)

```
┌─ 权限审批 ──────────────────────────────┐
│ Agent 请求: write → ~/.config/app.toml   │
│ 会话策略: 上次已批准同类 3 次             │
│ [ 批准 ] [ 拒绝 ] [ 本次会话允许 ]         │
│ [ 记住此文件 ] [ 查看 diff ]              │
└──────────────────────────────────────────┘
```

### 6.4 移动端(720px 以下)

```
┌──────────────────┐
│ ≡  M u s e P i  [中]│  ← 顶栏 + 抽屉
├──────────────────┤
│ 会话标题 / 模型     │
│ ┌──────────────┐ │
│ │ 消息流(同上)  │ │  ← 单栏;左/右栏收起
│ │ tool 卡片    │ │
│ │ 审批卡(模态) │ │  ← 屏小,审批改模态
│ └──────────────┘ │
│ [输入…        ]  │
└──────────────────┘
```

## 7. 交互流

| 流程 | 步骤 |
|---|---|
| **扫码连接** | 桌面「显示二维码」→ 手机扫码 → 解析 fragment key → 连 LAN/relay/tunnel → 顶栏「已连接」 |
| **审批** | 工具调用 → 权限链 → 需审批 → 内联审批卡(本地)/ 模态 + 推送(远程)→ 批准/拒绝 |
| **打开文件** | 点击对话中路径 → 按类型分发(file/diff/browser)→ 编辑 Save / attach as context |
| **Diff 评论** | diff stats 指示器 → diff pane → 点击行评论 → Cmd+Enter 批量 → agent 修改出新 diff |
| **会话切换** | 侧栏点击 → `session.subscribe` → 增量事件渲染;Ctrl+Tab 切换 |
| **切语言** | 顶栏 `中/EN` → collab setLocale 模式 → 全界面即时重渲染 |
| **对话建看板** | 看板页「对话创建」→ 描述需求 → agent 生成组件布局 → 落为看板 workspace |
| **远程降级** | tunnel 断 → 自动降 relay → LAN;顶栏状态实时;重连增量补齐 |

## 8. collab-web 组件复用映射

| collab-web 现有(78 tests) | GUI 用途 | 改造 |
|---|---|---|
| `tool-render/tools/*`(50+ 工具卡片) | 中栏工具调用卡片 + 看板组件基础 | 原样复用;看板组件另建注册表 |
| `Transcript` / `use-guest` | 对话流 | 数据源换 daemon RPC 事件 |
| `AgentDrawer` / `AgentsPanel` | 详情面板 Agent 区 | 扩展阶段/产物缩略(swarm 视觉) |
| `Composer` | 输入区 | 加 `+` 扩展菜单(附件/skills/MCP)+ 视图模式 |
| `i18n/*`(346 key) | 全界面 i18n | 迁移扩充 |
| `ThemeToggle` / `LanguageToggle` / `HeaderBar` | 顶栏 | 原样复用 |
| 二维码(collab-qrcode TUI 版) | 连接页 QR | Web 版用 `qrcode` 库渲染 |
| aicss.dev(外部) | thinking / web-search(带来源)/ file-diff / streaming / inline-citations / code-block / to-do 组件 | 直接复制组件代码(纯 CSS 无 Tailwind,React/Vue/Svelte);仅作组件,不上引框架 |
| autoresearch(第一方,直接集成) | 实验仪表盘 React 化:run 列表/指标趋势/baseline 对比/confidence/分段进度;数据经 RPC 读 SQLite | 后端与状态机零重写,只做视觉层;Phase 4 |
| OMP 会话树(第一方,直接集成) | 左栏会话树(SessionTreeNode/getTree() 经 RPC)+ TreeList 扁平缩进策略 + 标签/过滤/搜索 | React 树组件,零后端重写;Phase 4 |
| workspace-tree(第一方,直接集成) | 文件 pane 目录浏览器:per-dir 截断 recent+oldest / AGENTS.md 高亮 | 复用 native 单扫 + 截断策略;Phase 4 |
| kimi FilePreview(外部参考) | markdown/json/html/pdf/csv/image/video 预览形态 | React 重写(源码为 Vue);office 预览另用 docx-preview/SheetJS/pptxjs |
| cuelume(外部) | 14 个音效 cue | Phase 7;声明式属性 + 一次 bind();默认静音 |
| border-beam(外部) | 活跃 agent 卡片高光 | Phase 7;仅 1 处 |

## 9. 原型决策定稿(2026-08-02 评审)

| # | 问题 | 决策 | 状态 |
|---|---|---|---|
| 1 | pane 布局引擎 | **Phase 4 用固定 CSS grid 起步**(复用 collab-web 现有布局与样式),不引入布局引擎;拖拽重排/缩放/持久化(dockview 类)留到 **Phase 6** 按需引入——首个可运行版本不背布局引擎依赖 | ✅ 已定 |
| 2 | 看板与主会话关系 | 保持开放(独立 workspace vs 对话流内 pane),**Phase 6 排期时定**;原型保留两种可能 | ⏳ Phase 6 |
| 3 | 审批默认形态 | 内联卡(桌面)/ 模态(移动),与权限模式(Manual/Accept edits/Plan/Auto)联动;**记忆范围对齐 TUI 权限链会话级语义**(按文件/目录/会话三档,不重新设计) | ✅ 已定 |
| 4 | 文件 pane 编辑器 | **CodeMirror 6**(轻量);Monaco 700KB+ 太重,GUI 不是 IDE | ✅ 已定 |
| 5 | stats 看板集成 | **组件级复用**(共享主题/语言,i18n 切换跟随);iframe 无法跟随切语言;Phase 6 排期后置 | ✅ 已定 |
| 6 | 命令面板(⌘K) | **全量**:斜杠命令 + provider 切换 + 模型切换 + 主题 + 语言 + 看板/设置跳转;词表与 TUI 同源 | ✅ 已定(用户拍板) |
| 7 | 首启引导 | **连接页 = 首启首页**:品牌 splash + QR 扫码即连 + 连接方式选择(LAN/relay/tunnel);顶栏仍可呼出连接页 | ✅ 已定(用户拍板) |
| 8 | 视图模式与 TUI 一致性 | **对齐 TUI**:Normal/Verbose/Summary 语义与 TUI 的 compaction/transcript 控制一致,双端行为统一 | ✅ 已定 |

> 原型定稿。剩余开放项仅看板形态(Phase 6)。

## 10. 文档历史

- 2026-08-02:初始规划(信息架构 + 三栏线框 + 关键页面 + 组件复用映射)。
- 2026-08-02:综合更新——(1) 新增第 4 节「会话交互设计」:Claude Code Desktop 官方文档调研(会话即 session、pane 布局、文件交互/右键菜单、diff 行级评论、权限模式选择器、视图模式、+ 扩展菜单、side chat、跨会话);(2) 新增第 5 节「看板/组件化界面」:BitFun 看板截图分析(对话创建、组件类型库、拖/拉/折叠/pin 手势、模板市场);(3) 主界面线框升级为 pane 布局,新增 4 个未决问题。
- 2026-08-02:补全——(1) 新增 §4.7 Claude Research(agentic research)会话设计,明确标注推断项([INF],官方 UI 文档未获取);(2) 新增 §5.5 氛围与动效(cuelume 14 cue 逐场景映射 / aicss 组件 / border-beam 边界 / 默认静音);(3) gui-architecture.md §6 细化 aicss 组件清单与 cuelume 实测信息(均实测官网)。
- 2026-08-02:§4.7 重写为「科学工作流」——Claude for Life Sciences(官方页验证:科学 Connectors/Skills/Prompt library/产出形态,可借鉴点为「研究会话」产品形态)+ **autoresearch 第一方直接集成路径**(源码验证,2667 行):4 工具→RPC 方法、SQLite→看板数据源、git 分支隔离→会话恢复、ExperimentState→研究计划卡字段、dashboard.ts(437 行)→React 视觉组件(指标趋势/baseline/confidence/分段进度),Phase 4+ 落地,后端零重写。组件复用表 autoresearch 行改为「第一方直接集成」。
- 2026-08-02:§4.6 会话组织扩展为「会话即树」——OMP `/tree` 第一方设计(源码验证:SessionTreeNode id/parentId 层级、TreeList 扁平缩进防楼梯效应、标签/过滤/搜索/summarize 导航语义)直接集成进 GUI 左栏;workspace-tree.ts(native 单扫/per-dir 截断 recent+oldest/AGENTS.md 收集)集成进文件 pane 目录浏览器。左栏线框升级为会话树,组件复用表新增两行。
- 2026-08-02:**§9 未决问题定稿**(用户评审拍板):pane 引擎 Phase 4 CSS grid 起步/dockview 留 Phase 6;审批记忆对齐 TUI 权限链会话级;文件编辑 CodeMirror 6;stats 组件级复用;命令面板全量;首启=连接页;视图模式对齐 TUI。唯一开放项:看板形态(Phase 6)。原型定稿。
- 2026-08-02:新增 §4.8 文件类型支持——分层决策(Phase 4 只读预览 docx-preview/SheetJS/pptxjs + 批注层;原生编辑 Phase 6 决策树:drawio embed 优先/轻量富文本/OnlyOffice 最后);网页元素选取(Claude Desktop Cmd+Shift+S 锚点)+ 图片标注编辑(标注层+基础编辑);kimi-code web UI 参考(源码验证:35+ 组件库、移动端 Mobile* 组件、正交主题体系 data-color-scheme × data-accent、v2 语义 token)。设计原则新增第 10 条(主题正交化)。
