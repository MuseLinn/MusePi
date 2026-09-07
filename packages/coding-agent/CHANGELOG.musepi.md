# MusePi Changelog
MusePi 定制版本的发布说明,供启动时的"新功能"面板(`changelog.startup`)与
`/changelog` 展示。上游 oh-my-pi 的变更记录在 `CHANGELOG.md`(本文件存在时
优先读取本文件)。

## [Unreleased]

### Fixed

- **修复升级后设置页显示旧版本(GUI/daemon 版本不一致残留)**:版本门控原只在 daemon 报告 `musepiVersion` 且与 GUI 版本不同时才重启 daemon——CLI 安装/开机自启/其他实例启动的 daemon 不注入 `MUSEPI_VERSION`(`musepiVersion: null`),门控短路跳过,升级后旧 daemon 继续服务,设置页显示旧版。现改为 `musepiVersion ?? version` 与 GUI 版本比对(判定抽为可测纯函数 `lib/daemon-version.ts`,5 用例覆盖)。
  - EN: Fix the settings page showing a stale version after an upgrade (GUI/daemon version mismatch residue): the boot gate only restarted the daemon when it reported `musepiVersion` differing from the GUI version — a daemon from a CLI install / launch-at-login / another instance carries no `MUSEPI_VERSION` (`musepiVersion: null`), short-circuited the gate, and kept serving after the upgrade so settings showed the old version. Now compares `musepiVersion ?? version` against the GUI version (the predicate is extracted to a testable pure helper `lib/daemon-version.ts`, 5 cases).
- **修复 NSIS 安装器误杀终端 TUI/CLI 会话**:electron-builder 默认的 running-app 检测在 PowerShell 分支不可用时回退 `taskkill /IM "${APP_EXECUTABLE_FILENAME}"`(此处为 `MusePi.exe`)按**映像名**匹配——Windows 映像名比较大小写不敏感(实测 `tasklist /FI "IMAGENAME eq MusePi.exe"` 命中 `musepi.exe`),`~/.musepi/bin/musepi.exe`(用户终端 TUI/CLI daemon)与 GUI 的 `MusePi.exe` 字母相同即被命中,静默更新(/S)时直接杀掉,表现为"装个更新把终端会话全杀了"。现通过 `customCheckAppRunning` 宏覆盖默认检测,只终止**可执行路径位于 $INSTDIR 下**的进程(GUI 本体 + 本安装自带的 vendor daemon),用户终端里独立启动的 musepi 进程完全不受影响(openchamber `managed` 标记同款思路)。已验证宏编译进安装包。
  - EN: Fix the NSIS installer killing terminal TUI/CLI sessions: electron-builder's default running-app check falls back to `taskkill /IM "${APP_EXECUTABLE_FILENAME}"` (`MusePi.exe` here) when the PowerShell branch is unavailable — Windows image-name comparison is case-insensitive (verified: `tasklist /FI "IMAGENAME eq MusePi.exe"` matches `musepi.exe`), so a user's `~/.musepi/bin/musepi.exe` (terminal TUI/CLI daemon) shares the letters with the GUI's `MusePi.exe` and gets killed by a silent (/S) update. A `customCheckAppRunning` macro now overrides the default check to only terminate processes whose executable path lives under `$INSTDIR` (the GUI itself + this install's own vendor daemon); independently launched terminal musepi processes are untouched (openchamber `managed`-flag equivalent). Verified the macro compiles into the installer.
- **更新安装失败回滚 + UI 提示**:此前 `quitAndInstall` 裸调,安装器拒绝(签名失败/Squirrel 禁用)只进主进程日志,UI 无感知。现改为 Promise + 15s 宽限:安装失败时回滚 quit/install 状态并在 toast 内联显示错误,可重试(openchamber `installDownloadedUpdate` parity)。
  - EN: Update install failures now surface in the UI: `quitAndInstall` is a Promise with a 15s grace window — a rejected install (signature failure, disabled Squirrel session) rolls the quit state back and shows the error inline in the toast with a retry path, instead of dying silently in the log (openchamber `installDownloadedUpdate` parity).
- **修复更新弹窗下载中 taskbar 无进度提示**:补齐 Windows 任务栏进度条——下载时 `setProgressBar(0..1)`(preparing 阶段 indeterminate),下载完成/出错/开始检查时清除(openchamber parity)。
  - EN: The Windows taskbar now shows download progress during an update — `setProgressBar(0..1)` while downloading (indeterminate during preparing), cleared on completion/error/check start (openchamber parity).
- **更新说明(notes)展开/收起加规范折叠动效**:此前 `-webkit-line-clamp` 折叠与 `display:block` 展开是突变切换。现改为 max-height(6.2em→220px)+ opacity 的 spring 过渡,折叠态保留 4 行预览;`prefers-reduced-motion` 下关闭动画。
  - EN: The update-notes expand/collapse now animates smoothly (max-height 6.2em→220px + opacity with the spring curve) instead of a hard cut between line-clamp and full block; the folded state keeps its 4-line preview and `prefers-reduced-motion` disables the transition.
- **周期轮询检查更新**:除启动 12s 后的首次检查外,每 60 分钟复查一次——应用常驻期间新发布的版本也能浮现,无需等下次重启(openchamber 轮询 parity;`OMP_NO_AUTO_UPDATE=1` 整体关闭)。
  - EN: Update checks now run every 60 minutes in addition to the launch-time check — a release published while the app idles surfaces without waiting for a restart (openchamber polling parity; `OMP_NO_AUTO_UPDATE=1` disables all auto-checks).


## [0.4.19] - 2026-09-07

### Fixed

- **修复 0.4.18 启动崩溃(窗口隐藏到托盘回归)**:`87071a8189` 在将主窗口绑定迁移到隐藏到托盘机制时,误把 `managedBrowser.setOwner(mainWindow)` 与 `mainWindow.on(move/resize)` 提到模块顶层——`mainWindow` 此时仍为 `null`,模块加载即抛 TypeError,Electron 主进程在窗口打开前崩溃,表现为安装后无窗口/源码 `electron .` 无反应。绑定已移回 `createWindow` 内部(webview 弹窗拦截保持在模块顶层一次性注册)。
  - EN: Fix the 0.4.18 startup crash (hide-to-tray regression): `87071a8189` hoisted `managedBrowser.setOwner(mainWindow)` and the `mainWindow.on(move/resize)` handlers to module top level while migrating main-window wiring to the hide-to-tray mechanism — `mainWindow` is still `null` there, so module load throws a TypeError and the Electron main process dies before any window opens (installed app shows no window; source `electron .` does nothing). The wiring is back inside `createWindow` (the webview popup interception stays registered once at top level).

## [0.4.18] - 2026-09-07

### Added

- **轮次折叠头聚合更改条 + 一键回退**(ZCode 更改 chip parity):已完成的轮次折叠头在「时长 · 工具 · 命令」之后新增「更改 N 文件 +A −R」着色 chip——聚合该轮内全部 `edit`/`apply_patch` 结果的 diff 统计(多文件走 `perFileResults`,错误文件不计入),无编辑的轮次不出 chip;chip 尾部撤销按钮一键回退到该轮用户消息之前(复用 `session.branchAt` 分支回退,旧分支保留)。
  - EN: The completed-round fold header gains a ZCode-style aggregate chip ("更改 N 文件 +A −R") after the duration/tool/command counts — summing diff stats across every `edit`/`apply_patch` result in the round (multi-file via `perFileResults`, errored files excluded), omitted for rounds that edited nothing; a trailing undo button branches back to the round's user message (existing `session.branchAt` revert, old branch preserved).
- **文件面板 Markdown 渲染预览与预览工具行**:Files 面板的 `.md` 预览头新增「渲染 | 源码」分段切换(默认渲染,与聊天内 Markdown 同源:表格/代码块/mermaid),HTML 预览原有切换不变;预览头统一补齐「复制路径」「用默认应用打开」两个工具按钮。
  - EN: The Files pane's `.md` preview gains a Rendered|Source segment toggle (defaulting to rendered — same Markdown pipeline as chat: tables, code blocks, mermaid), leaving the HTML live|source toggle untouched; the preview header now consistently offers both "copy path" and "open with default app" tool buttons.
- **⌘1..8 右侧面板直达**(设计文档遗留项落地):按 rail 当前可见顺序直达对应 surface(files/git/browser…,与用户拖拽后的排序一致),面板折叠时自动展开;`app.tsx` 快捷处理层新增 `panelSelectRequest` nonce 通道,`ChatView` 与 `RightRail` 响应同一事件——设置快捷键列表与双语词表同步更新。
  - EN: ⌘1..8 jumps to the nth right-panel surface in the rail's current visual order (honoring drag-customized order), auto-expanding the panel when collapsed — wired via an App-level shortcut plus a `panelSelectRequest` nonce channel into ChatView; the settings shortcuts list and both i18n catalogs are updated.
- **终端 dock 标签按项目持久化**:每个项目的标签 cwd 列表(≤6)记忆在 `musepi-gui-terminal-tabs-{cwd}`,重开 dock / 重启应用后按记忆目录恢复(全新 pty);切换项目时重播种;标签现在可各自 cwd(此前共用会话目录),标签名跟随各自目录 basename。daemon RPC 无改动。
  - EN: Terminal dock tabs persist per project — each project's tab cwd list (≤6) is remembered under `musepi-gui-terminal-tabs-{cwd}` and restored (as fresh pties) when the dock or app reopens; switching projects reseeds the tab set; tabs can now hold their own cwd (previously all shared the session dir), with labels following each tab's basename. No daemon RPC changes.
- **Codex 订阅 GPT-6-Astra 接入**(吸收上游 oh-my-pi 09-03 ~ 09-05 的 5 个提交):`openai-codex` 新增 `gpt-6-astra` 模型(默认 272K 窗口、`/extended-context` 开启后 1.05M、`configuration_update` 推理)、client version pin 升至 `0.153.0`(后端按此版本门控 Astra 可用性)、全部 ChatGPT-OAuth 请求(Responses/compaction/WebSocket 握手)带 `x-codex-routing-hint`、多账号 discovery 对被后端 401/403 拒凭据的账号跳过而非整体中止、GPT-6 会话内稳定 effort 规划(`openai-configuration-update.ts`,request-level effort 恒定 + `configuration_update` input item 承载中途调整)。
  - EN: Codex-subscription GPT-6-Astra support (absorbing five upstream oh-my-pi commits, 09-03–09-05): `openai-codex` gains the `gpt-6-astra` model (default 272K window, 1.05M behind `/extended-context`, `configuration_update` reasoning), the client-version pin moves to `0.153.0` (the backend version-gates Astra availability on it), every ChatGPT-OAuth request (Responses/compaction/WebSocket handshake) carries `x-codex-routing-hint`, multi-account discovery skips accounts whose credential the backend rejected outright (401/403) instead of aborting the whole catalog, and GPT-6 gets mid-conversation stable-effort planning (`openai-configuration-update.ts`): the request-level effort stays pinned while later changes travel as `configuration_update` input items.

### Fixed

- **窗口关闭隐藏到托盘而非退出**(Windows/Linux 桌面惯例):主窗口关闭不再终止整个应用——托盘图标保持存活,用户可通过托盘点击或「显示主窗口」恢复;真正退出仅走托盘「退出」动作(经 before-quit -> daemon 清理 -> app.quit)。托盘创建失败时保留原退出行为,避免无 UI 僵尸进程。
  - EN: Window close hides to tray instead of quitting the app on Windows/Linux — the tray icon stays alive and the user can reopen via tray click or 'show-main-window'; real quit only through the tray 'quit' action (routed through before-quit -> daemon teardown -> app.quit). If the tray was never created, the close falls through to the existing quit path, avoiding a no-UI zombie.

## [0.4.17] - 2026-09-06

### Added

- **`musepi update` 下载进度条**:二进制下载(直接更新与 shim takeover 两条路径)现在实时显示进度——`[████░░░] 47% 23.5MB/50.0MB` 单行原地刷新,33ms 节流;失败/成功时同样的 `downloadFile` 钩子被调用,进度条在成功时自动清除。
  - EN: `musepi update` binary downloads (both the direct-update and shim-takeover paths) now show real-time progress — `[████░░░] 47% 23.5MB/50.0MB` rewritten in place at 33ms throttle; the same `downloadFile` hook fires on both failure and success, with the progress bar clearing automatically on success.
- **错误回复语义重试**(非 naive retry):重试 now obeys `retry.retryable` 而非硬编码清单;`context/retry.ts` 根据错误类型(`retry.retryable` / `retry.message`)判断是否重试,区分网络错误、速率限制、凭据失效等场景;`retry.failed` 状态在 daemon shell 内持久化,重试前恢复 daemon 状态机。
  - EN: Error-reply semantic retry (non-naive): retries now obey `retry.retryable` rather than a hardcoded allowlist; `context/retry.ts` inspects error fields (`retry.retryable` / `retry.message`) to decide whether to retry, distinguishing network errors, rate limits, credential failures, etc.; `retry.failed` is persisted in the daemon shell and the daemon state machine is restored before each retry attempt.
- **键盘快捷键可发现性**(notify + 设置列表):`⌘/` 打开命令面板(命令提示 + 键盘快捷键列),设置 → 快捷键列表也展示快捷键文本(支持平台差异,如 macOS `⌘` 映射为 `Ctrl` 显示),搜索框与分类过滤保持同步;`shortcuts.ts` 与两套 i18n 词表同步更新。
  - EN: Keyboard shortcut discoverability (notify + settings list): `⌘/` opens the command palette (command hints + keyboard shortcut column), and Settings → Shortcuts lists shortcuts with platform-aware display (e.g. `⌘` rendered as `Ctrl` on Windows/Linux); the search box and category filter stay synchronized; `shortcuts.ts` and both i18n catalogs are updated.
- **会话快捷方式可折叠**(panel collapse/expand 持久化):Files 面板折叠后 `⌘1` 等快捷键不再无效——`panelSelectRequest` 先展开 rail 再跳转;折叠态记忆在 `session.railCollapsedSurfaces`,跨会话保持;快捷键现在区分「展开并跳转」与「仅展开不跳转」两种意图。
  - EN: Session shortcuts collapse-aware: `⌘1` etc. no longer silently fail when a rail panel is collapsed — `panelSelectRequest` expands the rail before jumping; collapse state is remembered in `session.railCollapsedSurfaces` and persists across sessions; shortcuts now distinguish "expand-and-jump" from "expand-only" intent.

### Fixed

- **快捷键冲突修复**(`panelSelectRequest` 与 `⌘` 数字键):`⌘1`..`⌘8` 在 Windows/Linux 上不再与浏览器/系统快捷键冲突——daemon RPC 现在通过 `panelSelectRequest` nonce 通道响应,避免直接快捷键冒泡到 WebContents。
  - EN: Shortcut conflict fix (`panelSelectRequest` + `⌘` number keys): `⌘1`..`⌘8` no longer collide with browser/system shortcuts on Windows/Linux — the daemon RPC now responds through the `panelSelectRequest` nonce channel, preventing direct shortcut bubbling into WebContents.
