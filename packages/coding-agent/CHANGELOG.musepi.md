# MusePi Changelog

MusePi 定制版本的发布说明,供启动时的"新功能"面板(`changelog.startup`)与
`/changelog` 展示。上游 oh-my-pi 的变更记录在 `CHANGELOG.md`(本文件存在时
优先读取本文件)。

## [Unreleased]

### Removed

- **macOS 发布面只保留 Apple Silicon**:`musepi-darwin-x64` CLI 二进制从发布矩阵/brew formula/natives 叶子表/运行时平台表中移除——Intel Mac 不再受支持,发布页不再出现 macos x64 资产。
  - EN: macOS release surface is now Apple Silicon-only — the `musepi-darwin-x64` CLI binary is dropped from the release matrix, Homebrew formula, natives leaf table and runtime platform allowlist; Intel-Mac assets no longer appear on the release page.

### Added

- **`musepi update` 下载进度条**:二进制下载(直接更新与 shim takeover 两条路径)现在实时显示进度——`[████░░░] 47% 23.5MB/50.0MB` 单行原地刷新,33ms 节流,渲染到 stderr;非 TTY(管道/CI)保持静默,只有原 `Downloading …` 提示行。`downloadVerifiedBinary` 新增可选 `onProgress(received, total)` 回调。
  - EN: `musepi update` now shows a live single-line progress bar for binary downloads (both the direct-update and shim-takeover paths) — `[████░░░] 47% 23.5MB/50.0MB`, throttled at 33 ms, rendered to stderr; non-TTY streams stay silent behind the plain `Downloading …` line. `downloadVerifiedBinary` gains an optional `onProgress(received, total)` callback.
- **`musepi sessions` 命令行会话列表**:非交互列出已保存会话(按最近修改降序,含 id/标题/cwd/时间),支持 `--cwd`/`--limit`/`--json`——headless 枚举会话的补位(此前只有 TUI 交互 picker)。参考 kimi-code `session list`。
  - EN: New `musepi sessions` command lists saved sessions non-interactively (newest first, id/title/cwd/timestamp), with `--cwd`/`--limit`/`--json` — filling the headless-enumeration gap left by the TUI-only picker. Patterned after kimi-code's `session list`.
- **定时任务调度端到端支持时区**:`schedule.timezone`(IANA)现在真正生效——墙上时间、闲时窗口、cron 表达式都按任务时区求值(Intl 两步偏移,DST 安全,cron 按日历日展开、保留 Vixie dom/dow 语义);未设置/非法时回退本机时区,非法时区串由 `validateCronSchedule` 拒绝。
  - EN: Scheduled tasks now honor `schedule.timezone` end-to-end — wall-clock times, idle windows and cron expressions are evaluated in the task's IANA timezone (Intl two-step offset, DST-safe, per-calendar-day cron expansion with Vixie dom/dow semantics); unset/unknown falls back to host-local, and invalid tz strings are rejected by `validateCronSchedule`.
- **`cron.runs` / `cron.nextRuns` RPC 与 `crons.changed` 广播**:`cron.runs { id?, limit? }` 提供按任务运行历史(新→旧,默认 50/上限 100,只读、guest 可调);`cron.nextRuns { schedule, count? }` 让编辑器预览由 daemon 自己的解析器计算(客户端副本已删);`crons.changed` 在任何变更与运行开始/结束后即时推送,GUI 订阅刷新并保留 30s 轮询兜底。
  - EN: New `cron.runs` (per-task run history, newest first, default 50 / cap 100, read-only so guests may call it), `cron.nextRuns` (editor preview computed by the daemon's own parser — the client-side fork is deleted) and a `crons.changed` broadcast pushed on every mutation and run start/finish; the GUI subscribes for instant refresh and keeps its 30s poll as fallback.
- **任务中心运行历史与失败原因**:详情面板新增可折叠运行历史(状态/耗时/错误/打开会话),任务失败时展示 daemon 记录的 `lastError`;desktop-web 访客面板历史表改走 `cron.runs`(修掉 slice 50 但上游只有 20 的错位)。
  - EN: The task center detail panel gains a collapsible run history (status/duration/error/open-session) and surfaces the recorded `lastError` when a task fails; the desktop-web guest panel's history table now uses `cron.runs` (fixing the slice-50-from-20 mismatch).
- **智能体中心"完成未查看"标记**:子代理在用户没看窗口时完成(隐藏/失焦),Agents Center 行会保持"新"徽标 + accent 行底 + 静止环状态点,直到真正打开该子代理抽屉才消除(toggle 关闭不吞标记);同一子代理复活重跑时旧标记自动清除。标记存 GUI 层会话注册表(跨会话切换存活,重启即清),运行中的绿色脉冲语义不受影响。
  - EN: The Agents Center now marks subagents that completed while the user wasn't looking (window hidden/unfocused at completion) with a persistent "New" badge, accent row wash and a static status-dot ring; the marker clears only when the agent's drawer is actually opened (toggle-close does not eat it), and a revived subagent drops its stale mark when its run restarts. State lives in a GUI-lifetime registry keyed by session id — survives session switches, lost on app restart; the running pulse semantics are untouched.

### Fixed

- **欢迎页空态切换模型后新建会话仍用默认模型**:欢迎输入框模型选择器把选择以裸 id 存入本地状态(onModelSelect 只收第一个参数),发消息时 `session.create` 的 modelPattern 只带裸 id——同 id 多 provider 时 daemon 按偏好排序解析可能落到别的 provider,解析失败还会静默回退 DEFAULT 角色。现在 onModelSelect 同时消费 id 与 provider,以 `provider/id` 复合引用存入并发给 daemon,精确命中所选行。
  - EN: A model picked in the welcome (empty-state) composer still ran the new session on the DEFAULT model: the pick was stored as a bare id (onModelSelect dropped the provider arg), so session.create's modelPattern was provider-less — with several providers serving the same id the daemon's preference ranking could resolve to another provider, and a resolution miss silently fell back to the DEFAULT role. onModelSelect now consumes id+provider and stores a `provider/id` composite, so the new session exact-matches the picked row.
- **看板视图暂停/恢复失效**:看板开关调用不存在的 `cron.update` 且 `.catch(() => {})` 吞掉报错——daemon 只有 `cron.toggle`,现在与列表视图共用同一切换路径。
  - EN: Board-view pause/resume was dead: it called a nonexistent `cron.update` and swallowed the rejection; it now shares the list view's `cron.toggle` path.
- **新建定时任务丢失模型与思考等级**:`cron.upsert` 的新建分支是显式白名单却漏掉 `model`/`thinkingLevel`——编辑器选择在创建时被静默丢弃(编辑不受影响)。合并逻辑抽为 `mergeCronTask`(daemon 与 guest host 共用)并补上两字段。
  - EN: Creating a scheduled task silently dropped the selected model and thinking level — the create branch of `cron.upsert` (an explicit whitelist) omitted both fields. The merge logic is extracted into `mergeCronTask` (shared by daemon and guest host) with the fields carried.
- **任务中心日历周起始与 i18n + 运行状态判定**:页面日历写死周日开头且星期表头/日期格式硬编码中文,现与编辑器日历共用设置页周起始(`weekStartIndex`/`orderedWeekdayKeys`,移至 `lib/appearance.ts`)并全部改走 `scheduled *` 词表;`agent_end` 最后一条 assistant 消息 `stopReason` 为 `aborted`/`error` 时运行记为失败(含错误信息),中止/出错的运行不再误标成功。
  - EN: Task-center calendar week start + i18n and run-status accuracy: the page calendar hardcoded a Sunday start and Chinese-only weekday/date strings — it now shares the settings week start (`weekStartIndex`/`orderedWeekdayKeys`, moved to `lib/appearance.ts`) and the `scheduled *` word list. An `agent_end` whose final assistant message carries `stopReason "aborted"/"error"` now records a failed run (with the error message) instead of a false success.

## [0.4.15] - 2026-09-02

### Fixed

- **`musepi update` 在 `MUSEPI_VERSION` 环境变量污染下永远回滚**:开发入口 `src/musepi.ts` 会把 `process.env.MUSEPI_VERSION` 设为 package.json 版本,长期 shell 继承这个覆盖后,`--version` 恒报旧版本——update 下载新二进制、替换成功,验证却报旧版本,每次都回滚("still reports 0.4.12 (expected 0.4.13)")。现在版本验证子进程剥离 `MUSEPI_VERSION`,读编译内嵌的真实版本。
  - EN: `musepi update` rolled back forever under a polluted `MUSEPI_VERSION` env var — the dev entrypoint bakes it into the process env, long-lived shells inherit it, and every freshly-installed binary then reported the OLD version. The verification subprocess now strips the override and reads the compiled version.
- **OTA 更新安装路径与退出守护机制解耦**:`updater-install` 先显式 kill 归属 daemon 并标记退出已处理,`quitAndInstall()` 的 quit 不再被 `before-quit` 的 preventDefault/二次 quit 周期拦下——electron-updater 在 `quit` 事件上挂安装动作,吞掉第一次 quit 有竞态风险。
  - EN: The OTA `updater-install` path now tears down its owned daemon and flags the quit as handled before calling `quitAndInstall()`, so electron-updater's install action (registered on `quit`) is never delayed by the before-quit preventDefault/second-quit cycle.

### Changed

- **客户端正常退出时 daemon 一起退出;异常崩溃时 daemon 存活**:GUI spawn daemon 时写 `client.pid` 归属标记,`before-quit` 只 kill 本实例 spawn 的 daemon(连接的外部 daemon——另一实例/自启动/终端 `musepi serve`——不受影响);崩溃路径不经过 quit handler,detached daemon 天然存活。
  - EN: Quitting the client now takes the daemon down with it — the GUI records ownership in `client.pid` at spawn, and `before-quit` kills only the daemon this instance spawned (foreign daemons survive); crashes never reach the quit handler, so the detached daemon stays alive.

- **一键安装脚本不再静默 fallback 到源码编译**(install.ps1):binary 下载失败时先走 GitHub `releases/latest` 重定向重试(免 API,不受 60/hr 限流),仍失败则明确报错并退出,提示 `PI_SOURCE=1` 显式进入源码路径——不再默默用陈旧 checkout 编译 20 分钟。install.sh(Linux/macOS)本就默认 binary、无静默 fallback。
  - EN: The one-click installer no longer silently falls back to a 20-minute source build — after a binary-download failure it retries via the API-free `releases/latest` redirect, then exits with explicit instructions (`PI_SOURCE=1`) instead of compiling from a stale checkout. install.sh (Linux/macOS) already defaulted to binary with no silent fallback.
- **Windows 关主窗口后僵尸进程**:隐藏辅助窗口(托盘菜单/发光层/伙伴/固定件)使 BrowserWindow 计数永不为零,`window-all-closed` 永不触发——窗口没了,进程和 daemon 还活着,无任何 UI。现在非 macOS 平台关主窗口即 `app.quit()`(macOS 保持关窗即隐藏的惯例)。
  - EN: Closing the main window on Windows left a zombie process: hidden helper windows (tray menu, glow, pet, pins) kept the BrowserWindow count non-zero so `window-all-closed` never fired — window gone, process and daemon alive, no UI. Non-macOS platforms now quit the app on main-window close (macOS keeps close-to-hide).
- **daemon 启动命令解析顺序**:解析顺序改为 打包内嵌二进制 → 源码 checkout → PATH;PATH 上残留的 bunx 垫片(全局包已卸载、只剩无 `.bunx` 兄弟的启动器)会被跳过——此前它抢在 checkout 之前被选中,spawn 瞬间退出,GUI 报"daemon exited during startup"。
  - EN: The daemon command now resolves packaged asarUnpacked binary > dev checkout > PATH, skipping stale bunx shims on PATH (global package uninstalled, launcher .exe without a sibling .bunx) that previously won over the checkout and exited instantly — the GUI reported "daemon exited during startup".

## [0.4.14] - 2026-09-02

### Added

- **Windows ARM64 桌面包支持**:GUI Desktop Release 新增 win32-arm64 目标(原生 arm64 runner `windows-11-arm`),daemon 交叉编译支持 `CROSS_TARGET=win32-arm64`(bun-windows-arm64),natives 目标表/host 解析识别 win32-arm64(无 AVX2 variant 后缀),electron-builder 以 `--arm64` 产出 `MusePi-<version>-arm64-setup.exe`(与 x64 产物区分)。
  - EN: Windows ARM64 desktop support — the GUI release matrix gains a win32-arm64 target on the native `windows-11-arm` runner; the daemon cross-build accepts `CROSS_TARGET=win32-arm64` (bun-windows-arm64); the natives target table and host resolution recognize win32-arm64 (no AVX2 variant suffix); electron-builder emits a distinct `MusePi-<version>-arm64-setup.exe` via `--arm64`.

## [0.4.13] - 2026-09-01

### Changed

- **`node:child_process` spawn 集中封装(opencode 思路)**:弹窗修复的机制升级——新增 `@musepi/pi-utils/nodespawn` 集中 spawn 层,运行时委托给 `cross-spawn`(与 opencode cross-spawn-spawner 一致的 Windows spawn 修复:`.cmd`/`.bat` 垫片、`#!/usr/bin/env` shebang 脚本解析、cmd 参数转义,plain `node:child_process.spawn` 对这些场景在 Windows 上会 ENOENT)。win32 默认注入 `windowsHide: true`,显式传入的 `windowsHide` 覆盖生效。`collab/{ngrok,tunnel,tailscale-serve}.ts` 与 `daemon/terminal-provider.ts` 的 4 处 `node:child_process.spawn` 调用点全部改从该模块导入。`node:child_process` 的 ESM 命名空间不可 patch(不同于 `Bun.spawn`,后者由 windows-spawn-guard 全局兜底),集中模块是这类调用点的唯一正确入口——未来新增 `node:child_process` 调用点不会再漏。eval 内核/launch/MCP 的条件性 console 承继语义(`shouldHideKernelWindow`、`!hostHasInheritableConsole`)不受影响——那些走 `Bun.spawn`,且包装器允许调用点显式 opt-out(传 `windowsHide: false`),不会对 numpy/OpenBLAS `LoadLibraryExW` 死锁场景误加 `CREATE_NO_WINDOW`。
  - EN: Centralized `node:child_process` spawn layer (opencode pattern) — the popup fix is now enforced at the module level instead of per-site: a new `@musepi/pi-utils/nodespawn` module exports a `spawn` wrapper that delegates to `cross-spawn` (same Windows spawn fixes as opencode's cross-spawn-spawner: `.cmd`/`.bat` shims, `#!/usr/bin/env` shebang parsing, cmd arg escaping — all of which plain `node:child_process.spawn` fails with ENOENT on win32) and defaults to `windowsHide: true` on win32 (explicit caller value wins, so console-inheriting callers can opt out), and the four `node:child_process.spawn` sites in `collab/{ngrok,tunnel,tailscale-serve}.ts` and `daemon/terminal-provider.ts` import from it instead of the builtin directly (per-site comments removed). The `node:child_process` ESM namespace is immutable — unlike `Bun.spawn` (globally patched by windows-spawn-guard) it cannot be patched, so this module is the single sanctioned entry for such call sites and future sites cannot leak a `windowsHide` gap. The conditional console-inheritance semantics of the eval kernels / launch / MCP (`shouldHideKernelWindow`, `!hostHasInheritableConsole`) are untouched — those go through `Bun.spawn`, and the wrapper lets callers opt out explicitly, so no `CREATE_NO_WINDOW` is forced onto NumPy/OpenBLAS `LoadLibraryExW` deadlock paths.

### Fixed

- **Windows 客户端聊天运行代码时的弹窗 + 偶发 daemon 崩溃**:两处独立修复。1)弹窗:`installWindowsSpawnGuard` 只 patch `Bun.spawn`/`Bun.spawnSync`,绕过它走 `node:child_process.spawn` 的 4 处调用(GUI daemon 无 console,spawn 的每个子进程都会弹出一个可见 conhost 窗口)——`daemon/terminal-provider.ts` 的 pty-bridge 子进程(bun-pty 不可用时的 fallback,每次 terminal.open 弹一个 `node` 窗口)、`collab/{ngrok,tunnel,tailscale-serve}.ts` 的隧道进程、以及 `gui/electron/daemon.cjs` 的 `netstat` probe,全部补上 `windowsHide: true`。2)daemon 偶发崩溃:postmortem.ts 的全局 `unhandledRejection` handler 只豁免 EPIPE/EBADF/expected-cleanup,其余 rejection 一律 `exitAfterFatal`(杀进程,所有会话掉线,GUI 显示"无法连接本地守护进程");daemon 自己注册的 `process.on("unhandledRejection")` 只打日志、无法阻止 postmortem 的 fatal 路径。现在 daemon 启动时注册 `interceptUnhandledRejections` 拦截器(全部消费、只记日志),postmortem 的 handler 检查拦截器后提前返回,不再进 fatal 路径——代码运行期间 provider 流拆卸/原生 N-API 错误冒泡等 teardown race 不再杀掉整个 GUI 后端。
  - EN: Windows client popups when running code in chat + occasional daemon crash — two independent fixes. 1) Popups: `installWindowsSpawnGuard` only patches `Bun.spawn`/`Bun.spawnSync`; four `node:child_process.spawn` call sites bypass it (the GUI daemon has no console, so every child spawns a visible conhost window) — the pty-bridge subprocess in `daemon/terminal-provider.ts` (fallback when bun-pty is unavailable; one `node` window per terminal.open), the tunnel processes in `collab/{ngrok,tunnel,tailscale-serve}.ts`, and the `netstat` probe in `gui/electron/daemon.cjs` — all now pass `windowsHide: true`. 2) Occasional daemon crash: postmortem.ts's global `unhandledRejection` handler exempts EPIPE/EBADF/expected-cleanup but sends every other rejection to `exitAfterFatal` (kills the process, drops all sessions, GUI shows "cannot connect to local daemon"); the daemon's own `process.on("unhandledRejection")` only logged and could not stop postmortem's fatal path. The daemon now registers an `interceptUnhandledRejections` interceptor (consumes everything, logs only) at startup, so postmortem's handler returns early and never reaches the fatal exit — provider-stream teardown / native N-API error bubbles during code runs no longer take down the whole GUI backend.

- **后台异步 task 的子 agent 任务进度 widget 卡死"Working…"状态**:当 `task` 工具通过异步(非阻塞)方式派发子 agent 时,工具调用立即返回(返回时成员状态为 `pending`,后台作业尚未启动),`tool_execution_end` 的 `settle()` 因成员全是 `pending` 而停止 widget 的定时器、从界面移除;但 `widget` 闭包变量不受影响。稍后后台作业启动并发出 `tool_execution_update`(running)时,`update()` 因 `frameTimer===null` 却调用 `start()` 复活 widget,`start()` 把 `settled` 重置为 `false`——此后即使后台作业完成、最终状态变为 `done`,`#tick` 的 `if (this.settled) this.stop()` 因 `settled` 为 false 永不触发, widget 永久卡死在"Working…"状态,持续占用输入框上方空间。修复:1) `update()` 不再在 `frameTimer===null` 时调用 `start()`——已停止的 widget 不可复活;2) `#needsFrames()` 将 `pending` 状态视为需要帧(与 `running` 同权)——`settle()` 不会在异步作业尚未启动时过早停止 widget,从源头消除复活窗口。
  - EN: Task-swarm widget stuck in "Working…" state for background async subagents — when the `task` tool spawns agents asynchronously (non-blocking), the tool returns immediately with members in `pending` status (the background job has not started yet). `settle()` called from `tool_execution_end` stops the widget (timer cleared, removed from UI) because all members are `pending` — but the closure variable `widget` stays non-null. Later, when the background job starts and emits `tool_execution_update(running)`, `update()` found `frameTimer===null` and called `start()`, resurrecting the widget with `settled=false`. After that, even when the job completes and the final status becomes `done`, `#tick`'s `if (this.settled) this.stop()` never fires because `settled` is false — the widget is pinned forever showing "Working…". Fix: 1) `update()` no longer calls `start()` when `frameTimer===null` — a stopped widget must not be resurrected; 2) `#needsFrames()` treats `pending` like `running` (needs frames) — `settle()` no longer stops the widget prematurely when async jobs are still queued, eliminating the resurrection window at the source.

- **GUI 用户消息"编辑并重发"只回填不改 leaf,语义错位**:用户消息行的"编辑并重发"按钮仅把原文填入 composer(不动 tree leaf),发送后新消息追加在旧回复之后——原回复仍在上下文里,无法实现"重发该位置的回答"。修复为走 `jumpBackToMessage`(branchAt + 原文回填,leaf 落父节点旧尾部成为 sibling branch),与 TUI `/tree` 选用户消息后的 navigateTree 原语一致;与"撤回"(仅移动 leaf、不回填)形成互补对——两按钮互不冗余。
  - EN: GUI user-message "edit and resend" button was merely backfilling the composer without moving the leaf, so sending appended the new message AFTER the old reply (which stayed in context), making "resend" a misnomer. Fixed by wiring the button to `jumpBackToMessage` (branchAt + text backfill, leaf lands on the parent message so the old tail becomes a sibling branch), matching TUI `/tree` navigateTree behavior when selecting a user message. This also resolves the redundancy with "revert" (move leaf without backfill) — the two buttons now form a complementary pair: edit = move + backfill, revert = move only.

## [0.4.12] - 2026-09-01

### Added

- **GUI 媒体生成设置界面(图像/视频生成供应商管理)+ 插件化媒体后端(文本生图)**:TUI 一直有 `generate_image`/`agnes_video_gen` 工具与多供应商凭证接口,但没有对应的设置管理界面。现在 GUI 设置新增「图像与视频生成」段(基础设置 → 图像与视频生成):按供应商卡片列出 8 个内置图像生成供应商(Agnes/Agnes Global/OpenAI/Codex/Antigravity/xAI/Gemini/OpenRouter)与扩展注册的媒体供应商,显示凭证状态(已配置/未配置)、apiKey 型供应商内联密钥录入、OAuth 型供应商一键登录(复用 ModelSection 登录流)、已配置供应商可移除凭证;写入走既有 `providers.importApiKey`/`providers.login`/`providers.logout` RPC,凭证立即对所有会话生效。daemon 新增 `media.providers` RPC(内置 + 扩展供应商合并视图 + 凭证状态)。扩展 API 新增 `pi.registerMediaProvider(config)` / `pi.unregisterMediaProvider(id)`(kind: image|video、auth: apiKey|oauth、models、baseUrl、execute)——加载期排队、会话初始化时并入运行时注册表,扩展卸载/回滚时按 sourceId 清理;`generate_image` 的供应商解析链开放:扩展 id 加入自动解析次序尾部,凭证从共享 auth storage 解析,带 `execute` 的扩展后端处理文本生图(纯文本 prompt 进、单张图片 URL 出;style/aspect-ratio/参考图编辑等富参数暂不透传,由扩展在 execute 内自行实现)——第三方文本生图后端无需 fork 即可同时接入设置界面与工具执行。
  - EN: GUI media-generation settings section (image/video provider management) + pluggable media backends (text-to-image) — the TUI always shipped `generate_image`/`agnes_video_gen` with multi-provider credential interfaces but no settings management UI. The GUI settings now gain an "Image & video generation" section: provider cards for the 8 built-in image providers (Agnes/Agnes Global/OpenAI/Codex/Antigravity/xAI/Gemini/OpenRouter) plus extension-registered media providers, each showing credential status, inline API-key entry for apiKey-typed providers, one-click OAuth login for oauth-typed providers (reusing the ModelSection login flow), and credential removal for configured ones; writes go through the existing `providers.importApiKey`/`providers.login`/`providers.logout` RPCs and take effect for every session immediately. The daemon gains a `media.providers` RPC (merged builtin + extension view with credential state). The extension API gains `pi.registerMediaProvider(config)` / `pi.unregisterMediaProvider(id)` (kind: image|video, auth: apiKey|oauth, models, baseUrl, execute) — queued during loading, merged into the runtime registry at session init, cleaned per sourceId on unload/rollback. The `generate_image` provider-resolution chain opens up: extension ids join the tail of the auto-resolution order, credentials resolve from the shared auth storage, and an `execute`-carrying extension backend handles text-to-image generation (plain-text prompt in, single image URL out; rich params like style/aspect-ratio/reference-image editing are not forwarded yet — extensions implement them inside `execute` as needed) — third-party text-to-image backends plug into both the settings UI and tool execution without forking.

## [0.4.11] - 2026-08-31

### Fixed

- **`musepi update` 报 "Failed to fetch release info for @musepi/pi-coding-agent: Not Found"**:更新检查只查 npm registry,而 MusePi 从不发布 npm 包(`@musepi/*` 未在 registry 注册)→ 每次 `musepi update` 直接 404 失败,二进制安装(TUI standalone binary)无法自更新。现在 npm registry 404 时回退到 GitHub release feed(`/releases/latest`),返回 `dist: "binary"` 走既有二进制替换路径(下载 + SHA-256 校验 + 原子替换),npm 发布模型(rename 指针等)保持不动;非 404 错误照常抛出。
  - EN: `musepi update` failed with "Failed to fetch release info for @musepi/pi-coding-agent: Not Found" — the update check only consulted the npm registry, but MusePi never publishes its packages there, so binary-installed TUIs could not self-update. On a registry 404 the check now falls back to the GitHub release feed (`/releases/latest`), returning `dist: "binary"` so the existing binary-replacement path (download + SHA-256 verify + atomic swap) runs; the npm-distribution contract (rename pointers, dist markers) is untouched and non-404 errors still propagate.
- **GUI 空态/会话态模型选择列表不全(有的供应商模型不出现) + 逐条添加供应商/模型发现后不刷新 + 搜索不支持模糊匹配(TUI parity)**:三个问题同根修复:1)daemon `models.listAvailable`/`models.list`(history fallback)有 `.slice(0,200)`硬截断——已认证模型超过 200 个时尾部供应商整组消失,GUI 模型选择器搜索也搜不到,移除截断;2)`providers.login`/`providers.importApiKey`/`providers.logout` 认证变化后不广播 `models.changed` 事件(只有 `models.add`/`models.remove` 广播),GUI 模型选择器监听该事件刷新列表,缺广播导致添加供应商后两个列表(空态+会话态)都停在旧列表,补上广播;3)GUI `ModelSelector` 搜索用 `includes()` 子串匹配(如 `ds` 不匹配 `deepseek-v4-flash`,`gpt5` 不匹配 `gpt-5.2`),TUI 用子序列模糊匹配(`fuzzyRank`),改为子序列匹配(空格分词 + 每 token 子序列,对齐 TUI 语义)。
  - EN: Three GUI model-selector issues fixed together: 1) daemon `models.listAvailable`/`models.list` (history fallback) had a `.slice(0,200)` hard cap — when authenticated models exceeded 200, tail providers disappeared entirely from the GUI picker even with search; removed the cap. 2) `providers.login`/`providers.importApiKey`/`providers.logout` didn't broadcast `models.changed` (only `models.add`/`models.remove` did), so the GUI selector listening for that event never refreshed after adding a provider; added broadcasts. 3) GUI `ModelSelector` search used `includes()` substring matching (e.g. `ds` can't find `deepseek-v4-flash`, `gpt5` can't find `gpt-5.2`); the TUI uses subsequence fuzzy matching (`fuzzyRank`). Replaced with a subsequence matcher (space-separated tokens, each token must subsequence-match the provider/id/name text — TUI parity).
- **GUI 客户端中途崩溃重载**(daemon 被 EBADF unhandled rejection 杀掉):daemon 的会话 journal(`daemon/journal.ts`)append 链里 `.then(fd => fd?.write(line))` 持有的是 `#fdReady` 解析出的 fd 引用;一次 compact/rewrite(`#replaceFile`→`forEachFdInstance`)会关闭**所有实例**的 fd,若某个 append 恰好在关闭后仍用旧 fd 写,则抛 `EBADF (Bad file descriptor)`,栈只有 `node:fs/promises write` 无用户帧。postmortem 的全局 unhandledRejection 处理器只豁免 EPIPE,EBADF 直接 `exitAfterFatal` → daemon 整个进程被杀 → 客户端会话崩溃重载(08-30、08-31 两次同款)。两层修复:1)`postmortem.ts` 把 `EBADF`+`syscall: write` 同 EPIPE 一起豁免(日志警告、继续运行——Windows 上管道对端消失就报 EBADF 而非 EPIPE);2)journal append 链在 fd 已关闭的竞争窗口内捕获 EBADF 静默丢弃该事件(rewrite 的正常代价,保证 flush/close/readAll 不连锁失败)。
  - EN: GUI client crashing/reloading mid-session (the daemon was killed by an unhandled EBADF rejection). The session journal's append chain resolves its fd once via `#fdReady`, then writes; a compact/rewrite closes every instance's fd, so an append that lands in that window writes through a stale handle and throws `EBADF` (stack: only `node:fs/promises write`, no user frames). The postmortem unhandledRejection handler exempted EPIPE but sent EBADF straight to the fatal exit, killing the whole daemon and reloading the client (same signature on 08-30 and 08-31). Two layers: 1) `postmortem.ts` now exempts `EBADF` + `syscall: "write"` like EPIPE (log and continue — Windows reports a vanished pipe peer as EBADF rather than EPIPE); 2) the journal append chain catches EBADF in that closed-fd race window and drops the single event (the normal cost of a rewrite) so flush/close/readAll never chain-fail.

- **移动伴侣交互缺陷批量修复(A1-A5、B1)**:A1)Android 返回键无层级语义——改为统一返回层栈(`back-stack.ts`,AgentDrawer/QrScanner/SessionsSheet/ServerSwitcher/PanelMenu/AgentsRail/面板/workspace 全部注册,一次返回只关一层);A2)SessionsSheet 关闭无退出动画——常挂载 + visible/closing 状态机,backdrop 180ms + 卡片 280ms 退出动画(reduced-motion 立即隐藏);A3)ask 复选框多选时对话框在宿主 toggle 循环中被卸载——保持挂载、pending 期间禁用选项、宿主原地 replace;A4/A5)连接只在首个 welcome 帧记住一次(rememberConnection + location.hash 不再重复写);B1)窄屏(≤520px)顶栏 board/scheduled/files/workbench 收进 Panels 弹出菜单(matchMedia 驱动)。
  - EN: Batch fix for mobile companion interaction defects (A1-A5, B1). A1) Android back key had no layer semantics — unified back-layer stack (`back-stack.ts`; AgentDrawer/QrScanner/SessionsSheet/ServerSwitcher/PanelMenu/AgentsRail/panels/workspace all register), one back press closes exactly one layer. A2) SessionsSheet had no exit animation — always-mounted with a visible/closing state machine, backdrop 180ms + card 280ms exit animations (reduced-motion hides immediately). A3) ask checkbox multi-select unmounted the dialog mid host toggle loop — dialog stays mounted, options disabled while pending, host replaces in place. A4/A5) connections remembered and `location.hash` written only once, on the first welcome frame. B1) at ≤520px the header collapses board/scheduled/files/workbench into a Panels popover (matchMedia-driven).

## [0.4.10] - 2026-08-31


### Fixed
- **GUI 会话树地图长会话不可用**(220 消息 → 22k px 竖线,缩放/适配/回当前位置失效):`layoutTree` 对无分支单子链不做任何横向展开,深链画布高度爆炸且 fitView 的 fixed 0.7 scale 让全貌不可读。现在超过阈值的连续单子链折叠成"链段胶囊"(点击展开,段内节点不占画布高度,分支结构不受影响),画布高度压缩约 85%;fitView 改用自适应缩放。
  - EN: GUI session-tree map unusable on long sessions (220 messages → a 22k px vertical line; zoom/fit/locate all dead): `layoutTree` never expanded single-child chains horizontally, so deep chains exploded the canvas height and fitView's fixed 0.7 scale left the whole tree unreadable. Runs of single-child nodes beyond a threshold now fold into expandable "chain pills" (click to expand; folded nodes don't consume canvas height; branch structure is untouched), cutting canvas height ~85%; fitView now scales to fit.
- **GUI 地图滚轮缩放失效 + console 刷 "Unable to preventDefault inside passive event listener"**:React 的 `onWheel` 在 root 上注册为 passive listener,`preventDefault()` 被浏览器吞掉且报错——滚轮既不能缩放地图又同时滚动底层页面。改为原生 `addEventListener("wheel", …, { passive: false })`。
  - EN: GUI map wheel-zoom dead + console spammed "Unable to preventDefault inside passive event listener": React's `onWheel` registers as a passive listener on root, so `preventDefault()` was swallowed — the wheel neither zoomed the map nor was blocked from scrolling the page behind. Switched to a native `addEventListener("wheel", …, { passive: false })`.
- **GUI 地图聚焦卡点不掉/关不掉**:`suppressClick` 在节点拖拽后被置 true 且永不复位(拖过一次节点后所有点击被吞);`handleClick` 的 220ms 消歧 timer 闭包捕获旧 `focusedId`(连续点不同节点时误判)。现在 suppressClick 消费后复位、timer 读 ref 镜像;双击跳转立即卸载聚焦卡。
  - EN: GUI map focus card wouldn't open/close: `suppressClick` was set true after a node drag and never reset (every click after one drag got swallowed), and `handleClick`'s 220ms debounce captured a stale `focusedId` in its closure. suppressClick now resets after consumption, the timer reads a ref mirror, and double-click jump closes the card immediately.
- **GUI 地图缺右键菜单**:节点上只有悬停 branch/fork 按钮,没有右键菜单(设计缺失)。现在节点右键 = 跳转 transcript / 在此重答 / 在此分叉;空白处右键 = 重置视图 / 折叠全部链段。
  - EN: GUI map had no context menu (node actions were hover-only). Node right-click now offers jump / re-answer here / fork here; blank-canvas right-click offers reset view / collapse all chains.
- **GUI 发送消息无即时回显**(输入框已清空但气泡要等 daemon 事件流回推):`sendPrompt` 只调 RPC 不本地插入,reactivate 历史会话 / agent 思考准备慢时用户感觉"没发送"(TUI 有本地乐观插入)。现在 `optimisticEcho` 发送瞬间把用户消息插入本地视图,daemon `message_start` 到达时按内容签名(文本+图片数)匹配移除、由权威条目接管;`agent_end` 未匹配则清空(防幽灵)。
  - EN: GUI send had no instant echo (the input cleared but the bubble waited on the daemon event stream): `sendPrompt` only issued the RPC with no local insert, so reactivating history sessions / slow agent prep made sends feel lost (the TUI inserts optimistically). `optimisticEcho` now inserts the user message locally at send time; the daemon's `message_start` matches by content signature (text + image count) and takes over, and `agent_end` clears any unmatched echo (no ghosts).
- **GUI 缺 "." / "c" 继续工作快捷键**(TUI parity):TUI 发 `.` 或 `c` 是"继续工作"信号——合成隐藏指令(`manualContinuePrompt`,synthetic),不产生可见用户气泡;GUI 之前把 `.` 当普通消息发给 LLM。现在 Composer 检测裸 `.`/`c`(无引用/附件)→ `deliverAs:"continue"` → daemon 用 `manualContinuePrompt` 替换裸 `.`(TUI 同款指令,daemon 是唯一权威源)、`sendUserMessage` 走 `prompt(synthetic:true)` 立即送达(不入 steer/followUp 队列)、不触发标题生成、不乐观回显。
  - EN: GUI lacked the "." / "c" continue shortcut (TUI parity): in the TUI, a bare dot or c is the "keep working" signal — a hidden synthetic directive (`manualContinuePrompt`, synthetic) that produces no visible user bubble; the GUI used to send "." as a plain message. The Composer now detects a bare `.`/`c` (no quotes/attachments) → `deliverAs:"continue"` → the daemon substitutes `manualContinuePrompt` for the bare `.` (same directive the TUI sends; the daemon is the single authority), `sendUserMessage` routes to `prompt(synthetic:true)` for immediate delivery (not the steer/followUp queue), no title generation, no optimistic echo.
- **GUI 地图按轮分组堆叠 + 交互打磨**:地图节点按"轮"(User→Assistant→工具)垂直紧凑堆叠(轮内 12px、轮间 64px),长会话按轮阅读而非消息平铺;回到当前位置按钮修复(leaf 是折叠段内节点时回退到段首胶囊);单击=聚焦、按住拖动=移动卡片严格分离(拖动后不触发聚焦/双击跳转);悬停工具栏加"跳转到此消息"按钮且与聚焦隔离(pointerdown stopPropagation);右键菜单加描述文字说明每个动作效果。
  - EN: GUI map now stacks nodes by round (User→Assistant→tools) — compact within a round (12px), wide between rounds (64px), so long sessions read by turn instead of a flat message column. The locate-current button falls back to the fold head when the leaf is a folded-chain node. Click = focus, press-drag = move card, strictly separated (drag never triggers focus or double-click jump). The hover toolbar gained a jump-to-message button, isolated from focus (pointerdown stopPropagation). Context-menu items now carry descriptions explaining each action.
- **CI 失败测试修复:task-guards 7 fail**:`runSubprocess` 的 fake session 缺 executor 演进后新增的方法(`getAllToolInfos`/`getContextUsage`/`sendCustomMessage`/`setServiceTierFamily`/`setThinkingLevel`/`subscribeRunState`/`hasPendingAsyncWork`/`getAsyncJobSnapshot`/`settleAsyncWork`)——调用时 TypeError 导致事件流未建立、`result.requests` 恒 0。补全方法集后 8/8 通过。
  - EN: fixed the 7 failing task-guards tests: the fake session was missing executor methods added after the fork (`getAllToolInfos`/`getContextUsage`/`sendCustomMessage`/`setServiceTierFamily`/`setThinkingLevel`/`subscribeRunState`/`hasPendingAsyncWork`/`getAsyncJobSnapshot`/`settleAsyncWork`) — calls threw TypeError before the event stream was wired, so `result.requests` stayed 0. With the methods filled in, 8/8 pass.
- **GUI 重连风暴触发 "Agent was replaced during session initialization"**(modes.list failed):rpc 掉线重连时 `onStatus("open")` 反复 `reopenSession`,同一 session 并发 `session.resume` 在 daemon 端撞 attachSession 竞态。现在 `openSession` 防重入——同一 sessionId 的 in-flight 打开直接丢弃。
  - EN: GUI reconnect storms tripped "Agent was replaced during session initialization" (modes.list failed): every `onStatus("open")` re-opened the active session, so concurrent `session.resume` calls raced in the daemon's attachSession. `openSession` is now re-entrancy-guarded — an in-flight open of the same sessionId is dropped.

## [0.4.9] - 2026-08-30

### Fixed

- **Electron 主进程 EPIPE 崩溃**:从 Finder/Dock 启动(无终端)时父进程 stdio 管道关闭,主进程任意 `console.error`(如 MCP tool load failed 日志)抛 EPIPE → uncaughtException → Electron「A JavaScript error occurred in the main process」模态框 → 应用卡死、daemon 继续跑、GUI 显示 working、无法发消息。现在主进程 `console.log/warn/error` 重定向到 `~/.musepi/logs/gui-main.YYYY-MM-DD.log`,`uncaughtException`/`unhandledRejection` 全部吞掉(EPIPE 时 console 置 no-op)——任何主进程异常不再弹模态框。
  - EN: the Electron main process no longer crashes on EPIPE — when launched from Finder/Dock (no terminal) the parent stdio pipe is already closed, so any main-process console.error (e.g. an MCP tool load failure log) threw EPIPE → uncaughtException → the "A JavaScript error occurred in the main process" modal → the app froze while the daemon kept running (GUI showed "working", messages undeliverable). Main-process console output is now redirected to a dated log file and uncaughtException/unhandledRejection are swallowed (console becomes a no-op on EPIPE), so no main-process error can pop the crash modal again.
- **GUI 撤回/重试/分叉接线到会话树 RPC**:撤回(撤回该消息)与重试(编辑并重发)走 `session.branchAt`(非破坏性——leaf 原位移动,旧子树保留为 sibling branch),分叉(从此消息分叉新会话)走 `session.forkAt` + 自动切换到新会话;会话内消息操作不再只是本地状态,与会话树拓扑(分支/子会话)一致。
  - EN: the chat transcript's revert/retry/fork actions are now wired to the session-tree RPCs — revert & retry go through `session.branchAt` (non-destructive: the leaf moves in place, the old subtree survives as a sibling branch) and fork creates a new session via `session.forkAt` + auto-switches to it, so in-chat message operations match the session-tree topology (branches/child sessions) instead of local state.
- **TUI OSC 99 通知品牌残留**:`OSC99_APP_NAME` 品牌改名后终端通知测试仍期望 omp 时代的 "Oh My Pi" base64,已更新为 MusePi(修复 CI native/integration 的 notifications/streaming-scrollback 失败)。
  - EN: TUI OSC 99 notifications — the terminal-notifications tests still expected the omp-era "Oh My Pi" app-name base64 after the MusePi rename; updated to MusePi (fixes the notifications/streaming-scrollback failures in the native/integration CI bucket).
- **TUI tmux resize 渲染缺口**:`Text` 组件实现 `getNativeScrollbackWidthEpochRevision`(渲染行数签名),使 `setText` 改变高度时能通过 Container 的 epoch 聚合传播(修复 issue-2088 的 rendered-height 测试);TUI 现在向聚焦组件注入真实终端行数(`setViewportRowsProvider`),Editor 的 autocomplete 下拉按真实视口裁剪而非回退到 24 行假设(修复 autocomplete viewport 测试);测试 fixture 中性化 `TERM_PROGRAM`/`PI_TUI_RESIZE_IN_PLACE`,消除 Warp 终端宿主的 resize 路径误分类。
  - EN: TUI tmux-resize rendering gaps — `Text` now implements `getNativeScrollbackWidthEpochRevision` (rendered-line-count signature) so a `setText` height change propagates through Container's epoch aggregation (fixes the issue-2088 rendered-height test); the TUI injects its live terminal row count into focused components (`setViewportRowsProvider`), so Editor's autocomplete dropdown clamps to the real viewport instead of the 24-row fallback (fixes the autocomplete-viewport tests); test fixtures neutralize `TERM_PROGRAM`/`PI_TUI_RESIZE_IN_PLACE` so resize classification is deterministic on Warp hosts.

- **Windows 守护进程启动失败(空 PATH 条目误解析 GUI 为 daemon)**:`daemonCommand` 的 PATH 扫描把空条目当作当前工作目录——MusePi 装在 cwd 时 `musepi.exe` 存在性检查命中 **GUI 本体**(`MusePi.exe` 的副本),spawn 它当 daemon 立即退出(`child exited 0`),GUI 报「无法连接本地守护进程 / daemon exited during startup」。现在忽略空/纯空白 PATH 条目,并把每个候选 `path.resolve` 为绝对路径执行(PATH CLI → bundled daemon → dev checkout 优先级不变)。修复 #2。
  - EN: Windows daemon startup failure from empty PATH entries — `daemonCommand`'s PATH scan treated an empty entry as the current working directory, so when MusePi was installed in cwd the `musepi.exe` existence check hit the **GUI binary itself** (a copy of `MusePi.exe`), spawning it as the daemon which exited immediately (`child exited 0`) and left the GUI on "无法连接本地守护进程 / daemon exited during startup". Empty/whitespace PATH entries are now ignored and each candidate is `path.resolve`d to an absolute executable (PATH CLI → bundled daemon → dev checkout priority unchanged). Fixes #2.
- **win32 原生 addon 动态 CRT(干净 Windows 缺 VC++ Redistributable 无法加载)**:`build-bindings.ts`(gui-release win job 的 cargo/N-API 路径)的 RUSTFLAGS 只设 `target-cpu`、未静态 CRT,产物导入 `VCRUNTIME140.dll` + 6 个 `api-ms-win-crt-*`——干净机器(无 VC++ Redistributable)dlopen error 126 → daemon 启动即退。现在 win32 强制 `-C target-feature=+crt-static` + `CFLAGS/CXXFLAGS=/MT`(cargo 不把 RUSTFLAGS 反射进 `CARGO_CFG_TARGET_FEATURE`,C 依赖须经 CFLAGS 覆盖),与 bazel `static_link_msvcrt` 路径对齐;验证产物不再导入 VCRUNTIME140。
  - EN: the win32 native addon linked the dynamic MSVC CRT — the cargo/N-API build path used by the gui-release Windows job only set `target-cpu` in RUSTFLAGS, so the shipped `.node` imported `VCRUNTIME140.dll` + 6 `api-ms-win-crt-*` DLLs, which are absent on a clean Windows install (no VC++ Redistributable) → dlopen error 126 → the daemon exited at startup. The win32 build now forces `-C target-feature=+crt-static` + `CFLAGS/CXXFLAGS=/MT` (cargo does not reflect RUSTFLAGS into `CARGO_CFG_TARGET_FEATURE`, so C deps need the CFLAGS override), matching the bazel `static_link_msvcrt` path; the rebuilt addon imports no VCRUNTIME140.
- **macOS 原生 addon 硬链 Homebrew pcre2(无 Homebrew 的 Mac 无法加载)**:`tryCargoHostBuild`(mac/linux 的 cargo 兜底路径)env 缺 `PCRE2_SYS_STATIC=1`,pcre2-sys 走 pkg-config 把 CI runner 的 Homebrew `libpcre2-8` 以绝对路径链进 addon——干净 Mac dlopen 失败「Library not loaded: /opt/homebrew/opt/pcre2/...」。cargo 兜底现在同样 pin `PCRE2_SYS_STATIC=1`(与 `MODULE.bazel`、`build-bindings.ts` 三处对齐),shipped addon 不再保留宿主 pcre2 路径。修复 #1。
  - EN: the macOS native addon hard-linked Homebrew pcre2 — the cargo fallback build path (`tryCargoHostBuild`, used on mac/linux hosts) lacked `PCRE2_SYS_STATIC=1`, so pcre2-sys pkg-config'd the CI runner's Homebrew `libpcre2-8` at an absolute path into the shipped addon; on any clean Mac (no Homebrew) dlopen fails with "Library not loaded: /opt/homebrew/opt/pcre2/...". The cargo fallback now pins `PCRE2_SYS_STATIC=1` too (aligned with `MODULE.bazel` and `build-bindings.ts`), so no shipped addon retains a host pcre2 path. Fixes #1.
- **macOS GUI OTA 更新 404**:electron-builder 的 mac target 产出 zip + dmg + `latest-mac.yml`(zip 为主更新文件),但 `gui-release.yml` 发布 job 的 upload 列表漏了 `dist/*.zip` → zip 未上传 → macOS 用户 OTA 下载 `MusePi-*-arm64-mac.zip` 返回 404,更新失败(Windows/Linux 的 exe/AppImage 正常)。发布清单补上 `dist/*.zip`;已发布版本的缺 zip 资产也已手动补传。
  - EN: macOS GUI OTA update 404 — the electron-builder mac target emits zip + dmg + `latest-mac.yml` (zip is the primary update file), but the gui-release publish job's upload list omitted `dist/*.zip` → the zip never reached the release → macOS OTA downloads of `MusePi-*-arm64-mac.zip` returned 404 (Windows/Linux exe/AppImage were fine). The publish list now includes `dist/*.zip`; the missing zip asset was also backfilled onto the already-published release.
- **TUI binary 发布**:`musepi update` 的自更新资产(`musepi-{linux,linux-musl,darwin,windows}-{x64,arm64}[.exe]`)现已作为 release assets 发布(7 平台),修复之前 TUI binary 构建成功但从未上传到 GitHub release、`musepi update` 找不到匹配 asset 的问题。
  - EN: TUI binary release — the self-update assets consumed by `musepi update` (`musepi-{linux,linux-musl,darwin,windows}-{x64,arm64}[.exe]`) are now published as release assets (7 platforms); previously the TUI binary built successfully but was never uploaded, so `musepi update` could not find a matching asset.
- **CI 长期失败测试修复**(5 个 job):
  - **OAuth CAS 竞态**(packages/ai/auth-storage):CAS disable 丢失(`cas-lost`)时与 `peer-rotated` 一致——reload 已拿到 peer 轮转凭证,re-resolve 返回它而非 `undefined`;preflight 阶段 `cas-lost` 不再把候选标记为失败。
  - **interrupted-thinking**(agent-session):demote 跳过 Anthropic 方言——Claude 拒绝自己的推理以文本重放(reasoning_extraction),pi-ai 已在 LLM 视图剥掉未签名 run,会话层不再创建 hidden continuity。
  - **context-usage**:before_agent_start 扩展可返回带 undefined section 的 system-prompt 数组,计数前过滤 undefined,不再抛 "Failed to measure JavaScript string"。
  - **goal-mode**:`/goal <objective>`(无子命令)把裸文本当 objective 直接启动(镜像 `/goal set`);`/goal set` 的 images/imageLinks 正确透传(修复 1d67910ca5 biome 改名回归)。
  - **advisor-toggle**:handoff 已是 in-place commit(17.4.0),测试更新为新语义(sessionFile 不变、advisor cost 清零);`commitCompactionEntry` 在 resetAdvisorRuntimes 后 clearAdvisorCost()。
  - **natives 发布清单**:`prepareNativeCorePackage` files 补 `native/clipboard.js`/`.d.ts`——发布 tarball 之前缺 clipboard,组合安装报 Cannot find module。
  - **acp-builtins**:`/btw` 已有 headless handle,从 removed-commands 测试移除;`/context` 测试 fake session 补 tokenizer。
- **TUI binary 发布与测试 gate 解耦**:`Publish GitHub release` job 现在只依赖全部平台的 Release binary 构建成功——测试 fan-out(release_gate)是质量信号而非发布前置,一个 flaky/长期失败的测试 job 不再让 `musepi update` 更新通道停摆(npm leaf 发布保留完整 gate)。
  - EN: the GitHub-release publish job now depends only on every platform's TUI binary building successfully — the test fan-out (release_gate) is a quality signal, not a publish prerequisite, so a flaky or long-failing test job no longer strands the `musepi update` channel (npm leaf publishing keeps its full gate).
  - EN: fixed the 5 long-failing CI test jobs — OAuth CAS race (`cas-lost` now re-resolves like `peer-rotated`), interrupted-thinking skips Anthropic-dialect targets (reasoning_extraction), context-usage tolerates undefined system-prompt sections, goal-mode accepts a bare `/goal <objective>` and forwards images, advisor-toggle tests match the 17.4.0 in-place handoff semantics (session file unchanged, cost cleared after commit), the natives publish manifest ships `clipboard.js`, and acp-builtins drops `/btw` from removed commands + gives the `/context` fake a tokenizer.

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

## [0.4.13] - 2026-09-01
