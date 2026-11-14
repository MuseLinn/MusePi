# MusePi GUI 设置面板与主题设计(现状参考)
[English](gui-settings.md) | 中文

> 状态:与 `apps/desktop` / `packages/client-core` 当前实现同步(2026-08-04)。
> 早期规划稿(gui-architecture / gui-migration / gui-prototype)已删除——实现已交付,本文档与 **`docs/gui-design.md`**(设计规范)和 **`docs/gui-implementation.md`**(实现笔记)是唯一现行参考(2026-08-06 拆分为两份)。

## 1. 桌面壳与入口

- **Electron**(`apps/desktop/electron/main.cjs`,加载 `apps/desktop/dist/index.html`)——不是早期文档规划的 Tauri。
- 启动:`bun run desktop` = `bun run build && electron .`;`bun run desktop:run` 只启动 Electron(**不重新构建**,改代码后必须手动 `bun run build`)。
- 渲染进程通过 `RpcClient`(JSON-RPC over WebSocket)连 daemon(`musepi serve --port`)。

## 2. 设置面板布局

2026-09-24 起设置壳层**以槽位替换复用主布局**(不再覆盖聊天列):设置导航填入应用侧栏槽位,`SettingsView` 填聊天列。三部分:

```
gui-main (flex ROW)
├─ .gui-settings-nav-slot   ← 侧栏槽位的替身(壳层激活期间挂载);
│   (width = sideWidth)       SettingsView 将导航列 PORTAL 进这里(按 id 查找)
│                             └─ gui-settings-nav-col ← 分组导航
│                                (基础设置 / AGENT 能力 / 数据与统计)+ 底部引导
└─ gui-chat-col
   └─ .gui-view-enter > gui-settings-view   ← 铺满聊天列
      ├─ gui-settings-drag       ← 48px 窗口拖拽条(与 header 行同一条带)
      └─ gui-settings-main       ← flex:1
         └─ gui-settings-surface ← 圆角浮动卡片(与 gui-chat-surface 同款:
              m-2 + rounded-2xl + var(--color-surface) + 0 4px 24px 阴影)
            └─ gui-settings-content ← 居中列 width:100% / max-width:840px /
                 margin-inline:auto(openchamber SettingsPageLayout parity)
```

- **工作区 keeper**:真实 `SessionSidebar`(`.gui-side-keeper`)与聊天列 header + surface(`.gui-chat-col-keeper`)在壳层激活期间保持挂载、仅 display:none——关闭设置按标准 blur-in 恢复(分组展开态/转录/虚拟列表全部保留)。槽位与 keeper 的决策表在 `src/lib/settings-shell.ts`,契约测试 `test/settings-shell.test.tsx`。
- **已退役**:`.gui-settings-host`(聊天列绝对定位覆盖层)——侧栏不再与第二根导航列并排漂浮;设置导航就是侧栏槽位的内容。

- **圆角卡片**:与主聊天区一致的圆角阴影卡片,与左侧导航在磨砂玻璃背景上分隔。早期"平铺无卡片"实验已被用户否决,恢复卡片。
- **内容列**:840px 居中,左右留白对称;内边距 `calc(32px * density) / calc(48px * density)`。
- **分区**:`.gui-settings-section`(border-t 1px 分隔线,首区无分隔线)+ 标题/描述;字段行 `.gui-settings-field`(224px 标签列 grid,控件右对齐);开关行 `.gui-settings-row`。
- 侧栏导航项、分组标题、下拉控件均按 openchamber 1.18 样式移植。

## 3. 主题体系(三个正交轴)

`packages/client-core/src/lib/theme.ts` + `packages/client-core/src/styles/tokens.css`:

| 轴 | DOM 属性 | 取值 | 存储 key |
|---|---|---|---|
| 配色方案 | `data-theme` / `data-color-scheme` | `light` / `dark`(始终显式解析,无 system) | `omp-collab-theme` |
| 强调色 | `data-accent` | `brand` / `mono` / `ocean` / `jade` / `custom` | `omp-collab-accent`(+ `omp-collab-accent-custom`) |
| 界面主题 | `data-ui-theme` | 浅色:`default` / `warm` / `cool`;深色:`default` / `midnight` / `graphite` | `omp-collab-ui-theme-light` / `-dark` |

- **解析规则**:`data-ui-theme` = 方案为 light 时取浅色主题选择,dark 时取深色主题选择;tokens.css 用 `[data-theme="light"][data-ui-theme="warm"]` 形式限定,浅色预设不会漏进深色方案。
- **自定义强调色**:用户在设置里选色后,`applyAccent()` 内联写入 `--accent` 全家桶(`--accent-fg` 按 WCAG 亮度取深/浅、`--accent-muted` 18% 透明、`--accent-hover` 深色方案提亮/浅色方案压暗、`--accent-bd` 35%、`--brand-mark-gradient` 渐变);切回预设时清除内联变量,恢复 tokens.css 预设块。
- 顶部栏 `AccentToggle` 只循环 4 个预设;自定义色在设置面板管理。
- **模块初始化陷阱**:`initThemeModule()` 必须放在文件末尾调用(前面所有 `let` 存储已初始化),`applyResolvedTheme` 会触发 `applyUiTheme` + `applyAccent`,顺序错误会 TDZ 崩溃。

## 5. 磨砂玻璃

- 玻璃配方:`color-mix(in oklab, var(--bg-overlay) var(--gui-glass-overlay, calc(N% * var(--gui-glass-alpha, 1))), transparent)`(N = 40/55/88)。
- `--gui-glass-alpha` = 透明度滑杆(30-90%,`musepi-gui-glass`)。
- **窗口透明度开关**(`musepi-gui-glass-enabled`):关闭时设置 `--gui-glass-overlay: 100%` 使所有玻璃面不透明,并隐藏滑杆;开启时移除该变量。
- **原生窗口玻璃**(2026-08-04):桌面窗口 `vibrancy: "under-window"` + `backgroundColor: "#00000000"`(无需 `transparent: true`),桌面壁纸透过窗口显示;`base.css` 的 `body { background: var(--bg) }` 由 gui.css 的 `html body` 覆盖为透明(浏览器访客不受影响);`.gui-shell` 透明,侧栏/导航轨/详情面板用 `color-mix(…, transparent)` 半透明蒙层,聊天卡片/设置卡片保持不透明。开关同时通过 `gui-vibrancy` IPC 调用 `setVibrancy`/`setBackgroundColor`(`BrowserWindow.fromWebContents(event.sender)` — 不能直接用 `event.sender`,那是 WebContents)。
- 桌面运行环境:**Electron 43.2.0**(Node 24.18,2026-08-04 从 37 升级;37 已 EOL)。natives loader 的 `import.meta.dir ?? import.meta.dirname` 回退在 Node 24 下无需但无害。

## 5. 设置页各分区(外观页)

- **本地化**:语言 / 时间格式 / 周起始。
- **界面设置**:界面主题(system/light/dark)、浅色主题、深色主题(独立选择)、界面字号、界面字体、对话字体(`--font-transcript`)、间距密度(`--gui-density` 无单位因子,1=100%,calc 乘法必须用数字不能用百分比)、强调色(4 预设 + 自定义)、窗口透明度开关 + 磨砂玻璃透明度、背景色调。
- **代码设置**:浅色/深色代码主题(GitHub/One/Solarized 等,与界面主题正交)、显示行号、长行换行、代码字号、代码字体、终端字号、终端字体(`--font-terminal`)、终端位置(底部/右侧,终端标签支持拖拽与 Alt+左右键排序)。
- **代码预览**:两张 CodePreviewCard 并排,当前生效方案带"当前生效"标签。
- **效果**:头像开关等。

## 5b. 通知与音效(2026-11-13 重做)

- **通知投递**:系统通知、聚焦时也发送系统通知(应用内 toast 独立)、通知提示音(系统音或应用内音效,二选一;默认应用内音效,避免同一事件响两次)；测试通知按钮会同时触发两条通道。
- **通知事件**:完成 / 子任务 / 错误 / 提问各一行,同时提供桌面通知开关、音色选择与试听;音色显示可读名称并支持「无」。
- **应用内通知**:通知事件同步进入右下角 toast 栈(可关闭);窗口聚焦、系统通知被抑制时仍会显示;未聚焦期间产生的 toast 保留到回窗口后再短暂自动关闭。
- **音效**:总开关、音量、免打扰时段、触感反馈;交互音效(发送、审批、停止、切换、工具等)单独分组。
- **默认映射**:`tool` 与 `switch` 默认静音;完成→ready、提问→arrival、审批→pulse、子任务→droplet、拒绝→press。

## 6. 代码高亮(2026-08-04 新增)

- 桌面端聊天代码块与设置预览高亮,复用 **TUI 同款 Rust tree-sitter**(`@musepi/pi-natives` `highlightCode` → ANSI 行)。
- 渲染进程被 sandbox 隔离,原生模块在主进程加载:`main.cjs` `gui-highlight` IPC handler → `preload.cjs` 暴露 `electronAPI.highlightCode` → `apps/desktop/src/lib/highlight.ts`(`nativeHighlight`/`useChatHighlight`,按深浅方案给 GitHub 风 token 色板)。
- 转换纯函数在 guest-client `transcript/highlight.ts`(`ansiLineToHtml`/`highlightToCodeHtml`),`Markdown` 经 `CodeHighlightProvider` 上下文注入;浏览器访客无桥接 → 纯文本降级。
- Markdown 代码块带 `data-hl-hash`(FNV-1a),effect 按 hash 缓存异步高亮,流式重渲染不重复调用桥接。
- 已知坑:Electron 37 / Node 26 无 `import.meta.dir`,natives loader 需 `?? import.meta.dirname` 回退(已修,2026-08-04)。

## 7. 已知要点

- CSS calc 乘法:`calc(28px * var(--gui-density, 1))` 合法;`var(--gui-density, 100%)`(百分比)非法,整个声明静默失效(padding 变 0,无报错)。
- tokens.css 中禁止自定义属性自引用(`--border: var(--border)` 会使 token 变成 guaranteed-invalid,全 app 边框消失)。
- 参考实现:openchamber 已升级到 **v1.18.0**(本地 checkout 在 `/Users/muselinn/harness-engineering/openchamber`,tag `v1.18.0`)。
