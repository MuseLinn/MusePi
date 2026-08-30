# MusePi Changelog

MusePi 定制版本的发布说明,供启动时的"新功能"面板(`changelog.startup`)与
`/changelog` 展示。上游 oh-my-pi 的变更记录在 `CHANGELOG.md`(本文件存在时
优先读取本文件)。

## [Unreleased]

### Fixed

- **Electron 主进程 EPIPE 崩溃**:从 Finder/Dock 启动(无终端)时父进程 stdio 管道关闭,主进程任意 `console.error`(如 MCP tool load failed 日志)抛 EPIPE → uncaughtException → Electron「A JavaScript error occurred in the main process」模态框 → 应用卡死、daemon 继续跑、GUI 显示 working、无法发消息。现在主进程 `console.log/warn/error` 重定向到 `~/.musepi/logs/gui-main.YYYY-MM-DD.log`,`uncaughtException`/`unhandledRejection` 全部吞掉(EPIPE 时 console 置 no-op)——任何主进程异常不再弹模态框。
  - EN: the Electron main process no longer crashes on EPIPE — when launched from Finder/Dock (no terminal) the parent stdio pipe is already closed, so any main-process console.error (e.g. an MCP tool load failure log) threw EPIPE → uncaughtException → the "A JavaScript error occurred in the main process" modal → the app froze while the daemon kept running (GUI showed "working", messages undeliverable). Main-process console output is now redirected to a dated log file and uncaughtException/unhandledRejection are swallowed (console becomes a no-op on EPIPE), so no main-process error can pop the crash modal again.
- **GUI 撤回/重试/分叉接线到会话树 RPC**:撤回(撤回该消息)与重试(编辑并重发)走 `session.branchAt`(非破坏性——leaf 原位移动,旧子树保留为 sibling branch),分叉(从此消息分叉新会话)走 `session.forkAt` + 自动切换到新会话;会话内消息操作不再只是本地状态,与会话树拓扑(分支/子会话)一致。
  - EN: the chat transcript's revert/retry/fork actions are now wired to the session-tree RPCs — revert & retry go through `session.branchAt` (non-destructive: the leaf moves in place, the old subtree survives as a sibling branch) and fork creates a new session via `session.forkAt` + auto-switches to it, so in-chat message operations match the session-tree topology (branches/child sessions) instead of local state.
- **TUI OSC 99 通知品牌残留**:`OSC99_APP_NAME` 品牌改名后终端通知测试仍期望 omp 时代的 "Oh My Pi" base64,已更新为 MusePi(修复 CI native/integration 的 notifications/streaming-scrollback 失败)。
  - EN: TUI OSC 99 notifications — the terminal-notifications tests still expected the omp-era "Oh My Pi" app-name base64 after the MusePi rename; updated to MusePi (fixes the notifications/streaming-scrollback failures in the native/integration CI bucket).
- **TUI tmux resize 渲染缺口**:`Text` 组件实现 `getNativeScrollbackWidthEpochRevision`(渲染行数签名),使 `setText` 改变高度时能通过 Container 的 epoch 聚合传播(修复 issue-2088 的 rendered-height 测试);TUI 现在向聚焦组件注入真实终端行数(`setViewportRowsProvider`),Editor 的 autocomplete 下拉按真实视口裁剪而非回退到 24 行假设(修复 autocomplete viewport 测试);测试 fixture 中性化 `TERM_PROGRAM`/`PI_TUI_RESIZE_IN_PLACE`,消除 Warp 终端宿主的 resize 路径误分类。
  - EN: TUI tmux-resize rendering gaps — `Text` now implements `getNativeScrollbackWidthEpochRevision` (rendered-line-count signature) so a `setText` height change propagates through Container's epoch aggregation (fixes the issue-2088 rendered-height test); the TUI injects its live terminal row count into focused components (`setViewportRowsProvider`), so Editor's autocomplete dropdown clamps to the real viewport instead of the 24-row fallback (fixes the autocomplete-viewport tests); test fixtures neutralize `TERM_PROGRAM`/`PI_TUI_RESIZE_IN_PLACE` so resize classification is deterministic on Warp hosts.

## [0.4.8] - 2026-08-30

### Added

- **欢迎页语音输入**:空态输入框(WelcomeComposer)补齐麦克风按钮——与会话态输入框一致,本地 sherpa-ONNX 转写(daemon `stt.transcribe`,无会话即可用),听写结束按 `stt.submitTrigger` 设置自动发送或填入草稿;消除"空态提示轮播在介绍麦克风、输入框却没有麦克风"的文案矛盾。
  - EN: the empty-state (WelcomeComposer) input now ships the mic button its own welcome tips advertise — local sherpa-ONNX transcription via the daemon (`stt.transcribe`, session-less), honoring the `stt.submitTrigger` setting for auto-send vs draft-fill, matching the session composer.
- **使用统计补全进阶指标与可视化**:设置 → 数据与统计 → 使用统计 补齐 CLI `musepi stats` 的指标——汇总卡新增成功率(+失败数)、平均首字延迟(TTFT)、输出速度(token/s)、缓存 token 四张卡;新增"按智能体"三段占比条(主智能体/子智能体/顾问)和"请求与错误"按日堆叠图,与终端 dashboard 对齐。
  - EN: settings → data & statistics → usage statistics now surfaces the CLI `musepi stats` metrics that were previously terminal-only — four new summary cards (success rate + failed count, avg time-to-first-token, token throughput, cache tokens), an "by agent" three-segment share bar (main/subagent/advisor), and a per-day "requests & errors" stacked chart.
- **Widget 图表统一到零依赖 SVG 组件层**:新增 `Sparkline`(迷你趋势,含固定 `domain` y 域)、`KLine`(K线/蜡烛)、`Donut`(进度环)、`Gauge`(半圆仪表盘)四个零依赖响应式 SVG 组件,与既有 `LineChart`/`BarChart` 同契约(ResizeObserver 测容器 → 1:1 `viewBox`,淘汰手写 `preserveAspectRatio="none"` 的拉伸形变);逐个迁移 ticker / metric / indextape / fx / stocks / Kline / pomodoro / Gauge / slider 九个 widget 的手写 SVG,fx/stocks 的字符串 `dangerouslySetInnerHTML` sparkline 一并改为 JSX 组件,并清理 gauge/kline/ticker/metric 迁移后遗留的死 CSS;配色走 CSS 变量(含 fx/stocks 涨跌方向色 `var(--gui-*-dir)`、KLine 红涨绿跌 token),深浅主题热切换跟随,圆环、曲线与仪表盘不再形变。
  - EN: Widget charts unified onto the zero-dependency SVG component layer — new `Sparkline` (fixed `domain` y-axis), `KLine` (candles), `Donut` (progress ring) and `Gauge` (semicircle dial) components share the LineChart/BarChart contract (ResizeObserver → 1:1 viewBox, replacing the stretch-distorting hand-rolled `preserveAspectRatio="none"`); nine widgets migrated (ticker/metric/indextape/fx/stocks/Kline/pomodoro/Gauge/slider), including dropping the string `dangerouslySetInnerHTML` sparklines in fx/stocks for JSX and removing the dead gauge/kline/ticker/metric CSS left behind; colors use CSS vars (fx/stocks up-down `var(--gui-*-dir)`, KLine red/green semantic tokens), so dark/light theming tracks and circles/curves/dials no longer distort.
- **浏览器与 Computer Use 面板**:设置 tab 更名"浏览器与 Computer Use"(原"浏览器与桌面");daemon/webview/relay 的 `omp.*` 命名统一为 `musepi.*`;浏览器中继扩展从"只装"补齐三层实时状态(文件已写/服务在跑/扩展已连)与卸载;内置浏览器 tab 徽标吸收 craft-agents 质感——网页 `theme-color` 自适应徽标背景(WCAG 亮度反转前景)、favicon→spinner→globe 三级回退、agent 驱动 tab 的 accent 细边框;浏览器面板微动效(地址栏聚焦光晕/tab 切换/菜单入场)统一到 `--gui-motion-*` token。
  - EN: "Browser & Computer Use" panel — settings tab renamed, `omp.*` daemon/webview/relay naming unified to `musepi.*`, browser-relay extension gains three-tier live status (written/serving/connected) + uninstall; built-in browser tab badges absorb craft-agents polish (page theme-color adaptive background with WCAG luminance-aware foreground, favicon→spinner→globe fallback, accent hairline on agent-driven tabs); browser micro-motion unified onto `--gui-motion-*` tokens.
- **官网与 Windows Computer Use**:Github Pages 修复语言切换 404(硬编码 `/MusePi` 前缀与 baseurl 双重拼接)+ 下载按钮 macOS/Windows/Linux 分平台直链 + hero 点阵品牌标记对齐软件 DotMatrixMark(文字栅格化点阵/彩色流光/羽化/呼吸/光晕/波纹);Computer Use 提示词固化 Windows 非抢占路由(UIA 优先、网页走 browser 工具/relay、仅原生非 AX 区域才抢占前台)。
  - EN: site fixes — language-switch 404 (hard-coded /MusePi prefix double-joined with baseurl), per-platform download buttons (macOS/Windows/Linux direct asset links), and the hero dot-matrix mark upgraded to the app's DotMatrixMark (rasterized grid, flowing accents, feather/breathing/halo/ripple); Computer Use prompts now pin the Windows non-intrusive route (UIA first, browser tool/relay for web, foreground only for non-AX native regions).

### Changed

- **Widget 设计系统合规修复**:对照 `widget-design-system.md` §3/§5 全量归位——3 处 accent 实色按钮(todo 添加 / ask 发送 / 看板首页发送)改黑白主按键(`--color-text` + `--color-surface`);calc 计算器「到手」从绿(`--color-ok`)改 accent 蓝,消除「扣税红/到手绿」色盲冲突;约 20 处非阶梯间距/圆角(7/9/5/3/14/18px)归位到 4/8/12/16 阶梯;history 像素 logo/纹理与 music 频谱的 canvas 硬编码色桥接主题 token(`useThemePreference` + `getComputedStyle`,深浅主题实时跟随)。
  - EN: widget design-system compliance pass — 3 accent-solid buttons (todo add / ask send / board-home send) become monochrome primary buttons (`--color-text` + `--color-surface`); the calc "net" tile switches from green `--color-ok` to accent blue, removing the red/green colorblind clash; ~20 off-ladder spacing/radius values (7/9/5/3/14/18px) snap to the 4/8/12/16 ladder; the history logo/texture and music spectrum canvas colors bridge the theme tokens (useThemePreference + getComputedStyle) so dark/light tracks in real time.

### Fixed

- **欢迎页建议 chips 展开/折叠动画修复**:折叠时先固化当前(展开)高度再卸载多余 chips,`useLayoutEffect` 里临时抬起内联 height/overflow pin 后再读 `scrollHeight`(否则 `scrollHeight` 被 `clientHeight` 截断 → `delta < 1` → 高度 tween 直接跳过,容器卡在展开高度);消除展开即时塌陷的跳变与折叠后卡死。
  - EN: welcome suggestion chips expand/collapse no longer jump — collapse pins the current height before unmounting the extra chips, and the layout effect lifts the inline height/overflow pin before reading `scrollHeight` (which is floored at `clientHeight`, so a pinned container read back the pinned value with `delta < 1` and skipped the tween, stranding the container at the expanded height).
- **Windows NSIS 更新后桌面快捷方式丢失**:electron-builder 默认模板的 `KeepShortcuts` 保留机制在 OTA 更新(`--updated`)时跳过桌面快捷方式重建——一旦被用户/清理工具删除,后续每次更新都不会补回。新增 `packages/gui/release/ensure-shortcuts.nsh`(`nsis.include`),通过 `customInstall` 宏在每次安装(含静默更新)后无条件重建桌面 + 开始菜单快捷方式,绕过 `keepShortcuts` 门控。
  - EN: Windows NSIS updates no longer lose the desktop shortcut — electron-builder's KeepShortcuts retention skips desktop-shortcut recreation on `--updated` installs; a custom `customInstall` macro (`ensure-shortcuts.nsh`) now unconditionally recreates desktop + start-menu shortcuts on every install, including silent OTA updates.
- **语音输入/输出错误现在会提示**:口述(STT)与朗读(TTS)失败此前静默复位——`startDictation`/`speak` 的 `error` 回调被 Composer/WelcomeComposer/ChatView 丢弃,用户只看到麦克风/朗读指示消失、不知失败原因;现在麦克风不可用、空转写、转写异常、合成失败、播放失败都走 `dispatchNotification("error")` 桌面通知 + 错误音效。
  - EN: dictation (STT) and read-aloud (TTS) failures no longer fail silently — the `error` phase (mic unavailable, empty transcript, transcribe/synthesize/playback errors) now dispatches a desktop error notification + sound in the composer and transcript, instead of just resetting the mic/speaking indicator.
- **内置浏览器"更多操作"菜单被网页遮挡修复**:`isActuallyOnScreen` 曾把入场动画首帧 `opacity:0` 误判为"不在屏",导致原生视图不收起、菜单被 native WebContentsView 盖住;去掉 opacity 检查(global-pause 走 `visibility:hidden` 已覆盖)。
  - EN: the browser overflow menu was buried under the native view because isActuallyOnScreen misread the entrance animation's first-frame opacity:0 as "not on screen" and never hid the view; the opacity check is removed (global-pause is already covered by visibility:hidden).
- **会话轨迹面板高度修复**:轨迹视图移出共享 FadeScroll、根节点改 flex-1,消除嵌套滚动把面板撑出内嵌卡片(比左栏侧栏高、盖住 chat 顶部)的问题。
  - EN: the trajectory view moves out of the shared FadeScroll (root flex-1), so its nested scroll list no longer inflates the panel taller than the sidebar / clipping the chat top.

## [0.4.7] - 2026-08-29

### Added

- **Git 图谱表格化**:侧面板 git · 提交历史重做为表格(车道求解 SVG 图轨 + HEAD/分支/远端/tag 徽章 + 日期/作者/短哈希列,点击复制完整 hash,加载更多分页);daemon `git.log` 改结构化输出(`--topo-order` + \x1f 分隔字段),`git.status` 支持 `numstat` 行级增删汇总。
  - EN: git-graph table in the side panel (lane-solved SVG rail, ref badges, date/author/hash columns, click-to-copy, load-more paging); daemon `git.log` now returns structured commits and `git.status` accepts `numstat`.
- **浮动状态卡**:会话右上角悬浮卡栈——Git 工具卡(更改 +N/−M、分支切换、提交入口)、智能体卡(运行中子代理 + 已用时 + 已结束折叠)、待办进度卡;可折叠为药丸,空态隐藏。
  - EN: floating status-card stack top-right of the chat — git tools (±counts, branch switcher, commit jump), running/ended subagents with elapsed timers, todo progress; collapses to a pill.
- **奖励票券弹窗**:星空背景 + 3D 倾斜票券卡 + 数字滚动 + 领取成功面板(RewardOverlay),接入 what's-new 公告流——daemon 可选 `<agentDir>/reward.json` 驱动,按 id 只弹一次,设置页可重开。
  - EN: celebratory reward-ticket overlay (starry sky, 3D tilt, count-up amount, claim panel) wired into the what's-new announcement flow, driven by an optional daemon reward.json.
- **长会话跳转修复 + 树地图定位**:Transcript 新增 jumpRequest——跳转目标在折叠窗口/压缩折叠内时先扩窗再滚动高亮(此前直接滚到顶部 spacer);会话树地图新增当前位置虚线标记 + "回到当前位置"按钮,聚焦卡标签中文化。
  - EN: Transcript jumpRequest expands the window/compaction fold until the target mounts then scroll+flashes; the session tree canvas gains a current-position marker and a locate button.

- **已完成轮折叠**:每轮完成后,用户消息与最终回复之间的工具活动/思考折叠进回合头——`已工作时长(hh:mm:ss) + N 个工具 · M 个命令 + 预览`,点击展开;最终回复(文本+文件卡)保持可见,末轮(live)始终展开。折叠计数含最终回复自身的 toolCall。配套纯逻辑 `round-collapse.ts` + 5 单测。
  - EN: completed rounds fold their working span (tools/commands/thinking) behind a header — work duration hh:mm:ss + tool/command counts + preview; the final reply stays visible and the live tail never folds.
- **压缩历史不再默认折叠**:`display.collapseCompacted` 默认改为关——压缩点保留 inline 分隔线、完整转写可见,导航树/轨迹跳转不再因折叠而缺行;需折叠时在 外观→显示 显式开启。
  - EN: display.collapseCompacted defaults to off — compaction dividers stay inline so navigation/trajectory never lose rows to the fold; opt in via Appearance → Display.
### Changed

- **动效打磨**:会话切换骨架屏错落入场;上下文用量百分比改 per-digit 弹簧滚动(SlidingNumber);欢迎问候语逐字模糊渐显(BlurText)。
  - EN: staggered session-switch skeleton, per-digit spring-rolling context utilization (SlidingNumber), per-char blur-in welcome greeting.
- **设置整合与人性化(通知与音效/语音/交互)**:通知与音效新增主音量(cuelume setVolume 即时生效)、免打扰时段(事件音效窗口内静音,支持跨零点)、试听全部接线音效;音效库网格只保留未接线音效(接线过的由事件行表达,不再重复罗列)。语音 tab 的 5 组 schema 标签/描述补齐中文。设置分组去重:审批组从交互挪到工具(审批策略紧跟它管控的工具开关)、Language 组从交互挪到外观(外观语言控件本就双写 GUI locale + settings.locale)、computer.glow 从工具 tab 排除(浏览器与桌面 tab 持有实时生效的自定义行);交互 tab 描述文案同步。
  - EN: notifications gains master volume (live cuelume setVolume), quiet hours (overnight-wrap event-sound muting), audition-all; the palette grid lists unwired sounds only (wired ones live in the event rows). Voice tab schema labels/descriptions translated. Group-level dedupe: Approvals → Tools, Language → Appearance (its picker dual-writes), computer.glow → Browser & desktop only; interaction tab description updated.
- **会话列表排序修复**:working/unread 不再作为排序主键(点击打开清未读、离开时 working 翻转,行在光标下跳动)——纯按最后活跃时间排序,working/未读仅为行上视觉标记。分组/项目 tab 新增滑动胶囊指示器 + 列表 160ms 淡入;会话切换错峰动画收紧(尾延迟 210→120ms、时长 300→240ms)并删除 gui-pet.css 的冲突重复规则、补 motion-off/reduced-motion 降级;骨架屏闪烁阈值 150→250ms。
  - EN: session-list sort is pure last-activity (working/unread flips used to reorder rows under the cursor); groups/projects tab gains a sliding capsule thumb + 160ms pane fade; the switch stagger reveal tightens (tail 210→120ms, 300→240ms) with its conflicting duplicate removed and motion-off gating added; skeleton flicker threshold 150→250ms.

- **内置浏览器白屏根因修复（CDP 实锤）**:常驻 `role="dialog"` 元素（gui-global-pause 暂停遮罩、mtree 会话树面板等）让 `hasBlockingOverlay()` 恒 true → renderer 恒发 visible:false → 原生视图永远隐藏 → 白屏。修复:`isActuallyOnScreen()` 只认真正可见的 overlay（visibility/display/opacity/渲染盒）。另:最大化面板背景补 `background-color:var(--bg)!important`（EOF transparent 规则因伪元素特异性 0,2,1 压过 0,2,0,面板成半透明）;`applyLayout` 不再以 `owner.isVisible()` 为门（遮挡/最小化过渡不再永久隐藏视图）。
  - EN: built-in browser white-screen root cause — always-mounted role=dialog overlays kept hasBlockingOverlay() true forever; isActuallyOnScreen() now checks real visibility. Maximized panel gains an opaque background (!important beats the transparent EOF rule); applyLayout stops gating on owner.isVisible().
### Fixed

- **最大化面板遮罩**:右侧面板最大化新增模态遮罩(z 840,点击还原);浮层滚动条 z 100000 → 30(此前固定定位画在最大化面板之上,前后内容重叠);最大化期间 agent 后台浏览不再强行切换视图。
  - EN: maximized right panel gains a modal scrim; the fixed float scrollbar drops to a transcript-local tier (was painting over the maximized panel); agent browsing no longer yanks the view while maximized.
- **daemon `git.log` spawnSync 隐患**:改异步 spawn + 10s kill 守卫(spawnSync 曾冻结整个 daemon 事件循环)。
  - EN: daemon git.log switched from spawnSync to async spawn with a 10s kill guard.
- **分支切换错误静默**:WelcomeComposer 派发的 `musepi-gui-toast` 此前无监听者,现接入全局错误横幅。
  - EN: the listener-less `musepi-gui-toast` event from branch checkout now feeds the global error banner.
- **扩展中心加载失败可见性**:列表行对 `loadError` 扩展显示红点 + "加载失败"徽章,状态标签以失败相位优先。
  - EN: extension list rows show a red dot + "load failed" badge for loadError items.
- **内置浏览器投影加固**:原生视图在仅位移(捕获滚动/最小化恢复/DPI 变化)后重投影,修复页面错位/空白。
  - EN: the managed browser re-projects after position-only shifts (capture scrolls, minimize/restore, DPI change).
- **compat 壳透明契约**:serve 的 desktop-web 渲染器此前 html/body 实心 `--bg`、无玻璃管线,Electron 壳的 acrylic/vibrancy 窗口被完全遮住(侧栏/顶栏/主体四周不透明)。新增 `lib/native-glass.ts`:compat 标记 + Electron bridge 同在时 html/body 转透明、`sh-app`/头栏/侧轨 scrim 减薄,并把主题镜像到窗口材质;纯浏览器 guest 保持不透明画法。
  - EN: the served desktop-web renderer now opts into the native window glass (transparent root, thinned shell scrims, theme mirrored onto the material) via lib/native-glass.ts; plain-browser guests keep the opaque paint.
- **浮动状态卡遮挡切换钮**:Git/智能体/待办卡与「对话/地图」surface 切换同贴转写右上角(top 10px vs 8px)直接重叠——卡片整体下移至切换行之下(top 46px)。
  - EN: the floating status cards moved below the chat/canvas surface-mode toggle they overlapped in the top-right corner.
- **地图视图适配**:canvas 首次 fit 曾以 0px 容器计算且被 width×height 锁存吞掉——节点缩在角落一条;改为挂载 + ResizeObserver 守卫的智能适配(容器退化尺寸时重试),放不下的巨树以可读缩放居中「当前节点」;复位按钮复用同一适配。
  - EN: the tree-map fit now retries on degenerate wrap sizes (ResizeObserver) instead of a one-shot latch, and oversized trees center on the current node at a readable scale; the reset button reuses the same smart fit.
- **轨迹分支树缩进溢出**:缩进按消息层级逐行 +14px,线性长会话每行都超面板——改为只在真实分支点(多子)加层、单子链保持父级深度,并加 6 层硬上限。
  - EN: trajectory branch-tree indent now grows only at real branch points (single-child chains keep the parent depth) with a 6-level cap — long linear sessions no longer walk off the panel.


## [0.4.6] - 2026-08-28

### Added

- **dsh-desktop 兼容链**:`musepi serve --web-port` serve 渲染器 + `/__daemon.json`,Electron 壳经 `probeWeb()` 自动发现并 loadURL 运行时渲染器;`?shell=1` 注入 compat slot host(`extensions.list` → `window.MusePiCompatHost`),transcript.node 扩展在 serve 页渲染。
  - EN: dsh-desktop-compat chain — daemon-served renderer, Electron shell discovery via web.port, `?shell=1` injected compat slot host, transcript.node extensions render in the served page.
- **desktop-shell 一等扩展 + Shell 三模式**:壳是扩展(`extensions.list` 顶层 `shell:{enabled,mode,webUrl}`),`setEnabled` 切开关/模式;compatibility/extended/enhanced 按 mode 选 slot,extended 消费 composer.dock/statusbar/workbench。
  - EN: desktop-shell first-class extension + three shell modes (compatibility/extended/enhanced) with mode-driven slot injection.
- **agent 感知扩展清单**:system prompt 注入"已安装扩展"区块(扩展名+工具),热切换跟随更新——agent 知道自己的插件。
  - EN: extension inventory block in the system prompt — the agent sees its live plugins and their tools.
- **TUI `/preset use|list`**:会话内预设热切换(复用 modes v2 switcher)+ 列表。
  - EN: `/preset use|list` in-session preset hot-switch + enumeration.
- **扩展中心 musepi 插件管理**:GUI+TUI 的 musepi-extensions provider 空也可见(管理入口);onboarding 浮层菜单 scroll 跟随修复。
  - EN: musepi-extensions provider always visible in GUI/TUI extension centers; onboarding floating-menu scroll-follow fix.
- **Command Code 内置供应商**:新增 `command-code` 内置 OpenAI 兼容供应商(goat 订阅网关),动态 `/v1/models` 发现 61 个官方模型,并从 canonical 索引/models.dev 兜底注入上下文长度、输入能力、推理与思考等级;`/login command-code` 支持粘贴 API key 校验。
  - EN: Command Code (`command-code`) built-in OpenAI-compatible provider (goat subscription gateway) — dynamic `/v1/models` discovery of 61 official models, with context window / input modalities / reasoning / thinking efforts hydrated from the canonical reference index with models.dev fallback; `/login command-code` API-key paste validation.


## [0.4.5] - 2026-08-26

### Added

- **Windows 毛玻璃修复**:win32/linux 上左侧面板/顶栏/ChatView 圆角外四角色差清零、透明毛玻璃生效。根因:html 元素被 desktop-web base.css 的 `var(--bg)` 不透明底色盖住整窗(`gui-base.css` 只覆了 body),DWM acrylic / macOS vibrancy 透不过来;side pane 的 `blur(15px) saturate(1.8)` 单独渲染把侧栏提亮 9-12 度,与无 blur 的顶栏/卡片围边形成肉眼可辨色差。修复:`html:root` + `html:root body` 显式 `transparent`(specificity 0,1,1 稳压 desktop-web base 的 `html { background: var(--bg) }`,无视 bundle 顺序);win32/linux 下 `.gui-pane-side` 同 `.gui-main` 禁用 backdrop-filter,三面统一走单一 scrim。CDP 渲染层 clip 像素验证:side 35,30,25 / header 33,28,23(同暖色调,delta≤5)。
  - EN: Win32/Linux frosted glass fix: corner color mismatch between sidebar/header and the four corners around the ChatView rounded container eliminated; transparent glass effect working again. Root cause: html element kept an opaque `var(--bg)` from desktop-web base.css (gui-base.css only overrode body), blocking DWM acrylic / macOS vibrancy; .gui-pane-side's own `blur(15px) saturate(1.8)` rendered the sidebar 9-12 degrees brighter than the topbar/card ring which share no blur. Fix: `html:root` + `html:root body` explicitly `transparent` (specificity 0,1,1 wins over desktop-web base's `html { background: var(--bg) }` regardless of bundle order); `.gui-pane-side` disabled for backdrop-filter on win32/linux alongside `.gui-main`, all three surfaces share the same workspace scrim. CDP render-layer clips confirm: side 35,30,25 vs header 33,28,23 (same warm tint, delta≤5).
- **Foreign session import — MusePi source**:foreign-session-import 新增 `musepi` 源,SDK_SESSION_ROOTS 加入 `~/.musepi/agent/sessions`、`~/.musepi/sessions`、`~/.musepi/agent/data/sessions`;`foreignSessionSources()` 把 `musepi` 放在首位(自我迁移优先级最高);`"omp"` 显示名从 `"Oh My Pi"` 精简为 `"OMP"`。`Session.delete` RPC 已级联清理三张 materialized 表(sessions / materialized_sessions / messages / agents),数据卫生无遗留。
  - EN: Foreign session import adds a `musepi` source; SDK_SESSION_ROOTS extended with `~/.musepi/agent/sessions`, `~/.musepi/sessions`, `~/.musepi/agent/data/sessions`; `foreignSessionSources()` puts `musepi` first (self-migration priority); `"omp"` display name trimmed from `"Oh My Pi"` to `"OMP"`. `Session.delete` RPC cascades across all four materialized tables (sessions / materialized_sessions / messages / agents) — no data hygiene debt.
- **Daemon widget.data RPC**:daemon 提供 `widget.data { feed }` RPC,首期喂行情静态/轮询接口(`open.er-api.com`),60s 进程内缓存 + 请求合并;GUI BoardPage ticker 改走 RPC,保留现有静态 seed 离线回退。desktop-web widget-task-run 的直连 fetch 路径不动。
  - EN: Daemon exposes a `widget.data { feed }` RPC. First feed: static/periodic FX rates (`open.er-api.com`) with a 60s in-process cache + in-flight coalescing; GUI BoardPage ticker routes through RPC with static seed kept as offline fallback. The existing direct-fetch path in desktop-web widget-task-run remains untouched.
- **扩展 statusbar.seg 桥**:extension API 新增 `registerStatusBarSegment(id, { label, order?, renderKey? })`;loader 聚合到 `Extension.statusBarSegments[]`,runner 暴露 `getStatusBarSegments()`,`extensions.list` RPC 通过新加字段下发;GUI `StatusBarContent` 消费后按 `order` 升序拼入内置三段(model/mode/context)之后。Extension artifact compiler 同步支持 slot 组件编译输出 `statusBarSegments` 形状。
  - EN: Extension API gains `registerStatusBarSegment(id, { label, order?, renderKey? })`; loader aggregates into `Extension.statusBarSegments[]`, runner exposes `getStatusBarSegments()`, `extensions.list` RPC serves them via a new field; GUI `StatusBarContent` merges by `order` ascending after the three builtins (model/mode/context). Extension artifact compiler emits `statusBarSegments` shape alongside slot components.
- **Cleanse 连续流**:runCleanseLoop 加 `maxWaves` 可选参数(默认 1 = 既有单次行为精确保留);多次 wave 时每次重新 balanceDiagnostics,收敛到 clean / 达到上限 / 被 abort 信号中止 / 报错均停止。4 个回归测试:2-wave 收敛、maxWaves 上限触发 stalled、wave 中途 abort、默认单波。
  - EN: runCleanseLoop gains optional `maxWaves` (default 1 = exact existing single-pass behavior); iterates waves re-balancing each time via balanceDiagnostics; stops on clean, maxWaves hit, abort signal, or error. 4 regression tests: 2-wave convergence, maxWaves cap → stalled, mid-wave abort, default single-pass.
- **Assembly.toml manifest 子系统**:assembly 目录新增 `manifest.ts` / `verify.ts` / `types.ts` 三件套,提供 project-level 扩展白名单 + surface 覆盖 + seams 选择(terminal / compaction);CLI `musepi assembly status|verify` 命令;boot 阶段 `bootVerifyExtensions` 在 managed errors 下按 `degraded_ok` 决定 fail-loud 或 warn+soft-fail。
  - EN: Assembly.toml manifest subsystem — `manifest.ts` / `verify.ts` / `types.ts` providing project-level extension whitelist, surface override, and seams selection (terminal / compaction); CLI commands `musepi assembly status|verify`; boot-time `bootVerifyExtensions` raises managed errors with `degraded_ok` gating fail-loud vs warn+soft-fail.
- **GUI /trace TUI 轨迹视图**:TreeSelectorComponent 加入 projection 参数叠加时间/成本列(HH:mm:ss、tokens↑↓、duration、8 级 cost bar、error 符号)到 `/tree` 结构投影上;builtin-session 注册 `/trace` 命令入口。与 `/tree` 共享同一 TreePanel 实例,视图切换零开销。
  - EN: GUI `/trace` TUI trajectory view — TreeSelectorComponent gains projection param stacking time/cost columns (HH:mm:ss, tokens↑↓, duration, 8-level cost bar, error symbols) atop the `/tree` structural projection; builtin-session registers `/trace` entry. Shares one TreePanel instance with `/tree`, zero-cost view switch.
- **MusePi ps CLI**:子命令 `ps` 注册到 cli-commands,实现 `ps --json/--plain --all --dir`,TUI interactive monitor 与静态 listing 两套形态;live-board 同时作为 supervisor state surface 贡献给 ps 上下文。
  - EN: MusePi `ps` CLI — sub-command registered in cli-commands, implements `ps --json/--plain --all --dir`, two modes: TUI interactive monitor and static listing; live-board contributes as supervisor state surface to ps context.
- **Widget task scheduler 真实执行引擎**:BoardPage ticker 移除 1400ms setTimeout fake run,改用 `executeAndRecord` 真实 executor 刷新;ticker 30s 周期内扫描 due tasks,按 hourly/daily/schedule 类型触发,调用真实 fetch(离线降级);desktop-web widget-task-run 的 executeWidgetTask 复用同一 isTaskDue 时序逻辑。
  - EN: Widget task scheduler real execution engine — BoardPage ticker drops 1400ms setTimeout fake run, uses `executeAndRecord` real executor refresh; ticker scans due tasks every 30s, triggers by hourly/daily/schedule type, calls real fetch (offline degrade); desktop-web widget-task-run reuses the same isTaskDue timing logic.
- **P3/P4 插件接缝**:extension API 补 `registerNotificationChannel` / `registerThemeToken` / `registerService`;loader 新增三类 registration 校验,runner 实现 start/stop 生命周期(isolating throwing start)、notification 路由、theme token 聚合+reload;extensions-runner 3 个回归测试。
  - EN: P3/P4 plugin seams — extension API adds `registerNotificationChannel` / `registerThemeToken` / `registerService`; loader adds validation for three registration types, runner implements start/stop lifecycle (isolating throwing start), notification routing, theme token aggregation + reload; 3 regression tests in extensions-runner.
- **安卓 OTA 方案文档**:docs/ota-mobile-design.md,调研结论推荐 `@capgo/capacitor-updater`(web-layer OTA,自托管 bundle 规避国内网络问题),APK 下载仅作兜底;`update-manifest.json` 保留为桌面+移动端共通的版本公告格式。
  - EN: Android OTA design doc (docs/ota-mobile-design.md); recommendation: `@capgo/capacitor-updater` (web-layer OTA, self-hosted bundle to bypass China network issues), APK download as fallback; `update-manifest.json` retained as shared version-announcement format for desktop + mobile.
- **8 份核心文档中英双语配对**:`approval-mode` / `computer-use` / `environment-variables` / `marketplace` / `mcp-config` / `models` / `providers` / `session-operations-export-share-fork-resume` 全部创建 `.zh-CN.md` 及 `.i18n.yaml` hash 记录,`verify-translation-pairing` 严格检查通过。
  - EN: 8 core docs bilingual pairing — `approval-mode`, `computer-use`, `environment-variables`, `marketplace`, `mcp-config`, `models`, `providers`, `session-operations-export-share-fork-resume` all get `.zh-CN.md` + `.i18n.yaml` hash record, strict check passes via `verify-translation-pairing`.

### Changed

- **Telemetry 命名空间清理**:`pi.omp.agent.*` → `pi.musepi.agent.*`(11 个 counter/histogram),头注释 `"so omp can be observed"` 改为 `"so MusePi can be observed"`,otel-signals-probe + telemetry-export.test 9/9 通过。
  - EN: Telemetry namespace cleanup — `pi.omp.agent.*` → `pi.musepi.agent.*` (11 counters/histograms), head comment updated from "so omp can be observed" to "so MusePi can be observed"; otel-signals-probe + telemetry-export.test 9/9 pass.
- **文档活页更新**:`gui-design.md` §5g / `gui-implementation.md` §18 新增 2026-08-24→2026-08-26 落地特性章节(right-panel Phase 1-2、board widget canvas、composer.shape、statusLine.contextLine、OTA、win32 frosted-glass、双语 docs 约定、extension P3/P4 seams、/trace、musepi ps、telemetry rename)。
  - EN: Live-docs update — `gui-design.md` §5g / `gui-implementation.md` §18 gain 2026-08-24→2026-08-26 feature sections (right-panel Phase 1-2, board widget canvas, composer.shape, statusLine.contextLine, OTA, win32 frosted-glass, bilingual docs convention, extension P3/P4 seams, /trace, musepi ps, telemetry rename).
- **bazel pi-shell kill 信号测试超时放宽**:5s → 15s,消除 Windows 加载 runner 上的 flaky panic。
  - EN: Bazel pi-shell kill-signal test timeout relaxed 5s → 15s, eliminating flaky panic under loaded Windows runners.
- **Remote wt/* 分支清理**:`wt/glass`、`wt/installer-beta`、`wt/onboard-auth` 三个 worktree 已删除后遗留的远程引用一并 push --delete 清除。
  - EN: Remote wt/* branch cleanup — `wt/glass`, `wt/installer-beta`, `wt/onboard-auth` refs deleted from origin after worktrees were removed locally.
- **GUI settings 面板双语**:`gui-settings.md` / `gui-settings.zh-CN.md` 完成配对,切换器+结构签名对齐。
  - EN: GUI settings panel bilingual — `gui-settings.md` / `gui-settings.zh-CN.md` pair completed, switcher + structural signature aligned.

### Fixed

- **session.prompt dispatched 流程修复**:session.agent.ts 将 `prompt()` 改为 await `#promptWithMessage` 返回值,undispatched user prompt 触发 `#promptDropped` 事件;原 2 个 progress-guard 失败测试(600k-char prompt persisted before dispatch → no headroom post-compaction)已修复 29/29 pass。
  - EN: session.prompt dispatched flow fix — `prompt()` now awaits `#promptWithMessage` return; undispatched user prompts fire `#promptDropped`; the 2 failing progress-guard tests (600k-char prompt persisted before dispatch → no headroom post-compaction) now pass 29/29.
- **TuiTrace 测试 fixture 补全**:`trace-selector.test.ts` assistant message fixture 补 `totalTokens` + `cost` 字段(`makeNode` 参数放宽为 `Record<string, unknown>`),extensions-runner.test.ts 的 `toBe(true)` 断言因 `boolean | undefined` 类型选择错误 overload 改用 `toEqual(true)` 或 `Boolean()` 包装,全部通过。
  - EN: TuiTrace test fixture completion — `trace-selector.test.ts` assistant message fixtures gain `totalTokens` + `cost` (makeNode param widened to `Record<string, unknown>`); extensions-runner.test.ts `toBe(true)` assertions for `boolean | undefined` properties switch to `toEqual(true)` or `Boolean()` wrapper; all pass.
- **Extension runner 类型修复**:runner.startServices()/stopServices() 签名无参,测试中传参调用改为直接调;loader 类型 guard 缺失的 registerStatusBarSegment 等新增方法补齐。
  - EN: Extension runner type fix — runner.startServices()/stopServices() signatures are no-arg; tests adjusted. Loader type guards complete for newly added methods like registerStatusBarSegment.
- **assembly 子系统类型修补**(子代理产出后的自修):
  - assembly/index.ts 重复导出 `AssemblySessionState`(export { type } 与 export class 冲突)→ 删除 type re-export,保留 class
  - assembly/index.ts getCachedAgentDir / loadAssemblySync async 化调整
  - assembly/manifest.ts ManifestExtensionItem / compactionMethod 类型收窄
  - assembly/verify.ts ManifestExtensions.include/exclude optional access
  - commands/assembly.ts getAgentDir() 无参修正 + Settings.init 动态 import 绕过 shadow
  - daemon/server.ts #openTerminal IIFE await + onExit callback 解构修正
  - daemon/terminal-provider.ts child.off → removeListener; bun-pty 类型断言经 unknown 中转
  - test/assembly.test.ts fixture 补 runtime 字段
  全部编译通过,仅保留既有 updatedAt + collab 两处预存错误。
  - EN: Assembly subsystem type fixes (post-subagent cleanup):
    - assembly/index.ts duplicate `AssemblySessionState` re-export → removed, class kept
    - assembly/index.ts getCachedAgentDir / loadAssemblySync async adjustments
    - assembly/manifest.ts ManifestExtensionItem / compactionMethod type narrowing
    - assembly/verify.ts ManifestExtensions.include/exclude optional access
    - commands/assembly.ts getAgentDir() arg fix + Settings.init dynamic import to bypass shadow
    - daemon/server.ts #openTerminal IIFE await + onExit callback destructuring fix
    - daemon/terminal-provider.ts child.off → removeListener; bun-pty type assertion via unknown
    - test/assembly.test.ts fixture runtime field added
    All compile clean except the two pre-existing updatedAt + collab errors.



## [0.4.4] - 2026-08-24

### Added

- **Windows 安装器升级(NSIS assisted)**:安装可选目录(默认 `%LOCALAPPDATA%\Programs`,
  逐用户免管理员);升级检测复用已装路径并预填;桌面/开始菜单快捷方式 + 卸载项中文名;
  卸载保留用户数据(`deleteAppDataOnUninstall=false`);electron-updater 增量更新兼容。
  - EN: Windows installer upgrade (NSIS assisted): optional install dir (default `%LOCALAPPDATA%\Programs`, per-user, no admin); upgrade detection reuses and pre-fills the installed path; desktop/Start-menu shortcuts + Chinese uninstall entry; uninstall keeps user data (`deleteAppDataOnUninstall=false`); electron-updater incremental-update compatible.
- **GUI 长文本粘贴门控**:粘贴 >100 行或 >4000 字符时弹选择菜单(直接粘贴 / 包裹为
  代码块 / 附加为工作区文件),与 TUI 大粘贴菜单一致。
  - EN: GUI large-paste gate: paste >100 lines or >4000 chars prompts a choice menu (paste / wrap as code block / attach as workspace file), matching the TUI large-paste menu.
- **TUI 粘贴附件芯片**:粘贴文本变 chips 带、图片变
  `🖼 img-1` 原子 token(折叠/compact/shift),`setCollapsedText` 恢复草稿原文。
  - EN: TUI paste attachment chips: pasted text becomes a chip strip, images become `🖼 img-1` atomic tokens (collapse/compact/shift), `setCollapsedText` restores the draft text.
- **右侧面板 Phase 1**:surface 分组(primary/secondary/tertiary)+ rail 溢出菜单
  (diff/pr 折叠)+ 宽度上限 560→900。
  - EN: Right panel Phase 1: surface grouping (primary/secondary/tertiary) + rail overflow menu (diff/pr collapse) + width cap 560→900.
- **OTA 重启更新(electron-updater)**:`下载更新 → 进度条 → 立即重启`,daemon
  sidecar 先杀再 `quitAndInstall`;下载失败回退「前往下载」;CI 发布各平台
  `latest*.yml`(下一版本起 OTA 自动生效)。
  - EN: OTA restart-to-update (electron-updater): download update → progress bar → restart now; daemon sidecar killed before `quitAndInstall`; download failure falls back to “go to download”; CI publishes per-platform `latest*.yml` (OTA takes effect automatically from the next version).
- **Beta 版本通道**:tag 含 `-beta`(如 `v0.4.5-beta.1`)的发布自动标记为 GitHub
  prerelease,并以 `beta` channel 打包(`beta.yml` / `beta-mac.yml` /
  `beta-linux*.yml`,安装版内嵌 app-update.yml `channel: beta`)——beta 安装版
  OTA 只跟 beta 通道,正式用户继续走 `latest*.yml` 互不干扰;正式版发布后
  beta 用户经 electron-updater 的 latest.yml 回退自动升级到稳定版。
  - EN: Beta release channel: tags containing `-beta` (e.g. `v0.4.5-beta.1`) are auto-marked as GitHub prerelease and packaged with the `beta` channel (`beta.yml` / `beta-mac.yml` / `beta-linux*.yml`, installer embeds app-update.yml `channel: beta`) — beta builds only follow the beta channel while stable users keep `latest*.yml` untouched; after a stable release, beta users auto-upgrade to stable via electron-updater's latest.yml fallback.

### Changed

- **文件面板重构**:
  - 预览接管模式——打开文件时预览占满整个面板(原左右分栏 + 拖拽比例已移除),
    顶部返回按钮回树;窄面板下树/预览互斥,不再互相挤压。
  - 路径压缩——单子目录链(`src/components`)合并为一行显示,点开直接展开到
    链内文件。
  - 工具栏新增「新建文件/新建文件夹」按钮(原仅右键可达)。
  - 面板宽度上限 1200px(代码预览可读宽度,窄屏自动适配)。
- **目录选择对话框**:保持右面板 context/files/git/notes/browser
  布局,文件树不迁移左侧。
  - EN: directory picker keeps the right-panel context/files/git/notes/browser layout; file tree not migrated to the left.
- **清理历史遗留 tags**:删除上游 oh-my-pi 遗留 tags(~900 本地 / ~290 远程,
  v0.5.x–v18.x),仅保留 musepi 版本线(v0.2.x + v0.4.x)。
  - EN: Clean up legacy tags: remove upstream oh-my-pi leftover tags (~900 local / ~290 remote, v0.5.x–v18.x), keep only the musepi version line (v0.2.x + v0.4.x).
- **v0.4.3 release body 补全**:全平台下载表格(macOS/Windows/Linux x64/arm64)。
  - EN: Complete v0.4.3 release body: full-platform download table (macOS/Windows/Linux x64/arm64).

### Fixed

- `bun.lock` 未提交 electron-updater 条目导致 CI `--frozen-lockfile` 失败。
  - EN: Fix CI `--frozen-lockfile` failure caused by the electron-updater entry not committed in `bun.lock`.
- **macOS OTA 缺 `.zip` 工件**(源码级核实):MacUpdater 硬性要求 zip
  (`findFile(files, "zip", ["pkg","dmg"])`,无 zip 抛
  `ERR_UPDATER_ZIP_FILE_NOT_FOUND`)——mac target 补 `zip`,CI 上传/发布清单
  同步收录 `*.zip`。
  - EN: macOS OTA missing `.zip` artifact (verified at source): MacUpdater hard-requires zip (`findFile(files, "zip", ["pkg","dmg"])`, throws `ERR_UPDATER_ZIP_FILE_NOT_FOUND` without zip) — added `zip` to the mac target; CI upload/release manifests now include `*.zip`.
### Added (0.4.4 追加,2026-08-25)

- **移动端 MusePi(mobile)**:Capacitor Android 壳(compileSdk 36 / minSdk 24),
  连接局域网 daemon 的远程会话伴侣——三合一发送控件(点阵 bloom 反馈)、盲文
  点阵工作指示器、会话归档(localStorage)、PWA 离线壳 +
  连接码复制优化、旋转/断点几何过渡、时间感知问候与轮换提示、空态建议 chips、
  jsQR 扫码加入、沉浸式 edge-to-edge 布局。
  - EN: Mobile MusePi: Capacitor Android shell (compileSdk 36 / minSdk 24), remote session companion connecting to a LAN daemon — three-in-one send control (dot-matrix bloom feedback), braille dot-matrix working indicator, session archive (localStorage), PWA offline shell + connection-code copy optimization, rotation/breakpoint geometry transitions, time-aware greeting and rotating tips, empty-state suggestion chips, jsQR scan-to-join, immersive edge-to-edge layout.
- **collab 远程会话管理**:guest 可创建/删除/重命名
  会话;agent 主动分享(collab tool,分级审批);`session.abort` 允许 guest
  停止远端正在运行的 turn。
  - EN: Collab remote session management: guests can create/delete/rename sessions; agent-initiated sharing (collab tool, tiered approval); `session.abort` lets guests stop a running turn on the remote daemon.
- **GUI /btw 分支提升**(与 TUI b-branch 一致):/btw 提问
  后「分支」按钮把当前会话切到新会话,问答可见,侧栏出现新分支会话 + 树路径
  transcript 脉冲。
  - EN: GUI /btw branch promotion (matches TUI b-branch): after /btw, the “branch” button switches the current session into a new session, Q&A stays visible, sidebar shows the new branch session + tree-path transcript pulse.
- **撤回语义重构**:撤回改为 branchAt 树跳转——
  旧回复保留为 sibling 分支、树上随时跳回;撤回悬浮卡片带 Reveal 折叠/展开
  动画;daemon 侧 revert RPC 全套移除(-1176 行)。
  - EN: Undo semantics refactor: undo is now a branchAt tree jump — the old reply stays as a sibling branch, jump back anytime from the tree; undo hover card gets Reveal collapse/expand animation; daemon-side revert RPC fully removed (-1176 lines).
- **plan 批准并压缩上下文**:GUI plan 面板第二 primary 按钮,approve 后自动
  compact(与 TUI "Approve and compact context" 一致)。
  - EN: Plan approve-and-compact: second primary button on the GUI plan panel, auto-compacts after approve (matches TUI “Approve and compact context”).
- **浮层定位规范**:全翻转+位移、btw Esc 关闭、菜单 clamp 进视口(不截断);
  AskCard 选择取消按钮、设计语言卡片(floating ask/inspector)。
  - EN: Floating-layer positioning spec: full flip + offset, btw Esc to close, menus clamped into viewport (never clipped); AskCard select-cancel button, design-language card (floating ask/inspector).
- **实例切换器**:连接远程 daemon。
  - EN: Instance switcher: connect to a remote daemon.
- **HarmonyOS NEXT WebView 壳**(ArkTS Web + harmonyNative bridge)脚手架。
  - EN: HarmonyOS NEXT WebView shell (ArkTS Web + harmonyNative bridge) scaffold.
- **Nix 发布修复**:恢复 rust-toolchain.toml、清理 collab-web/robomp-web 死
  路径映射——OMP Nix flake 评估恢复通过。
  - EN: Nix release fix: restored rust-toolchain.toml, cleaned up collab-web/robomp-web dead path mappings — OMP Nix flake evaluation passes again.

### Changed (0.4.4 追加)

- 会话列表按最后活动日期分组(不再按创建时间);agent-activity 行转瞬态
  (agent 完成即清);breadcrumb 仅分支导航时显示。
  - EN: Session list grouped by last-activity date (not creation time); agent-activity rows become transient (cleared when the agent finishes); breadcrumb shown only while navigating branches.
- SessionTreeCanvas 可读总览 + 正确有向流;canvas 聚焦/跳转/搜索交互 +
  轨迹分支车道。
  - EN: SessionTreeCanvas readable overview + correct directed flow; canvas focus/jump/search interactions + trajectory branch lanes.
- rail 溢出菜单弹出动画。
  - EN: Rail overflow menu pop animation.

### Fixed (0.4.4 追加)

- 会话列表日期分组与 canvas 地图语义修正;daemon fork 激活(title-slot 头)+
  message-tree 父级 walk-up;view-key/branch-at 测试清理损坏会话目录。
  - EN: Fix session-list date grouping and canvas map semantics; daemon fork activation (title-slot head) + message-tree parent walk-up; view-key/branch-at tests clean up corrupted session dirs.
- i18n general/settings 域 `active` key 冲突(去重)。
  - EN: Dedupe i18n `active` key conflict in general/settings domains.



## [0.4.3] - 2026-08-22

### Added

- **OTA 更新渠道切换**:GUI 与 daemon 的版本探测统一走 GitHub release 资产重定向
  (`/releases/latest/download/update-manifest.json`,无 api.github.com
  限流);repo 公开前 404 优雅降级为"尚未发布公开更新源"。
  - EN: OTA update channel switch: GUI and daemon version probes both go through GitHub release asset redirects (`/releases/latest/download/update-manifest.json`, no api.github.com rate limit); 404 before the repo is public degrades gracefully to “public update source not yet published”.
- **三合一发送按钮 run 级 working**:agent 工作中按钮变为胶囊 + 点阵 bloom + 「工作中」/
  「停止」双标签;`turn_end` 不再熄灭 working(每工具批次触发),只有 `agent_end` 或权威
  state 帧才复位——修复轮间 provider 准备期按钮闪回发送箭头的问题。
  - EN: Three-in-one send button run-level working state: while the agent works the button becomes a capsule + dot-matrix bloom + “working”/“stop” dual labels; `turn_end` no longer clears working (every tool batch triggers it), only `agent_end` or an authoritative state frame resets — fixes the button flashing back to the send arrow during inter-turn provider preparation.
- **更新提示 toast**:主进程启动 12s 后自动检查,发现新版推送右下角 `UpdateToast`(版本
  当前→最新 + 说明 + 「前往下载」/「跳过此版本」,按版本 localStorage 记忆。
  - EN: Update toast: auto-check 12s after main-process startup; on a new version, push a bottom-right `UpdateToast` (current → latest + description + “go to download”/“skip this version”, remembered per version in localStorage).
- **设置 → 检查更新人性化**:行内显示当前版本/状态 + 手动检查按钮;发现新版展开更新说明
  摘要 + 明确「前往下载」按钮(不再自动 window.open 弹浏览器)。
  - EN: Settings → check for updates, humanized: inline current version/status + manual check button; on a new version, expand the update description summary + explicit “go to download” button (no longer auto window.open popping the browser).

### Changed

- **模型设置 UI**:模型选择器即时刷新 + provider 模型能力/发现对齐 + 角色卡布局与
  project-scope 角色写入+ 思考等级选项/模型切换 clamp 修正。
  - EN: Model settings UI: model picker instant refresh + provider model capability/discovery alignment + role card layout and project-scope role writes + thinking-level option/model-switch clamp fixes.
- **转录渲染**:tool-result 图片内联提升、diff 语言推断、async-result/advisor
  自定义消息渲染、流式 markdown 契约(见 gui-implementation.md §16)。
  - EN: Transcript rendering: inline tool-result images, diff language inference, async-result/advisor custom message rendering, streaming markdown contract (see gui-implementation.md §16).
- **i18n**:词表按域拆分(渲染 12 域/TUI 13 域),en 侧编译级一致性;伙伴文案从
  pet.ts 拆到 companion.ts。
  - EN: i18n: vocab split by domain (12 renderer / 13 TUI), compile-level en consistency; companion copy moved from pet.ts to companion.ts.

### Fixed

- 设置覆盖台账泄露秘密形状 key(`d0df8b77`);GuiSelect 在 roles tab 的无条件 hooks
  React #300 崩溃(`a2a95708`)。
  - EN: Fix settings overlay ledger leaking secret-shaped keys (`d0df8b77`); GuiSelect unconditional hooks crash React #300 on the roles tab (`a2a95708`).
- 子代理面板跨会话接线 + subscribe 时 hydration;预设模式 chip(vmodes.list)
  不再消失。
  - EN: Fix sub-agent panel cross-session wiring + hydration on subscribe; preset mode chips (vmodes.list) no longer disappear.
- 语音页只渲染 Speech 组而非整个交互 tab;语音模型下载流程加固(验证/去重/终止事件)。
  - EN: Voice page renders only the Speech group instead of the whole interaction tab; voice model download flow hardened (verify/dedupe/terminate events).

## [0.4.1] - 2026-08-16

### Added

- **托盘菜单用量区**:同供应商多凭据并排列(每列账户 + 进度条 + 用量/限额),最右侧
  合计列(平均占比);供应商按用量最低优先排序;窗口固定高度(440px),内容内部滚动。
- **GUI /usage 用量面板与上下文圆环配额块**:同供应商全部凭据合并为并排列 + 合计
  列,与 TUI `/usage` 同源(daemon `usage.reports` 共享聚合),活跃凭据 ● 标记。
- **slash 补全排序**:精确/前缀匹配优先,`/usage`、`/context` 等 GUI 原生命令在
  同层匹配中优先(输入 `/c` 时 `/context` 排在 `/clear`、`/compaction` 前)。
- **i18n 词表按域拆分**(渲染端 12 域、TUI 13 域),en 侧编译级一致性(缺/多 key
  编译报错),新增 `registerTranslations` 插件翻译注册 API。
- **用量磁盘缓存**:5 分钟 TTL + 失败时 last-good 快照兜底 + 并发合并,重复查看
  用量零上游请求(daemon 重启后仍生效)。

### Changed

- **/usage 与托盘用量列序修复**:凭据列改为 provider 级固定列序(跨窗口平均用量
  降序)——此前每窗口独立 worst-first 排序导致同一凭据在不同窗口"左右错位"。
- 托盘菜单文案全量接入 i18n(中文/英文随界面语言切换)。

### Fixed

- 托盘用量区同供应商多凭据重复 key 警告(React `Encountered two children with
  the same key`)。
- 上下文圆环配额弹层丢失凭据归属(各供应商限额拍平后无法区分账户)。


## [Unreleased]
