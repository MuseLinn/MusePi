# MusePi GUI 设计规范

[English](gui-design.md) | 中文
> 状态:**活文档**(2026-08-06 建立)——规定 `packages/desktop-app` / `packages/guest-client` 的**设计风格与交互标准**(长什么样、怎么动、怎么组织)。与实现同步,实现文件为准。
>
> 实现契约、daemon RPC 形状、踩坑记录与验证方法见 **`docs/gui-implementation.md`**(2026-08-06 从本文件拆出)。早期线稿/架构稿(gui-prototype / gui-architecture / gui-migration)已删除——实现早已交付,以本文档与 gui-implementation 为准。
>
> 修改约定:改实现时同步本文件;发现本文档与代码不一致时,以代码为准并更新本文档。

## i18n 契约(guest-client/src/i18n)

- **命名参数**:`t("… {count} …", { count: n })`——不用 `{0}` 位置参数(openchamber/opencode/bitfun/kimi-code 全部命名参数,翻译可读性好;位置参数是 musepi 旧做法,2026-08-06 全量迁移)。
- **词表按域拆分**(2026-08-16):`zh-CN/` + `en-US/` 各 12 个域模块(shell/composer/sessions/context/collab/transcript/settings/agents/tools/pet/guest),barrel 合并为扁平 map——改文案按功能找对应域文件;域间重复 key 在 barrel 模块加载时抛错(替代 spread 静默覆盖)。TUI 词表(`coding-agent/src/i18n/zh-CN/`,13 域)同款拆分与守卫,但用 `{0}` 位置参数。架构总览见 `docs/i18n.md`。
- **类型化 key**:`TranslationKey = keyof typeof zhCN`(zh-CN barrel 合并后 `as const`)——`t()` 的 key 与 params 都编译期检查:key 拼错、占位符名写错、漏传参数 → tsgo 报错。动态 key(schema 驱动 label、运行时错误串、`tag.${…}` 拼接)显式 `as TranslationKey` 断言——运行时仍走 `?? key` 原文回退。
- **占位符类型**:`ParamsOf<K>` 用模板字面量类型从 zh-CN 值提取 `{name}` 并映射为 `{ [name]: string | number }`——参数名与翻译模板强绑定。
- **en 编译级 parity**(2026-08-16):每个 en 域文件 `as const satisfies Record<ZhKey, string>`——en 缺/多 key 是编译错误(负向验证 TS2353),新增 zh key 必须同步加 en。
- **插件 seam**(2026-08-16):`registerTranslations(locale, map)` 运行时注册/覆盖文案并 `emit()` 即时重渲染(支持全新 locale);插件自有 key 用 `tLoose(key, params)`(核心 `t` 只收 `TranslationKey`)。均不持久化。
- **en passthrough**:key 即英文原文;替换作用于最终字符串(dict 命中或 key 回退都替换)——英文 UI 显示 `context · 42%` 而非 `context · {pct}`。
- **测试**:packages/guest-client/src/i18n/i18n.test.ts(key 集 parity、跨域重复守卫、注册覆盖/隔离)+ test/i18n.test.ts(查找/替换/回退/英文 passthrough/无位置参数残留断言);测试内 setLocale 必须 afterAll 恢复初始值(bun test 同进程顺序执行,泄漏会污染其他断言英文文案的测试)。
- **类型化副作用**:类型化强制所有 UI 文案有 zh 翻译——迁移时补了此前 passthrough 的键(open sidebar/connected/unknown/jump to bottom 等);`as const` 场景(PREFERENCE_LABEL、KIND_TRANSITION、SCALAR_ARGS、TIP_KEYS、SOUND_USAGE_KEYS)用 `as const satisfies Record<…, TranslationKey>` 或显式 `Partial<Record<…, TranslationKey>>` 让动态索引保持字面量类型。
- **渲染时调用**:`t()` 只在渲染期调用(模块加载期调用会拿到旧 locale——已有注释约束)。

## 0. 树/轨迹术语表(2026-08-21 规范化,消除命名错位)

| 术语 | 指代 | 组件/承载 | 备注 |
|---|---|---|---|
| **会话列表** | 左侧栏上按 分组/项目/日期/定时任务 聚合的**会话**(可多选/置顶/标记状态) | `SessionTree.tsx`(文件名沿旧称,职责是列表) | 不要叫它"会话树";改文档/注释用「会话列表」 |
| **会话/消息树** | **会话内条目树**:entry 的 id/parentId 层级、fork 分支、叶导航(TUI `/tree` 的语义) | TUI `tree-selector.ts` + 会话级 `session-manager.ts`;GUI 侧载体 `lib/message-tree.ts`(`buildMessageTree`) | 与「会话列表」是两层数据:列表管"选哪个会话",消息树管"会话里怎么分支" |
| **轨迹** | 当前会话的**事件时间线**:turn 分组 + Overview 时间轴 + 检视 + 跳转 | 右侧 ContextPanel「轨迹」tab(`TrajectoryView` + `TimelineOverview`) | 时间投影轴;与消息树同源(都是同批 entries)但投影维度不同 |
| **/trace(规划)** | TUI 中消息树×轨迹的融合视图:树结构上叠加时间/成本/令牌列 | TUI 新命令(复用 tree-selector 数据源) | 方案见 `docs/archive/tui-trace-plan.md`;`/tree` 保持纯结构投影 |

**命名铁律**:写代码/文档/UI 文案时,「会话树」只准指消息树(/tree 语义);会话语义的树一律叫「会话列表」;时间轴一律叫「轨迹」。

## 1. 布局体系

- **三栏 shell**(openchamber 共识布局):左 SessionSidebar(会话/分组/项目)+ 中 ChatView(消息流 + 圆角 composer)+ 右 ContextPanel(始终可见)。`gui-shell` 是 flex ROW——每个全宽 pane(SettingsView 等)必须 `flex:1; min-width:0`,否则塌缩到内容宽。
- **设置面板**:全窗口替换工作区,左导航 + 右内容(`gui-settings-content` 固定高度滚动容器,`width:100% + max-width + margin-inline:auto` 居中列);上限为 `--gui-settings-content-max` = `clamp(840px, 78%, 1080px)`——840px 是 openchamber 的定值,保留为下限使普通窗口几何与参照一致,宽面板下升至 1080px,避免高分辨率最大化窗口把内容列晾在空白里)。
- **扩展控制中心**(设置「扩展」tab):section 占满设置视口(`gui-skills-section` = `height:100%` flex column,`gui-ext-center` `flex:1; min-height:0`)——左列表(`gui-ext-list-scroll`)与右详情(`gui-ext-detail`)在各自圆角容器内**独立滚动**,设置页整体不滚(TUI /extensions 面板 parity);两栏统一细滚动条(8px、thumb `text-faint 30%`、hover 50%,与 xterm 同配方);指令内容不限高(pre 无 max-height),随详情区整体滚动,避免嵌套滚动。
- **内容边界羽化(ScrollShadow,2026-08-21 审计)**:`useScrollShadow` hook + CSS `mask-image` linear-gradient 实现边缘渐变淡出——透明→实色 20-24px 柔带,仅内容溢出且滚离边缘才挂载(`data-top-scroll`/`data-bottom-scroll` 属性驱动)。已覆盖:`.gui-transcript`(聊天)/`.gui-sessions-list`(会话列表)/`.gui-settings-nav-scroll|content`(设置)/`.gui-model-list`/`.gui-notes-editor`/`.pet-bubbles`。**通用载体 `FadeScroll`**(`components/FadeScroll.tsx` + `.gui-fade-scroll` 规则,可选 `onClick` 透传)接无专用 class 的泛化滚动容器——**全部 11 处已接入**:右栏 tab 内容体/轨迹列表/扩展 tab/GitLog/Diff/PR 面板/连接向导/导入列表/引导选择列表/模型设置列表/模式定义弹窗。
- **空态**:WelcomeComposer 大输入框(品牌/问候/提示 + composer),输入即建会话;专注模式(⌘⇧E)输入框铺满。
- **消息流**:复用 guest-client `tr-*` 类;用户消息右对齐圆角气泡,助手消息全宽无气泡;40px gutter 放头像。

### 轨迹时间轴与检视(DSH Trajectory Overview parity,2026-08-21)

右栏 ContextPanel「轨迹」tab 的 TrajectoryView 顶部 = **固定 Overview 时间条**(`TimelineOverview.tsx`,不随列表滚动):44px 圆角条带,内嵌 sunken 底 + 1px border;背景 = 时间域(全部 turn 的 [最早 start, 最晚 end]),两端 mono 起止时钟;每 turn 一段(`traj-ov-segment`,accent 26%→hover 42%,agent_end 冻结的回合时长命中时 = 完整回合跨度,否则 = 该轮末条事件),turn 内每个带 tsMs 的事件一落点(`traj-ov-dot`,颜色按 kind;user 点稍低错开)。

**交互契约**(与 DSH Overview 拖拽聚焦对齐,克制节奏):
- **列对齐契约(2026-08-21 实测)**:事件行内,工具名称/参数/结果/文本全部与条目名称**左对齐**(同列 x 一致,`.traj-content` 内零左缩进);turn 头的 `Turn N` 标签与事件 tag 同宽(`min-width: 62px`),使 **turn 摘要列与事件内容列精确对齐**(实测 x 相等)——新增/改动行排版时保持此契约。
- 拖拽(pointer capture,位移 ≥3px)= 选中时间区间;区间覆盖层 accent 18% + 左右 1px 强调边;激活 chip(`traj-focus-chip`)显示「聚焦 hh:mm:ss – hh:mm:ss」+ ✕。
- 单击某 turn 段 = 选中该**整轮**;单击空白 = 清除;Esc 优先清区间、再清选中(与模态键盘契约一致)。
- 悬停段/点 → 提示(`traj-ov-tip`,`gui-fade-in` 120ms):标题 + 起止/精确时刻 + 时长;离开 140ms 延时隐藏,便于在提示间滑移。**时长口语化**:0.8s / 12.3s / 1m 23s / 1h 02m(`durationText`,状态栏同语感)。
- **聚焦模式**:区间激活时列表 turn/事件置灰(`.traj-event--dim` 0.35 + saturate .6 / `.traj-turn-group--dim` 0.45),区间内记录保持原样——不裁剪只降噪,dsh 同款"聚焦"而非"过滤"。
- **选择检视**:点击行 = 选中(accent 45% 描边 + 8% 底);检视面板(`traj-inspector`)在时间条下方:头部 kind 标签 + 标题 + ✕;网格行 = 时间(全格式)/轮次/回合用时(roundDurations 命中才显示)/具体时刻(mono);**settled assistant 记录另显模型请求统计**——令牌(`↑{in+cacheWrite} ↓{out} ☍{cacheRead}`,k/M 紧凑化)/请求耗时/首字节延迟/速率(`output/duration` tok/s,同 transcript usage 行语感);Input/Output 块(`traj-inspector-pre`,max-height 132 内滚、pre-wrap)。
- 动效:过渡 120–140ms 读 `--gui-ease-out`;`gui-motion-off` 下 hover 淡入自然退化为瞬现(基于 opacity 的动画)。

**CSS 命名**:`traj-ov-*` / `traj-focus-*` / `traj-inspector-*` / `traj-event--selected|--dim` 全部归 `gui-workspace.css` 轨迹段。图标沿用 oc-icons sprite(聚焦 chip 用 `target`,**勿用不存在的 `focus-3`**)。

## 2. 设计 token 与主题

- **三条正交轴**(DOM 层永远是已解析值,无 "system"):`data-theme`(light/dark 已解析)+ `data-accent`(强调色预设)+ `data-ui-theme`(独立浅/深主题预设)。
- **密度**:`--gui-density` 是**无单位系数**(如 `1`/`0.85`),CSS 用 `calc(32px * var(--gui-density, 1))`。
- **圆角——6 步阶梯(2026-09-17)**:`--radius-xs 2` / `sm 4` / `md 6` / `lg 8` / `xl 12` / `2xl 16`(+胶囊 `999px`、圆 `50%`)。同心规则:子圆角 = 父圆角 − 父内边距(16−4→12−4→8−2→6),出现「外圆内方」即同心被破坏。手写 CSS 禁止字面 px 圆角(`scripts/check-radius-tokens.ts` 已进 `check:tools`;生成的 `tailwind.out.css` 豁免)——卡片/面板用 `lg`,对话框/抽屉/浮层用 `xl`,全屏 sheet 用 `2xl`。卡片统一保留 `border: 1px solid var(--border)` + `background: var(--color-surface-raised|sunken)`。
- **字体**:UI 默认 serif + 打包的 Maple Mono NF CN(等宽);变量字体 Inter/JetBrains Mono 在 `@fontsource-variable/*`。代码块字号走 `--gui-code-size`。
- **玻璃**:`gui-vibrancy` IPC + CSS `--gui-glass-overlay` 透明度;窗口透明度开关关=100% overlay 覆盖所有半透明规则。 **液态玻璃(2026-09-17)**:在 vibrancy 窗口之上,高层玻璃面(对话框、shell 侧栏/顶栏、lightbox 主按钮)渲染为液态玻璃——tokens.css 的 `--glass-*` 阶梯(半透明填充、内侧顶部镜面亮边 `--glass-edge-hi` + 底部暗回声、对角 `--glass-sheen` 走未被占用的 ::before、抬升 `--glass-shadow`),入场/菜单/按压用 `--spring-liquid`(过冲弹簧 cubic-bezier(.34,1.56,.64,1))。`.gui-dialog` 是参考实现(72% 半透明面 + blur(3xl) saturate(170%);::before 是 sheen 层——内容 z-index 必须在其上)。强调色换色不影响玻璃阶梯;语义绿(成功态/桌宠)保留绿色。

## 3. 动效规范(核心标准,2026-08-06 定稿)

| 场景 | 组件 | 机制 |
|---|---|---|
| 条件区块(显隐跟随另一选项) | `<Reveal open>`(`components/Reveal.tsx`) | useCollapse px 高度 240ms `cubic-bezier(0.22,1,0.36,1)` + 外层 160ms 淡入;关闭态 `aria-hidden`+`inert`;节点保持挂载 |
| 保持挂载但高度变化(tab 切换/列表增长) | `<HeightMorph morphKey>`(`components/HeightMorph.tsx`) | 渲染期捕获旧高度→新内容提交→高度过渡→settle `auto`;同一外层 160ms 淡入按 key 重启;**形变期间容器 `overflow:hidden` 裁剪内容,否则新内容瞬间铺满(溢出钉住的矮盒子)、只看到盒子边缘在动="无动画";settle 后恢复**;高度不变时(`|target-prev|<1`,如设置 section 切换的固定高度滚动容器)跳过钉住/裁剪只保留淡入——否则滚动条消失 300ms、滚动被禁用;**时长随高度差自适应 240→480ms(`delta/6` 封顶)——ease-out 曲线前端加载极狠,固定 240ms 的大展开(如供应商网格 2200px)读起来仍是快弹** |

- **HeightMorph 铁律**:children 直接渲染进带 ref 的外层,**绝不在中间包 wrapper div**——调用方传自己的布局类(如 `.gui-provider-grid` 是 CSS grid),wrapper 会变成网格唯一子项、全部内容单列堆叠(70 卡 4234px 伪平滑的教训)。`display:contents` 是备选修复但 fade 不渲染。**形变必须裁剪**(见上表)——供应商"显示全部"展开要逐卡露出(8→40→56→…→70),不是卡片瞬间弹出。
- **禁用** `grid-template-rows: 0fr↔1fr` 做折叠(useCollapse 文档记录 Chromium 单向动画问题)。
- 设置区 section 切换是固定高度滚动容器,HeightMorph 只贡献淡入。
- 时值约定:高度/形变 240ms + `cubic-bezier(0.22,1,0.36,1)`;淡入淡出 160ms ease;KITT 扫光 1.7s 同缓动 alternate。
- 应用点:SettingsView 条件项(主题分支/玻璃滑杆/扫光颜色)、模型内部 tab、供应商 grid「显示全部」、设置 section 切换、SessionSidebar 分组/项目块、CustomGroups。

## 4. 组件与设置模式

- **设置行**:`gui-settings-row` = label+desc 左、控件右;`PrefToggle`(开关,`storageKey` + 可选 `onClass` 反相挂 documentElement)/`PrefSegmented`(分段选择)是两个标准控件,新设置优先复用。
- **TUI 设置同步(2026-08-11,合并进既有 tab)**:TUI 设置面板 10 个 tab 的 **336 项配置全部并入桌面设置**,不设独立"TUI 设置"页——**有对应 tab 就合并,没有就新增 tab,需要更名的更名**:外观(并入,原生主题卡 + schema 30 项)/模型设置(并入,角色模型 + schema 44 项)/任务与子智能体(原"子智能体"更名,并入 tasks 28 项)/新增 交互(41)·上下文(27)·Shell(16)·工具(60)·供应商(36);文件与 LSP、记忆 保持独立 schema section。全部 **schema 驱动**(daemon `settings.schema` RPC,与 TUI 同源)。控件:boolean→toggle / enum→select(无 options 的 enum 由 daemon 合成)/ string→input(凭据掩码保留)/ number→input / **array→逗号分隔输入(blur 提交)** / **record→紧凑 JSON 输入(非法 JSON 内联报错,不提交)**;改动 `settings.set` 乐观写入、失败回滚。条件门控 CONDITIONS 与 TUI settings-defs 对齐(11 个;`hasImageProtocol` 在桌面恒真)。**i18n 全量中文**:从 coding-agent i18n 移植 966 条翻译进 guest-client zh-CN(标签/描述/选项/分组;模型/供应商/音色等专有名词保持原文,与 TUI 一致);未覆盖项回退英文。行为抽查:textVerbosity low≈150 字 vs high≈250 字(GUI→daemon→会话行为链路生效)。**重复定义审计修复(2026-08-11)**:①语言单源——`settings.locale`(config.yml)为唯一源:boot 经 `settings.get` 同步渲染器 locale(daemon 对未配置的 `settings.locale`/`defaultThinkingLevel` 不回填 schema 默认值,防止未配置时把中文 UI 强制切英文),常规语言 select 与交互 tab「界面语言」行均双写 RPC + localStorage 镜像;NAV_GROUPS 改渲染期求值(原模块级常量冻结首语言);②思考层级——删除 `musepi-gui-default-thinking` localStorage 镜像,WelcomeComposer 预选改为 boot 快照:`modelRoles.default` 的 `:level` 后缀优先(off→关闭思考),否则回退已配置的 `defaultThinkingLevel`(auto 允许),未配置保持 medium;boot 同时剥离后缀给模型预选;③`options:"runtime"` 的 schema 行(theme.light/dark)GUI 渲染为只读输入(防键入非法主题 id 写坏 config.yml),提示「选项由 TUI 运行时提供」。**导航去重合**:「智能体」更名「运行中智能体」(实时 roster,agents.list 2s 轮询)与「任务与子智能体」(tasks schema 配置)明确区分——两者内容本不重叠,命名消除混淆。**设置页 roster 全面移除(2026-08-11)**:「运行中智能体」设置 tab 与「任务与子智能体」内嵌 roster 均删除——live roster 由会话右栏 ContextPanel 的 AgentsPanel 承载(session stream 驱动的实时 HUD:主/子行、状态、活动、相对时间、进度/生命周期,比 agents.list 轮询更丰富);设置页回归纯配置语义。swarm GUI 盘点(对比 kimi-code apps/kimi-web):kimi 有转录内联 SwarmTool 卡片(成员手风琴+阶段点+概览条+done/total)、AgentDetailPanel 详情面板(暂停原因/流式输出/进度组)、ChatDock+TasksPane 底部 dock;我们现有右栏 AgentsPanel HUD + task/yield 工具卡片渲染 agent results,无转录内联 swarm 卡片、无详情面板。**task 工具卡升级为 SwarmTool 级(2026-08-11)**:头部 done/total chip(聚合失败红显)、body 顶部阶段概览(分段条 done/merge-failed/running/failed/aborted 五段 + legend)、成员行首阶段色点(running 脉冲)、每成员手风琴(点击 chevron 展开完整输出/错误/patch;已结束成员默认折叠,有详情才渲染 chevron);数据全部来自既有 TaskToolDetails.results/progress,无新数据管道。SSR 6 测试 + CDP 实测(2/2、3/3 chip、ok/run dots、chevron 展开 alpha 输出)。后续打磨:无内容的任务清单行(只有 #N 无 description)不再渲染空行;live/settle 时 AgentProgress 高级字段(retryState/extractedToolData/inflightTaskDetails)尚未消费。

**桌面子代理操作(2026-08-11, TUI Agent Hub 对等)**:daemon 新增 RPC `agents.kill`(abort + release tombstone→aborted)/`agents.revive`(ensureLive)/`agents.chat`(ensureLive + prompt steer,与 collab host 的 agent-cmd 同构,server.ts agents.list 旁)。GUI 右栏 ContextPanel 的 AgentsPanel 选中行后渲染 AgentControls 操作条(packages/desktop-app/src/components/AgentControls.tsx):running→停止、parked/aborted→复活、chat 输入框(Enter 发送),错误小字展示。collab guest 走 agent-cmd 帧,桌面走 RPC——两条路语义一致。SDK events.ts 的 agent-progress payload 注释修正为 SubagentProgressPayload 包装(daemon 实际发送形状)。RPC 实测:kill idle→{ok}+ref aborted、kill/revive 错误路径、chat→ensureLive+steer 生效;running 态 kill 时序窗口未抓到(step-3.7-flash 子代理完成过快),abort 路径与 collab host 同构。**i18n 补全**:schema 全部 UI 字符串覆盖 100% 可译项——标签/描述/选项标签/选项描述全量中文(新增 ~240 条手译,复用 coding-agent zh 78 条),仅剩专有名词(模型/供应商/音色/硬件/API key 名/数值)保持英文与 TUI 一致;zh-CN.ts 经 biome --write 全量格式化。
- **设置键名**:一律 `musepi-gui-*`(如 `musepi-gui-chat-usermsg`、`musepi-gui-statusbar-indicator`);类开关类偏好(如 `gui-chat-hide-time`)在 documentElement 上切换,样式写在 gui.css 的偏好区。
- **设置 → 检查更新(2026-08-22)**:行内展示「当前版本 / 状态(检查中·已是最新·发现新版本)」+ 手动检查按钮;发现新版时在 desc 下方展开**更新说明摘要 + 明确的「前往下载」按钮**(不自动 window.open 弹浏览器)。启动自动检查(主进程 12s 后)推送的更新提示是**右下角 toast**(`UpdateToast`):版本(当前 → 最新)+ 说明 + 「前往下载」/「跳过此版本」(按版本 localStorage 记忆,bitfun parity)。**两条说明链路独立**:toast 读 `update-manifest.json.notes`(OTA 渠道),「新功能」弹窗读 `CHANGELOG.musepi.md`,发版都要填。实现细节见 `gui-implementation.md §17`。
- **预览模式**:配置项带实时预览(效果预览/聊天预览)——复用**真实渲染组件** + 示例内容,选项状态驱动;不要造静态假预览。
- **状态条**:braille/球体指示器(`--gui-status-accent` 会话色,TUI djb2 哈希移植)+ 流光/KITT/简洁文字效果;KITT 是文字渐变亮带(非独立条);扫光颜色可选默认色调/强调色。
- **暂停 UI(2026-08-20,与 TUI /pause 同 gate)**:两级暂停,状态来自 daemon(重连/重启不丢,见 gui-implementation.md §1c)。**全局暂停** = 全屏磨砂遮罩 `GlobalPauseOverlay`(`.gui-global-pause`,active 态遮罩 + 居中卡片:暂停图标 + "已暂停"标题 + 实时计时 `formatPauseElapsed` 分:秒,`data-paused-at` 锚定 pausedAt 不随组件重挂清零);header 暂停按钮发 `daemon.pause/pauseRelease`。**会话级暂停** = ChatView 内 banner + 实时 hold 计时(同样锚定 pausedAt),header 会话暂停按钮发 `session.pause/pauseRelease`。两级互不干扰:会话暂停只冻该会话(每会话独立 AgentPauseGate),全局暂停冻全部会话(进程级 gate,agent loop 先查全局再查会话)。暂停中会话 `working` 显示为 false(列表/树 paused 徽标同源)。恢复 = 重新拉 `pauseStatus` + 订阅流 `pause-state`/`global-pause-state` envelope 驱动。
- **输入框**:Composer/WelcomeComposer 共享 `autosize`(data-focused 感知);专注模式 morph 必须用 `useLayoutEffect`(passive effect 会先画一帧全宽再回跳)。
- **右键菜单(统一标准组件)**:所有悬浮右键菜单(会话/分组/项目块/列表项)一律用 `ContextMenu` 组件(`.gui-context-menu`,磨砂玻璃:bg-overlay + blur(24px) saturate(180%) + 分层阴影 + 130ms gui-menu-in/out,portal 到 root)——**不另造菜单样式**;条目 = 图标 + label + 可选 hint/divider/danger/disabled/color 圆点(分组颜色选择器用 `color` 属性 + `gui-dot`)。操作入口归属:会话=固定操作;分组=重命名/颜色/删除;项目块=打开 Finder/复制路径/移除项目(移除入口在右键菜单,不单独放行内删除按钮)。**行内编辑**(如分组重命名)用专用紧凑类(`.gui-group-edit`:13px/500、line-height 20px、padding 1px 4px、透明底 + accent 55% focus 细边)——全局 `.gui-input`(8px padding + 边框 ≈ 38px 高)会让行内编辑态膨胀突变,禁止用于行内重命名。
- **浮层菜单必须两阶段进入**(2026-08-06 关键修正):`ContextMenu` 与 `Pop` 挂载时先以 **opacity 0 无动画类**上屏,下一帧(rAF 双跳)再加 `--entered`/`--pending` 类启动 `gui-menu-in`——`useFloatingMenu` 早已如此。原因:**挂载即动画(带 transform scale 的 gui-menu-in)会让 Chromium 在真实屏幕合成器上跳过 backdrop 采样,菜单渲染成普通半透明(背后内容直接透出,无磨砂)**;CDP 截图(offscreen 合成)仍显示模糊,极易误导验证(曾误判为"transparent 窗口 blur 全失效"并错误地用 95% scrim 覆盖全部浮层——已回退,切勿再犯)。实现:`.gui-context-menu{opacity:0}` + `.gui-context-menu--entered{opacity:1;animation:gui-menu-in}`;Pop 复用 `.gui-menu-popup--pending/--entered`,**Pop 调用方类(openin/instance/header-title/overlay/creds/view/add-project/proj)不得自带 animation**(已移除,由 --entered 统一提供)。验证必须用真实屏幕截图(screencapture -l),CDP 截图不算数。
- **全浮层两阶段统一(2026-08-11)**:新增共享 hook **`useTwoPhaseEnter(active)`**(`lib/use-two-phase-enter.ts`,返回 `--entered` 后缀)——Board 放大(`gui-board-focus`)/小组件任务(`gui-task-modal`)/引导遮罩(`gui-onboarding-backdrop`)/⌘K 命令面板(`gui-palette`)/选区工具条(`gui-select-pop`)此前是**条件挂载 + 挂载帧直接播 `gui-fade-in`**,属 §6.5 风险类(纯 opacity 的轻度变体,未实测失效但违反契约),现全部接入。配套:命令面板改**常驻挂载**(app.tsx 不再条件渲染,`visible`/`closing` 内部状态,退出播 `gui-menu-out` 130ms + backdrop 渐隐);选区工具条补齐入场/退场(`gui-select-pop-in/out`,keyframes 必须烤入内联 `translateX(-50%)`——transform 动画覆盖静态 transform);base 规则统一 `opacity:0` + `--entered{opacity:1;animation:…}`,使 `gui-motion-off` 自然退化为瞬现(无需逐类列 motion-off)。**类名组合陷阱(2026-08-11,5/5 初版全踩)**:基类是 fixed/居中/blur 的唯一来源,必须**保留基类 + 追加完整 BEM 修饰 token**——`gui-foo${entered ? " gui-foo--entered" : ""}`。两种错误拼接:①`gui-foo${entered}` → 只有 `gui-foo--entered`,基类丢失 → 浮层落进文档流(引导卡实测 x=280 y=0,跟在侧栏后);②`gui-foo --entered`(空格直拼后缀)→ 孤立 `--entered` 类不匹配任何选择器 → 永远 opacity:0 不可见。CDP 量 `getBoundingClientRect` 验证:backdrop `position:fixed inset:0 opacity:1` + 卡片 centerDelta [0,0]。
- **首次启动引导居中悬浮(2026-08-11)**:ZCode 两栏卡居中悬浮——`min(1000px, calc(100vw-160px)) × min(620px, calc(100vh-160px))`(每侧 ≥80px 磨砂边,20px 圆角 + 24px 阴影)。**绝不是全屏贴边**:用户实测反馈近全屏(40px 边)右/上贴到软件边缘、整体过大;引导层必须让四周磨砂羽化遮罩明显可见,才有"悬浮在软件顶层"的观感。card `flex column` + grid `flex:1` 撑满高度,左栏内容底部对齐(圆点 `margin-top:auto`),右栏渐变面板内垂直居中示意动画。**三个步骤的示意窗口统一 280×190**(此前 236×168 / 244×155 / 244×120 三档,切换步骤右栏会跳变;chat/settings 用 `justify-content:center` 在固定盒内垂直居中内容)。
- **浮层卡面单层归属(2026-08-15,ColorPicker 双画教训)**:`useFloatingMenu` 的 `className` 落在 portal 外层——**菜单类**(proj/todo/queue/creds…)传 className、外层当卡面,内容必须是**无卡面的平铺元素**;**面板类**(quota/context/color-picker)组件根自带卡面 class,调用方**不得再传 className**。同一卡面 class 同时出现在两层 = 背景嵌套双画圆角磨砂容器(内容后面多一层圆角玻璃)。判定:DOM 里卡面 class 只出现一次。
- **点阵品牌背景**(`DotMatrixMark.tsx`,WelcomeComposer 背后,kimi 参考增强版 2026-08-06):文本栅格化为全矩形点阵——背景点淡(fg 8%)+ 文字点亮(fg)+ ~2% 彩色 accent 点(5 色板)**HSL 色相缓慢流动**(sin 偏移 ±0.12,每点独立相位)+ **羽化边缘**(文字 bbox 外 42px smoothstep 衰减,半径/透明度随距离渐隐,无硬矩形边界)+ **点击涟漪**(pointerdown 生成波前,0.55px/ms 外扩、26px 带宽内径向脉冲推点 + 放大,900px 后消散)+ 呼吸 + 鼠标 halo(吸引放大/active 变色)。**i18n 字体适配**:CJK/JP/KR 自动换字体栈(PingFang/Hiragino/Noto…)。**字形参数(2026-08-06 调优)**:`gridGap 7` + `dotRadius 2.0` + `600` 字重 + 140px 短文本阶梯(>6 字 115、>10 字 85;CJK >4 字 120、>8 字 90)——实测每字符 ≈ **11 列**(比 kimi 参考 140@8 的 ~9.6 列密 ~15%);字重 700 时 M 斜线栅格化成实心块(读作笨重方块),600 保留像素阶梯,经典点阵 M;`fontSize` prop 可覆盖(设置预览传 96)。mark 定位 `top: 17%` 让文字底缘(≈235px)保持在品牌行顶(≈242px)之上。IntersectionObserver 离屏暂停。
- **自定义与预览**(设置 → 常规):`musepi-gui-dotmatrix` 开关 + `musepi-gui-dotmatrix-text` 自定义文字(默认 MusePi,≤24 字符,欢迎页与预览实时联动,事件 `musepi-dotmatrix-changed`);预览 = 同组件小字号实例(`fontSize={96}`)在 `.gui-dotmatrix-preview`(744×170 圆角卡)内,**必须给预览 canvas 设 CSS 尺寸**(`width/height: 100%`)——组件只设像素缓冲不设 CSS 尺寸,无样式时 canvas 按缓冲尺寸显示(300×150×dpr),文字被 2× 放大且贴左上被容器裁剪(欢迎页 canvas 有 `.gui-welcome-mark` inset:0 所以没这问题)。

### 伙伴(Agent Companion,BitFun parity,2026-08-06)

- **预置**:10 个内置 Petdex 预置(`src/lib/pet.ts` 的 `BUILTIN_PETDEX`,sprite 在 `public/pets/`,768×936 = 8×9 网格,96×104 帧,来源 BitFun MIT)。设置页网格按「已导入 → 预设」分组;卡片 = rest 帧缩略图(`zoom: 0.66` 缩放,不裁 transform 动画)+ 名称 + 描述 2 行截断;选中卡 accent 边框 + 14px check(`gui-pet-card__check` 必须显式 width/height——Icon 组件无默认尺寸,漏写会渲染成 219px)。
- **形象选择**:`.gui-pet-trigger` 行显示当前伙伴缩略图 + 名称 + 箭头(展开翻转);预览缩略图用 `zoom: 0.55`。删除按钮只出现在导入卡,hover 显现,`stopPropagation` 防选中。
- **渲染形态**(PetSprite.tsx + gui.css):`.gui-petdex-sprite` 必须 `image-rendering: pixelated`;帧循环 + 每 mood 一个 transform 动画(`PETDEX_MOOD_ANIM`:rest 2.4s+breathe、working 1.16s+work bob、hover 1.44s+lift、dragging 0.96s+wiggle),两者同时挂同一元素(不同属性不冲突);mood 行映射 rest=0/hover=1/dragging=2/error=5/waiting=6/working=7/analyzing=8。
- **尺寸归一化与大小调节**(2026-08-06):所有 Petdex 形象按 **rest 行内容高度统一渲染**(`PET_CONTENT_TARGET_H = 100`,k = 100/contentH)——导入包的帧尺寸各异(Doraemon 192×208 vs 内置 96×104),不归一化会 2 倍大小、阴影溢出画布。contentH 来源:内置走 `BUILTIN_PETDEX.contentH`(实测写死),导入包 import 时 `measurePetdex()` 测量,旧包由 `migratePetdexContent()`(usePet 挂载时)自动补测回写。**伙伴大小滑块**(设置 → 伙伴,`musepi-gui-pet-scale` 60–150%,默认 100)乘在归一化之上;桌面宠物窗口由主窗口桥 `pet-activity {scale}` 推送(跨窗口 localStorage 不可靠),输入框内宠物直接读 pref。
- **窗口与阴影边界**:宠物窗口 320×290 基础尺寸(`PET_WINDOW_SIZE`),宠物锚定 `bottom: 52px`(帧 [134,238],偏上更居中)——**必须给 drop-shadow 留足辐射空间**(rest 0 6px 16px ≈ 22px → 30px 余量;hover 0 10px 22px ≈ 32px + bump ≈ 2px → 18px 余量),否则阴影在窗口底边被硬切(割裂感)。**恢复单窗口(2026-09-16)**:气泡/面板回到 pet 窗口内(`bottom: 174px` 气泡栈定位重新生效);窗口在需要时向上生长(底边固定)。
- **气泡栈(单窗口,2026-09-16 回并)**:最多 5 条(`MAX_VISIBLE_BUBBLES`)、最新在上、打字机逐条显示、× 关闭、8s 自动消失;**iOS Notification-Center 折叠形态**——折叠时只显示最新一条 + 「N more」chip,点击展开完整列表;折叠↔展开是**宽高双轴 morph**(320ms overshoot,`stackMorph` 过渡 width+height,窗口经内容尺寸上报跟随);深色圆角气泡 + 边框 + 轻阴影,卡片自绘磨砂玻璃面(自绘 tint + 高光 + 发丝线)——2026-08-22 的材质决策不变。2026-08-11 的双窗口拆分(独立 bubble 窗口追着宠物跑)是非 100% 缩放下"宠物↔气泡"漂移的根因,已回退。
- **气泡 kind 区分(2026-09-19)**:`bubble.kind`(`completed`/`error`/`question`/`subtask`,`lib/pet.ts`)此前**只有 `error` 有样式**——另外三种渲染完全相同,而 `question` 是唯一**阻塞 agent** 的 kind,最紧急的气泡看起来和信息类一样。现在每条气泡都带 `--pet-kind` accent token(`pet-window.css` `:root`:completed = `--color-accent`、error = `--color-danger`、question = `--color-accent`、subtask = 42% 文字色 tint),驱动 **2.5px 左侧规则**(`.pet-bubble::before`),并在正文与页脚之间加大写 kind 标签(`.pet-bubble__kind`,zh/en i18n `pet bubble kind *`);`error` 与 `question` 额外给边框上色(55% mix)——`question` 最响亮,因为它要求动作。两个实现陷阱:① 左规则必须用 **`background-color`,绝不能用 `background` 简写**——当 `var()` 的值是 `color-mix()` 结果时,Chromium 在解析期就丢弃该简写,规则什么都不画(实测:`background-image: none`,几何正常 2.5×47.75px);② 未知 kind 由标签 helper 返回 `null`,不产出误导性标签。
- **桌宠常驻普通窗口之上,但给全屏让路(2026-09-19)**:桌宠是桌面伙伴,所以常驻置顶层——但「行为得体」由三条规范定义,且三条都用户可见。① **不能下沉**。置顶断言在可见期间每 5s 重施加一次,因为 Windows 会在边缘吸附与睡眠唤醒时降级该层级且永不恢复;层级用 `pop-up-menu`(高于任务栏级 UI),不是 `floating`。② **不能抢全屏**。当别的应用占满屏幕——游戏、视频、演示——桌宠在该应用退出前退出置顶层,退出后回来。这是「伙伴」与「骚扰」的分界,而且必须对**别人的**应用生效,不能只管自家窗口。桌面本身永远不算全屏:点壁纸、Alt-Tab 都不许把桌宠赶走。③ **必须能回来**。拔掉显示器、DPI 变化、笔记本睡眠唤醒,都不许把桌宠留在屏幕外、被不可见地 cloak、或尺寸错乱(看着被放大、且每睡一次就更大一圈,是用户报成「坏掉了」的那种失败)。以上任一情况之后,桌宠回到合理位置,但**若用户是特意把它停在一个可达处,就不得移动它**——DPI 事件不是给用户手放位置重新居中的许可。
- **交互面板(单窗口,2026-09-16 回并)**:点击宠物在 pet 窗口内 sprite 上方切换面板(2026-08-11 的 bubble 窗口版本已删)。面板 = 实时任务摘要(working/idle + 当前工具 + 最近消息,1s 节流推送 + 打开时即时快照)+ 审批卡(批准/拒绝走主窗口 `tool.approve/deny`,**另配全局热键 `Ctrl/Cmd+Shift+Y/N`**——仅在"有 pending 审批且宠物可见"时注册)+ 快捷回复(有会话 steer/followUp,无会话 createSession 首条消息)+ 会话标题 + ↗ 打开主窗口按钮 + tab(消息/最近会话)。面板 316px 固定宽、absolute 底部锚定在宠物区上方(`bottom: 170px`),高度随内容(窗口经 `pet-set-content-size` 向上生长);**入场 gating 依旧**:面板 mount 时 `opacity:0`,等窗口 resize 事件(120ms 兜底)再播 `pet-panel--in`——窗口生长比 React commit 晚一次 IPC 往返,立即播动画会把面板裁剪。面板 i18n(locale 经 `pet-activity {locale}` 推送)。气泡在面板打开时隐藏。**空闲睡眠(2026-09-16)**:60s 无手势且无任务活动 → sprite 调暗 + 漂浮 "z z z"(`.pet-window__pet--sleeping`,纯 CSS——导入包无需新帧);任何手势或 mood 变化唤醒。

## 5. i18n 与音效

- **i18n**:文案 key 即英文回退,zh 翻译按域拆在 `guest-client/src/i18n/zh-CN/<domain>.ts`(en 侧 `en-US/` 编译级 parity,详见 §i18n 契约与 `docs/i18n.md`);`t()` 调用点渲染(模块级 const 不随语言切换)。数字/时间格式化显式传 locale,禁依赖浏览器默认。
- **音效(2026-08-07 活动化改造)**:cuelume(Web Audio 合成,14 个 recipe);统一经 `packages/desktop-app/src/lib/sfx.ts`:
  - **活动分类配置**(opencode per-category sounds parity):10 个活动(`SFX_EVENTS`)——发送消息/首次消息/消息完成(agent_end,stopReason 非 aborted/error 才响)/审批请求/审批通过/审批拒绝/切换会话/停止回合/工具结果/错误;每类可换音色(`soundFor`/`setSoundFor`,持久化 `musepi-gui-sfx:<event>`,无效值回退 `DEFAULT_SFX`)。
  - **调用点用 `sfxFor(event)`**(app/Composer/WelcomeComposer/ApprovalCard/session-store),不再直接 `sfx(name)`(保留给一次性/预览);总开关 `musepi-gui-sound` gating 全部。
  - **消息完成挂 agent_end 而非 turn_end**(2026-08-07 修正):turn_end 每轮模型调用都触发(多工具任务连响),且中止时与 stop 音叠加——agent_end 每 run 一次。
  - **设置 UI**:通知与音效 tab = 每活动一行(名称 + 触发说明 + 默认音色)+ 音色下拉 + ▶ 预览 + 14 色 palette 网格(`ALL_SOUNDS`/`WIRED_SOUNDS`/`previewSound`);新触发点接入后同步 WIRED_SOUNDS 与中文用途文案。
  - **验证坑**:cuelume 有 `navigator.userActivation` 浏览器策略 gate——CDP 合成输入不产生真实激活,音效播放无法自动化验证(配置读取/持久化可测,播放需真实点击)。

## 5b. 动画与库选型(2026-08-07 评估)

- **原则:CSS 优先 + 自研 hook**。现有动效体系全部手写 CSS/JS(Reveal/HeightMorph/useCollapse、BorderBeam、DotMatrixMark、ThinkingOrbs、KITT 扫光、两阶段浮层、宠伴帧动画)——桌面 GUI 的动效需求是"精致克制的 UI 反馈",CSS transition/keyframes 足够且零运行时开销、天然尊重 `prefers-reduced-motion`(`gui-motion-off` 偏好)。
- **已用第三方**:`cuelume`(音效)、`lucide-react`/`lucide`(图标)、`morphicons`(Composer 发送/停止图标 morph)、`beautiful-mermaid`(guest-client Mermaid 渲染)、`@xterm/xterm`(终端)、`pdfjs-dist`(PDF)。**motion(原 Framer Motion)曾依赖但零引用——已移除**(2026-08-07)。
- **GSAP 评估(不引入)**:GSAP 3(现完全免费,含全部插件)是命令式时间轴/ScrollTrigger/SplitText/MotionPath 的行业标准——但其强项场景(营销页滚动、文字逐字特效、复杂多步编排)不在桌面 GUI 核心路径;引入需建立新动画规范(时间轴/插值)且与现有 CSS 动效双轨并存。**保留为候选**:若后续做欢迎页品牌文字逐字动画(SplitText 类)、复杂转场编排,再评估。
- **图标切换 = morphicons,禁自绘交叉(2026-08-14 教训)**:任何"图标 A → 图标 B"的过渡(主题/强调色全屏遮罩、按钮态切换、状态卡)一律用 **`morphicons`**(`morphicons/react` 的 `MorphIcon`,或纯 DOM 场景 `morphicons/element` 的 `<morph-icon>` + `set()`/`morphTo(target, "snappy")`)——**Procrustes 最优旋转 + 极坐标插值 + spring 物理的形状变形**。**禁止**用两个 SVG 叠放 + opacity/rotate 交叉淡入淡出伪装 morph(2026-08-14 主题遮罩曾误用,用户明确要求 morphicons 效果;Composer/Transcript/引导步骤已全部是 morphicons,遮罩必须同款)。
- **store 变更通知必须在 swap 回调内 emit(2026-08-14 教训)**:`setThemePreference`/`setAccentPreference` 经 `withColorTransition` 延时(340ms)执行切换——**`emit()`/`emitAccent()` 必须放在 `withColorTransition(fn)` 的 `fn` 内部**(preference/accent 已更新后),不能放在调用之后:在外部同步 emit 会广播**旧值**,`useSyncExternalStore` 订阅者(设置页 segmented/色板按钮)读到旧 preference——按钮状态**滞后一次点击**(点了浅色、主题已切、按钮还在"跟随系统";下次点击显示的是上一次的选择)。
- **React Bits 评估(源码参考,不装包)**:140+ 开源动画组件(MIT 系,github.com/DavidHDev/react-bits)。与现有"参考仓库抄模式"工作流一致——候选组件(按需复制):`BlurText`/`ShinyText`(欢迎页品牌文字)、`CountUp`(数字滚动:状态栏 token/统计)、`SpotlightCard`(设置卡 hover 光效)、`Aurora`/`Particles`(欢迎页背景备选,现有 DotMatrixMark 优先)。BorderBeam 我们已有自研版(参考 opencode),reactbits 同款可对照参数。

## 5c. 参考资源(设计与实现对照)

| 资源 | 对照用途 | 备注 |
|---|---|---|
| opencode(`../opencode` dev) | 会话树/header/服务器实例/设置 v2 形态 | 音效三分类(agent/permissions/errors)是活动音效配置的蓝本 |
| openchamber(`../openchamber` v1.18.1) | 三栏 shell/设置布局/通知模板/远程实例(SSH+端口转发) | 设置页形态主参考;消息局部选择悬浮/保存为图片/基于回答新会话(2026-08-07 已落地局部选择+保存图片,fork 模态未做) |
| bitfun(`../bitfun` main) | 伙伴(Petdex/帧动画/mood)/SSH 远程工作区/审批 | 桌宠视觉与交互主参考 |
| clawd-on-desk(`/tmp/clawd-on-desk`,rullerzhou-afk,AGPL) | 桌宠浮窗布局/权限气泡/状态指示 | **内容驱动窗口设计参考**(2026-08-11 分析):固定宽度 + 高度自适应(窗口宽度不变→无锚定裁剪);气泡堆布局优先级 下方→侧边(空间多侧,右优先)→角落;入场从桌宠侧滑入(translateX 60→0 弹簧)。「宽度先行」思想(尺寸稳定后再动效)已落地面板入场 gating |
| kimi-code(`../kimi-code`) | 图标卡中卡 80.5%/点阵品牌背景/供应商网格 | Dock 视觉对齐基准 |
| ZCode | 连接向导 4 步(SSH/Docker) | ConnectDialog 步骤骨架 |
| `../ui-references/aicss/` | AI 界面 CSS 配方(thinking/code-block/comparison-table…) | 消息流细节对照 |
| `../ui-references/cuelume/` `border-beam/` `thinking-orbs/` | 音效/光束/思维球参考 | 自研组件的灵感源 |
| reactbits.dev(2026-08-07 起) | 动画组件源码参考 | 已落地:CountUp/BlurText/ShinyText/SpotlightCard(全部零依赖变体);候选:字体粒子背景(需 WebGL,未采用) |

## 5d. 设计缺口与跟进(2026-08-07 登记)

| 缺口 | 现状 | 补全设计草案 | 状态 |
|---|---|---|---|
| **plan 审批 3 选项 GUI 化** | GUI ApprovalCard 仅 批准/拒绝(tool.approve/deny);TUI 有 批准并执行(新开会话)/批准并压缩上下文/批准并保持上下文——那是 `xd://propose` 设备流 → `handlePlanApproval` → 进程内 `session.prompt` 的 TUI 专属机制,daemon 的 approval-request payload 只有 `{requestId, tool}`,无 plan 元数据,GUI 无对应 RPC | ①daemon `approval-request` 对 plan 工具附加 plan 上下文(planFilePath/title/planExists,对齐 TUI 的 propose dispatch 形状);②新增 approve 模式参数(tool.approve 扩展 `mode: "run"\|"compact"\|"keep"`);③GUI ApprovalCard 检测 `tool === plan` 显示 3 选项,默认保持上下文;④桌宠审批卡同源 | 登记待排期 |
| **基于回答开始新会话模态** | 已有 fork(`session.forkAt`,非破坏性分叉);openchamber 是配置模态(模型/思考级别/智能体/说明/工作树/目标运行) | 复用 ModelSelector/ThinkingSelector 组件做轻量模态,默认值=当前会话 | 登记待排期(可选) |
| **Aurora/Particles 欢迎页背景** | 未采用(WebGL/常驻 rAF 违反 CSS 优先;DotMatrixMark 已是品牌视觉) | 若用户想要"换氛围",用 CSS 渐变动画替代或做切换开关 | 备选,不做 |


## 5f. 设计资产扩展点(插件化,2026-08-16 定稿)

内置设计资产以 **token + 覆盖机制** 组织,第三方/主题/动效包通过覆盖 token 扩展,不 fork 组件。

### 动效参数全表(gui.css `:root`)

| Token | 默认 | 用途 | 覆盖方式 |
|---|---|---|---|
| `--spring` / `--spring-snappy` / `--spring-bouncy` | spring(300,30)/(400,34)/(320,16) linear() | 全部 UI morph 缓动 | 注入 CSS 覆盖 `:root` 变量 |
| `--gui-motion-menu-in/out` | 130ms | 浮层菜单进出 | 同上 |
| `--gui-motion-chip` | 180ms | 芯片/小元素 | 同上 |
| `--gui-motion-fade-in/out` | 160ms | 淡入淡出 | 同上 |
| `--gui-motion-height` / `-max` | 240ms / 480ms | 高度形变(HeightMorph delta/6 封顶) | 同上 |
| `--gui-motion-blur` | 280ms | blur 类动效(BlurText) | 同上 |
| `--gui-motion-roll` | 240ms | 滚动/翻页类 | 同上 |
| `--gui-motion-slide-y` / `-lg` | 6px / 10px | 位移距离 | 同上 |
| `--gui-motion-blur-amt` / `-lg` | 8px / 24px | 模糊量 | 同上 |
| `--gui-ease-out` | cubic-bezier(0.22,1,0.36,1) | 高度/形变缓动别名 | 同上 |

**覆盖机制**:keyframes 与 transition 一律读 token(`var(--gui-motion-*)`);动效包/主题注入样式表(加载在后 wins)覆盖变量即可整体换肤,无需改 keyframes。`gui-motion-off`(prefers-reduced-motion)全局禁用。

### 组件参数化(不 fork 即可定制)

- `BlurText`(`stepMs`/className)、`ShinyText`(`speed`/`spread`/`shineColor`)、`CountUp`(`duration`/`format`)、`SlidingNumber`(`padStart`/`decimals`)、`TextMorph`(`stepMs`/`durationMs`)、`GuiSelect`(options/className)、`SpotlightCard`(`spotlightColor`)
- 玻璃层:`--gui-glass-alpha`(透明度滑杆)+ `--gui-glass-overlay` 派生;`.gui-main`/悬浮卡 blur 读平台类(`[data-platform="win32"]` 关底层 blur,见性能节)

### 新动效组件的接入契约

1. 时值/位移/模糊 **必须读 token**,禁止裸值(裸值 = 无法被主题/动效包覆盖)。
2. 进场动画走两阶段(`useTwoPhaseEnter` 或 `opacity:0` + 下一帧 `--entered`),防 Chromium 跳过 backdrop 采样。
3. 尊重 `gui-motion-off`(禁用态直显,不播动画)。
4. 复用 `gui-menu-in/out` / `gui-fade-in/out` keyframes 或同参数自建(命名 `gui-<name>-in/out`)。
## 5e. 弹窗、键盘与选择器(2026-08-14 定稿)

### 弹窗动画与键盘优先级

- **DialogFrame 契约**:宿主**无条件渲染** + `open` 驱动(`{x && <DialogFrame/>}` 条件挂载会丢退出动画——180ms closing 相位);prompt/confirm(`lib/prompt-dialog.tsx`)同款两阶段 enter + closing,`finish()` 延迟到退出动画完成后才 resolve promise。
- **模态持有键盘**:DialogFrame 打开时在 `document` **capture 阶段**监听 Esc → onClose(赢过背后 handler,composer 不再吞 Enter 发消息),焦点移入弹窗第一个可聚焦元素、关闭后恢复;confirm 框 Enter = 确认(焦点落在确认按钮);引导面板 Enter = 下一步(输入框聚焦时保留输入框自己的 Enter)、Esc = 上一步/第一步关闭,面板打开即聚焦;公告面板 Esc = 关闭。
- **紧凑弹窗**:小内容确认框用 `gui-dialog--confirm`(auto 尺寸 + max-width 380 + 22×24 padding)——基类 `.gui-dialog` 是 600×420 设置框,desc+两按钮装在里面读起来是坏的(看板删除/新建项目/定时删除均踩过)。
- **hooks 铁律**:所有 hook 声明必须在**任何早退 return 之前**(`if (!open) return null` 之后的 hook 会在 open 切换时崩 "Rendered more hooks than during the previous render"——AnnouncementOverlay 回归实测)。

### 浮窗定位规范(2026-08-25 定稿,openchamber v1.20.0 对照)

**单一入口铁律**:所有弹出浮层(菜单/dropdown/上下文菜单/颜色选择器/附件菜单)必须经 `components/Pop.tsx` → `lib/use-floating-menu.tsx`(唯一实现:portal 到 React root + 全局互斥 + `gui-menu-in/out` 动画)。**禁止手写 `position: fixed/absolute` 的弹出浮层**——openchamber 用 @base-ui/react(floating-ui popper 内部引擎),我们手写同语义、不相依:
- **碰撞语义(flip + shift)**:垂直方向 = 锚点下方放不下(或上方空间更多)时向上翻转(flip);水平方向 = 左/右溢出时整体移入视口(clamp 到 `[8, innerWidth − menuW − 8]`,shift 不翻转)——右对齐菜单右缘钉锚点右缘,空间不足时右移保命,不被窗口边缘截断。
- **两阶段测量**:首次 open 时菜单未挂载 → 260×300 估算定位 → 挂载帧一次性重测 `offsetWidth/Height` 精确重定位(`measuredRef` 防循环);右对齐菜单右缘因此仍精确落在锚点上。
- **上下翻转含高度**:`flipUpForBottomOverflow = r.bottom + 6 + menuH > innerHeight − 8` —— 高菜单挂在低锚点下也向上翻,不许底部溢出。
- **常驻浮卡(非弹出)**:btw 侧问卡/角标卡等 fixed 角卡必须自带视口 clamp(`maxWidth: calc(100vw − 48px)` + `max-height: min(60vh,520px)` + body 滚动),禁止裸 fixed 无边界。
- **键盘**:浮卡/浮菜单的 Esc 承诺必须接线(如 btw 卡 hint「Esc closes」↔ onKeyDown Escape),不许提示与行为脱节。

> **范围澄清(2026-09-14)**:「手写同语义、不相依」只适用于**浮层定位**这一域——floating-ui 的 flip/shift/clamp 语义量小、CSS + 尺寸测量足以精确复刻,且与 `gui-menu-in/out` 两阶段入场深度耦合。**拖拽排序不适用此原则**:**务实选型**——`@dnd-kit` 的传感器仲裁(指针/键盘激活阈值)、碰撞检测、可访问性(屏幕阅读器 reorder announcement)、嵌套容器是实打实的状态机,依赖能很好解决这类需求,就用依赖(openchamber 全线 14 处拖拽同库对齐,见下节);**只有**当交互简单到依赖反而是累赘(无排序语义的一次性拖放、纯指针的一维位移)时才手写。判断标准:涉及"顺序"且需持久化 → `@dnd-kit`;单纯"把这个东西放到那里" → 手写 pointer capture。

### 拖拽排序规范(2026-09-14 定稿,openchamber 对照)

openchamber 全线拖拽(14 处:模型收藏/供应商、右栏面板排序、会话标签页、起始提示词 chips、排队消息 chips、会话文件夹/项目排序、TodosSection、移动端项目/会话)统一用 `@dnd-kit`。需要排序的拖拽我们对齐同库:

- **依赖**:`@dnd-kit/core@6` + `@dnd-kit/sortable@10` + `@dnd-kit/utilities@3`(`@dnd-kit/modifiers@9` 按需),装在 `packages/desktop-app`。
- **传感器约定**:可见排序用 `PointerSensor` + `activationConstraint: { distance: 8 }`(移动 ≥8px 才启动拖拽,避免误触点击);整行 header 拖拽用 `MouseSensor` distance 8;需键盘排序时加 `KeyboardSensor` + `sortableKeyboardCoordinates`。
- **结构**:`DndContext`(sensors + `closestCenter` + `onDragEnd`)包 `SortableContext`(`verticalListSortingStrategy` / `rectSortingStrategy`);行用 `useSortable` + `CSS.Transform.toString(transform)`;拖拽手柄是独立 `<button>`(带 `attributes`/`listeners`),不是整行可拖——行内有按钮/输入框时整行拖会劫持点击。**例外**:纯图标按钮(右栏 rail icon)自身不含嵌套控件,可直接当 activator,8px 阈值已保证点击不被劫持。
- **完成态**:onDragEnd 里 `arrayMove` 后**整表回写**存储(localStorage 或 RPC),不允许只改本地可视顺序与后端不一致。
- **禁用条件**:条目 ≤1 时整块 `draggable={false}`/不渲染手柄;搜索过滤态下按 id 在**完整数组**上重排(不能在过滤子集上 splice,否则丢隐藏项)。

### 右栏 rail 交互(openchamber ContextPanelRail parity,2026-09-14 定稿)

- **拖拽排序**:`@dnd-kit` 全套(PointerSensor distance 8 + TouchSensor delay 200/tolerance 6),在**完整 order** 上 arrayMove 后整表回写 localStorage(`writeSurfaceOrder`)。扩展槽 tab(`ext:`)不进 SortableContext。
- **⌘/Ctrl 长按揭示序号**:按住修饰键 500ms → rail 图标右上角显示 1..N(对应 ⌘1..8 跳转);松开、失焦、或真的按了数字键即消费并消除,下次按住才回来。app.tsx 的 ⌘1..8 处理器不变,这边只负责可视化。
- **角标**:live 计数(当前仅 git 变更文件数,99+ 封顶)优先于序号;序号只在修饰键长按时出现。a11y 标签把计数读进 `aria-label`(「git,3 个已更改文件」)。
- **富 tooltip**:registry 每项带可选 `description`(i18n key);hover 150ms 后在图标左侧弹出(label + description + 角标描述行),单个 portal 由 rail 层托管(`RailTooltip`),拖拽中抑制。rail 是贴视口右缘的定宽列,几何恒定,不需要 floating-ui 的 flip/shift。
- **不做**:surface 显示/隐藏配置弹窗(openchamber 的 equalizer 入口)——musepi 的 has-content 自动隐藏已够用,用户未提需求。

### 模型选择器(provider 复合键)

- **模型身份 = `provider/id`**,绝不是裸 id——两个供应商可提供同裸 id(opencode-go / opencode-zen 都出 `deepseek-v4-flash`):收藏(`musepi-gui-fav-models`)、DEFAULT 图钉(`modelRoles.default`)、选中态、角色行赋值全部按 `provider/id` 键控(旧裸 id 条目兼容匹配、toggle 时清理);`session.setModel` 携带 `provider` 让 daemon 精确解析(daemon 侧 provider 限定查找已加)。
- **composer/欢迎页**模型菜单行 = 模型名 + provider 徽标 + 收藏星 + **DEFAULT 图钉**(target 图标,当前默认实心)——点图钉即写 `modelRoles.default`(设置页 DEFAULT 角色同键,两边一致);菜单 min-width 260 / max-width 344。
- **单胶囊合并(dsh single-trigger parity)**:两个选择器合并为一个胶囊(`ModelThinkingCapsule`),左段显示模型品牌图标 + 模型名,右段显示思考图标(brain)+ 等级文本;点击各自弹独立菜单(模型搜索/收藏/图钉菜单 + 思考等级 ladder)。胶囊在 composer frame 宽度不足时自动收缩为仅图标(文字通过 `@container` 查询 + `--gui-motion-chip` 180ms 过渡淡出,`gui-motion-off` 直接切换;收缩阈值 480px 思考文本先让位、380px 模型文本与分隔线再让位,均以 `.gui-composer-frame` 的 inline size 为基准)。胶囊段之间细竖线分隔,每段 hover 用 `--spring` 150ms 过渡高亮,高亮形状贴合胶囊(首段圆左半、末段圆右半、单段全圆)——与独立 `.gui-model-btn` 的 hover 一致;胶囊 `flex-shrink: 0`,按钮行拥挤时不被挤压(收缩只由 frame 宽度驱动)。
- **模型品牌图标(`@lobehub/icons`,MIT)**:胶囊左段与模型菜单行均按 `provider` 渲染品牌 logo(Mono 单色变体,`size 14`;`model-brand-icon.tsx` 内联 24 个 provider→图标映射 + 按 modelId 子串兜底),未知 provider 回落 oc-icons `ai-agent`;深度导入(`@lobehub/icons/es/<Brand>`)保证 tree-shaking 只打包用到的品牌。
- **角色思考等级动态**:角色行 thinking select 渲染 `resolvedRoleModels[role].efforts`(daemon `getSupportedEfforts`,模型无 thinking 支持则为空)——绝不固定七档;每次角色模型变更经 `applyRoleModels`(set 成功后重拉 resolvedRoleModels)让"自动选择"派生行与等级列表即时刷新。

### 获取可用模型(自定义供应商表单)

- **配置界面形态**:添加自定义供应商是**规范弹窗**(DialogFrame,`gui-dialog--settings`),由「自定义供应商」tab 内点击「添加自定义供应商」打开——**不是独立 tab**(用户反馈:添加自定义供应商应是有设计规范的弹窗;旧 add-tab 已移除)。Base URL 与 API 协议(openai-completions / openai-responses)确定后点「获取可用模型」——**只对 OpenAI 兼容协议可问**:anthropic-messages / google-generative-ai 没有可读的模型列表,错误提示引导手工填写(与 DSH discover-models 同哲学:配置期对草稿的一次性询问,不写任何配置)。**引导界面(OnboardingOverlay ProviderSetup)的自定义表单同样提供「获取可用模型」**,不必手填 model id。
- **询问即草稿**:RPC 参数 = 表单当前值(baseUrl/api/apiKey/provider 名),**apiKey 仅用于这一次询问、daemon 绝不落盘**;无 baseUrl 时按钮禁用并 hover 提示「请先填写 Base URL」。
- **候选弹窗**(DialogFrame,始终挂载由 `candidates !== null` 驱动,嵌套于配置弹窗内):勾选列表(id + name,端点序)+ 全选/取消全选(全选时「取消全选」)+ 「添加所选」;采纳后候选并入表单模型列表(`adopted`),每行带删除;错误(协议不支持/401/404/端点无模型)内联展示在按钮下方,不弹窗。
- **提交语义**:`models.add` 的 models 数组 = 已采纳列表 + 手工单条(modelId/modelName/compactionModel)合并;校验改为「供应商名称、Base URL 与至少一个模型为必填」——单条与采纳列表至少满足其一。
- **成功反馈**:保存成功关闭弹窗,返回「自定义供应商」tab 在添加按钮原位置显示短暂「供应商已添加」反馈(2.5s 后消失);引导界面显示 added 卡片。

### 看板画布与组光效

- **画布自适应**:`.gui-board-surface` 布局宽固定 BASE_W(1092),`transform: scale(容器宽/1092)` 适配窗口;effect 依赖 `activeId`(挂载时 home 视图 ref null → deps `[]` 时 scale 永驻 1,画布 1092 布局溢出被裁——已修);`overflow-x: hidden` + `overflow-y: auto`(transform 不改布局,窄窗口必出横向滚动条伪影)。
- **ChromaGroup 组光效**(reactbits ChromaGrid parity,`components/ChromaGroup.tsx`):容器 pointermove 写 `--cg-x/--cg-y`(零 re-render),`.gui-chroma-glow` 纯 CSS 三层 RGB 错位径向渐变 + `mix-blend-mode: screen` + hover 淡入 + `gui-motion-off` 隐藏——**一个共享光晕同时照亮组内所有卡片**(看板画布 + 模型供应商网格);伙伴预设/桌宠市场**不适用**(滚动密集小卡网格上整片背景泛光 + 固定 inset-0 在滚动容器被裁——用户实测回退)。

### 设置搜索与新建项目

- **设置搜索**:侧栏搜索过滤**配置项级**(section label 或 `SECTION_SEARCH_TERMS` 关键词命中,双语);内容区匹配行 `.gui-settings-match`(accent 13% 底 + 24% 描边)命令式高亮 + 首个匹配 `scrollIntoView`(新查询/section 切换滚一次,继续打字不滚防抖动);`aria-hidden/inert` 折叠行跳过。
- **新建空白项目**(kimiwork parity):侧栏项目 tab「添加项目/远程」菜单 + composer 项目菜单 → DialogFrame(名称 + 父路径 native picker)→ daemon `fs.mkdir { cwd: 父路径, path: 名称 }` → 打开 + `musepi-gui-project-added`;保存按钮双字段齐备才启用,失败内联展示。字段 = label 上控件下的紧凑布局(`gui-settings-field` 两列 grid 在紧凑弹窗里会把 input 挤到 76px)。

## 5g. 近期落地特性(2026-08-24 → 2026-08-26)

早期章节之后落地的设计决策与模式;实现契约与坑在 `docs/gui-implementation.md` §18,分特性规格见所列文档。

- **右栏改造 Phase 1–2**(`docs/archive/gui-right-panel-redesign.md`):右栏 ContextPanel 改为**分组 44px 图标 rail**——surface 注册表(`surfaces/registry.ts`)新增 `group` 字段(primary/secondary/tertiary);高频图标固定,secondary 收进 rail 底部「…」溢出;宽度 clamp 放宽到 **260–1200px**(+ maximize 态);**⌘E** 切换面板,**⌘⇧E** 为 focus mode(输入框铺满);关闭动画为 **220ms 宽度折叠**(非 proma overlay)。第二条 TabBar 行与多实例 tab **已被架构否决**("rail 是唯一导航轴");Phase 3 面板级细化继续。
- **看板/widget 画布**(`docs/archive/board-dashboard.md`、`docs/archive/widget-design-system.md`):`BoardPage` + 白名单 `WidgetRegistry`(18 种 widget)——同一 registry 渲染看板网格、transcript 内联卡与 pin 窗,一个 widget 写一处三处复用。画布固定布局(BASE_W 1092)缩放适配窗口(`transform: scale(窗口宽/1092)`),`overflow-x:hidden` + `overflow-y:auto`;ChromaGroup 辉光(`components/ChromaGroup.tsx`)以单份共享 RGB 偏移径向渐变点亮整组(`mix-blend-mode: screen`,`gui-motion-off` 隐藏)。
- **Composer 与状态行设置**(daemon schema,设置「交互」/「Shell」tab 中呈现,§4 TUI 设置同步):`composer.shape`(string,默认 `"box"`)选 composer 形态;`statusLine.contextLine`(enum `CONTEXT_LINE_MODE_VALUES`,默认 `"embedded"`)驱动状态行 gauge——`off`(纯 accent 实线)、`percentage`(已用段 accent、其余 border)、`annotated`/`embedded`(百分比 + 窗口标签)。
- **win32 磨砂玻璃修复(2026-08-26)**:显式 `html:root, html:root body { background: transparent }`——`html` 是被忽略的一层,带着不透明 `var(--bg)` 挡住 DWM Acrylic(Windows)/vibrancy(macOS)透出半透明 scrim。`[data-platform="win32"] .gui-main` 关掉页面 `backdrop-filter`(模糊来自窗口材质,更省 GPU);`[data-platform="win32"][data-theme="light"]` 用薄 22–58% scrim(Acrylic 是亮材质,默认 58–76% 浅色 scrim 会冲掉磨砂)。
- **OTA 更新 UI**:「检查更新」(§4)从「前往下载」(openExternal)升级为 **下载 → 进度 → 重启**(electron-updater,v0.4.4)——`docs/archive/ota-update-design.md`;toast 现在显示百分比 + 「立即重启」。notes 双通道不变:toast 读 `update-manifest.json.notes`、「What's new」读 `CHANGELOG.musepi.md`。
- **双语文档约定**(`docs/i18n/README.md`):范围内 `docs/**` 每个 markdown 成对 `foo.md` + `foo.zh-CN.md` + `foo.i18n.yaml`(blob 哈希一致性记录);标题后语言切换行(`English | [中文](foo.zh-CN.md)` / `[English](foo.md) | 中文`);`bun run verify-translation-pairing` 执行(`--write` 记录哈希,具名 pair 严格校验);两语言地位平等、结构镜像。
- **画板 Codex 对齐**(2026-09-19):画板新增**文本工具**(真实 `<textarea>` 浮层,按画布像素定位 —— 输入法/粘贴/选区都是原生行为;失焦或切到别的工具时落成 Konva `Text`,所以待输入的插入符不会丢)、用**形状飞出菜单**取代原来平铺的直线/箭头两个按钮(直线/箭头/矩形/椭圆/菱形/三角形/五角星/心形,4 列玻璃浮层;轨道按钮显示**当前选中**形状的图标,让矩形和菱形一眼可辨)、**12 色调色盘**,以及取代 2/4/8/14 四档的**连续粗细滑杆**(1–24)。**全部几何计算搬进 `lib/sketch-geometry.ts`** —— 拖拽归一化、星形/心形取点、文本度量、命中范围 —— 因为 Konva 离开 canvas 无法断言;由 `test/sketch-geometry.test.ts`(42 个用例)覆盖。画板外壳并入**液态玻璃 + 弹簧动效规范**:78% 半透明表面 + `blur(3xl) saturate(170%)`、`--glass-sheen` 走未被占用的 `::before`、`--glass-shadow`,入场用 240ms `--spring-liquid`(关闭时 180ms `--spring` 的缩小回弹不变,画板仍读作"回落进输入框")。这里每个视觉 `position`/`transform` 都只有一个归属(入场由画板 keyframes 独占,遮罩只负责淡化)。
- **画板 chip 重开的是 A0,不是 A1 的副本**(2026-09-20):这里的产品规则是**画的连续**,不是**一张能涂的图**。完成时既交付进入消息的 PNG,**也**交付画板的笔画列表(`scene`,`lib/sketch-scene.ts`);chip 两者都带,所以点击它恢复的是对象——每一笔依旧可选、可拖、可缩放、可擦除——再次编辑就是精确地改用户所指的那一笔。旧行为(把导出的 PNG 当底图挂回)让画板自己的产物一步就变成不可再编辑:之后任何修改都只能在栅格上叠涂,这正是它读作"只是粘贴了图片"的原因。scene 同时也是闭环的关键——完成是像素**与** scene 一起换,所以第十次再编辑和第一次一样可编辑。降级只有一个方向且无感:丢了 scene 的 chip(恢复的草稿、改动前的数据)按旧的整图底图打开,而不是拒绝打开。
- **文字标签是图形,不是说明文字**(2026-09-20):规则是**一套对象模型**,所以文字既无特权也无豁免。它随输入自动换行并增高(标签持有真实盒子,高度跟着换行行数走),用与矩形、图片相同的四个角手柄缩放,单击即选中并拖动——**双击**才是编辑,因为"点标签放插入符"曾让文字成为画板上唯一拖不动的对象。值得守住的不变量:看到的文字与选中框量自同一个行高,所以不断变宽的选中框永远不会和里面的字形对不上。
- **文字要量,不要估;用户选的宽度必须尊重**(2026-09-20):这两条合起来才让文本框像一个对象而不是一次猜测。(1) 标签盒子按**真实画布度量**定尺寸,因为任何固定的"每字符系数"都只是在描述某一种文字:按拉丁文调出来的估算会把中文低估约 1.6 倍,于是中文标签被静默截到只剩前几个字。(2) 用户把盒子拖到某个宽度,这个宽度就要保留——文字在里面换行,盒子不会弹回去贴合自己的内容,因为用户亲手设定的尺寸绝不能被悄悄推翻。唯一的例外是某一行真的放不下,那时盒子变宽而不是藏起字形。

## 5h. 吸收轮增补(2026-08-29)

- **浮动状态卡**(会话右上角,ZCode 悬浮卡对齐):紧凑磨砂启动卡(Git / 智能体 / 待办),248px 宽,`gui-menu-in` 入场;可折叠为细药丸(持久化 `musepi-gui-status-cards`);全部为空时整栈消失——不为空闲会话装饰。点击穿透打开对应 surface;除分支切换器外不复刻 surface 内部 UI。
- **奖励票券弹窗**(活动版 what's-new 形态):星空 + 3D 倾斜漂浮票券,变换分层(tilt / float / entrance 各在独立元素——每个 `transform` 只有一个动画源);数额 CountUp 滚动;`gui-motion-off`/`prefers-reduced-motion` 下全部静止。领取反馈耦合完成音效。
- **右侧面板最大化**是模态:遮罩(z-840,自 48px 头栏之下起,点击还原)垫在 z-850 面板之后——浮动 fixed 层(浮层滚动条、tooltip)必须低于遮罩层,否则会被读成面板内容。
- **Git 图谱表格**(提交历史子标签):车道求解 SVG 图轨 + 徽章(HEAD=home/强调色,本地分支=branch,远端=cloud/弱化,tag=琥珀) + 日期/作者/哈希列;点击哈希复制,1.2s 反馈。会话级 i18n key 在 settings 域(`subject/date/author/commit column`、`load more`)。

## 5i. 会话悬浮卡与 design 空态(2026-09-19)

- **会话悬浮卡**(WorkBuddy 悬浮弹窗对齐 + 我们的 mode 行):行上悬浮 ~350ms 在行右侧浮出 288px 磨砂卡——标题(2 行截断)、fork 来源、**模式 chip**(accent 着色,`mode {id}` 命名链未知预设回落默认模式,与 ContextPanel 同规)、任务工作空间(cwd basename,title 全路径)、最后活跃 + 创建时间。架构:行经**模块级 bus**(`SessionHoverCard.tsx` 的 `reportSessionHover`/`clearSessionHover`)上报——不给 memo 化的 `SessionRow` 加任何 props;卡片(每侧栏一实例)从 `sessionMeta` 现查 cwd/modeId 并 **portal 到 document.body**(侧栏的玻璃/transform 祖先会劫持 fixed 定位)。卡片取代行原生 `title` 气泡。两阶段入场(opacity 经 `--entered` 翻转、动画只动 transform)遵守 `.gui-menu-popup` 的 backdrop 规则;滚动(capture)/点击行/离行即收,跨行移动有 120ms 宽限。
- **design 预设空态**(设计稿 08 欢迎页对齐):design 预设 armed 时欢迎页输入框与会话 composer 同款——同一行风格 chips(`composer/design-styles.tsx`,共享 `DesignStyleChips` + `DESIGN_STYLES`)渲染在输入卡上方,点风格即写入 `design style brief update {style}` 句;placeholder 切为 `design empty placeholder`,不再轮播能力提示。模式 chip 背后的数据链:daemon `session.modes`/header → view-store `mode_id` 列(幂等迁移)→ `session.list` → app `sessionMeta` → 悬浮卡。

## 5j. 桌宠眼动、pet 头像预设与主题跟随色板(2026-09-19)

- **眼动跟随(gaze)**:builtin 球的眼睛现在跟着鼠标走——clawd-on-desk 同款能力,也是让球体丰富的状态设计真正值钱的那个交互。桌面桌宠由主进程**复用既有的 120ms 点击穿透轮询**顺带算好"光标相对窗口中心"的归一化向量(`pet:gaze`:420css-px 视距夹到 ±1,0.02 死区节流,零新增定时器)推给渲染进程;引擎以注意力缓动(220ms 渐入 / 380ms 渐出、120ms 滑动时间常数)把实时目标与自带的闲视漂移混合——"注意到你"但不抽搐,保留闲时性格;镜像态(挂靠左侧/拖拽翻面)在写入侧对 x 取反,视线永远对着真实光标。
- **Agent 头像 pet 预设 + 状态绑定**:设置 → 常规 → Agent 头像新增"桌宠小球"预设(`avatar-presets.tsx` `PetAvatar`)——把桌面那只球放进头像槽,眼睛同样跟随光标。该预设**退出空闲效果轮播**:表情直接绑定会话状态(`ORB_TO_PET_MOOD`:composing→working,searching/solving/shaping→analyzing,listening→rest)。缺状态才是真正的病根——头部与聊天视图此前各自用一份重复的三元式派生 orb、都漏了待审批;`orbFromSession`(lib/pet.ts)成为单一来源,有工具审批待处理时头像钉在新增的第 7 态 `waiting`(wave 动画,钉住不轮播——"暂停等你"),桌面桌宠同步切 waiting 表情。
- **主题跟随色板**:球体此前的石墨壳+品牌金配色只在默认金色主题下成立——ocean 蓝主题下金圈金眼配冷蓝球像三种凑在一起的颜色。现在壳/圈/眼/边缘光/眼辉的绘制全部从实时 `--accent` 派生:chroma.js 只负责解析 accent token,派生本身是纯 oklch 通道算术,值以 `oklch()` 字符串交付、由 Chromium 做色域映射(出 gamut 的亮 tint 保色相降色度)。`pet-palette.ts` 在启动时、data-theme/data-accent 切换时、以及桌宠窗口收到 `petActivity {theme, accent}` 推送时把 8 个变量(`--gui-pet-shell-a/b/c`、`--gui-pet-gold-a/b/c`、`--gui-pet-rim`、`--gui-pet-glow`)写上文档根。默认金色主题下与旧写死配色几乎重合(身份不变);mono 近中性 accent 经染色下限仍有色调。error 脸保留 `--color-danger`(球上唯一的红)。

## 5k. 桌宠交互轴、白脸与 footer 液态玻璃胶囊(2026-09-20)

本轮由四条用户反馈驱动:审批胶囊外圈有颜色、停靠球太大、球渲染成黑色而不是主题色、桌宠状态用得不够。

- **footer 胶囊统一为液态玻璃**(`gui-composer.css`):审批模式胶囊与设计风格胶囊共用**同一套配方**——`--glass-bg` 填充叠在 composer 框的磨砂面上、`blur(var(--gui-glass-blur)) saturate(var(--gui-glass-saturate))`,以及高光边(`--glass-edge-hi` / `--glass-edge-lo`)与 `::before` 上的对角 `--glass-sheen` 水光,按下走 `--spring-liquid`。**这圈边是 inset box-shadow,不是 border**——999px 圆角上真画 1px border 就会渲染出用户反馈的那圈可见环。(`--write` / `--yolo` / `--set`)状态保持同一玻璃面,只让**颜色**承载状态,切换模式不会改变胶囊的材质。
- **审批胶囊色圈是共享 class 的 bug**:`.gui-approval` 同时被审批**卡片**(`ApprovalCard.tsx`,它画 `--color-warning-soft` 是正当的)和 footer 胶囊(`approval-mode-button.tsx`)使用。卡片那条规则给无边框胶囊底下画了一整个警告色胶囊。修法是加 `--pill` 修饰类清掉 padding/radius/background(`padding: 0; border-radius: 0; background: transparent`),而不是把共享类改透明。**教训:改共享 class 前先 grep 全部使用点。**
- **停靠球尺寸**:`.gui-composer-pet` 的 clamp 从 `44px…60px` 收窄到 `34px…46px`。60px 时球比 composer 整行第一排还高,读起来像"粘在窗口上的一颗球";34–46 既在脸还能解析的区间内(眼胶囊 ≥4px、嘴描边 ≥0.75px),又明显从属于它所停靠的框。
- **黑球有两个成因**:(1) SVG 壳渐变的写死 fallback 是冷板岩色(`#4a5768/#26303d/#0e141c`)、不是 accent 派生——色板生效前的每一帧都画黑球;现在回落到达尔文本就该产出的深色 accent 石墨(`#7d7159/#453a24/#1c1408`)。(2) `app.tsx` 只在 `MutationObserver` 上推送 accent 色板,而它**首次加载从不触发**——桌宠窗口在用户换主题前收不到任何 accent。该 effect 现在挂载时也会先推一次。
- **脸在任何主题下都是白的**(`pet-palette.ts`):眼与嘴不再跟随 `--gui-pet-gold-a/b`。随主题变脸意味着 ocean 主题下蓝眼睛配蓝球,脸不再从壳上分离出来。白色守住了吉祥物唯一需要的可读性规则——**球上最亮的东西永远是脸**——主题则由圈来承载,一眼仍能看出配色。新增两个变量(`--gui-pet-face`、`--gui-pet-face-glow`),光晕是中性的所以永不染白脸。error 脸保留 `--color-danger`(唯一的那点红)。
- **眼动幅度**:`GAZE_TRAVEL` 从 13.2/8.4 提到 20.5/13.5(face 单位,眼睛环本身约 26 单位宽,±13 只像轻推不像注视),桌宠窗口的 `PET_GAZE_RANGE_CSS` 从 420 收到 260(视距过宽会把有效偏转带压缩进范围的头三分之一),头像预设的 `GAZE_RANGE_PX` 从 120 放宽到 150。
- **新增:桌宠交互轴**(`pet-face.ts` / `pet-motion.ts`):`PetInteraction` 是**第二条轴**——`startled` / `delighted` / `curious` / `dozing` / `peek`——刻意不并进 `PetMood`。`PetMood` 是 store 写入的会话契约;一次戳弄绝不能被持久化、必须按自己的时钟释放、并且要回落到实时 agent 状态。所以反应是**叠在状态之上**的:引擎按解析出的方向取数据,而 svg 同时带两个 class,好让状态那层的纯 CSS 材质(error 的红眼、hover 的增亮辉光)在反应期间不被重置。`INTERACTION_MOTION` 是全系统唯一允许"闹"的身体运动(戳弄类反应带 `enter` 过冲),因为它们由用户手势触发、约一秒内结束。
  - **composer 桌宠**:戳一下是 startled,900ms 内快速补一下变成 delighted——`ComposerPetState.pokes` 携带连击计数。hover 仍属状态(它是氛围不是反应);旧的拿 `dragging` 冒充戳弄已删除。
  - **桌面桌宠**:戳弄类反应保持 `POKE_HOLD_MS` 1400;新增两个闲时桥段——进入 60s 睡眠闩锁前 40s 开始 `dozing`(让入睡是渐睡而非硬切),以及每 12–26s 一次的 `peek`/`curious` "被抓包"桥段。反应会让位于实时手势与睡眠。
  - 测试:`test/pet-interaction.test.ts`(11 条)钉住这条轴的边界——数据成对完整、两轴名字不冲突、没有 mood 偷偷长出 `enter`、startled 不眨眼(惊到一半眨眼像在抛媚眼)、dozing 是全系统最慢的呼吸。

## 5l. 伙伴尺寸契约、装饰即配置与头像选择器(2026-09-20)

本轮由三条用户反馈驱动:重启后输入框上的小球**仍然**过大(但换任何其他头像都正常)、吉祥物积累了一堆没人要的装饰、设置页的头像行只能切换、什么都区分不出来。

- **输入框上的小球尺寸从来就不是 CSS 定的。** `PetSprite` 的内置分支在 `.gui-pet` 上写了 inline 的 `width: size * scale` / `height: size * scale * (VIEW_H / VIEW_W)`。**inline 样式优先级高于任何样式表规则**,所以 `.gui-composer-pet` 的容器 clamp(§5k 加的 `34px…46px`)**一直没生效**,小球按创作尺寸渲染——dock 在输入框上沿时就是"一个巨大的球卡在窗口上"。其他头像预设走的是 petdex 分支(`PetdexSprite` 自带帧几何)或手绘 `<svg>`,从不经过这条路径,这正是"换其他头像就正常"的原因。**教训:样式表规则看起来没生效时,先排查 inline 声明,再回头调规则。** 这个 clamp 是第三次修这个症状——前两次都在给一个被覆盖的 CSS 重新调参。
- **尺寸契约**(`gui-pet.css`):一个盒子,两种尺寸来源,而"关键的那个数"永远由宿主提供。
  - `width` 主导 → `.gui-composer-pet`(容器 clamp),高度由 `aspect-ratio`(`--gui-pet-ratio`,即 SVG 自身的 `VIEW_W / VIEW_H`)跟随。
  - `--gui-pet--h` 让高度主导 → `.gui-avatar-pet`(调用点传 `--gui-pet-size`:工具栏/顶栏 20、聊天 64)与 `.pet-window__pet`(`--gui-pet-window-scale`,即大小滑杆)。
  - `--gui-pet-fallback`(旧的 `size` prop,改为自定义属性透传)是宿主既不给宽也不给高时的兜底,保证形象永远不会塌成 0。**调用点绝不能再给 `.gui-pet` 写真实的 `width`。**
  - `PetAvatar`(聊天头像)采用高度主导还有第二个原因:转录网格为助手头像预留了 **40px gutter**,一个多余的 inline 64px 会溢出布局给它留出的那一列。**定尺寸的槽位必须由槽位来决定尺寸。**
- **装饰现在是配置,不再是默认**(`lib/pet-decor.ts`):
  - **整体删除**——地面系(`__thrust` 悬浮辉光、`__bounce` 底部反光、`__ground` 地面投影)与头顶信标(`__antenna-group` 及其 `gui-pet-antenna` / `gui-pet-beacon` / `gui-pet-halo` 三组 keyframes)。地面系描述的是一具**悬浮在地面之上**的身体,而伙伴 dock 在输入框边沿,那里根本没有地面:这些层会溢进缝隙,读作输入框下方的一条金色污渍。信标在任意 composer 尺寸下都细到不足一像素——一个孤立的金点。**不是默认关闭,是不再渲染。**
  - **保留,但做成可关闭开关**——`gloss`(`__gloss` + `__gloss-dot` + `__sweep`)。它是唯一在每个场景下都成立的装饰:它让一个扁平深色圆读作**被照亮的球**。关闭 → `.gui-pet-svg--flat` 只隐藏光影层;壳渐变、环绕轨道环、边缘轮廓光与白脸全部保留。
  - **留白收紧** `HEADROOM 40 / SIDE 26 / FLOOR 30` → `TOP 24 / SIDE 20 / BOTTOM 22`(约 1.28× → 约 1.04× 球径)。球在同样的盒子里变大,边缘也不再悬空。旧的 `margin-bottom` hack(为补偿"占位但被隐藏的天线"把 composer 盒子往上拉)随之删除。
  - 存储是**标志记录**(`musepi-gui-pet-decor`),**逐键降级**——格式损坏或更新版本写入的键只降级自己,不会把整个形象清空(`test/pet-decor.test.ts`,12 条)。`PET_DECOR_FLAGS` 是设置 UI 的生成来源——**加一个配饰(音符、耳机…)只需一条标志 + 两个 i18n key**,不需要手写新行。写入广播 `omp-pet-changed`,而 `usePet` / `usePetDecor` 本就监听该事件,所以开关会同时落到 composer、聊天头像与悬浮桌宠。
  - 作用域:装饰只存在于**内置矢量**形象上。导入的 petdex 精灵表是烘焙好的位图——该分组会明确说明并禁用开关,而不是静默无效。
- **设置页的头像选择器能区分选项了**(`gui-settings.css`):`设置 → 常规` 的 Agent 头像行原本是五个无标签的 38px 图标按钮,身份藏在 `title` 悬浮提示里,选中态是一条发丝描边——"只能进行切换"。现在是 `.gui-avatar-grid` + `.gui-avatar-card`:**32px 实时预览台**(小到能judge 出差异的尺寸;固定 40×34 槽位,让宠物的宽盒子与方形图标共享基线)、预设**名称**、以及选中项的**勾选**。伙伴设置页新增对应的**外观细节**分组。两处都复用 `.gui-pet-card` 的卡片语言,让两个头像界面读作同一套系统。(`.gui-avatar-opt` 保留给其他使用者——引导流程的个性化步骤,以及 git 设置里的用户头像来源选择器。)
- **滑杆对齐**:伙伴大小滑杆步进为 5%,而 `petScale()`/`setPetScale()` 存取并夹取整数百分比,导致存下的值与标签错位(`step=5` → 60/65/70…,却按 1% 的夹取范围读回)。改为 `step=1`。

## 5m. 配饰、用户 SVG 导入与桌宠窗口四 bug(2026-09-20 下午)

本轮由五条用户反馈驱动:头像小球变空白、桌面小球保持石墨色而非品牌金、面板裁切/遮挡角色、拖拽位置恢复偏移,以及——功能需求——配饰(音符/耳机)+ 用户 SVG 导入,参考 clawd on desk / blobstudio。

- **配饰是 pick-one 联合类型,不是标志位**(`pet-decor.ts` 的 `PetAccessory = "none" | "note" | "headphones"`):§5l 预言"一条标志 + 两个 i18n key",但穿戴物**互斥**——分段控件(`.gui-pet-accessory-picker`)不会漂移成组合衣柜,clawd-on-desk 的教训("一个状态一套完整动画,不是换贴图")同样适用于穿搭。绘制为 **rig 组内的静态画**(脸部之后):随球缩放、免费骑在身体运动上;两者都按 rig 留白创作(音梁顶点 y≈−4 对 TOP 24;音符杆 r≈112 对壳 R≈114)所以不裁切——头顶漂浮的挂件会复刻已删除信标的"孤立金点"问题,所以音符是**贴在壳面上的贴花**。存储仍是逐键记录;`asAccessory` 把联合类型外的值降级为 `none`。
- **用户 SVG 导入 = 单帧 petdex 包**(`PetdexPackage.format: "svg"`):渲染端文件选择(≤512KB、`<svg` 嗅探、带 viewBox 文本兜底的 Image 解码以对付无尺寸 SVG)存为 `format:"svg"`、`rows:[1]`、`contentH = height`——预设网格、触发器、composer 与桌面桌宠全部经**现有** PetdexSprite 路径渲染(`backgroundPosition` 钉在 `0 0`;行偏移会在 hover/拖行时把整张图移出盒子)。心情系统对单静态帧降级为 transform 行(bob/lift/wiggle),与缺行的精灵表一致。
- **头像小球空白**——`.gui-pet-svg` **自身没有尺寸规则**(gui-pet.css 用 `.gui-pet svg` 后代选择器定尺寸);任何不套 `.gui-pet` 包装就渲染精灵的调用点会塌成 0。该规则升级为组件:`PetBox`(包装器 + 两个变量),包装器从导出的 `PET_BOX_RATIO` 发布 `--gui-pet-ratio`——样式表字面量只作水合兜底,重调 VIEW 不再静默失同步每个宿主。
- **石墨球**——桌宠窗口从不加载 `tokens.css`,根上不存在 `--accent`,`applyPetPalette` 落到硬编码暖石墨兜底("黑色带点黄")。从源头修:`pet-window.css :root` 携带品牌金 `--accent` 字面量(主窗口的主题推送仍会覆盖它)。教训:**推送管线需要在接收端有正确默认值**,而不只在发送端。
- **面板裁切 + 遮挡**——`.pet-panel` 的 `max-height: calc(100vh - 180px)` 度量的是**它想让它变高的那个窗口**:高度上报量的是被钳住的盒子、只请求刚好的高度、窗口变高、上限跟着变大——恶性反馈循环收敛到一个约 112px 的矮面板(截图 3)。卡片现在**不带 max-height**;窗口才是约束(经 `pet-set-content-size` 向上生长,main.cjs 内按工作区钳制),`.pet-panel__body`(`min-height:0; overflow-y:auto`)是唯一 scrollport。第二处:面板开关订阅挂在 `[panelOpen]` 上重注册,落在拆卸/重注册交换窗内的点击跑的是**旧** handler——面板开着却"又开一次"、且关不掉。改为挂载一次、读 `panelOpenRef`。
- **拖拽位置偏移**——`persistPetPos` 存的是**浮层展开时变高的窗口**的左上角 `y`;按基础高度恢复会让宠物下坠"长高量",贴底边的矩形则直接过不了可见性检查(位置"被遗忘"→回落默认角落)。锚点改为宠物的**底边**(`bottom: (y+h)/dip`,恢复为 `y = bottom − base`)——精灵悬挂其上的不变量,与 `reconcilePetWindow` 保持的是同一个。命中盒上报加了覆盖浮层元素的 `ResizeObserver`(切 tab / 形变改内容尺寸而不改窗口尺寸;旧命中盒会让点击穿透轮询落错位置)。
- **去重(clawd pass)**:删除仍在描述已废弃气泡窗口的过时双窗口注释块(main.cjs 托盘段、bubble × 关闭处理器、桌宠窗口 backgroundColor 注、pet-main 开关文档)——描述不存在架构的注释比没有注释更糟。

## 5n. 语音输入交互:只承动效的麦克风按钮与输入框内状态条(2026-09-20)

本轮由三条用户反馈驱动:中文听写输出繁体、转录很慢且全程无反馈(按钮的状态在文字出现前就结束了)、以及麦克风胶囊"装不下那么多文案——更应该承载动效"。

- **30px 胶囊是动效预算,不是文案预算**(`composer/action-buttons.tsx` 的 `VoiceButton`):按钮只通过染色 + 脉冲(录音中)与 spinner(转写中)承载状态——秒数时钟、相位文案、取消提示永不回灌。控件装不下自己的反馈时,把反馈挪到装得下的地方;在胶囊里缩小字号读作坏了,不是紧凑。
- **反馈长在输入卡内部**(`VoiceStatusStrip`,composer children、textarea 上方——与错误胶囊同位):13 根 bar 的波形 + 秒数/「转写中…」+ Esc 提示。它是**整个转录等待期**唯一的反馈面——旧流程在录音一停就什么都没有了,文字在几秒死寂后"凭空出现"。经 `role="status"` / `aria-live="polite"` 播报。
- **波形纯 CSS**(动效标准 §3):共享一条 scaleY keyframes;每根 bar 的负 `animation-delay` 加略异的时长错相,不读作节拍器;真实麦克风 RMS 只经 `--voice-level` 调制条组透明度。无 JS 高度驱动,波形无 rAF 循环。
- **相位诚实**(`use-dictation.ts`):`idle → recording → transcribing` 单一真相源,用户一停就乐观进入转写相位——异步结果在途时控件绝不能渲染成 idle。转写中再 toggle 是真取消(旧 UI 只清自己的 flag,在途结果照样落盘)。

## 5o. 原文级吸收:状态轴说 blobstudio 的话,导入 SVG 成为完整伙伴(2026-09-20 晚)

本轮由一条方法论指令及其功能落地驱动:「我们以后不能靠语义来复刻,而是直接吸收源码——语义相似但效果千差万别,完整复现后我们的伙伴形象才精致完好」,以及让导入的 SVG 伙伴与内置球体支持同一套状态、特效与参数。

- **吸收,不是神似**:运动表、dash 飞行公式与 settle 时序全部换成源站的字面值,逐字对照反解出的引擎源码(注释完整)核验。"语义相似"的 sway 并排一看就是两种东西;数字完全一致,伙伴才读作同一物种的运动。数值由测试钉死。
- **状态轴天然 shape-agnostic——导入 SVG 伙伴直接继承**:此前 `format:"svg"` 的 petdex 包退化到 transform 行 mood;现在经 `PetdexStateStage` 渲染,获得与内置完全相同的 31 态运动、七类特效与 dots/glyph 身体消解,全部按 face-unit(228.541 盒)归一,任意宿主尺寸下比例不变形。这正是源站自己的契约:"an uploaded logo behaves exactly like the built-in circle"。
- **耳机是 AirPods Max,也是身体的成员**:白色阳极氧化板 + 玫瑰金轨/滑杆/Digital Crown,固定身份(从 accent 派生的配色会溶进金色壳;中间的炭灰版被读作秃头)。blobstudio 没有配饰系统——附属于身体的东西都活在身体组里——所以整套耳机住在 `bodyRef`:dash 飞行带着耳机,dots 消解连球带耳机一起化掉。旧炭灰头梁、滑杆、耳罩与麦克风臂全部移除(AirPods Max 没有麦克风臂;Crown 才是签名)。
- **特效层以兄弟身份夹住 rig**:后层轨迹被球正确遮挡,前层火花浮在上方,两层都不继承身体的 motion transform——尾巴要采样飞行路径,不是搭车在里面。

## 5p. 定制跟着预览走,挂靠小球长回来(2026-09-21)

本轮由三条用户诉求驱动:「这个小球的定制放到常规Agent头像那里去?」「挂靠输入框时的小球稍微大一点?」「耳机稍微大一点?」。

- **外观细节组住在预览旁边**:光泽开关 + 配饰选择器从伴侣页尾部搬到常规页 Agent 头像网格正下方。宠物头像卡就是活的 `BuiltinPetSprite`——拨动开关立刻在上方网格里读到反馈,而不是跑到另一个页面去看。组件自持状态(自己解析、订阅 `omp-pet-changed` 重解析),挂哪都成立;伴侣页保留形象选择/尺寸/导入。
- **挂靠球的上限跟着画走,不跟着历史走**:46px 上限定 box 还背着 ~1.28× rig 的年代;padding 卸掉后(box ≈ 1.04× 球)同一上限读起来偏小。上限 46 → 52,下限 34 → 38——仍低于当年"巨球"的视觉(那时 60px box 是 ~47px 球;现在 52px box 是 ~50px 球且无一物外溢)。
- **耳机作为整体绕球心缩放**(`HEADPHONE_SCALE` 1.08):耳罩、canopy 与轨是按一个刚体授权的,放大就是引擎每帧配件 transform 里的一次 scale——不是重新绘制。1.08 是所有极值都留在 rig padding 内的最大系数;尺寸与 gaze 倾斜搭乘同一属性,因为该属性归引擎所有。

## 6. 品牌图标(App Icon,2026-08-06 重设计)

- **源文件**:`packages/desktop-app/build/icon.svg`(1024×1024 画布,Python 脚本生成点阵坐标——23×23 网格)。构建产物:`build/icon.png`(1024×1024)+ `build/icon.icns`(iconutil 10 档 iconset)。
- **设计语言**:**点阵风格**——23×23 圆点网格(间距 24px),背景点淡(fg 9% 透明度,`r=4.2`)+ π 形状点亮(fg 暖白 `#ece8e9`,`r=7.6`);π = 3 点厚横梁(rows 3-5, cols 5-18)+ 3 列宽双腿(rows 6-19)。背景 = 主题深色微渐变(`#242128 → #1b191f`,`--bg` 系)。**配色只用主题色(fg + bg surface),零强调色/渐变**——与 WelcomeComposer 的 `DotMatrixMark`(点阵品牌背景)视觉语言同源,替代旧版"深底 + 粉紫青渐变 π"(花哨、与主题脱节)。
- **卡中卡布局(2026-08-06 实测 kimi 对齐)**:图标 = 深色卡占 tile **80.5%(824/1024,四周对称 100px 透明边距)** + 卡角 superellipse n=5 圆角——与 Kimi 桌面 app(`/Applications/Kimi.app` 的 icon.icns 实测 alpha bbox x100-923,80.5%)完全一致。**Dock 里"我们图标比 kimi 大"的根因**:此前全出血 100%,kimi 卡中卡 80.5%;92% 内缩版仍 >80.5%("始终大一点")。全出血 1024 + 系统遮罩是 Apple HIG 基线,但**与邻位 app 视觉统一优先于 HIG 抽象规范**——kimi 实际就是卡中卡,我们要并排同大。
- **三处同步**:`build/icon.png`(打包源)+ `build/icon-dock.png`(dev Dock setIcon)+ `src/vendor/logo.png`(splash/内嵌,512 同参数);打包版 icns 同样带 80.5% 卡边距(不重打包则 bundle icns 手动同步)。
- **改动流程**:改点阵参数(网格/π 形状/点径/配色)→ Chrome headless 渲染 1024 PNG → 套 80.5% 卡中卡 + superellipse 切角 → 重生成 iconset + `iconutil -c icns` → 替换 build/icon.png + icon.icns + icon-dock.png + src/vendor/logo.png(+ release bundle 的 icns)→ **手动同步 bundle icns 后必须重签**(`codesign --force --deep --sign - release/mac-arm64/MusePi.app`——签名后改资源会失效,CSDN 4.3 坑)→ `bun run pack:dir` 重打包(dev 模式 Dock 图标走 `app.dock.setIcon(build/icon-dock.png)`,打包版用 bundle icns——**只换 png 不重打包,打包版 Dock 仍是旧图标**)。

## 7. 图标 morph 与色彩管线（定稿 2026-09-18）

### 图标 morph 三则（StateIcon，规范板「图标 morph 规范与缺口清零」）

- **形状互换 → `<StateIcon on pair>`**（`components/StateIcon.tsx`）：凡随运行时状态翻转的图标对（play/pause、eye/eye-off、展开/收起、已存/下载、面板方向、全屏切换）一律弹簧交叉形变而非硬切换。两个形状常驻 inline-grid，出场收缩（scale .4 / −90° / 120ms fade）同时入场从对侧长出，`--spring` 计时。纯 CSS 是刻意的：`.gui-motion-off` / `prefers-reduced-motion` 全局降级零接线。已迁移 29 处（commit d55086d6d）；三态类别图标保持普通 `<Icon>` + TODO(P1) n-ary 变体。
- **同形旋转 → 保持 transform**：chevron 旋转 180° 不是图标变化——旋转本身是最短路径。只旋转的不 morph。
- **渲染期选型 → 普通 `<Icon>`**：按静态事实（条目类型、配置）选的图标永不 morph——没有状态翻转可言。
- **为什么 sprite 世界不直接用 MorphIcon**：`MorphIcon`（morphicons）渲染单条 stroke 插值路径（lucide 语言）；全应用 sprite 是 fill 造型（Remix 系 `<use>` 形状）。路径形变会把实心图标变描边轮廓——StateIcon 是 sprite 世界的同读感等价物。stroke 图标（引导页步骤图标）直接用 `MorphIcon`。
- API：`<StateIcon on={cond} pair={["开时图标", "关时图标"]} className="h-4 w-4" />` —— `on` 为真显示 `pair[0]`。

### 色彩管线判定（chroma.js PoC，规范板「色彩管线 · chroma.js 评估」）

- **chroma-js（guest-client）负责**：自定义强调色派生（`theme.ts deriveCustomAccent` —— OKLCH hover ±0.07 远离静止态、降 chroma 色域钳制、按对比度选前景）与 ColorPicker 未来的对比度门禁（chroma.contrast，WCAG）。冷路径：仅 accent 偏好变更时调用（约 19KB gzip，一次调用，非逐帧）。
- **CSS `color-mix(in oklab, …)` 负责**：全部逐帧运行时混色——原生零成本，已有 60+ 处。那里永远不要上 JS 库。
- **tokens.css 手调 oklch 值负责**：静态真相（预设、表面、图表色）。不要用脚本生成它们——这些值本身就是设计决策。
- **回归锁**：`packages/guest-client/test/derive-custom-accent.test.ts` —— 8 组强调色 × 双主题 accent-fg ≥ 4.5:1；旧 sRGB 派生在品牌金上只有 2.2:1。
