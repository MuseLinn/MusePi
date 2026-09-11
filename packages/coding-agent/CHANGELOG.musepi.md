# MusePi Changelog
MusePi 定制版本的发布说明,供启动时的"新功能"面板(`changelog.startup`)与
`/changelog` 展示。上游 oh-my-pi 的变更记录在 `CHANGELOG.md`(本文件存在时
优先读取本文件)。

## [Unreleased]

### Fixed

- **修复「保存为图片」弹窗的复制按钮无反应**:复制走的是 `toPng` 生成 data URL 再 `fetch` 取 blob,而渲染层 CSP 的 `connect-src` 不含 `data:`,该 fetch 被浏览器拦截、又被空 `catch` 吞掉——点下去毫无反应(控制台可见 `Refused to connect because it violates the document's Content Security Policy`)。现改用 `toBlob` 直接拿画布 blob,不再经过 data URL,也顺带省掉一次 base64 往返。
  - EN: Fixed the "save as image" dialog's copy button doing nothing: the copy path ran `toPng` → `fetch(dataUrl)` for the blob, but the renderer CSP's `connect-src` does not allow `data:` — the fetch was blocked and the empty `catch` swallowed it, so clicking had no visible effect (the console showed "Refused to connect because it violates the document's Content Security Policy"). It now uses `toBlob`, which returns the canvas blob directly — no data URL, and one less base64 round-trip.

## [0.4.24] - 2026-09-11

### Added

- **设置页模型列表显示能力图标**:设置 → 模型与供应商的模型列表现与输入框的模型选择器一致,逐行显示文本/图片理解/视频理解/图片生成/视频生成/推理图标(同一套图标与文案,tooltip 列出全部能力)。为此 `models.catalog` 随每个模型下发能力标志。
  - EN: The Models & Providers model list now shows the same capability icons as the composer's model picker — text / image understanding / video understanding / image generation / video generation / reasoning, per row, with a shared tooltip listing them. `models.catalog` carries the capability flags for every model to make this possible.

### Fixed

- **修复网关型供应商的模型能力丢失(DeepSeek V4.1 Flash 发图仍无效)**:command-code 这类网关的 `/v1/models` 只返回裸 `{id}`,能力全靠 models.dev 目录回退;而共享目录预热是 fire-and-forget,发现过程赢得竞态时同步视图尚为空,映射器于是落到"纯文本"默认值并被 ModelManager 写进缓存(2 小时 TTL)。表现是 `deepseek-v4.1-flash` 的 `input` 一直是 `[text]`——即便 0.4.23 已放宽请求转换的剥离闸门,`input` 不含 `image` 仍会在第一道判断处拦下图片,能力图标也不显示。现发现过程自行解析目录载荷(带超时,失败回退同步视图)。
  - EN: Fixed lost capabilities for gateway-style providers (DeepSeek V4.1 Flash still could not take images): a gateway like command-code returns bare `{id}` rows from `/v1/models`, so every capability comes from the models.dev catalog fallback — but the shared catalog prime is fire-and-forget, and when discovery won that race the synchronous view was still empty, so the mapper fell through to the text-only defaults and the ModelManager cached them for the 2-hour TTL. `deepseek-v4.1-flash` thus stayed at `input: [text]`, which defeats the 0.4.23 un-stripping fix at its first check (`input` must contain `image`) and hides the capability icons too. Discovery now resolves the catalog payload itself, with a timeout and a fallback to the synchronous view.
- **发布页 changelog 段落错位(历史遗留)**:此前正文生成器取"第一个版本段",升段晚于打包时就会嵌入上一版内容(v0.4.21/v0.4.19/v0.4.16 曾如此,均已按各自版本内容修正)。
  - EN: Fixed misaligned changelog sections on older release pages: the body generator takes the first version section, so a promotion that lagged packaging embedded the previous release's notes (v0.4.21/v0.4.19/v0.4.16 were affected; each now carries its own version's content).

## [0.4.23] - 2026-09-10

### Fixed

- **修复 DeepSeek V4.1 Flash 发图被丢弃**:`isTextOnlyDeepSeek` 以 `id.includes("deepseek")` 一刀切、仅豁免 `ocr`,把真正接受图像输入的模型在请求转换阶段剥成了占位符。现补齐上游 KDL 的 `vision` token 豁免,并单独豁免 V4.1 Flash——models.dev 对其 8 个条目一致声明 `modalities.input: [text, image]`,且已对 command-code 网关实测:带图请求返回 200 并正确读图(能复述图中的红框与侧边栏条目)。纯文本 SKU(如 `deepseek-v4-flash`,models.dev 59 个条目一致声明纯文本)仍按原样剥离。
  - EN: Fixed images being dropped for DeepSeek V4.1 Flash: `isTextOnlyDeepSeek` matched every `deepseek` id and exempted only `ocr`, so models that genuinely accept image input had their images replaced with a placeholder during request conversion. The guard now mirrors upstream's KDL `vision` token carve-out and additionally exempts V4.1 Flash — models.dev declares `modalities.input: [text, image]` across its eight entries, and a live image request against the command-code gateway returned 200 and read the image correctly (it recited the screenshot's red box and sidebar entries). Text-only SKUs such as `deepseek-v4-flash` (declared text-only across 59 models.dev entries) are still stripped as before.
- **修复设置页自定义供应商区块在其它标签页重复出现**:`CustomProviderPane` 原先无条件渲染,于是"角色模型/模型行为/供应商"三个标签页底部也长出整个区块(标题+列表+添加按钮),与第四个同名标签页重复。现收敛到它自己的标签页。
  - EN: Fixed the custom-providers section appearing on every Models & Providers tab: `CustomProviderPane` rendered unconditionally, so the roles/behavior/providers tabs each grew the whole section (title, list, add button) below their own content, duplicating the dedicated tab. It now renders only on that tab.

## [0.4.22] - 2026-09-10

### Added

- **内置 `musepi-contributing` 提交规范 skill**:按项目模板与 CONTRIBUTING
  规范帮用户起草/提交 issue、PR、commit 与 changelog(PR body 必含用户本人
  一句、别为自提工作开 issue、`musepi --version` 字段等),安装进用户技能列表。
  - EN: New bundled `musepi-contributing` skill routes issue/PR/commit/release
    submissions through the project's templates and CONTRIBUTING rules (PR
    body must include the user's own sentence, no issue for work you will
    implement, `musepi --version` field, …), installed into the user skills list.

### Fixed

- **仓库品牌本地化(清理 oh-my-pi / omp / robomp 残留)**:CONTRIBUTING 标题与
  维护者表述、issue 模板的 `omp version` 字段(`musepi --version`)与 provider
  说明、issue 链接与安全公告从 can1357/oh-my-pi 指回 MuseLinn/MusePi 仓库
  docs、`OMP Nix` workflow 显示名,以及 coding-agent README 的自称与
  `~/.omp/config.yml` 路径(`~/.musepi/agent/config.yml`)。运行时兼容路径
  (`.omp` 项目级发现、`OMP_*` 环境变量、`omp-*` 事件)是契约,未改动。
  - EN: Repo branding localisation (oh-my-pi / omp / robomp residue): the
    CONTRIBUTING title and maintainer wording, the issue templates' `omp
    version` field (now `musepi --version`) and provider copy, issue links and
    the security advisory pointing at can1357/oh-my-pi (now MuseLinn/MusePi
    docs), the `OMP Nix` workflow display name, and the coding-agent README
    self-description plus its `~/.omp/config.yml` path
    (`~/.musepi/agent/config.yml`). Runtime compat surfaces (`.omp` project
    discovery, `OMP_*` env vars, `omp-*` events) are contracts and untouched.

## [0.4.21] - 2026-09-08

### Added

- **Agnes 3.0 Flash 上架并设为默认**(CN + 国际站):`agnes-3.0-flash` 已加入 agnes / agnes-global 内置目录(512K ctx、text+image、刊例价同 2.5-flash、当前 promo ¥0,规格来自 wiki.agnes-ai.cn 2026-09-08),两站默认模型从 `agnes-2.5-flash` 切到 `agnes-3.0-flash`。
  - EN: Agnes 3.0 Flash is now bundled and the default on both the CN and global providers — `agnes-3.0-flash` joins the agnes / agnes-global static catalogs (512K ctx, text+image, list pricing identical to 2.5-flash, currently ¥0 promo; specs per wiki.agnes-ai.cn 2026-09-08) and both descriptors default from `agnes-2.5-flash` to `agnes-3.0-flash`.

### Fixed

- **Windows 冷启动闪黑窗(MCP cmd.exe/npx 包装链产生孙进程)**:`windowsHide` 只控制直接子进程——npx.cmd 走 `cmd.exe /c` 时孙进程无 console 抑制即闪窗。stdio transport 现直接解析 Windows npm 手写 batch shim(`%~dp0` 形态,区别于 cmd-shim 的 `%dp0%`)直跑 `node npx-cli.js`,不再经 cmd.exe;`where.exe` 探测补 `CREATE_NO_WINDOW`;spawn guard 安装扩展到 `runCli()` 入口,`__omp_worker_*` 子进程同享 windowsHide 注入。冷启动与 agent 执行路径均无可见 conhost 闪窗。
  - EN: Windows cold-start console flashes (MCP cmd.exe/npx wrapper chain spawning grandchildren): `windowsHide` only governs direct children — `cmd.exe /c npx` leaked an uncontrolled grandchild console. The stdio transport now parses npm's hand-written Windows batch shims (`%~dp0` shape, distinct from cmd-shim's `%dp0%`) and runs `node npx-cli.js` directly, bypassing cmd.exe; the `where.exe` probe gained `CREATE_NO_WINDOW`; the spawn guard now installs at the `runCli()` entry so `__omp_worker_*` children get windowsHide too. No visible conhost flashes on cold start or agent execution.
- **修复 opencode-go / opencode-zen 发消息 400 MissingSessionID**:两个网关自 2026-09-06 起强制 `x-opencode-session` 请求头——推理请求、用量轮询与模型发现现统一补发(会话 id 优先,回退 install id)。
  - EN: Fix opencode-go / opencode-zen 400 MissingSessionID: both gateways now require the `x-opencode-session` header — inference, usage polling and model discovery all send it (session id first, install id fallback).
- **修复 lark grammar 跨包 text-import 编译路径泄漏**:edit 引擎的 hashline grammar/prompt 改从包内相对路径加载,避免编译成 Windows 单文件后把 Bun 虚拟路径当 grammar 内容发给 codex 导致 `Invalid lark grammar`。
  - EN: Fix lark grammar path leakage from cross-package text imports: the edit engine now loads its hashline grammar/prompt via in-package relative imports so a Windows single-file compile can't substitute a Bun virtual path for grammar text (the `Invalid lark grammar` error when talking to codex).
- **GUI 长文本粘贴选择卡无样式(裸文字内嵌)**:`long-paste` 对话框自引入起从未配套 CSS——四个选择按钮被全局样式重置成一行文字。现补全卡片与 accent pill 按钮样式(与 slash-note/magic-tip 同系列视觉)。
  - EN: The GUI long-paste chooser rendered unstyled (bare text inline): the dialog never shipped its CSS since introduction, so its four action buttons collapsed into a run of reset text. The card and accent-pill button styles are now defined, matching the slash-note/magic-tip family.
- **GUI 输入框对程序性文本插入不伸缩**:粘贴选择、撤回插入等 `setText` 绕过 textarea onChange,原 autosize 只在各插入路径手动调用且粘贴分支漏调。现按值驱动兜底(文本每次提交后 rAF 重测),150 行粘贴插入后输入框正确长到 8 行上限并滚动。
  - EN: The GUI input no longer failed to grow on programmatic inserts (paste-choose, queue pop-back…): those `setText` paths bypass the textarea onChange and autosize was only invoked per-path, with the paste branch missing it. A value-driven fallback now re-measures after every draft commit — a 150-line paste insert grows the box to its 8-row cap with scrolling.
- **GUI 排队面板 Steering(引导)消息项补「立即发送」**:与 After-yield(排队)项对称——引导队列里的消息现可单条立即发出(`session.queuedSend` 本就支持 steering 组:从队列移除并即刻作为 steer 投递),不再只有撤回。
  - EN: Steering queue items now have a per-item "send now" button, mirroring After-yield items — a queued steer can be delivered immediately (`session.queuedSend` already accepted the steering group: it removes the entry and delivers it as a steer right away) instead of only being takable back.


## [0.4.20] - 2026-09-07

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
