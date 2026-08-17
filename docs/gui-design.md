# MusePi GUI 设计规范

> 状态:**活文档**(2026-08-06 建立)——规定 `packages/gui` / `packages/collab-web` 的**设计风格与交互标准**(长什么样、怎么动、怎么组织)。与实现同步,实现文件为准。
>
> 实现契约、daemon RPC 形状、踩坑记录与验证方法见 **`docs/gui-implementation.md`**(2026-08-06 从本文件拆出)。早期线稿/架构稿(gui-prototype / gui-architecture / gui-migration)已删除——实现早已交付,以本文档与 gui-implementation 为准。
>
> 修改约定:改实现时同步本文件;发现本文档与代码不一致时,以代码为准并更新本文档。

## i18n 契约(collab-web/src/i18n)

- **命名参数**:`t("… {count} …", { count: n })`——不用 `{0}` 位置参数(openchamber/opencode/bitfun/kimi-code 全部命名参数,翻译可读性好;位置参数是 musepi 旧做法,2026-08-06 全量迁移)。
- **类型化 key**:`TranslationKey = keyof typeof zhCN`(zh-CN.ts `as const`)——`t()` 的 key 与 params 都编译期检查:key 拼错、占位符名写错、漏传参数 → tsgo 报错。动态 key(schema 驱动 label、运行时错误串、`tag.${…}` 拼接)显式 `as TranslationKey` 断言——运行时仍走 `?? key` 原文回退。
- **占位符类型**:`ParamsOf<K>` 用模板字面量类型从 zh-CN 值提取 `{name}` 并映射为 `{ [name]: string | number }`——参数名与翻译模板强绑定。
- **en passthrough**:key 即英文原文;替换作用于最终字符串(dict 命中或 key 回退都替换)——英文 UI 显示 `context · 42%` 而非 `context · {pct}`。
- **测试**:packages/collab-web/test/i18n.test.ts(查找/替换/回退/英文 passthrough/无位置参数残留断言);测试内 setLocale 必须 afterAll 恢复初始值(bun test 同进程顺序执行,泄漏会污染其他断言英文文案的测试)。
- **类型化副作用**:类型化强制所有 UI 文案有 zh 翻译——迁移时补了此前 passthrough 的键(open sidebar/connected/unknown/jump to bottom 等);`as const` 场景(PREFERENCE_LABEL、KIND_TRANSITION、SCALAR_ARGS、TIP_KEYS、SOUND_USAGE_KEYS)用 `as const satisfies Record<…, TranslationKey>` 或显式 `Partial<Record<…, TranslationKey>>` 让动态索引保持字面量类型。
- **渲染时调用**:`t()` 只在渲染期调用(模块加载期调用会拿到旧 locale——已有注释约束)。

## 1. 布局体系

- **三栏 shell**(openchamber 共识布局):左 SessionSidebar(会话/分组/项目)+ 中 ChatView(消息流 + 圆角 composer)+ 右 ContextPanel(始终可见)。`gui-shell` 是 flex ROW——每个全宽 pane(SettingsView 等)必须 `flex:1; min-width:0`,否则塌缩到内容宽。
- **设置面板**:全窗口替换工作区,左导航 + 右内容(`gui-settings-content` 固定高度滚动容器,`width:100% + max-width:840 + margin-inline:auto` 居中列)。
- **扩展控制中心**(设置「扩展」tab):section 占满设置视口(`gui-skills-section` = `height:100%` flex column,`gui-ext-center` `flex:1; min-height:0`)——左列表(`gui-ext-list-scroll`)与右详情(`gui-ext-detail`)在各自圆角容器内**独立滚动**,设置页整体不滚(TUI /extensions 面板 parity);两栏统一细滚动条(8px、thumb `text-faint 30%`、hover 50%,与 xterm 同配方);指令内容不限高(pre 无 max-height),随详情区整体滚动,避免嵌套滚动。
- **空态**:WelcomeComposer 大输入框(品牌/问候/提示 + composer),输入即建会话;专注模式(⌘⇧E)输入框铺满。
- **消息流**:复用 collab-web `tr-*` 类;用户消息右对齐圆角气泡,助手消息全宽无气泡;40px gutter 放头像。

## 2. 设计 token 与主题

- **三条正交轴**(DOM 层永远是已解析值,无 "system"):`data-theme`(light/dark 已解析)+ `data-accent`(强调色预设)+ `data-ui-theme`(独立浅/深主题预设)。
- **密度**:`--gui-density` 是**无单位系数**(如 `1`/`0.85`),CSS 用 `calc(32px * var(--gui-density, 1))`。
- **圆角**:`--radius-lg` 等阶梯;卡片统一 `border: 1px solid var(--border)` + `background: var(--color-surface-raised|sunken)`。
- **字体**:UI 默认 serif + 打包的 Maple Mono NF CN(等宽);变量字体 Inter/JetBrains Mono 在 `@fontsource-variable/*`。代码块字号走 `--gui-code-size`。
- **玻璃**:`gui-vibrancy` IPC + CSS `--gui-glass-overlay` 透明度;窗口透明度开关关=100% overlay 覆盖所有半透明规则。

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
- **TUI 设置同步(2026-08-11,合并进既有 tab)**:TUI 设置面板 10 个 tab 的 **336 项配置全部并入桌面设置**,不设独立"TUI 设置"页——**有对应 tab 就合并,没有就新增 tab,需要更名的更名**:外观(并入,原生主题卡 + schema 30 项)/模型设置(并入,角色模型 + schema 44 项)/任务与子智能体(原"子智能体"更名,并入 tasks 28 项)/新增 交互(41)·上下文(27)·Shell(16)·工具(60)·供应商(36);文件与 LSP、记忆 保持独立 schema section。全部 **schema 驱动**(daemon `settings.schema` RPC,与 TUI 同源)。控件:boolean→toggle / enum→select(无 options 的 enum 由 daemon 合成)/ string→input(凭据掩码保留)/ number→input / **array→逗号分隔输入(blur 提交)** / **record→紧凑 JSON 输入(非法 JSON 内联报错,不提交)**;改动 `settings.set` 乐观写入、失败回滚。条件门控 CONDITIONS 与 TUI settings-defs 对齐(11 个;`hasImageProtocol` 在桌面恒真)。**i18n 全量中文**:从 coding-agent i18n 移植 966 条翻译进 collab-web zh-CN(标签/描述/选项/分组;模型/供应商/音色等专有名词保持原文,与 TUI 一致);未覆盖项回退英文。行为抽查:textVerbosity low≈150 字 vs high≈250 字(GUI→daemon→会话行为链路生效)。**重复定义审计修复(2026-08-11)**:①语言单源——`settings.locale`(config.yml)为唯一源:boot 经 `settings.get` 同步渲染器 locale(daemon 对未配置的 `settings.locale`/`defaultThinkingLevel` 不回填 schema 默认值,防止未配置时把中文 UI 强制切英文),常规语言 select 与交互 tab「界面语言」行均双写 RPC + localStorage 镜像;NAV_GROUPS 改渲染期求值(原模块级常量冻结首语言);②思考层级——删除 `omp-gui-default-thinking` localStorage 镜像,WelcomeComposer 预选改为 boot 快照:`modelRoles.default` 的 `:level` 后缀优先(off→关闭思考),否则回退已配置的 `defaultThinkingLevel`(auto 允许),未配置保持 medium;boot 同时剥离后缀给模型预选;③`options:"runtime"` 的 schema 行(theme.light/dark)GUI 渲染为只读输入(防键入非法主题 id 写坏 config.yml),提示「选项由 TUI 运行时提供」。**导航去重合**:「智能体」更名「运行中智能体」(实时 roster,agents.list 2s 轮询)与「任务与子智能体」(tasks schema 配置)明确区分——两者内容本不重叠,命名消除混淆。**设置页 roster 全面移除(2026-08-11)**:「运行中智能体」设置 tab 与「任务与子智能体」内嵌 roster 均删除——live roster 由会话右栏 ContextPanel 的 AgentsPanel 承载(session stream 驱动的实时 HUD:主/子行、状态、活动、相对时间、进度/生命周期,比 agents.list 轮询更丰富);设置页回归纯配置语义。swarm GUI 盘点(对比 kimi-code apps/kimi-web):kimi 有转录内联 SwarmTool 卡片(成员手风琴+阶段点+概览条+done/total)、AgentDetailPanel 详情面板(暂停原因/流式输出/进度组)、ChatDock+TasksPane 底部 dock;我们现有右栏 AgentsPanel HUD + task/yield 工具卡片渲染 agent results,无转录内联 swarm 卡片、无详情面板。**task 工具卡升级为 SwarmTool 级(2026-08-11)**:头部 done/total chip(聚合失败红显)、body 顶部阶段概览(分段条 done/merge-failed/running/failed/aborted 五段 + legend)、成员行首阶段色点(running 脉冲)、每成员手风琴(点击 chevron 展开完整输出/错误/patch;已结束成员默认折叠,有详情才渲染 chevron);数据全部来自既有 TaskToolDetails.results/progress,无新数据管道。SSR 6 测试 + CDP 实测(2/2、3/3 chip、ok/run dots、chevron 展开 alpha 输出)。后续打磨:无内容的任务清单行(只有 #N 无 description)不再渲染空行;live/settle 时 AgentProgress 高级字段(retryState/extractedToolData/inflightTaskDetails)尚未消费。

**桌面子代理操作(2026-08-11, TUI Agent Hub 对等)**:daemon 新增 RPC `agents.kill`(abort + release tombstone→aborted)/`agents.revive`(ensureLive)/`agents.chat`(ensureLive + prompt steer,与 collab host 的 agent-cmd 同构,server.ts agents.list 旁)。GUI 右栏 ContextPanel 的 AgentsPanel 选中行后渲染 AgentControls 操作条(gui/src/components/AgentControls.tsx):running→停止、parked/aborted→复活、chat 输入框(Enter 发送),错误小字展示。collab guest 走 agent-cmd 帧,桌面走 RPC——两条路语义一致。SDK events.ts 的 agent-progress payload 注释修正为 SubagentProgressPayload 包装(daemon 实际发送形状)。RPC 实测:kill idle→{ok}+ref aborted、kill/revive 错误路径、chat→ensureLive+steer 生效;running 态 kill 时序窗口未抓到(step-3.7-flash 子代理完成过快),abort 路径与 collab host 同构。**i18n 补全**:schema 全部 UI 字符串覆盖 100% 可译项——标签/描述/选项标签/选项描述全量中文(新增 ~240 条手译,复用 coding-agent zh 78 条),仅剩专有名词(模型/供应商/音色/硬件/API key 名/数值)保持英文与 TUI 一致;zh-CN.ts 经 biome --write 全量格式化。
- **设置键名**:一律 `omp-gui-*`(如 `omp-gui-chat-usermsg`、`omp-gui-statusbar-indicator`);类开关类偏好(如 `gui-chat-hide-time`)在 documentElement 上切换,样式写在 gui.css 的偏好区。
- **预览模式**:配置项带实时预览(效果预览/聊天预览)——复用**真实渲染组件** + 示例内容,选项状态驱动;不要造静态假预览。
- **状态条**:braille/球体指示器(`--gui-status-accent` 会话色,TUI djb2 哈希移植)+ 流光/KITT/简洁文字效果;KITT 是文字渐变亮带(非独立条);扫光颜色可选默认色调/强调色。
- **输入框**:Composer/WelcomeComposer 共享 `autosize`(data-focused 感知);专注模式 morph 必须用 `useLayoutEffect`(passive effect 会先画一帧全宽再回跳)。
- **右键菜单(统一标准组件)**:所有悬浮右键菜单(会话/分组/项目块/列表项)一律用 `ContextMenu` 组件(`.gui-context-menu`,磨砂玻璃:bg-overlay + blur(24px) saturate(180%) + 分层阴影 + 130ms gui-menu-in/out,portal 到 root)——**不另造菜单样式**;条目 = 图标 + label + 可选 hint/divider/danger/disabled/color 圆点(分组颜色选择器用 `color` 属性 + `gui-dot`)。操作入口归属:会话=固定操作;分组=重命名/颜色/删除;项目块=打开 Finder/复制路径/移除项目(移除入口在右键菜单,不单独放行内删除按钮)。**行内编辑**(如分组重命名)用专用紧凑类(`.gui-group-edit`:13px/500、line-height 20px、padding 1px 4px、透明底 + accent 55% focus 细边)——全局 `.gui-input`(8px padding + 边框 ≈ 38px 高)会让行内编辑态膨胀突变,禁止用于行内重命名。
- **浮层菜单必须两阶段进入**(2026-08-06 关键修正):`ContextMenu` 与 `Pop` 挂载时先以 **opacity 0 无动画类**上屏,下一帧(rAF 双跳)再加 `--entered`/`--pending` 类启动 `gui-menu-in`——`useFloatingMenu` 早已如此。原因:**挂载即动画(带 transform scale 的 gui-menu-in)会让 Chromium 在真实屏幕合成器上跳过 backdrop 采样,菜单渲染成普通半透明(背后内容直接透出,无磨砂)**;CDP 截图(offscreen 合成)仍显示模糊,极易误导验证(曾误判为"transparent 窗口 blur 全失效"并错误地用 95% scrim 覆盖全部浮层——已回退,切勿再犯)。实现:`.gui-context-menu{opacity:0}` + `.gui-context-menu--entered{opacity:1;animation:gui-menu-in}`;Pop 复用 `.gui-menu-popup--pending/--entered`,**Pop 调用方类(openin/instance/header-title/overlay/creds/view/add-project/proj)不得自带 animation**(已移除,由 --entered 统一提供)。验证必须用真实屏幕截图(screencapture -l),CDP 截图不算数。
- **全浮层两阶段统一(2026-08-11)**:新增共享 hook **`useTwoPhaseEnter(active)`**(`lib/use-two-phase-enter.ts`,返回 `--entered` 后缀)——Board 放大(`gui-board-focus`)/小组件任务(`gui-task-modal`)/引导遮罩(`gui-onboarding-backdrop`)/⌘K 命令面板(`gui-palette`)/选区工具条(`gui-select-pop`)此前是**条件挂载 + 挂载帧直接播 `gui-fade-in`**,属 §6.5 风险类(纯 opacity 的轻度变体,未实测失效但违反契约),现全部接入。配套:命令面板改**常驻挂载**(app.tsx 不再条件渲染,`visible`/`closing` 内部状态,退出播 `gui-menu-out` 130ms + backdrop 渐隐);选区工具条补齐入场/退场(`gui-select-pop-in/out`,keyframes 必须烤入内联 `translateX(-50%)`——transform 动画覆盖静态 transform);base 规则统一 `opacity:0` + `--entered{opacity:1;animation:…}`,使 `gui-motion-off` 自然退化为瞬现(无需逐类列 motion-off)。**类名组合陷阱(2026-08-11,5/5 初版全踩)**:基类是 fixed/居中/blur 的唯一来源,必须**保留基类 + 追加完整 BEM 修饰 token**——`gui-foo${entered ? " gui-foo--entered" : ""}`。两种错误拼接:①`gui-foo${entered}` → 只有 `gui-foo--entered`,基类丢失 → 浮层落进文档流(引导卡实测 x=280 y=0,跟在侧栏后);②`gui-foo --entered`(空格直拼后缀)→ 孤立 `--entered` 类不匹配任何选择器 → 永远 opacity:0 不可见。CDP 量 `getBoundingClientRect` 验证:backdrop `position:fixed inset:0 opacity:1` + 卡片 centerDelta [0,0]。
- **首次启动引导居中悬浮(2026-08-11)**:ZCode 两栏卡居中悬浮——`min(1000px, calc(100vw-160px)) × min(620px, calc(100vh-160px))`(每侧 ≥80px 磨砂边,20px 圆角 + 24px 阴影)。**绝不是全屏贴边**:用户实测反馈近全屏(40px 边)右/上贴到软件边缘、整体过大;引导层必须让四周磨砂羽化遮罩明显可见,才有"悬浮在软件顶层"的观感。card `flex column` + grid `flex:1` 撑满高度,左栏内容底部对齐(圆点 `margin-top:auto`),右栏渐变面板内垂直居中示意动画。**三个步骤的示意窗口统一 280×190**(此前 236×168 / 244×155 / 244×120 三档,切换步骤右栏会跳变;chat/settings 用 `justify-content:center` 在固定盒内垂直居中内容)。
- **浮层卡面单层归属(2026-08-15,ColorPicker 双画教训)**:`useFloatingMenu` 的 `className` 落在 portal 外层——**菜单类**(proj/todo/queue/creds…)传 className、外层当卡面,内容必须是**无卡面的平铺元素**;**面板类**(quota/context/color-picker)组件根自带卡面 class,调用方**不得再传 className**。同一卡面 class 同时出现在两层 = 背景嵌套双画圆角磨砂容器(内容后面多一层圆角玻璃)。判定:DOM 里卡面 class 只出现一次。
- **点阵品牌背景**(`DotMatrixMark.tsx`,WelcomeComposer 背后,kimi 参考增强版 2026-08-06):文本栅格化为全矩形点阵——背景点淡(fg 8%)+ 文字点亮(fg)+ ~2% 彩色 accent 点(5 色板)**HSL 色相缓慢流动**(sin 偏移 ±0.12,每点独立相位)+ **羽化边缘**(文字 bbox 外 42px smoothstep 衰减,半径/透明度随距离渐隐,无硬矩形边界)+ **点击涟漪**(pointerdown 生成波前,0.55px/ms 外扩、26px 带宽内径向脉冲推点 + 放大,900px 后消散)+ 呼吸 + 鼠标 halo(吸引放大/active 变色)。**i18n 字体适配**:CJK/JP/KR 自动换字体栈(PingFang/Hiragino/Noto…)。**字形参数(2026-08-06 调优)**:`gridGap 7` + `dotRadius 2.0` + `600` 字重 + 140px 短文本阶梯(>6 字 115、>10 字 85;CJK >4 字 120、>8 字 90)——实测每字符 ≈ **11 列**(比 kimi 参考 140@8 的 ~9.6 列密 ~15%);字重 700 时 M 斜线栅格化成实心块(读作笨重方块),600 保留像素阶梯,经典点阵 M;`fontSize` prop 可覆盖(设置预览传 96)。mark 定位 `top: 17%` 让文字底缘(≈235px)保持在品牌行顶(≈242px)之上。IntersectionObserver 离屏暂停。
- **自定义与预览**(设置 → 常规):`omp-gui-dotmatrix` 开关 + `omp-gui-dotmatrix-text` 自定义文字(默认 MusePi,≤24 字符,欢迎页与预览实时联动,事件 `omp-dotmatrix-changed`);预览 = 同组件小字号实例(`fontSize={96}`)在 `.gui-dotmatrix-preview`(744×170 圆角卡)内,**必须给预览 canvas 设 CSS 尺寸**(`width/height: 100%`)——组件只设像素缓冲不设 CSS 尺寸,无样式时 canvas 按缓冲尺寸显示(300×150×dpr),文字被 2× 放大且贴左上被容器裁剪(欢迎页 canvas 有 `.gui-welcome-mark` inset:0 所以没这问题)。

### 伙伴(Agent Companion,BitFun parity,2026-08-06)

- **预置**:10 个内置 Petdex 预置(`src/lib/pet.ts` 的 `BUILTIN_PETDEX`,sprite 在 `public/pets/`,768×936 = 8×9 网格,96×104 帧,来源 BitFun MIT)。设置页网格按「已导入 → 预设」分组;卡片 = rest 帧缩略图(`zoom: 0.66` 缩放,不裁 transform 动画)+ 名称 + 描述 2 行截断;选中卡 accent 边框 + 14px check(`gui-pet-card__check` 必须显式 width/height——Icon 组件无默认尺寸,漏写会渲染成 219px)。
- **形象选择**:`.gui-pet-trigger` 行显示当前伙伴缩略图 + 名称 + 箭头(展开翻转);预览缩略图用 `zoom: 0.55`。删除按钮只出现在导入卡,hover 显现,`stopPropagation` 防选中。
- **渲染形态**(PetSprite.tsx + gui.css):`.gui-petdex-sprite` 必须 `image-rendering: pixelated`;帧循环 + 每 mood 一个 transform 动画(`PETDEX_MOOD_ANIM`:rest 2.4s+breathe、working 1.16s+work bob、hover 1.44s+lift、dragging 0.96s+wiggle),两者同时挂同一元素(不同属性不冲突);mood 行映射 rest=0/hover=1/dragging=2/error=5/waiting=6/working=7/analyzing=8。
- **尺寸归一化与大小调节**(2026-08-06):所有 Petdex 形象按 **rest 行内容高度统一渲染**(`PET_CONTENT_TARGET_H = 100`,k = 100/contentH)——导入包的帧尺寸各异(Doraemon 192×208 vs 内置 96×104),不归一化会 2 倍大小、阴影溢出画布。contentH 来源:内置走 `BUILTIN_PETDEX.contentH`(实测写死),导入包 import 时 `measurePetdex()` 测量,旧包由 `migratePetdexContent()`(usePet 挂载时)自动补测回写。**伙伴大小滑块**(设置 → 伙伴,`omp-gui-pet-scale` 60–150%,默认 100)乘在归一化之上;桌面宠物窗口由主窗口桥 `pet-activity {scale}` 推送(跨窗口 localStorage 不可靠),输入框内宠物直接读 pref。
- **窗口与阴影边界**:宠物窗口 320×290(`PET_WINDOW_SIZE`),宠物锚定 `bottom: 52px`(帧 [134,238],偏上更居中)——**必须给 drop-shadow 留足辐射空间**(rest 0 6px 16px ≈ 22px → 30px 余量;hover 0 10px 22px ≈ 32px + bump ≈ 2px → 18px 余量),否则阴影在窗口底边被硬切(割裂感)。**气泡/面板已迁出 pet 窗口**(双窗口,见下)——气泡栈 `bottom: 174px` 等 pet 窗口内定位规则是单窗口时代遗留,仅 legacy 保留。
- **气泡栈(双窗口,2026-08-11 更新)**:最多 5 条(`MAX_VISIBLE_BUBBLES`)、最新在上、打字机逐条显示、× 关闭、8s 自动消失;**iOS Notification-Center 折叠形态**——折叠时只显示最新一条 + 「N more」chip,点击展开完整列表;折叠↔展开是**宽高双轴 morph**(320ms overshoot,`stackMorph` 同时过渡 width+height,窗口经 RO report 逐帧跟随);深色圆角气泡 + 边框 + 轻阴影。气泡渲染在 **bubble 窗口**(`.pet-bubble-window`,内容驱动尺寸),不再悬浮在 pet 窗口内。
- **交互面板(双窗口,2026-08-11 重写)**:点击宠物切换 bubble 窗口内的面板(单窗口时代是 pet 窗口 resize 320×290→340×540,已废弃)。面板 = 实时任务摘要(working/idle + 当前工具 + 最近消息 ≤80 字,1s 节流推送 + 打开时即时快照)+ 审批卡(question 气泡带 requestId → 批准/拒绝走主窗口 `tool.approve/deny`)+ 快捷回复(有会话 steer/followUp,无会话 createSession 首条消息,同欢迎页语义)+ 会话标题 + ↗ 打开主窗口按钮 + tab(消息/最近会话)。面板 316px 固定宽、flow + margin 居中(非 absolute,`transform: none`);**入场 gating(宽度先行,2026-08-11)**:面板 mount 时 `opacity:0` 不播动画,等 bubble 窗口 resize 到面板尺寸(`resize` 事件,120ms 兜底)再播 `pet-panel--in` 入场——否则 316px 面板在气泡堆宽度(~140px)的窗口内被裁剪,"先露右半再突现左半"(实测根因);入场用**无水平位移的 flat keyframes**(`pet-panel-in-flat`:仅 translateY(10px)+scale(0.98)+blur)——legacy keyframes 烤的 `translateX(-50%)`(absolute 居中残留)在 flow 布局下把面板左移半宽,同样造成"右半先"。面板 i18n(locale 经 `pet-activity {locale}` 推送)。气泡在面板打开时隐藏。

## 5. i18n 与音效

- **i18n**:文案 key 即英文回退,zh 翻译在 `collab-web/src/i18n/zh-CN.ts`;`t()` 调用点渲染(模块级 const 不随语言切换)。数字/时间格式化显式传 locale,禁依赖浏览器默认。
- **音效(2026-08-07 活动化改造)**:cuelume(Web Audio 合成,14 个 recipe);统一经 `gui/src/lib/sfx.ts`:
  - **活动分类配置**(opencode per-category sounds parity):10 个活动(`SFX_EVENTS`)——发送消息/首次消息/消息完成(agent_end,stopReason 非 aborted/error 才响)/审批请求/审批通过/审批拒绝/切换会话/停止回合/工具结果/错误;每类可换音色(`soundFor`/`setSoundFor`,持久化 `omp-gui-sfx:<event>`,无效值回退 `DEFAULT_SFX`)。
  - **调用点用 `sfxFor(event)`**(app/Composer/WelcomeComposer/ApprovalCard/session-store),不再直接 `sfx(name)`(保留给一次性/预览);总开关 `omp-gui-sound` gating 全部。
  - **消息完成挂 agent_end 而非 turn_end**(2026-08-07 修正):turn_end 每轮模型调用都触发(多工具任务连响),且中止时与 stop 音叠加——agent_end 每 run 一次。
  - **设置 UI**:通知与音效 tab = 每活动一行(名称 + 触发说明 + 默认音色)+ 音色下拉 + ▶ 预览 + 14 色 palette 网格(`ALL_SOUNDS`/`WIRED_SOUNDS`/`previewSound`);新触发点接入后同步 WIRED_SOUNDS 与中文用途文案。
  - **验证坑**:cuelume 有 `navigator.userActivation` 浏览器策略 gate——CDP 合成输入不产生真实激活,音效播放无法自动化验证(配置读取/持久化可测,播放需真实点击)。

## 5b. 动画与库选型(2026-08-07 评估)

- **原则:CSS 优先 + 自研 hook**。现有动效体系全部手写 CSS/JS(Reveal/HeightMorph/useCollapse、BorderBeam、DotMatrixMark、ThinkingOrbs、KITT 扫光、两阶段浮层、宠伴帧动画)——桌面 GUI 的动效需求是"精致克制的 UI 反馈",CSS transition/keyframes 足够且零运行时开销、天然尊重 `prefers-reduced-motion`(`gui-motion-off` 偏好)。
- **已用第三方**:`cuelume`(音效)、`lucide-react`/`lucide`(图标)、`morphicons`(Composer 发送/停止图标 morph)、`beautiful-mermaid`(collab-web Mermaid 渲染)、`@xterm/xterm`(终端)、`pdfjs-dist`(PDF)。**motion(原 Framer Motion)曾依赖但零引用——已移除**(2026-08-07)。
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

## 5e. 弹窗、键盘与选择器(2026-08-14 定稿)

### 弹窗动画与键盘优先级

- **DialogFrame 契约**:宿主**无条件渲染** + `open` 驱动(`{x && <DialogFrame/>}` 条件挂载会丢退出动画——180ms closing 相位);prompt/confirm(`lib/prompt-dialog.tsx`)同款两阶段 enter + closing,`finish()` 延迟到退出动画完成后才 resolve promise。
- **模态持有键盘**:DialogFrame 打开时在 `document` **capture 阶段**监听 Esc → onClose(赢过背后 handler,composer 不再吞 Enter 发消息),焦点移入弹窗第一个可聚焦元素、关闭后恢复;confirm 框 Enter = 确认(焦点落在确认按钮);引导面板 Enter = 下一步(输入框聚焦时保留输入框自己的 Enter)、Esc = 上一步/第一步关闭,面板打开即聚焦;公告面板 Esc = 关闭。
- **紧凑弹窗**:小内容确认框用 `gui-dialog--confirm`(auto 尺寸 + max-width 380 + 22×24 padding)——基类 `.gui-dialog` 是 600×420 设置框,desc+两按钮装在里面读起来是坏的(看板删除/新建项目/定时删除均踩过)。
- **hooks 铁律**:所有 hook 声明必须在**任何早退 return 之前**(`if (!open) return null` 之后的 hook 会在 open 切换时崩 "Rendered more hooks than during the previous render"——AnnouncementOverlay 回归实测)。

### 模型选择器(provider 复合键)

- **模型身份 = `provider/id`**,绝不是裸 id——两个供应商可提供同裸 id(opencode-go / opencode-zen 都出 `deepseek-v4-flash`):收藏(`omp-gui-fav-models`)、DEFAULT 图钉(`modelRoles.default`)、选中态、角色行赋值全部按 `provider/id` 键控(旧裸 id 条目兼容匹配、toggle 时清理);`session.setModel` 携带 `provider` 让 daemon 精确解析(daemon 侧 provider 限定查找已加)。
- **composer/欢迎页**模型菜单行 = 模型名 + provider 徽标 + 收藏星 + **DEFAULT 图钉**(target 图标,当前默认实心)——点图钉即写 `modelRoles.default`(设置页 DEFAULT 角色同键,两边一致);菜单 min-width 260 / max-width 344。
- **角色思考等级动态**:角色行 thinking select 渲染 `resolvedRoleModels[role].efforts`(daemon `getSupportedEfforts`,模型无 thinking 支持则为空)——绝不固定七档;每次角色模型变更经 `applyRoleModels`(set 成功后重拉 resolvedRoleModels)让"自动选择"派生行与等级列表即时刷新。

### 看板画布与组光效

- **画布自适应**:`.gui-board-surface` 布局宽固定 BASE_W(1092),`transform: scale(容器宽/1092)` 适配窗口;effect 依赖 `activeId`(挂载时 home 视图 ref null → deps `[]` 时 scale 永驻 1,画布 1092 布局溢出被裁——已修);`overflow-x: hidden` + `overflow-y: auto`(transform 不改布局,窄窗口必出横向滚动条伪影)。
- **ChromaGroup 组光效**(reactbits ChromaGrid parity,`components/ChromaGroup.tsx`):容器 pointermove 写 `--cg-x/--cg-y`(零 re-render),`.gui-chroma-glow` 纯 CSS 三层 RGB 错位径向渐变 + `mix-blend-mode: screen` + hover 淡入 + `gui-motion-off` 隐藏——**一个共享光晕同时照亮组内所有卡片**(看板画布 + 模型供应商网格);伙伴预设/桌宠市场**不适用**(滚动密集小卡网格上整片背景泛光 + 固定 inset-0 在滚动容器被裁——用户实测回退)。

### 设置搜索与新建项目

- **设置搜索**:侧栏搜索过滤**配置项级**(section label 或 `SECTION_SEARCH_TERMS` 关键词命中,双语);内容区匹配行 `.gui-settings-match`(accent 13% 底 + 24% 描边)命令式高亮 + 首个匹配 `scrollIntoView`(新查询/section 切换滚一次,继续打字不滚防抖动);`aria-hidden/inert` 折叠行跳过。
- **新建空白项目**(kimiwork parity):侧栏项目 tab「添加项目/远程」菜单 + composer 项目菜单 → DialogFrame(名称 + 父路径 native picker)→ daemon `fs.mkdir { cwd: 父路径, path: 名称 }` → 打开 + `omp-gui-project-added`;保存按钮双字段齐备才启用,失败内联展示。字段 = label 上控件下的紧凑布局(`gui-settings-field` 两列 grid 在紧凑弹窗里会把 input 挤到 76px)。

## 6. 品牌图标(App Icon,2026-08-06 重设计)

- **源文件**:`packages/gui/build/icon.svg`(1024×1024 画布,Python 脚本生成点阵坐标——23×23 网格)。构建产物:`build/icon.png`(1024×1024)+ `build/icon.icns`(iconutil 10 档 iconset)。
- **设计语言**:**点阵风格**——23×23 圆点网格(间距 24px),背景点淡(fg 9% 透明度,`r=4.2`)+ π 形状点亮(fg 暖白 `#ece8e9`,`r=7.6`);π = 3 点厚横梁(rows 3-5, cols 5-18)+ 3 列宽双腿(rows 6-19)。背景 = 主题深色微渐变(`#242128 → #1b191f`,`--bg` 系)。**配色只用主题色(fg + bg surface),零强调色/渐变**——与 WelcomeComposer 的 `DotMatrixMark`(点阵品牌背景)视觉语言同源,替代旧版"深底 + 粉紫青渐变 π"(花哨、与主题脱节)。
- **卡中卡布局(2026-08-06 实测 kimi 对齐)**:图标 = 深色卡占 tile **80.5%(824/1024,四周对称 100px 透明边距)** + 卡角 superellipse n=5 圆角——与 Kimi 桌面 app(`/Applications/Kimi.app` 的 icon.icns 实测 alpha bbox x100-923,80.5%)完全一致。**Dock 里"我们图标比 kimi 大"的根因**:此前全出血 100%,kimi 卡中卡 80.5%;92% 内缩版仍 >80.5%("始终大一点")。全出血 1024 + 系统遮罩是 Apple HIG 基线,但**与邻位 app 视觉统一优先于 HIG 抽象规范**——kimi 实际就是卡中卡,我们要并排同大。
- **三处同步**:`build/icon.png`(打包源)+ `build/icon-dock.png`(dev Dock setIcon)+ `src/vendor/logo.png`(splash/内嵌,512 同参数);打包版 icns 同样带 80.5% 卡边距(不重打包则 bundle icns 手动同步)。
- **改动流程**:改点阵参数(网格/π 形状/点径/配色)→ Chrome headless 渲染 1024 PNG → 套 80.5% 卡中卡 + superellipse 切角 → 重生成 iconset + `iconutil -c icns` → 替换 build/icon.png + icon.icns + icon-dock.png + src/vendor/logo.png(+ release bundle 的 icns)→ **手动同步 bundle icns 后必须重签**(`codesign --force --deep --sign - release/mac-arm64/MusePi.app`——签名后改资源会失效,CSDN 4.3 坑)→ `bun run pack:dir` 重打包(dev 模式 Dock 图标走 `app.dock.setIcon(build/icon-dock.png)`,打包版用 bundle icns——**只换 png 不重打包,打包版 Dock 仍是旧图标**)。
