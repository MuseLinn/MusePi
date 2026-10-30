---
layout: default
title: GUI 实现契约
status: living
summary: 桌面端与共享客户端 UI 的 daemon RPC、Electron IPC、生命周期和验证契约。
scope:
  - packages/desktop-app
  - packages/client-core
  - packages/coding-agent/src/daemon
lang: zh-CN
---

# MusePi GUI 实现笔记(契约与坑)
[English](gui-implementation.md) | 中文

> 状态:**活文档**(2026-08-06 建立,从 `gui-design.md` 拆出)——`packages/desktop-app` / `packages/client-core` 实现的**事实记录**:daemon RPC 契约、IPC 形状、算法语义、踩坑与验证方法。与实现同步,实现文件为准。
>
> 设计风格规范(布局/token/动效/组件模式)见 **`docs/gui-design.md`**。

## 1. daemon 生命周期

`musepi serve` 由 Electron main **detached spawn**(`daemon.cjs`),GUI 退出后存活、重启 GUI 只重连不复用新代码——daemon 代码变更后必须重启它。实例菜单(header)有 **「重启 daemon」** 项(`daemon-restart` IPC):lsof 找监听 pid → SIGTERM → 等端口释放 → 重新 spawn → 等绑定 → GUI 自动重连(boot 链)。**lsof 参数必须合成单 token `-tiTCP:<port>`**(拆分会被当文件名)。主进程代码(main.cjs/daemon.cjs)不热加载——改动后必须重启 Electron 实例。

## 1b. 空闲回顾(recap,daemon 契约)

TUI `recap.enabled`/`recap.idleSeconds`(schema tab `interaction`、group Notifications)在 daemon 会话的完整对齐实现:

- **daemon 侧**(`daemon/server.ts`):`agentSession.subscribe` 收到 `agent_end` → `#scheduleIdleRecap`(读 `settings.getGroup("recap")`,isCompacting/editorDraft 跳过,计时 `idleSeconds` clamp 1–3600);计时器触发 → `#runIdleRecap`:复查 `isStreaming`/`isCompacting`/`editorDraft`/会话存活/entries 非空 → `runEphemeralTurn`(side-channel,`recap-user.md` prompt) → `previewLine` 280 截断 → 推 `{ kind: "recap", seq, payload: { text, at } }`。**取消时机 = TUI 对齐的活动集**:`agent_start`/`turn_start`/`message_start`/`tool_execution_start`/`auto_compaction_start` 取消,`session.send`(touch)与 `session.setDraft(draft:true)` 取消,**notice/流式 update/retry 等被动帧不取消**——否则 agent_end 后紧跟的 notice 会杀掉刚排程的 recap(实测踩过,goal mode 下必现)。dispose 同样取消。**goal/todo 锚点与 TUI 同源**:`getGoalModeState().goal.objective`(fallback 会话标题) + `nextActionableTask(getTodoPhases())`(tools/todo 同款函数;ModeSessionLike 类型对齐 TodoPhase)。**editor-draft guard 的 daemon 等价物**:GUI composer 草稿经新 RPC `session.setDraft { sessionId, draft }` 上报(`Composer.tsx`:`true` 300ms 防抖、`false` 立即、卸载补发 false);清空草稿**不补排程**(等下一个 agent_end,TUI parity)。**历史会话零消耗**:`session.resume` 是 snapshot-only(不 activate)→ 无 AgentSession/subscribe → 不排程不烧 token;只有 `session.send` 触发 activate 才进入 recap 生命周期。
- **协议**:`@musepi/sdk` `SessionStreamEvent` 联合新增 `{ kind: "recap"; payload: { text; at } }`(envelope TypeBox kind 同步加 Literal)。
- **GUI**:`session-store.apply` `kind === "recap"` → state.recap;任何后续 wire AgentEvent 清空;`ChatView` 在滚动容器外、JumpToBottomButton 旁渲染 `.gui-recap-row`(`※` + 文本,fixed 不随内容滚动 = TUI 状态行语义)。设置:「通知与音效」tab 底部「空闲回顾」section(rpc 读 `settings.get` recap.enabled/idleSeconds,写 `settings.set`,daemon 自动 flush;与 renderer-local 通知偏好不同,这两项在 config.yml)。`Composer` 通过 `session.setDraft` 上报未发送草稿(daemon 侧 editor-draft guard)。
- 验证:ws RPC 直连 daemon(idleSeconds=1)→ send → agent_end 后 1s 收 recap envelope;draft=true 期间 agent_end 后无 recap、清空不补排程;resume 历史会话 5s 零事件(不烧钱),send 继续后才正常 recap;GUI CDP 发消息 → `.gui-recap-row` 出现,新消息 → 消失。

## 1c. 暂停(daemon 契约,2026-08-20)

暂停分两级,状态都只活在 daemon 侧,重连/重启 GUI 不丢:

- **会话级**(每会话一个 `AgentPauseGate`,agent loop 在模型调用/工具调用边界轮询):
  - `session.pause{sessionId}` → `{ engaged, paused, pausedAt }`(已暂停返回 `engaged:false`)
  - `session.pauseStatus{sessionId}` → `{ paused, pausedAt }`(可激活归档会话)
  - `session.pauseRelease{sessionId}` → `{ duration, paused }`(duration = now − pausedAt)
- **全局级**(进程级 `agentPauseGate`,TUI `/pause` 同款语义,跨全部会话):
  - `daemon.pause` / `daemon.pauseStatus` / `daemon.pauseRelease`(返回形状同上)
- **订阅流**:会话订阅收到 `{ kind: "pause-state", payload: { paused, pausedAt } }` envelope(server.ts:1644,gate.onChange 驱动)。
- **持久化**(TUI/GUI 对齐关键):暂停是宿主层状态,不在 agent 事件流里。daemon 把每次 gate 迁移镜像到 per-session sidecar `<journal>/<sessionId>.pause.json`(存在 = 暂停,`{paused:true,pausedAt}`;`release`/`paused:false` 时 unlink = 可逆);`resumeSession`(归档 >30min 或 daemon 重启后的激活路径)读 sidecar rehydrate gate(`AgentPauseGate` 构造 `{paused,pausedAt}`,pausedAt 原样保留,duration 正确)。`deleteSession` 补 unlink,防同名会话复活成暂停。全局暂停是进程内存态,daemon 重启即丢(设计如此,不持久化)。
- **wire**:`SessionState` 新增可选 `paused` / `pausedAt`(live snapshot 与归档 snapshot 都注入,server.ts:2056-2057);`session.list` rows 也有 `paused` 字段。
- **心跳配套**:daemon 新增 `system.ping` RPC(无参 → `{pong:true}`),供 WS 客户端 keepalive。
- 验证:ws RPC 直连 → create → send(落盘 SDK 文件,空会话无文件无法激活)→ pause → 断言 sidecar 存在 → SIGKILL daemon 重启 → pauseStatus 仍 `{paused:true, pausedAt 一致}` → release → sidecar 消失。

## 1d. 连接恢复(2026-08-20,合盖睡眠唤醒冻结修复)

触发:Electron 在系统睡眠时断开 renderer↔daemon 的 WebSocket(electron#19993,localhost 同受);唤醒后必须重连。恢复链三层:

- **renderer keepalive**(`packages/desktop-app/src/lib/rpc.ts`):请求 15s 超时(`REQUEST_TIMEOUT_MS`)防永挂;每 20s 发 `system.ping`(`KEEPALIVE_INTERVAL_MS`),45s(`KEEPALIVE_DEAD_MS`)无任何响应 → `ws.close()` 强制触发重连(浏览器 WS 无 ping 能力,这是标准替代)。
- **干净恢复路径**(`app.tsx`):`onStatus("closed")` → `recoverFromDrop` = close 旧 client(停退避重试)→ `setBooting(true)` 显示 splash → `boot()` 全新重连(probe/spawn/events.subscribe/pauseStatus/settings 全量初始化)——与「重新连接」按钮同一路径(ce1c9284d 已验证;原自动原地 restore 会冻结 renderer)。`recoveringRef` 防重入。
- **主动唤醒**:`electron/main.cjs` `powerMonitor.on("resume")`(app ready 后注册,electron#32576)→ 各窗口 `app-power-resume` → renderer 收到即触发恢复(visibilitychange/online 在 macOS 唤醒不保证触发)。
- **兜底**:App 级 `ErrorBoundary`(components/ErrorBoundary.tsx)渲染崩溃显示「重新连接」页,不再无边界静默卸载根树(冻结特征:CPU 空闲、console 活、点击死)。
- **服务端心跳**(`ws-transport.ts`):15s PING、3 次 PONG 超时 destroy 连接(清死连接订阅/缓冲区,`teardown` 同步清 interval)。
- 验证:真实 Electron + CDP 杀 daemon 模拟掉线 → UI 恢复可交互、无 error bar、renderer 日志含恢复路径;暂停状态重连后一致。

## 1e. 自定义供应商模型发现(models.discover,2026-08-22)

「获取可用模型」按钮的 daemon 契约:配置期对**草稿**端点的一次性询问,不写任何配置、不入缓存。

- **RPC** `models.discover { baseUrl, api, apiKey?, provider? }` → `{ models: [{ id, name }] }`(daemon `server.ts` handle 分支,`models.listCustom` 旁;动态 import `config/model-discovery` 的 `discoverDraftModels`——按 AGENTS.md 禁止 inline import 规则,daemon 层动态 import 是既有模式)。
- **协议门禁**:仅 `openai-completions` / `openai-responses` 可问;`anthropic-messages` / `google-generative-ai` 抛「protocol "X" has no model listing this build can read; enter this provider's models by hand」。理由:OpenAI 兼容端点(官方 + 网关 + 自建)共享 `GET {base}/models` 形状,其余协议无统一列表。
- **实现**:`discoverDraftModels(request, fetchImpl?)` 构造 `DiscoveryProviderConfig`(discovery.type = `openai-models-list`)+ `DiscoveryContext`(fetch 可注入供测试,默认 globalThis;`getBearerApiKeyResolver` 返回草稿 apiKey 字符串——**仅本次询问,绝不落盘**),复用既有 `discoverOpenAIModelsList`(同样的 baseUrl `/v1` 归一化、Bearer 认证、bundled-reference name 富集、超时)。
- **name 语义**:bundled catalog 命中的 id 富集为规范名(`gpt-4` → "GPT-4");未命中的保持裸 id;端点自报 name 字段**不采纳**(既有 discoverOpenAIModelsList 行为)。
- **错误**:HTTP 4xx/5xx 抛 `HTTP <code> from <url>`;端点无模型返回空数组(GUI 提示「该端点没有返回可用模型」)。
- **GUI**:「自定义供应商」tab 内点「添加自定义供应商」→ **配置弹窗**(DialogFrame `gui-dialog--settings`,旧 add-tab 已移除;用户反馈:添加自定义供应商应是有设计规范的弹窗)——弹窗内「获取可用模型」按钮(无 baseUrl 禁用)→ **候选 DialogFrame 嵌套于配置弹窗内**(均 portal 到 body,互不冲突;勾选 + 全选/取消全选 + 添加所选)→ `adopted` 并入 `models.add` 的 models 数组;校验「至少一个模型」(手工单条或采纳列表)。保存成功:关弹窗 + 「自定义供应商」tab 添加按钮原位置短暂「供应商已添加」反馈(`addedName` state,2.5s 清除)。**引导界面**(OnboardingOverlay `ProviderSetup`)自定义表单同款「获取可用模型」+ 候选弹窗,节省手填 model id;`EMPTY_FORM` 抽为模块级常量供两个表单共享重置。

## 2. 扩展控制中心(daemon 契约)

设置「扩展」tab + 侧栏「扩展」入口共用 `components/ExtensionsCenter.tsx`,TUI /extensions parity。UI 形态(见 gui-design.md 无——此处只记契约):顶部 provider tabs(`buildProviderTabs` 排序:ALL → 有内容的 enabled → disabled → 空,disabled 灰显可点)+ 左侧 provider→kind(计数)→item 三级树(provider 级开关走 setProviderEnabled,native/内置节点只读;kind 折叠记忆)+ 右侧详情(名称/类型/描述/触发/来源 via X (等级)/路径/状态/指令内容/raw inspector 折叠)。

daemon RPC:
- `extensions.list`(TTL 10s 缓存,复用 state-manager 的 loadAllExtensions,返回 10 种 kind 统一 Extension 形状,无 raw——raw 走 `extensions.raw{id}` 16KB 截断)
- `extensions.setEnabled{id,enabled}` 写 `settings.disabledExtensions`(TUI 同 key 同 `kind:name` id;`mcp:` 前缀走 mcp.json canonical denylist + legacy 对账;flush + 缓存失效)
- `extensions.setProviderEnabled{providerId}` 用 enableProvider/disableProvider(native 拒绝;**capability 层只 settings.set 不 flush,daemon 补 flush**)
- `skills.setEnabled` 已删除(迁移到 extensions.setEnabled),`skills.list/read/delete` 保留

语义:状态三色点 绿 active / 灰 disabled / 橙 shadowed(详情显 shadowedBy)。provider 关闭后其条目从列表消失(loadCapability 层行为,与 TUI 同源,不是 bug)。内置判定 provider native|omp-managed|builtin-defaults。

## 3. Git 设置与功能(实现)

- **GitHub OAuth 令牌** = `github.authStatus`(spawn `gh auth status` 文本 + `gh api user` 解析 login/email——**勿用 `gh auth status --json`**,字段名随 gh 版本变)+ 认证卡片(头像字母/用户名/邮箱/「已通过 gh CLI 认证」/禁用——logout 用 `--yes` 防交互阻塞)。
- **gh 解析**:`ghPath()` 工具函数——PATH 优先,再探测 `/opt/homebrew/bin/gh`、`/usr/local/bin/gh`(darwin)与 `%ProgramFiles%\GitHub CLI\gh.exe`(win32)——GUI/launchd 拉起的 daemon 常缺 `/opt/homebrew/bin` 于 PATH,仅 `Bun.which("gh")` 会误报未安装。4 处 gh spawn(prs/authStatus/authPoll/authLogout)全部走 ghPath()。
- **Device Flow 卡片**(openchamber 原生感):「授权 MusePi」标题 + 提示 + 大号等宽 code 块(24px/800/字距 3px)+ 复制按钮(clipboard,1.5s「已复制」反馈)+「打开 GitHub」主按钮(external-link 图标)+「取消」链接 + 等待行(自绘 spinner + 「等待批准…(自动刷新)」)。CSS 见 gui.css `.gui-github-flow*`。
- **GUI 错误映射**:`github.authStatus` RPC 失败(如 daemon 早于该 RPC 的旧代码)≠ gh 未安装——catch 时保留 detail,`installed:false` 分支显示 `({detail})` 区分「daemon 太旧」与「真没装 gh」。**坑**:gh keyring token 失效时 `gh auth status` 卡网络验证(10s kill cap → detail 空串)——GUI 用 `||` 回退「未认证」文案;网络差(API EOF)同样卡 gh——用户侧先终端 `gh auth status` 自查。**Device flow 网络错误分类**(2026-08-06,实测坏代理验证):`classifyNetworkError`——TLS/certificate/handshake = **fatal**(友好提示「无法验证 TLS 证书——检查代理/VPN」,停止轮询);其余(EOF/ECONNREFUSED/ETIMEDOUT/ENOTFOUND/Unable to connect 等)= **transient**——authPoll 返回 `{pending, interval+5}` **继续轮询**(GitHub device-flow 规范)。
- **gh 认证存储模式**(2026-08-06,openchamber 模式重写):**不再 `gh auth login --with-token`**——openchamber 源码分析发现其成功关键是:device flow token **自己存配置**(不经 gh),`api.github.com` 失败**容忍**(仅 401/403 失效)——而 gh login 的 token 验证请求 api.github.com,在网络差的机器(用户环境:github.com 可达、api.github.com EOF)上**整个认证失败**。musepi 改为:authPoll 成功后 token 写 `agentDir/github-token.json`(0600,含 login/email 缓存)——**github.prs 等 gh spawn 用 `GH_TOKEN` env 注入**(优先级高于 keyring);authStatus 优先读 daemon token(authenticated 即真,api 不可达时用缓存身份 + detail 提示);authLogout 删 token 文件 + gh logout 尽力。keyring(gh CLI 手动登录)仍作为 fallback。**验证**:mock gh 确认 GH_TOKEN 注入(api user 无 token 失败/有 token 成功)、logout 后状态回落。**v2(2026-08-06 晚,用户报 Git tab loading 久)**:authStatus 的 daemon-token 分支**不再同步等待 `gh api user`**——直接返回 stored login/email + `avatarUrl: https://github.com/<login>.png`(头像由 login 推导,零网络——api.github.com 不可达但 github.com 可达,device flow 已证明),身份刷新改为**后台 fire-and-write**(gh api user 成功 → writeGhToken 更新 login/email 缓存)。**实测**:mock gh api user 挂 5s 时 authStatus 299ms 返回,6s 后 token 文件 login 自动更新;keyring fallback 分支同样带 avatarUrl。GUI 头像 = `<img className="gui-github-avatar-img">`(34px 圆,object-cover)+ onError → 字母 fallback(`avatarFailed` state,avatarUrl 变化时重置)。
- **GitHub 头像同步到聊天用户头像**(2026-08-06):Git 设置页 `refreshAuth` 成功时把 `auth.avatarUrl` 写入 `localStorage["musepi-gui-user-avatar"]`(无则移除——登出自动清除);ChatView 的 `UserAvatar` **同步读**该 key(每条消息一个实例——per-instance RPC 会扇爆,localStorage 零成本),渲染 `.gui-user-avatar-img`(20px 圆 object-cover,容器百分比尺寸,媒体查询 28px 自动跟随),onError → 首字母 fallback,avatarUrl 变化重置失败态。**E2E 验证**:隔离 daemon(mock gh + token)→ Git tab 写入 `https://github.com/MuseLinn.png` → 打开历史会话(user 消息)→ transcript 用户气泡 img 渲染且真实加载成功(imgLoaded true)。**测试教训**:fake SDK 会话文件与 `session.create` 的 live 会话**同 id 冲突**——点击 row 打开的是空 live(welcome 态);历史会话要在 daemon 启动前写好 fake 文件,点击走 reactivate 路径(snapshotFromJsonl)才有消息。`#retry()` 连接失败时**reject 全部 pending 请求**并清空——否则 reload/daemon 重启窗口发出的请求**永久挂起**(旧 ws 的响应永远不来,新连接响应 id 匹配不上),Git tab 的 authLoading 永 true(用户「loading 加载蛮久」的一个来源)。**实测**:kill daemon 后 Git tab 3s 内显示 `(not connected)` 错误而非永转圈。GUI Git tab 的 loading 行为:`authLoading && !auth` 显示「loading」行,**同时**「添加账号」按钮也渲染(`!auth?.authenticated` 对 null 成立)——是预期组合,非 bug。
- **RPC 重连窗口死挂修复**(rpc.ts,2026-08-06):`#retry()` 连接失败时**reject 全部 pending 请求**并清空——否则 reload/daemon 重启窗口发出的请求**永久挂起**(旧 ws 的响应永远不来,新连接响应 id 匹配不上),Git tab 的 authLoading 永 true(用户「loading 加载蛮久」的一个来源)。**实测**:kill daemon 后 Git tab 3s 内显示 `(not connected)` 错误而非永转圈。GUI Git tab 的 loading 行为:`authLoading && !auth` 显示「loading」行,**同时**「添加账号」按钮也渲染(`!auth?.authenticated` 对 null 成立)——是预期组合,非 bug。
- **Provider 登录卡片**(SettingsView 供应商 tab,2026-08-06):`loginState` 面板从简陋版(URL 链接 + 文本)升级为 **device-flow 同款原生卡片**(`.gui-github-flow` 样式族)——标题 + 「打开登录页」主按钮(external-link)+ 取消链接 + 「等待登录…」spinner(非 waitingInput 时)+ 粘贴 code/URL 输入框(waitingInput 时)。渲染路径与 git device flow 卡片同构(事件驱动 provider-login → loginState)。
- **供应商认证元数据与注册表所有权**：`providers.list` 暴露 `loginKind`（`oauth` 或 `api-key`），由 OAuth 流程字段和显式设备授权声明决定；纯 API Key 卡片不再显示重复登录动作。无会话的供应商 RPC 直接复用 daemon 缓存的发现结果取得共享 `ModelRegistry`，不再创建并销毁临时会话，因此注册表持有的凭据数据库在登录和导入时保持可用。导入 RPC 错误以弹窗警示显示，不再被吞掉。
- **Windows 安装器接线**：electron-builder 的 `build.nsis.include` 加载 `release/installer-branding.nsh`，该脚本包含快捷方式辅助逻辑并启动 WebView2 安装向导。`customInit` 在创建任何页面前通过自绘宿主收集全部答案，随后将 NSIS 切为静默模式，因此原生目录、进度和完成页都会跳过，NSIS 仅在后台执行安装。`scripts/check-installer-branding.py` 在编译 NSIS 测试骨架前校验此配置；发布工作流在打包前构建安装器宿主。产物生成后，`scripts/wrap-windows-installer.mjs` 把 NSIS 载荷嵌入原生引导程序。引导程序在 `%LOCALAPPDATA%` 下创建私有临时目录，以该目录作为子进程的 `TEMP/TMP` 启动 NSIS，转发更新参数并返回子进程退出码，然后重新生成 blockmap 与 `latest.yml`/`beta.yml` 校验值。这样无需修改系统 `%TEMP%` 或自绘安装向导即可避开损坏的临时目录。
- **添加账号** = GitHub OAuth Device Flow(client_id `178c6fc778ccc68e1d6a` 即 gh CLI 公开客户端;`github.authStart` POST /login/device/code → GUI 显示 user_code + 打开 verification_uri + 按 interval 轮询 `github.authPoll`(pending/slow_down 续轮询;拿到 access_token 后 `gh auth login --with-token` stdin 导入 gh keyring——**所有 gh RPC 立即生效**))。注意 gh 配置在 `$HOME/.config/gh`(token 在 macOS Keychain)——**隔离 HOME 的 daemon 看不到用户 gh 认证**(测试用 mock gh + GH_CONFIG_DIR 组合)。
- **身份** = 提交身份列表(localStorage `musepi-gui-git-identities` + `musepi-gui-git-default-identity`,两步 prompt 新建,默认徽章,confirm 删除)——**git.commit 消费**(`-c` 注入)。**系统身份行**(2026-10-22):设置 Git tab 的身份区顶部新增一行只读的系统身份——daemon RPC `git.identity`(spawnSync `git config user.name` / `user.email`,local→global 链解析;`--local --get` 探测来源)返回 `{name, email, source}`;非仓库目录退化为全局配置且不报错。未写自定义身份时该行挂「默认」徽章,`source === "local"` 时挂「当前项目」徽章。
- **Issue/PR 阅读与评论**：`github.issueView` / `github.prView` 为独立详情列供数；gh 状态串按大小写不敏感处理（`OPEN` 与 `open` 都表示开放）。PR 详情请求 gh 支持的 `reviewRequests` 字段，并归一化为 GUI 的 `reviewers` 数组。`github.issueComment` 和 `github.prComment` 接收 `{cwd, number, body}`，要求 number 为正整数、body 非空白，经 host-aware `runGh` 调用 `gh issue|pr comment <number> --body <body>`，返回 `{ok:true}` 或 `{error}`，不落盘评论内容。发表成功后清空输入框并刷新列表与详情。列表和详情请求用序号防止选择/筛选竞态，mutation 完成后不得重新加载已卸载条目。
- **工作区变更面板**(openchamber GitView/ChangesPanel parity):三组(已暂存/未暂存/未跟踪 + 可选已忽略),每行 hover stage/unstage(`git.stage` = `git add -- <paths>`;`git.unstage` = `git restore --staged --` fallback `git reset HEAD --`),header 有平铺/树形视图切换 + Gitignored 开关(`git.status {ignored}` → `--ignored` 标志解析 `!!` 行)+ 提交按钮。
- **项目笔记面板**(ContextPanel NotesPane,2026-08-06 openchamber 对齐):快速笔记(daemon notes.get/set,3000 字符上限 + `{n}/3000` 计数,**400ms debounce 自动保存 + blur 立即落盘**)+ **待办列表**(localStorage `musepi-gui-todos:<cwd>`;**openchamber 语义**:header「待办 {count} 项」、每项 120 字符、添加插入到第一个已完成项之前、勾选完成移到末尾(completed-last)、清除已完成按钮(0 完成时 disabled)、删除 ✕)+ **计划文件**(daemon `plans.list/get/save/delete`,存 `agentDir/plans/<cwdHash>/<时间戳>-<slug>.md`,格式 `# 标题\n\n内容`——标题从首行 `# heading` 解析;GUI:「计划 {count} 个文件」header + `+` 新建(两步 prompt:标题+内容)+ 列表(标题+日期+删除)+ 打开查看(等宽 pre))。**存储设计**:与 openchamber 的 `~/.config/openchamber/projects/<id>.json` 不同——musepi 用 agentDir 文件(与 notes 同款,不碰用户项目)。**未做**(说明):dnd 拖拽排序、待办发送到会话、文件导入、聊天消息「保存为计划」按钮、CodeMirror PlanView。
- **prompt 对话框修复**(prompt-dialog.tsx,2026-08-06):确定按钮对 prompt 分支原来 `finish(true)` → 返回 **null(等于取消)**——prompt 只能靠 Enter 确认,点确定无效——改为 `state.kind === "prompt" ? finish(value.trim()) : finish(true)`。**bun build CSS 坑**:bun 的 CSS 解析器**不支持 `@layer` 裸语句**(`@layer a, b, c;` 报 Unexpected token,错误位置漂移到注释里的 `*` 误导调试)——**块形式** `@layer a {} @layer b {}` 可以(语义等价,声明层顺序)。base.css 的层顺序声明已用四空块替代。
- **文件预览与编辑器交互**(FilePane.tsx,2026-08-06):文件树支持**目录折叠**(点目录行 toggle,caret 旋转)、**点击文件预览**(内嵌右栏)、**右键菜单**(打开预览/在应用中打开/复制路径/刷新,复用 ContextMenu 组件)。预览分类:`fs.readBytes`(base64+mime+size,8MiB 默认 cap/32MiB 硬 cap)读文件 → 文本(TEXT_EXT + 前 4KB 无 NUL 判定,`<pre>` 等宽滚动)/图片(Blob URL + `<img>`)/**PDF 内嵌 pdf.js 渲染**(pdfjs-dist@6,逐页 canvas → data URL;渲染失败(加密/损坏)回退 `openWith("", path)` 系统默认应用)/其他二进制系统打开。**pdf.js worker**:bun build 不支持 `?url`/`?raw` 查询导入(bare 与相对路径都失败)——构建脚本 `cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs dist/pdf.worker.min.mjs`,`GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", location.href)`(file:// 同源 worker 正常)。**坑**:workspace.tree 的 entry.path 是**相对会话 cwd**,而 fs.readBytes 按 **daemon cwd** 解析——FilePane 必须显式拼接 `${cwd}/${entry.path}`(测试侥幸通过只因两者相同);复制路径同样用绝对路径(VS Code 语义)。预览 blob URL 在 preview 变化时 revoke 防泄漏。
- **内嵌文本编辑器 + office 预览**(FilePane.tsx,2026-09-16):预览面板对文本文件可编辑了。`openPreview` 的文本解码分支把已解码源码存进 `PreviewState.raw`(仅当 `size <= EDIT_MAX_BYTES` = 2 MiB——更大文件保持只读),预览头的 ✎ 按钮把预览体换成 `FileEditor`(纯 textarea——刻意不做代码编辑器:不会因部分解析挂掉,大缓冲也快)。**保存**走既有 `fs.write`(cwd 相对路径;预览存的是绝对路径,保存时切回尾部)。**dirty 状态镜像到面板 tab**:`onDirty(path, dirty)` → ContextPanel 解析 `panelTabId({surface:"files", target})` → `panelTabs.setDirty`,驱动 tab 条圆点并门控关闭(✕ / 右键关闭 / 关闭其他 / 关闭全部 都逐个确认 dirty tab;「关闭全部」保留用户拒绝的)。`PanelTab.dirty` 只在运行时存在——`serializePanelTabs` 从不持久化,恢复的布局是干净的。**离开守卫**:切换预览(树点击、tab 激活、外部 reveal)前确认丢弃;`activeFile` 效果在守卫被拒时**回滚 `lastLoadedRef`**,被拒绝的 tab 之后仍可激活。**缓冲缓存**(`bufferCacheRef`,绝对路径为键)跨 tab 切换保留——面板切 tab 时 pane 卸载,否则未保存的 textarea 会被重置成磁盘内容;保存后删除条目。**新建文件流**:以前新建文件会弹「GUI 无内置编辑器」——现在直接打开进编辑器。**office 预览(只读,不做编辑 SDK)**:`.docx` 用 docx-preview `renderAsync` 渲染进容器(`useBase64URL` 处理内嵌媒体;失败 → 「无法预览」提示 + 系统应用回退);`.xlsx`/`.xls`/`.csv` 用 SheetJS(`buildSheetModels`,为测试导出)解析成逐 sheet 的转义 HTML 表格,1000 行上限 + sheet 切换器。**SheetJS 坑**:`sheet_to_html` **不转义**单元格值,所以表格 HTML 本地构建并做 `&<>` 转义(含 `<script>` 的单元格绝不能进 DOM);`sheetRows` **会重写 `!ref`**,所以截断标记看返回行数(> 上限)而非 range;损坏字节 **不抛错**——解析成退化 workbook(无 sheet 或单个空单元格),故 `buildSheetModels` 在「没有任何非空单元格」时返回 null,预览回退到 `openWith`。`.pptx`/`.doc`(旧格式)仍走系统默认应用。
- **内嵌浏览器**(ContextPanel BrowserPane,2026-08-06):**Electron `<webview>`**(main.cjs `webviewTag: true` + `web-contents-created` popup 拦截——target=_blank 原地 loadURL,http/https only;partition `persist:omp-browser`;webpreferences `contextIsolation=yes, sandbox=yes`),**web 构建 iframe fallback**(isElectron 检测)。功能:地址栏(缺 scheme 补 http://)、后退/前进(URL 历史栈 + disabled 态)、刷新、在浏览器中打开、快捷端口、**视口尺寸预设**(自适应/手机 393×852/平板 768×1024/桌面 1440×900——容器宽度控制,居中)、**元素选取**(bitfun/openchamber parity):注入 `BROWSER_INSPECT_SCRIPT`(Promise.withResolvers,`webview.executeJavaScript(script, true)` 跨域执行)——hover 高亮 + 标签 tooltip + click 捕获 {tag, text≤500, selector(CSS path,≤6 层), outerHTML≤2000} → `window.dispatchEvent("musepi-gui-insert-text")` → Composer 监听追加「网页元素 <tag>：text + 选择器: selector」到草稿。webview 的 did-finish-load 用 ref addEventListener(React webview JSX 类型无事件 props;Electron 全局类型有 WebViewHTMLAttributes)。**三家参考**:bitfun=Tauri 原生 webview eval 注入 + context pill(`#element:` token);openchamber=Electron webview + 截图高亮附件(capturePage);craft-agents=BrowserView+CDP(Runtime.evaluate,agent 驱动 ref 点击,无用户点选 UI)——musepi 采用 bitfun/openchamber 的用户点选模式。**未做**:截图附件(capturePage + 高亮矩形,需要 main IPC——元素元数据已含 text/outerHTML 够 agent 用)。**测试教训**:CDP `dispatchKeyEvent` Enter 不带 text 时不触发表单 implicit submission——用 `form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))`;React 受控 input/select 用 native setter + input/change 事件;webview 是独立 CDP target(可对其 Input.dispatchMouseEvent 模拟页面点击)。
- **提交对话框**:textarea(⌘⏎ 提交)+ **19 个内置 gitmoji**(carloscuesta/gitmoji 子集,离线可用——openchamber fetch remote JSON 7d 缓存,musepi 选择内置)+ 身份(`git.commit` 用 `-c user.name/email` **注入不落 repo config**——openchamber 写 local config,musepi 桌面设置不该静默改用户仓库;身份来自设置 Git tab 默认身份)。
- **树形视图**:按首个路径段分组(`changesTree` 简化版),目录行可折叠。
- **daemon cwd 语义**(2026-08-06 修复):git RPC 原作用于 `#host.cwd()` = **daemon 启动目录**(非会话 cwd)——git 视图显示的是 daemon 所在仓库,切换项目会话不改变它(既有设计)**——已修复**:5 个 git RPC(log/diff/status/stage/unstage/commit)接受 `params.cwd`,优先 `path.resolve(params.cwd)`,空则 fallback `#host.cwd()`;GUI 的 GitLogPane/DiffPane 传 `snap.state.cwd`(会话权威 cwd,与 FilePane/NotesPane 同源),load 的 useCallback 依赖补上 `cwd`。**E2E 验证**(隔离 daemon cwd=/tmp/git3 + /tmp/gitrepo):无 cwd → `not a git repository`(不再误读 daemon 仓库);status 显示 a.txt M/c.txt ??;`ignored:true` → x.log;stage a.txt+c.txt → staged 2;commit `-c user.name/email` → 身份注入成功且 **repo config 未被写**(git config user.name 仍 Test User);unstage/diff/log 正常;daemon cwd 零泄漏。**tsgo 幻影错误教训**:tsgo 增量缓存可能拿旧源文件做类型检查(354 行 `"completed"` 报成 `"done"` 无重叠)——遇到不可能的错误先 `rm -rf node_modules/.cache/tsgo` 重跑。
- **Git 偏好设置**(设置页 Git tab):更改视图 radio/gitmoji 开关/显示 Gitignored 开关——localStorage `musepi-gui-git-view`/`musepi-gui-gitmoji`/`musepi-gui-git-show-ignored`,与 DiffPane 同 key 联动。

## 4. 会话设置与清理(算法)

- **会话默认值组** = 默认模型(`ModelSelector` 无 sessionId → `models.listAvailable`,写 `musepi-gui-default-model`——WelcomeComposer 读同 key)+ 默认思考等级(segmented,`musepi-gui-default-thinking`)+ 自动标题(`musepi-gui-autotitle`)+ 显示删除对话框(`musepi-gui-confirm-delete`)。
- **胶囊合并纯 UI**(ModelThinkingCapsule):composer/欢迎页两选择器合成一胶囊按钮——左段模型(品牌图标 + 名)、右段思考(brain + 等级),点击各自弹**原菜单**(搜索/收藏/图钉 / 等级 ladder)。**零新 RPC**:复用 `models.list(available)` / `session.setModel` / `settings.get(modelRoles)` / `getSupportedEfforts` 原链路,胶囊只重组触发按钮 + 容器查询收缩(`@container` 基于 `.gui-composer-frame` inline-size,文字 180ms 淡出为仅图标,`gui-motion-off` 瞬切);锚点仍走 `useFloatingMenu`(两阶段 + 模块级互斥,一次只开一个菜单)。
- **会话保留组** = 启用自动清理(`musepi-gui-autoclean`)+ 保留时长 stepper 1-365 天(`musepi-gui-autoclean-days`,默认 30,关闭时行 `gui-settings-row--disabled` 降透明+pointer-events:none)+ 过期动作归档/删除(`musepi-gui-autoclean-action`)+ 手动清理(`gui-btn` + 「当前可清理:{0}」)。
- **动作语义**:归档 = `session.close`(live 会话转 daemon 快照;**SDK 文件会话 close 报错被吞**——daemon 刻意不碰 workspace 文件);删除 = `session.delete`(**2026-08-11 起永久删除**:journal 文件 + materialized.db 物化行 + SDK transcript 主文件(`<sessionsDir>/<project>/<timestamp>_<sid>.jsonl`)+ 同名 artifacts 目录——修复前只删 journal/db 行,jsonl 残留导致 `listAllSessions()` 文件扫描重新列出、历史列表"复活"已删会话)。**已知语义**:`knownSessions` 的 `listAllSessions()` 有 10s TTL 缓存(`#historyCache`)——删除后列表最多延迟 10s 刷新;`session.list` 也可能显示"已删但缓存未过期"的会话,非 bug。**实现坑**:删除 transcript 用 `Bun.Glob.scanSync()` 返回**相对路径**,必须 `path.join(sessionsRoot, f)` 再 unlink/rm——裸相对路径按 daemon cwd 解析 → ENOENT 抛错中断循环。
- **删除确认统一在 `deleteSession`**(`useConfirm()` 弹窗,Escape/backdrop/取消/确定都可关;GuiHeader 与 SessionSidebar 不再自弹——避免双弹;开关关=直删)。

## 5. 伙伴实现细节(单窗口:pet.html——2026-08-11 的双窗口拆分已于 2026-09-16 回退)

- **单窗口合并(2026-09-16,非 100% 缩放下"宠物↔气泡"漂移的根因修复)**:气泡 + 交互面板迁回 pet 窗口(`src/pet-bubbles.tsx`);`bubble.html` / `bubble-main.tsx` / `bubble-set-size` / `syncBubbleWindow` / `watchPetMove` / `pet-set-panel` / 两个 DPI 探针全部删除。漂移是结构性的:两个窗口各自吸收一遍 DPI/scale 换算(误差翻倍),两个运行时探针(`probeSetPositionSpace` / `probeCursorSpace`)按机器猜 DIP 还是物理像素(RDP / per-monitor DPI / 虚拟化会话下猜错),且拖拽循环中途回读 `getPosition`(setPosition 异步 → 反馈环 = "鼠标停住还在漂")。新契约:① **一个窗口**——浮层卡片是 sprite 上方的 DOM(相对位置是 CSS,对 DPI 免疫);窗口经 `pet-set-content-size` 向上生长(底边固定 → sprite 在屏幕上不动;宽度钉死 320,面板 316 / 气泡栈 280 都放得下),无内容时缩回 290;click-through hitbox 并集纳入 `.pet-bubbles / .pet-bubble__dismiss / .pet-panel`。② **全程 DIP,零探针**——光标、窗口位置、workArea、持久化坐标全部按 Electron 契约用 DIP;`safeSetPosition` 只做 int 安全防护(无 scale 乘法、无同值回读)。③ **纯锚定拖拽**——`pet-drag-client` 每次拖拽只锚定一次 `{cursor, window}`,之后 `setPosition(anchorW + (cursor − anchorC))`;拖拽中途零回读(零反馈环);500px 坐标翻转守卫保留,重锚时保持窗口↔光标偏移。④ **持久化 = 完整 DIP 矩形** `{x,y,w,h,dock}`;恢复时按保存的尺寸校验包含性再落位。⑤ 交互打磨(对齐 clawd-on-desk):全局审批热键 `Ctrl/Cmd+Shift+Y/N`(globalShortcut,仅在"有 pending 审批且宠物可见"时注册;`pet:approval-resolved` 同步面板卡片)与 60s 空闲**睡眠态**(CSS 调暗 + "z z z",`.pet-window__pet--sleeping`;任何手势/mood 变化唤醒)。

- **Petdex 市场内嵌搜索/预览/安装**(2026-08-06):设置「伙伴」section 底部常驻 **PetMarket**(搜索框 + 结果网格 + 安装)。**数据源逆向**:petdex.dev 是 Next.js 站,CORS 全拒(renderer fetch 必失败)→ 全部走主进程 IPC——`pet-search`(net.fetch `https://petdex.dev/api/pets/search?q=&limit=24&includeMeta=0`,参数集从 JS chunk 逆向:q/kinds/vibes/colors/batches/sort/cursor/limit/includeMeta;响应 pets[]:slug/displayName/description/spritesheetPath/zipUrl/soundUrl/featured/kind/vibes)+ `pet-install-url`(下载 zip → 复用 importPetdexFromZip 解压路径 → dataURL 返回)。**预览**:`<img src=远程 spritesheet>` 是 CORS `*`(assets.petdex.dev 有 ACAO 头——canvas 可读)→ PetMarketCard 里 Image decode → measurePetdex → PetdexSprite 动画;远程测量是异步的(24 卡并行 ~2-5s),meta 未就绪显示 spinner。**安装**:点按钮 → 下载+解压 → measure → savePetdex + 自动选中(pickPet)。**细节**:主进程用 net.fetch 非全局 fetch(走系统代理);zipUrl 校验 `^https://assets\.petdex\.dev/`;搜索 debounce 350ms(清空即时)+ seq guard 防乱序。**同时移除内置 bitfun**(BUILTIN_PETDEX 条目 + public/pets/bitfun.webp,预设 10→9)。
**市场预览尺寸**(2026-08-06 二修):PetdexSprite 归一化后渲染 ~97px 宽,64px thumb 里被 overflow 裁切(看起来"放大局部")→ 每卡按 `fit = 56 / (frameW × 100/contentH)` 算 scale 传入(56 = thumb 64 − 8px 内边距),**完整显示、不裁切**(帧比例不同所以 per-pack 计算,不能固定系数)。**已安装网格 + Reveal**:`{expanded && …}` 条件渲染改为 `<Reveal open={expanded}>`(useCollapse 240ms + 160ms 淡入,关闭态 aria-hidden+inert、节点保持挂载——与设置其他条件区块同动效语言);市场区常驻不折叠。**spinner 命名坑**:`.gui-pet-market-card__loading` 曾引用不存在的 `@keyframes gui-flow-spinner`(实际叫 `gui-flow-spin`)——远程测量 2-5s 窗口里环是静态的,改后正常旋转。
- **帧循环必须跳过空列**(2026-08-06 闪烁根因):BitFun 的 sheet 行 = N 个有效帧 + 透明填充列——rest/waiting/working/analyzing 行只有 6 帧有效(cols 6-7 全透明),hover/dragging/error 行 8 帧;panda-pix 例外全 8。`steps(7)` 会把空列实打实渲染 343ms/周期——宠物每 2.4s 消失一次("一直在闪烁")。正确公式 = 行有效帧数 N:`steps(N)` + `--gui-petdex-cycle-end: -(N×帧宽)px`(与 BitFun `steps(6)+85.714%` 数学等价,终点列只出现在 t=100% 的不可见瞬间)。有效帧数来源:内置 pet 走 `PETDEX_ROW_FRAMES_DEFAULT=[6,8,8,8,8,8,6,6,6]`(panda-pix 显式全 8),导入包在 import 时用 `measurePetdexRows()` 扫 alpha(<1% 不透明视为空)存进 `PetdexPackage.rows`。旧存包无 rows → 回退默认。**"列 md5 不同 = 8 个独立帧"是错误结论**——空帧的 md5 也与其他列不同。
- **拖拽方向翻转 + hover 冻结**(2026-08-06):拖拽行帧是**固定方向走路循环**(BitFun 原版也无翻转——往右拖会"倒着跑")→ pet-main.tsx 跟踪 `ddx = e.clientX - s.lastX` 增量方向,`flip = ddx > 0`(帧本为往左跑,只镜像右移),翻转放**独立 wrapper** `.pet-window__pet-flip--mirror { transform: scaleX(-1) }`(transform-origin 50% 80%)——绝不能放 `.pet-window__bump` 上(动画覆盖静态 transform,见下条);resetDrag 清 flip。**抖动脉冲修复(两轮)**:①逐帧增量方向噪声 ±1-2px——`setFlip(ddx > 0)` 让拖拽中宠物左右横跳→ 改**累计位移 + 阈值** `dirAcc += ddx; |dirAcc| > 5px 才翻转并清零`(DIR_FLIP_THRESHOLD_PX=5);**②真正根因——主进程 `pet-drag-client` 增量算法累积漂移**:`abs = 移动后窗口位置 + clientX` 而 `petDragLast` 存的是**移动前**位置+clientX——窗口每次移动都把自身位移二次计入,越追越快→ 超调 → 指针相对窗口反向 → clientX 增量方向振荡 → flip 反复切(合成 CDP 测试测不出:注入的是窗口内坐标,窗口移动不反噬 clientX;cliclick 真实指针才暴露)。修复:**锚定式拖拽**——`pet-drag-client` 改用 `screen.getCursorScreenPoint()`(物理指针):首个 move 锚定 `{cx, cy, wx, wy}`,之后 `setPosition(锚定wx + (指针x - 锚定cx), …)`——窗口位置只由物理指针推导,与窗口自身位置零反馈,无漂移无振荡;`movePetWindow` 复用节流持久化。cliclick 实测:右拖 200px flips=1 + 窗口精确跟手;左拖 flips=1 + mirror 正确移除。边界(原设计):拖拽中指针移出窗口会断事件流(pointerup 丢失 → 陈旧锚定),真实使用窗口跟手不会触发。**hover 冻结帧**:hover 行的帧循环在多数包上是走路内容,悬停播帧 = "没有方向语境地在跑"→ PetdexSprite 加 `frozen` prop(animation 只留 `gui-petdex-{mood}` transform 弹跳,background-position 停在 hover 行帧 0;`--gui-petdex-cycle-end` 省略),pet-main 传 `frozen={displayMood === "hover"}`。E2E(CDP 合成鼠标):往右拖 mirror ✓ 往左拖无 ✓ 释放清 ✓ hover animation 只有 `gui-petdex-hover` ✓。**拖拽状态机对齐 clawd-on-desk/openpets(2026-08-06)**:用户报"鼠标失去焦点后,不拖也一直跟着鼠标走"——根因:**pointerup 被吞后 `pressed` 卡死 true**(窗口失焦/pointer capture 被系统抢走时 up 事件丢失),之后任何 hover move 都走拖动分支。参照两项目状态机补齐:①`onLostPointerCapture={resetDrag}`(clawd: lostpointercapture → stopDrag);②**window blur → resetDrag**(clawd blur 兜底);③resetDrag **幂等化**(clawd stopDrag guard: pressed&&dragging 双 false 直接 return,防 up/blur 双触发);④**RAF 合并 move IPC**(clawd queueDragMove 模式:pointermove 120Hz+,每事件一发 IPC 会在 setPosition 后排队积压→窗口滞后追赶噪声;RAF 帧合并、只发最新 client 点);⑤**主进程 did-finish-load 清 petDragLast**(openpets resetForNavigation:renderer 重载后 pressed 全新,陈旧锚让首个 hover move 拖动窗口)。cliclick 真实指针验证:RAF 拖拽跟手 ✓;blur 中途→ hover 移动窗口不动 ✓;lostpointercapture 中途→ 停止 ✓。参考实现:clawd-on-desk hit-renderer.js(五复位路径+RAF+dragLock)、openpets pet-preload.cjs(document 级监听+主进程快照+导航兜底)。**input 模式宠物定位**(2026-08-06):宠物从 ComposerFrame `footerLeft`(输入框内左下)移到 **`.gui-composer-pet` 槽**(frame 内 absolute,`right:10px; bottom:calc(100% + 4px)` = 输入框上边界外右上角,pointer-events:none + z-index:1)——welcome/会话共用 ComposerFrame 一处实现(FLIP morph 一起动);设置文案同步(「输入框内」→「输入框上方右上角」)。**踩坑:几何验证 ≠ 视觉可见**——BorderBeam 注入 CSS `[data-beam] { overflow: hidden }` 把溢出宠物顶边裁掉(welcome + 会话两场景都有 beam)——getBoundingClientRect 不受 overflow 影响,纯几何 E2E 全绿但用户看不到;修复 `.gui-border-beam.gui-border-beam--pet { overflow: visible }`((0,2,0) 压过 (0,1,0),beam 装饰层 clip-path 自裁所以安全)。验证必须截图(captureScreenshot + 视觉确认),不能只信 rect。
- **bump 动画必须保留基座 transform**:`.pet-window__pet` 靠 `translateX(-50%)` 居中,而动画会覆盖基座 transform——`gui-pet-stage-bump` 每个关键帧都要带 `translateX(-50%)`,否则每次 mood 切换宠物横跳 48px。
- **mood 切换的微弹** `gui-pet-bump` 用 classList 重触发(remove → reflow → add),**不能靠 key 重挂载**(会重启帧循环)。
- **click-through 机制**(darwin 专属):窗口默认 `setIgnoreMouseEvents(true)`;main.cjs 120ms 光标轮询(`screen.getCursorScreenPoint` vs 窗口位置 + renderer 上报的 hitbox 并集)翻转 ignore;**hover 状态由主进程 `pet:hover` IPC 推送**(click-through 下 renderer 的 pointerleave 不可靠);渲染器每次布局变化(气泡增减)重报 hitbox(`pet-set-hitbox`,置 `petIgnoreState=null` 强制下一 tick 刷新)。
- **拖拽三铁律**(2026-08-06 交互审查后确立):①**拖拽中绝不切回 click-through**——`updatePetClickThrough` 在 `petDragLast !== null` 时跳过整个翻转逻辑。快速拖拽时光标会瞬间逃出 hitbox,一旦翻转 ignore,pointer capture 失效、pointerup 丢失、`petDragLast` 残留,下一次拖拽第一帧按旧 delta 跳窗。②**锚点必须在所有丢指针路径上清理**——renderer 的 `resetDrag`(pointerup 与 pointercancel 共用)必须调 `pet-drag-end`,main 侧 `setPetVisible(false)` 与窗口 `closed` 也清。③**位置持久化必须节流**——sync fs 每 pointermove 一写会卡主进程,拖拽中 ≤1 次/150ms(`petLastPosWrite` + `petPosDirty`),`pet-drag-end` 时 `flushPetPos()` 兜底最终位置。
- **hitbox 并集必须含 `.pet-bubble__dismiss`**:× 按钮 `top:-7px; right:-7px` 悬出气泡矩形,只并 `.pet-bubble` 会让 × 外圈 7px 成为穿透死区(点击落到底层 app);selectors: `.pet-window__pet, .pet-bubble, .pet-bubble__dismiss`。
- **已知取舍**:120ms 轮询 = 进入 hitbox 后 ≤120ms 内的快速点击会穿透(与 BitFun 同款间隔,可接受);矩形并集在气泡栈与宠物之间的空隙吞点击;Windows/Linux 未启用 click-through(整窗 320×290 交互会挡桌面点击——darwin 专属是刻意选择,跨平台需实测)。
- **pet-pos.json 校验**:加载时若持久化位置不完整落在任一 display workArea 内则拒绝回默认位(macOS 会把越界 frame 钳回,导致存储与实际脱钩、click-through 翻转时跳回旧帧)。
- **[2026-09-16 被上方单窗口合并取代] 双窗口架构**(2026-08-06 拆分,2026-08-22 窗口材质改为全平台透明):气泡与交互面板曾迁出 pet 窗口,独立 **bubble 窗口**(`bubble.html` → `src/bubble-main.tsx`),经 `bubble-set-size` → `syncBubbleWindow` 内容定尺 + sprite 锚定。这套"追着宠物跑"的定位正是漂移根源,已删;卡片自绘玻璃(半透明 tint + 顶部高光 + 发丝线)的材质决策原样保留。
- **[2026-09-16 已删] 锚定数学**(`syncBubbleWindow`):曾锚**角色 sprite**(`petRect`,非窗口)+ workArea clamp;`watchPetMove` 拖拽跟随。随 bubble 窗口一并删除——浮层锚定现在是单窗口内的纯 CSS。
- **挂靠态可交互(2026-09-19,`.gui-composer-pet` 五处缺陷)**:该槽长期是 `pointer-events:none` 的纯装饰,且尺寸写死 `size={30}`。以 **CDP 对真实 React 组件**逐项实测(自建 DOM 与 `element.click()` 都看不见 blur,只有真实事件源有效),修掉:①**尺寸低于可辨识度下限**——嘴 stroke 仅 0.80px,改为容器查询定尺寸 `width: var(--gui-composer-pet-size, clamp(44px, 4.6cqw + 26px, 60px))`(`.gui-composer-frame` 已带 `container-type: inline-size`),配 46px 地板 `--micro` 降级(mouth/eye-filter/antenna 全 `display:none`,只留两个眼灯);实测 320px 视口 stroke 1.13px、980px 下 1.70px。②**天线 mast 亚像素**(`stroke-width:4` face 单位 → 0.58px)挂靠态隐藏,接地感交给 wrapper 的 drop-shadow。③**viewBox 底部死区**浮空约 6px——`margin-bottom: calc(var(--gui-composer-pet-size) * -40 / 298.5)` 按 `FLOOR/VIEW_H` 折算收回。④**点击夺焦**——mousedown 在任何不可聚焦元素上都会 blur 当前焦点,点桌宠会把光标踢出输入框(实测 `activeElement` 从 `#ta` → `body`);`onPointerDown` 里 `e.preventDefault()` 抑制由 pointerdown 派生的**兼容鼠标事件**,blur 不再发生而 `click` 仍照常触发。⑤**金色污渍**(截图才发现)——`ground`/`thrust`/`bounce` 三个地面层锚在轮廓**下方**(`bounce` 在 `cy=ORB_C+78`),溢出球底约 4.7px,挂靠成一团金污;挂靠态三者全隐藏。**验证纪律**:①必须对真实组件 + 真实指针事件测,`element.click()` 不产生兼容鼠标事件序列,blur 永不触发;②必须 1:1 像素截图判可辨识度——6× CSS zoom 会重新光栅化 SVG,必然好看,会掩盖亚像素失败;③每次修复都做**撤回验证**(移除修复→变红→恢复→绿),本轮撤回 ④ 时实测 `FAIL caret preserved through the click (activeElement=#)`。
- **折叠↔展开宽高双轴 morph**(2026-08-11,修复"宽度跳变"):`stackMorph = { from: {width,height} }`,morph effect 对 width+height 双属性过渡(320ms overshoot);switchStack 捕获 from rect、渲染分支 inline 锁 from、effect lift→测 to→锁回→reflow→过渡。**关键坑**:lift 测量必须 `el.style.width = ""`(清 inline 回 CSS `max-content`),**`"auto"` 对块级元素=撑满包含块**(覆盖 max-content 后 toW 退化为窗口宽→宽度过渡静默跳过);折叠卡禁用 `width: min(240px, 70vw)`(vw 依赖与内容定宽窗口形成收缩振荡)。
- **面板入场 gating(宽度先行,2026-08-11,修复"先右半再全显")**:面板 mount 时 `opacity:0`,等窗口 resize 事件(120ms 兜底)→ 加 `pet-panel--in`(320ms 入场,`forwards` 保持终态——基础规则已 opacity 0)。根因:面板 316px 在气泡堆宽度(~140px)窗口内渲染,窗口 resize 经 IPC 滞后一帧——先露右半、左半突现;叠加 keyframes 烤的 `translateX(-50%)`(absolute 居中残留)把 flow 定位面板左移半宽。bubble 版用 flat keyframes(`pet-panel-in-flat`,无水平位移)。**通用模式**:内容驱动窗口的入场动效必须等窗口尺寸稳定(`resize` 事件)再播——见 gui-design.md §5c clawd-on-desk 分析。
- **report 动画尺寸**(2026-08-11,修复面板打开窗口闪烁):report 对进行中 CSS 动画的元素用 `offsetWidth/offsetHeight`(布局盒,不含 transform)——`getBoundingClientRect` 含 scale(0.98) 缩小值,动画中报告会把窗口定小、animationend 后跳变;检测 `el.getAnimations().some(a => a.playState === "running")`。
- **mount effect dead code**(2026-08-11,biome noUnreachable 报出):`return bridge?.onPetActivity?.(...)` 提前 return 吞掉后续 `requestPetState`——订阅 teardown 用 `const off = ...; void sideEffect(); return off` 模式。

- **win32 桌宠原生集成(koffi FFI,2026-09-19,修「桌宠漂移 / 下沉 / 变大」)**:`electron/win32-native.cjs` 是**全失败放行(fail-open)**的原生模块(koffi → `user32` / `dwmapi`),暴露 Electron 拿不到的三个探测:**① 前台全屏**(`GetForegroundWindow` + `GetWindowRect` + `MonitorFromWindow` + `GetMonitorInfoW` + `GetWindowLongW` + `GetClassNameW`)——`BrowserWindow.isFullScreen()` 只报**自家窗口**,全屏游戏对它不可见,于是 topmost 看门狗每 5s 把 z 序从游戏头上抢回来;**② 每显示器 DPI**(`GetDpiForWindow`)——权威因子,取代 display-matching 猜测;**③ DWM cloak**(`DwmGetWindowAttribute(DWMWA_CLOAKED)` / `DwmSetWindowAttribute(DWMWA_CLOAK)`)。五处根因,逐项实测:① **`setPosition` 无读数回校**——win32 的 `SetWindowPos` 按显示器把 DIP→物理像素并取整,窗口管理器还可能在边缘吸附/夹取;该修正从未回写到拖拽锚点,于是误差每帧都从陈旧假设重新推导并累积(本机 `GetDpiForWindow` = **144,即 150% 缩放**——正是这种取整最大化的配置)。修法:`setPetBounds()` 成为**唯一**位置写入点——先读实时 rect,有差异才写,且用 `setBounds`(不是 `setPosition`)让宽高随写一起走。② **无显示器拓扑监听**——`display-removed` / `display-added`(立即)与 `display-metrics-changed`(**400ms 去抖**——DPI/RDP 事件成串到达,逐事件夹取会让桌宠整段过渡期抖动)→ `reconcilePetWindow()`,只有 rect 的**中心点**离开所有工作区时才动位置。③ **`powerMonitor` resume 只重连 daemon**——唤醒时的 DPI 通量正是把尺寸棘轮放大的元凶(clawd #408,"越睡越大"),故 resume 现在延后一个去抖节拍按 `PET_WINDOW_SIZE` 校正尺寸。④ **`setAlwaysOnTop` 只设一次**——被边缘吸附与睡眠唤醒降级后永久失效;改为 `"pop-up-menu"`(高于任务栏级 UI)并由 **5s 看门狗**重断言,外加拖拽/挂靠跑到 `isNearWorkAreaEdge()`(容差 2)时立即重断言。⑤ **cloak 自愈**——被 cloak 的窗口不可见,而所有 JS 可见信号全是绿的;只恢复 `APP`(自身造成)的 cloak:从不碰 `SHELL`(常是用户在别的虚拟桌面,且没有 `IVirtualDesktopManager` 时两者无法区分),失败按指数退避。**两处值得留存的判断**:(a) **必须排除桌面/Shell 窗口类**(`progman`、`workerw`、`xamlexplorerhostislandwindow`、`windows.ui.core.corewindow`),否则「点桌面」会被判成全屏、桌宠乱隐藏;(b)`MAXIMIZED ≠ FULLSCREEN`——有任务栏时 `rcWork != rcMonitor` 几何即可分辨,但**无任务栏显示器上 `rcWork == rcMonitor`,geometry 彻底失效**,只能靠 style 位(`WS_MAXIMIZE && WS_CAPTION` = 最大化普通窗口)。`GetWindowRect` 返回的是**含 DWM 不可见边框**的物理像素(实测 `-8,-8`),故比较一律用容差、绝不用相等。**验证**:13/13 条 `classifyFullscreen` 断言(含反向输入——返回常量的桩必须失败),以及一次真实 Electron 探针确认 `dpiForWindow` = 144 = Electron 自己的 `scaleFactor`、cloak = 0,且关键的是——三个探测在**窗口已销毁时全部失败放行而非抛错**(看门狗是按定时器轮询它们的)。**打包陷阱(不得回归)**:koffi 的原生二进制放在**独立的按平台分包**里(`@koromix/koffi-<platform>-<arch>`),加载方式是朴素的 `require("@koromix/koffi-win32-x64")` → `win32_x64/koffi.node`。必须同时满足两个条件,否则模块**只在打包产物里**静默降级成 stub——开发态照样能用,这正是它危险的地方:① 平台分包必须是**声明过的**依赖;已写进 `optionalDependencies`(六个桌面目标),这样它才会真正被链接到 `packages/desktop-app/node_modules/@koromix/`。此前它只在 bun store 里而**从未被链接**(`bun install` 报的 `EEXIST … failed to symlink` 警告),koffi 只是靠往上走进 store 目录结构才找到它——纯属开发态巧合;② electron-builder 的 `files` 是**白名单**,故 `node_modules/koffi/**/*` 与 `node_modules/@koromix/**/*` 显式列入,并在 `asarUnpack` 里重复一遍(原生 `.node` 必须与加载器同处)。验证方式是插桩 `Module._resolveFilename` 后真实加载 koffi,不要靠推断——并确认 `koffi.version` 有返回。

- **眼动跟随(gaze,2026-09-19)**:`pet:gaze` 搭载 main.cjs 里既有的 120ms `updatePetClickThrough` 轮询——光标相对窗口中心,按 `PET_GAZE_RANGE_CSS = 420` css px 归一化到 ±1、夹紧到单位圆、`PET_GAZE_EPSILON = 0.02` 死区节流(光标不动就零 IPC)。渲染链:`preload.onPetGaze` → pet-main 写入一个 `GazeVec` ref(**绝不走 React state**——IPC 流不允许触发重渲染;引擎在 `useMascotEngine(mood, gazeRef)` 里逐帧读 ref)。镜像补偿发生在**写入侧**:`gazeMirrorRef` 同步 `flip || dockSide === "left"` 并对 x 取反,抵消 CSS `scaleX(-1)` 刚体,视线永远对着真实光标。引擎混合常数(PetSprite.tsx):渐入 220ms / 渐出 380ms / 滑动 τ 120ms;不传 ref 则只有原生闲视漂移。主窗口的头像预设直接监听 `window.pointermove`——每个挂载的 `PetAvatar` 一个监听器,120px 视距,写各自的 ref。Petdex 精灵图忽略 gaze(位图帧,眼睛动不了)。
- **gaze 头部滚动 + 配饰的分摊(2026-09-20/21)**:只有眼睛动会读作"滑动",所以 rig 本体朝光标方向微滚——`rotate(gx·GAZE_ROLL)`(0.05 ≈ 满偏 ±1°)追加在 shell 的 motion transform 之后;配饰只承担 rig 没带的那部分(配件组 translate 0.3/0.24·g + rotate 0.06°·gx):耳罩挂在壳面上,免费继承壳的滚转,再叠一遍就会转过头。耳机的整体放大(`HEADPHONE_SCALE` 1.08,已按 TOP 24 / SIDE 20 核验——1.10 时 canopy 圆帽出界)搭乘同一个每帧配件属性;在那里写静态 transform 会被引擎每帧覆盖。
- **orb 状态单一来源(2026-09-19)**:`orbFromSession(snap)`(lib/pet.ts)——`approvals.length > 0 → "waiting"`,否则沿用旧的 `working/streaming` 三元式,否则 `"listening"`。ChatView(聊天 orb)与 GuiHeader(工具栏 orb)都改为消费它;两者各自的重复三元式早已和 `moodFromState` 漂移、从未反映待审批。vendor `OrbState` 联合类型新增 `"waiting"`(`STATE_TO_MODE.waiting = "wave"`——零新引擎工作,同 ModeKey;区分靠钉住不轮播)。`waiting` 不得加入 AgentAvatar 的空闲 `IDLE_CYCLE`,pet 预设则完全退出轮播(`ORB_TO_PET_MOOD` 绑定是权威的——脚本化轮播会与会话状态打架)。
- **主题跟随色板契约(2026-09-19)**:`lib/pet-palette.ts` 的 `petPaletteVars(accent, theme)` 派生 8 个变量(`--gui-pet-shell-a/b/c`、`--gui-pet-gold-a/b/c`、`--gui-pet-rim`、`--gui-pet-glow`)。dark:壳 L .56/.36/.19 @ C .045–.05;光族 = tint(accent L+0.12,C×1.1+.02 ≤ .14)/ accent / shade(L×.62,C×.9);rim = tint @ .3 透明度,glow = accent @ .8。light:壳 .78/.58/.38,tint L+0.15(≤ .8),shade 地板 L .3;rim L .3 C ≤ .1 @ .22,glow shade @ .55。色度地板 C0 ≥ .055(mono 近中性 accent 仍有染色)。**chroma-js 只用于解析**——它的颜色对象以 RGB 为底,构造时即钳制到 sRGB(会旋转本色板亮 tint 的色相),所以派生是纯通道算术、输出为手工格式化的 `oklch()` 字符串;Chromium 对其做规范的色域映射(hex 则会逐通道钳制、旋转色相)。应用点:app.tsx 挂载 + MutationObserver(`attributeFilter: ["data-theme", "data-accent"]`)+ 桌宠窗口 `applyScheme`;桌宠窗口从不设 `data-accent`,因此 `PetActivity` 增加 `accent`(解析后的 `--accent` 字符串),pet-main 先内联到 `--accent` 再重派生。依赖:`chroma-js ^3.2`(+ `@types/chroma-js`)——bun isolated linker 把它解析到 `.bun/` 下,直接 `ls node_modules/chroma-js` 看不见属正常。测试:`test/pet-palette.test.ts`(10 条)——色相断言解析**写入的 oklch 字符串**,绝不做 chroma 往返(chroma 解析时即钳制出界颜色,会伪造色相漂移)。
- **状态系统是对 blobstudio 的原文级吸收,不是语义复刻(2026-09-20 晚)**:用户指令「不能靠语义来复刻,直接吸收源码——语义相似但效果千差万别」。权威底本是反解出的引擎源码(`.workbuddy/tmp/blob/idx.js`,注释完整):STATE_MOTION 每一处值都换成 bundle 字面量(`sending:{dash:[66,1500],scale:.21}`、`receiving:{dash:[66,-1500],scale:.21}`、`uploading:{bob:[3,1000],scale:.74}`、`loading:{sway:[2.2,1500],pulse:[.012,1500],scale:.72}`、`progress:{pulse:[.022,1600],scale:.74}`、`thinking-dots:{}`),外加 `dashPoint()`(Lissajous:cos r / sin 2r·0.44)与源码自己的语义("balled up and thrown along a flight path, [travel radius, period ms]")。`test/pet-state.test.ts` 钉死这些字面量,防止日后"清理"悄悄重新推导。
- **dash 把身体飞行与尾巴焊在同一个时钟上**:`motionTransform` 用 `entryElapsed`(逐入场)推进 `dash`,`PetEffects` 拿同一个 `entryClockRef`——尾巴采样的是头部真实飞行的路径。换成持续相位钟,每次状态切换后头尾都会落在环路的不同点。
- **特效层是运动 rig 的兄弟,绝不是子节点**:三处 `<g translate(SIDE TOP)>` 挂载——特效后层 / shellRef rig / 特效前层。继承身体的 motion transform 会把 dash 头甩到 2 倍飞行偏移处、拖着尾巴追一个已经飞走的球;特效层按世界系授权,球遮住后层才读作环绕。
- **bodyRef + htmlBodyRef:一个身体,两条通道**:dots/glyph 不再 CSS 压暗脸——直接驱动共享身体组(SVG `setAttribute` transform/opacity;HTML `style.transform`/`style.opacity`,同一 shed 公式 `target = radius/(FACE_BOX/2)`)。HTML 通道存在的原因:petdex 状态宠的身体是 div 不是 SVG 节点;`PetdexStateStage` 把 motionRef(外层,引擎 transform)嵌在 bodyRef(内层,特效 transform)外面,两个变换复合而不是互写清空。
- **PetdexStateStage:导入 SVG 获得完整状态轴**(`PetdexSprite` state 分支):`u = frameH·k/FACE_BOX` 是唯一的 face-unit 缩放——任意宿主尺寸下运动振幅与特效坐标都保持源码比例。它的 overlay svg 逐字重声明 `gui-pet-grad-shell` 径向渐变:dots/pops/glyph 填充 `url(#gui-pet-grad-shell)`,而该渐变定义在 builtin Silhouette 的 defs 里——纯导入页没有这个 def,特效会画成空白。(重复 id 解析到首个;两处定义一致,builtin 页不受影响。)
- **SHAPE 契约 + 「无配饰系统」(blobstudio 实测结论)**:引擎天然 shape-agnostic——`MascotShape {fit, body{{GRADIENT}}, clip, anchor}`,注释原文 "All of this is shape-agnostic — it moves whatever silhouette it is given, so an uploaded logo behaves exactly like the built-in circle"。源码里没有配饰系统(headphone/hat/outfit 零命中):一切附属于身体的东西都活在身体组里、随身体变换。这就是耳机的规范——AirPods Max 全套(canopy 三弧 r 123.3/128/118.5 + 玫瑰金轨 2.6 + 滑杆 9×30 + 耳罩 12.6×25 含网垫/深腔/边缘高光 + 右耳罩 Digital Crown 7×10;白 `#f6f5f2→#dfdeda`,玫瑰金 `#e5bdaf→#cf9485→#9f6b60`,固定身份、刻意不从 accent 派生)整体住在 `bodyRef` 里:dash 飞行带着耳机走,dots 消解连球带耳机一起化掉,而不是让一堆硬件悬在彗星头上。

## 6. CSS 反模式清单(全部踩过坑)

1. **自定义属性自引用/循环**(`--border: var(--border)`)→ guaranteed-invalid,静默消失。**同坑复发**:浮层 scrim 想写 `--gui-glass-overlay: max(95%, var(--gui-glass-overlay))` 是自引用,静默回退继承值——必须直接覆盖 `background` 本身。
2. **calc 长度×百分比**(`calc(28px * 100%)`)→ 非法,静默回退 0。
3. **transform 动画 keyframes 替换静态 transform**(`translate(-50%,-50%)` + scale 关键帧)→ 动画期间锚点丢失跳位;纯 opacity 或把完整 transform 写进关键帧。
4. **backdrop-filter 首帧闪烁** → 两阶段挂载(先 opacity 0 上屏,下一帧加动画类)。
5. **挂载即动画会杀死磨砂**(2026-08-06 实测,与 4 同根):带 `transform: scale` 的 `gui-menu-in` 若在**挂载帧直接播放**(ContextMenu/Pop 旧实现),Chromium 真实屏幕合成器**跳过 backdrop 采样,且动画结束后不重采样**——菜单永久渲染成普通半透明(背后文字直接透出,无磨砂);`useFloatingMenu` 的两阶段(挂载帧无动画类,下一帧 rAF 加 `--entered`)不受影响。**CDP 截图(offscreen 合成)仍显示模糊,是最大误导源**——曾据此误判"transparent 窗口 blur 全失效"(electron#30412 是长期未解决的独立问题,但本 GUI 的菜单 blur 一直可修),错误地用 95% scrim 覆盖全部浮层(用户立刻发现"全都不是磨砂了",已回退)。修复:ContextMenu/Pop 两阶段进入(`--pending`/`--entered` 类),Pop 调用方类移除自带 animation。**验证浮层磨砂必须真实屏幕截图(screencapture -l 窗口 ID),CDP 截图/计算样式不算数。** **全浮层统一(2026-08-11)**:共享 hook `useTwoPhaseEnter(active)`(packages/desktop-app/src/lib/use-two-phase-enter.ts,两 rAF 后返回 `--entered` 后缀,close 时重置)——接入此前越轨的 5 处:Board 放大/小组件任务/引导遮罩/⌘K 命令面板(改常驻挂载+退出动画)/选区工具条(补入场退场);base `opacity:0` + `--entered` 使 motion-off 自然瞬现。这些点此前是**挂载帧直接播 `gui-fade-in`(纯 opacity,无 scale)**——属本条风险类的轻度变体,未在真实屏幕实测失效,但契约上违反两阶段,统一后消除差异。
5. **flex 子项缺 `min-width:0`** → 内容撑破/尺寸不一致;flex 子项 `margin-inline:auto` 会击败 stretch。
6. **popup/浮层被祖先 overflow/transform 裁剪** → portal 到 body。
7. **rAF 节流闩锁未在帧回调内释放** → 后续事件被吞。
8. **SVG stroke 渐变必须 `gradientUnits="userSpaceOnUse"`**(2026-08-06 图标渲染实测):`stroke="url(#g)"` 配默认 objectBoundingBox 单位在 Chromium 渲染器(Chrome/Electron headless)整条 stroke **渲染为空白**,同渐变 fill 正常;显式坐标 + userSpaceOnUse 即恢复。涉及 app 图标 SVG 渲染(build/icon.svg)时必踩。
9. **无层(unlayered)规则压制所有 @layer 规则**(2026-08-06 侧栏 tabstrip 贴边根因):guest-client base.css 的 `*{margin:0}` 是 unlayered,Tailwind v4 utility 全部在 `@layer utilities`——cascade 里 **unlayered 恒胜所有 layer**,于是侧栏 `mx-2.5/mt-3/ml-auto` 等全部 margin utility 静默算成 0px(胶囊贴左边缘、右侧按钮簇紧跟胶囊、`mt-3` 间距消失),而 padding utility 正常(没有 universal padding reset),症状极具迷惑性。修复:reset 移入 `@layer base`,前置空 `@layer theme/base/components/utilities {}` 块钉死顺序(tailwind CLI 会把 `@layer a,b,c;` 语句规范成这种空块形式,构建幂等)。教训:**GUI 里 Tailwind margin utility 不生效先查 unlayered universal margin reset**。
10. **误截断源文件的恢复路径**(2026-08-06 事故记录):`head -c <N>` 按**字节**截断大 CSS(8251 行 ≈ 370KB),git 无 WIP 提交、无 sourcemap、无 TM 快照时,唯一完整恢复源是**上次 `bun run build` 的 dist 压缩 CSS**(含全部规则):①选择器集合 diff(HEAD vs dist)枚举 WIP 规则;②从 dist 提取每条规则(压缩单行,按 `{` 平衡扫描 + 向前回溯选择器列表起点,合并逗号组合块);③`@media` 内规则记录上下文;④@keyframes 逐一比对(注意 `ag-*/tr-*/tv-*/spin` 等属 guest-client,勿混入 gui.css);⑤格式化重排后追加,带恢复注释。恢复后功能等价,格式/注释丢失。**教训:大文件截断前先 `wc -c`;**给重要 CSS 定期 `git add`(index blob 可救)。
11. **legacy keyframes 烤静态 transform 在 flow 布局下错位**(2026-08-11):面板 keyframes 烤 `translateX(-50%)`(旧 absolute 居中残留),新布局已 `transform: none`(flow + margin 居中)——动画播放时把元素左移半宽,"先露右半再突现左半"。**教训:改布局定位方式时必须同步审计 keyframes 里的静态 transform;动画与静态布局解耦用 flat keyframes(只动位移/缩放/模糊的相对量)**。
12. **动画中 `getBoundingClientRect` 含 transform**(2026-08-11):scale(0.98) 入场动画中 rect 是缩小值——内容驱动窗口按它报告会把窗口定小,animationend 后跳变。**内容尺寸报告对动画中元素用 `offsetWidth/offsetHeight`(布局盒)**;检测 `el.getAnimations().some(a => a.playState === "running")`。
13. **锁宽测量 `width:"auto"` 覆盖 CSS `max-content`**(2026-08-11):morph 测量目标宽度时 `style.width = "auto"` 对块级元素=撑满包含块(覆盖 CSS `width:max-content`),toW 退化为容器宽 → 宽度过渡静默跳过(高度正常,视觉"只缩高不缩宽"再跳变)。**必须 `style.width = ""`(删 inline 声明回 CSS 值)**。
14. **浮层卡面 class 双应用 = 嵌套双画圆角**(2026-08-15,自定义强调色选色器):`useFloatingMenu(…, { className })` 的 class 落在**外层 portal 容器**,内容组件根若带**同一卡面 class**(ColorPickerPanel 根 `gui-color-picker`),两层同时拿到磨砂+圆角+阴影 → 背景多画一层圆角容器(`div.gui-menu-popup.gui-color-picker.gui-menu-popup--entered > div.gui-color-picker`)。规则:**卡面 class 只能出现在一层**——传 className 时内容平铺(proj/todo/queue/creds 类);不传时内容根自持卡面(quota/context/color-picker 类)。验证:`document.querySelectorAll('.gui-color-picker').length === 1` 且外层 computed `border-radius: 0`、`background: transparent`。

## 6b. 浮层材质、降级与 modal 栈

- **材质归属**：tooltip、toast、alert/approval 与 drawer/sheet 容器使用 L2（`--glass-bg-strong` + `--glass-border` + `--glass-sheen` + `--glass-shadow`）；modal、palette 与 confirmation 卡使用更高层级的 L3，token 集合相同。阴影 token 同时拥有上下内缘，包括底缘；不得再叠加第二套 rim 或阴影。`ConfirmDialog` 使用 `ss-card--confirm`，避免与 SessionsSheet 的 L2 角色混用。`ApprovalCard` 使用语义文字/动作色，不使用固定深色底。
- **回退归属**：`client-core/src/styles/overlay-fallback.css` 集中定义 `prefers-reduced-transparency`、不支持 `backdrop-filter` 与 `[data-platform="win32"]` 的浮层规则。所有使用共享浮层样式的入口都在组件样式之后导入它，确保回退在真实 desktop 级联中胜出，不被后续卡片/scrim 声明夺回。桌面 `initTooltips` 在安装桌面 tooltip 行为之前先写入 `shellPlatform()` 的 `data-platform`，因此 main、pin、pet 窗口都能匹配 Windows 规则。pet 在 `pet-window.css` / `gui.css` 后加载 tokens 与回退，并设置 `data-transparent-window`，使页面豁免 Windows/Linux 不透明工作区背板，同时不影响 tooltip/overlay 规则；只有这些浮层表面转为不透明。这些路径关闭背景采样，使用不透明 `--color-surface-raised` 底，同时保留共享边框、sheen 和阴影；scrim 使用不透明 `--color-bg`。已由 `::before` 承载 sheen 的卡片只用不透明背景，sheen 只画一层。桌面浮层正常路径仍使用 `--gui-glass-blur` / `--gui-glass-saturate`。任何规则都不得给常驻 transcript 或 composer 新增 blur。
- **动效**：此浮层族的入场和出场都同时受 `.gui-motion-off` 与 `prefers-reduced-motion` 禁用；关闭定时器仍可负责卸载，但不得留下 1ms 动画或中间视觉帧。tooltip 显隐 transition 和 SketchPad 关闭 transition 同样包含在内，不只检查 CSS keyframes。
- **共享栈**：`useModalFocus` 记录 opener 并压入每个活跃 dialog；`isTopModal` 门控 Tab 与 Escape。仅栈顶锁焦或响应 Escape，底层保持打开。关闭栈顶后归还可连接的 opener；关闭底层或组件卸载不得从剩余栈顶抢焦点。消费者包括 `DialogFrame`、Promise prompt/confirm、client-core `ConfirmDialog`、`AgentDrawer`、`SessionsSheet`、`TaskModal`、能力抽屉、Board 放大卡、SketchPad、Onboarding/Announcement 与 ImageLightbox。RewardOverlay 自己注册共享栈并提供 dialog ARIA；AnnouncementOverlay 仅在非 reward 分支激活卡片 hook，因此 reward 切换到 Markdown 后仍会入栈。SessionsSheet 将 backdrop portal 到 `document.body`，带滤镜的 header 不得成为其 fixed 定位包含块。`CommandPalette` 保留自己的输入框焦点、方向键导航和 Escape 处理，不因名称含 palette 就隐式加入共享栈。
- **确认键**：普通确认允许 Enter。Promise confirm 与 client-core `ConfirmDialog` 在 `destructive: true` 时都抑制 Enter；Promise 版本初始聚焦 Cancel，显式激活确认按钮仍可执行。只有确认框位于共享栈顶时 Escape 才取消。Promise prompt/confirm 在 180ms 出场后 settle；请求被替换或宿主卸载时也会 settle，不留下悬挂 Promise。
- **临时表面**：桌面 tooltip 初始化保留既有 `aria-describedby` token，以触发元素的矩形做 flip/shift 定位，不再使用指针坐标。悬停与焦点共用 150ms 打开延迟；触屏静止长按 500ms 打开，移动取消，释放关闭。可见提示在滚动/缩放时跟随锚点；指针移到提示内容上时保持打开，离开锚点与内容后才关闭。Escape 取消等待中或可见的提示并认领按键，不移动焦点。提示本身不可聚焦。toast 在悬停或焦点内暂停，恢复时续算剩余时长；错误持续显示并 assertive 播报，其他级别使用 polite status 播报。
- **面板空态与标签动效**：右侧零标签时，`.gui-panel-empty` 通过现有 flex 高度链让限宽自适应卡片 grid 垂直居中。`useTabMotion` 为 surface 与托管浏览器标签统一展示层 entering/closing：恢复不重播，打开 130ms、关闭 140ms；关闭中重开会取消退场，卸载会清理全部定时器。closing 项 inert、对辅助技术隐藏，并退出 roving tabindex 与 dnd items。业务标签仍立即关闭；浏览器 ref detach、guest-gone 和 main dispose 顺序绝不等动画。motion-off 与 reduced-motion 同时取消两类动画。
- **面板实例注入**：`SlotComponentMount` 向扩展组件传入 `panelTab` 与共享 `fmtTokens`。`ContextPanel` 按当前列的 `bodyView` 解析扩展内容，不使用全局激活 view，分栏不会挂载彼此内容。压缩标签描述只保存 `surface/target/dedupeKey`；`session.compaction` 返回当前会话与 id 对应的条目，`tokensAfter`、`method`、`warning` 对旧记录均为可选。bundled `compaction-summary` 插件通过 `panel.tab.compaction` 注册，不新增第二套标签存储，也不让 Cordis 进入 `wire` 或 `agent`。

## 7. macOS 应用图标处理(2026-08-06 查证 + 修复)

三条独立路径,规则完全不同:

1. **打包版 Dock / Finder 图标** = bundle 内 `Contents/Resources/icon.icns`(electron-builder 默认 `buildResources/icon.icns` = `build/icon.icns`)。LaunchServices 解析 bundle 时**自动应用系统 squircle 遮罩** → icns 必须全出血 1024 方形、**绝不能自画圆角**(否则双重圆角)。生成链:SVG → 1024 PNG → `iconutil -c icns`(10 档 16-1024 @1x/@2x)。release 打包后手动同步 bundle icns(md5 一致)。
2. **dev 模式 Dock 图标** = `app.dock.setIcon(image)`:官方语义只是"贴图到 NSDockTile",**不经过 LaunchServices,系统遮罩不生效** → 传全出血方形 PNG 就是方角(用户看到"图标是方的"的根因)。dev 必须用**预圆角 PNG**(`build/icon-dock.png`)。**填充率以 kimi 实测为准 = 80.5%**(2026-08-06 `/Applications/Kimi.app/Contents/Resources/icon.icns` 解出 1024,alpha bbox x100-923):深色卡 824/1024 居中 + 四角 superellipse n=5 切圆 + 四周对称透明边距。**全出血 100% 会让 Dock 里图标比 kimi 大 ~24%**(用户"始终大一点"根因;92% 内缩版仍 >80.5%);"禁止内缩"的上一版结论错误——kimi 官方桌面资产就是卡中卡,与邻位 app 视觉统一优先。Python/numpy 生成。打包版 icns 同样带 80.5% 边距(卡中卡是设计,不是遮罩错误)。
3. **窗口 icon**(`BrowserWindow icon`)= Linux/Windows 窗口 chrome;macOS 上 Cmd+Tab/窗口预览由系统按 bundle/Dock 图标渲染(全出血 + 系统遮罩),窗口预览显示"大方块"是**窗口内容预览**而非图标,系统行为。

**启动页与启动调度**：`SplashOrb` 与桌面桌宠共用 `gui-pet-*` 主题色板。`StartupSplash` 用 CSS 不确定轨道提供持续反馈，同时保留辅助技术可读的隐藏原生 `<progress>`；减少动态效果时放慢轨道。慢启动不会出现 stall 诊断或重试按钮，既有 `!rpc` 分支仍是唯一恢复页。renderer 不等待 `system.prewarmStatus`；`boot.done` 后以非阻塞方式调用 `system.prewarmStart`，若会话操作先需要 SDK，daemon 也会按需加载同一模块。欢迎页的模型、语言和思考默认值也在后台到达，慢 `settings.get` 不再阻塞首屏。主动重启 daemon 时，被替换客户端记入 `ExpectedDisconnects`，其关闭不会再触发第二次 boot。能力探测没有副作用，只有明确的 unknown-method 错误才算能力缺失。换图标仍需同步 `build/icon.icns`（打包）与 `build/icon-dock.png`（dev Dock）。

## 8. 验证工作流(改 UI 的必做项)

- 启动隔离实例:`electron . --remote-debugging-port=9223 --user-data-dir=/tmp/<name>`(同 daemon 只读连接,不打扰用户实例),CDP 驱动(`browser` 工具 `cdp_url` 连接)。
- 布局/动画断言:采样 getBoundingClientRect/background-position/getAnimations 帧轨迹;动画平滑度受窗口遮挡影响(后台窗口 rAF 节流),对比要同条件。
- 视觉确认:`tab.screenshot({selector})` + 视觉模型检查;重建用 `bun run build`(`desktop:run` 不重建,吃旧 dist)。
- 宠物验证:设置页 CDP attach 断言 10 卡 + 选中态 + 图标 14px;帧循环用 100ms 采样 `backgroundPosition` 枚举所见列(必须 ⊆ 有效列);真实光标用 Swift `CGEvent(mouseMoved/leftMouseDown/leftMouseUp).post(.cghidEventTap)`(AppleScript `set mouse position` 在 macOS 26 报 -2740);`screencapture -l <windowID>` 偶发全空帧是捕获伪影,验证闪烁用 `-R` 区域截图。
- **气泡/面板逐帧验证**(2026-08-11 套路,2026-09-16 按单窗口更新):主窗口 eval `window.electronAPI.setPetVisible(true)` → `toggleBubblePanel()` 切换窗内面板(pet target 就是 bubble target——同一个 renderer)→ rAF 推 `{iw, panel.getBoundingClientRect()}` 采样 → 1.5s 后读。断言:面板 mount 帧 `opacity:0`、窗口 resize(事件——窗口经 `pet-set-content-size` 向上生长)后才出现动画、面板 rect 全程在窗口内(`l ≥ -4 && r ≤ iw+4`,排除 scale 动画的微小越界)。`pet-set-panel` 已不存在(面板状态在 renderer 本地)。
- 注意:CDP 附加实例偶发 React onClick 委托失效(按钮无响应、键盘/直接 fiber 调用正常)——判定为环境产物,换键盘路径验证,勿当应用 bug。

### Esc 归属与中断回合（2026-09-12）

- **窗口级只有一个绑定，靠归属门控**：无修饰键的 Esc 中断正在跑的回合（TUI parity）。`app.tsx` 把它交给 `shouldEscapeStopTurn`（`lib/escape-stop.ts`），仅在**无人认领**（`defaultPrevented` 为假）、**无归属面**（`escapeOwner(target)` 为 null）、**非连发**、**确有回合在跑**（`storeRef.current.getSnapshot().working`）时才中断。空闲时 abort 并非无害：带用户中断标签的 `AgentSession.abort` 会锁上顾问自动续跑抑制，并把会话标记为 user-interrupted。
- **任何自行处理 Esc 的面都必须认领该键**（`e.preventDefault()`）——只关自己的 UI 而不认领就会把按键漏给中断绑定，这正是「菜单关闭却中断了回合」的成因。结构归属由 `escapeOwner` 兜底识别：`[role="dialog"|"listbox"|"menu"|"tooltip"]`、`[aria-modal="true"]`、`[data-escape-owner]`（→ `"overlay"`），以及 `[data-chat-input="true"]` **之外**的 `input`/`textarea`/`select`/`contenteditable`（→ `"field"`）。composer 刻意不算归属面：那里的 Esc 保持中断语义。焦点在菜单触发器上（在 portal 之外），结构识别看不到已打开的弹层——这类只能靠认领。
- **`session.abort` 必须传 `USER_INTERRUPT_LABEL`**，不能用相近字面量：`AgentSession.abort` 以 `reason === USER_INTERRUPT_LABEL`（"Interrupted by user"）严格比较来决定是否设 `AIError.Flag.UserInterrupt` 并抑制顾问自动续跑。契约由 `coding-agent/test/daemon/session-abort-rpc.test.ts` 锁定（断言该 reason 满足 `isUserInterruptAbort`，而非仅「看起来像」）。
- **验证安全（共享 daemon）**：隔离 `--user-data-dir` 实例仍连**同一个** daemon，窗口里是同一批会话。它只要显示着你关心的会话，就绝不能向它发 Esc、点停止按钮或调 `session.abort`——按一次 Esc 已经中断了用户正在跑的回合。探针请指向临时会话，或指向它自己的 daemon（`PI_CONFIG_DIR=<临时根> musepi serve --port <n>` + 预置 `localStorage["musepi-gui-url"]`）。离线回合夹具：`scripts/fake-openai-server.mjs`（流式桩）+ 临时根 `agent/models.yml` 里的 `fake` provider，不消耗任何真实配额。驱动脚本：`scripts/verify-escape-guard.mjs`。
- **已知隐患**：(1) **启动路径不再误杀别人的 daemon（2026-10-18 修复）。** `daemon-start` 过去先 `await kill(port)` 且不看归属，`daemon-restart` 至今仍按监听 pid 硬杀——而 `daemon-restart` 正是启动期版本门控触发的（`shouldRestartDaemon` → `api.restartDaemon`），所以开发实例包版本与「安装版或终端启动的 daemon」不一致时，一连上就会杀掉那个 daemon（本轮 Esc 验证期间 `:8300` 就是这么没的）。`daemon-start` 现在只回收自己登记过的孤儿，未登记的监听者不再被杀：外来 daemon 占着端口时以 EADDRINUSE 暴露，而不是被替换掉。`daemon-restart` 保留硬杀是刻意的——它只由用户显式操作、启动版本/能力门控或启动接管门（§8b）触发，这些路径在请求重启前都先验证 daemon 是我们自己的。(2) 被 SIGTERM 的 daemon 若其子进程继承了监听 socket，端口会永远接受 TCP 而背后没有进程——`connect()` 永不 settle，壳停在启动闪屏且必须手动终止（恢复：重启机器，或找出持有句柄的孤儿进程）。启动还会先试默认 `:8300` 再探测，且该次尝试不设超时。(3) **Windows 上 `SIGTERM` 就是 `TerminateProcess`，不可捕获**，所以 daemon 侧 `process.on("SIGTERM", shutdown)`（`commands/serve.ts`）在那里永远不执行，`kill()` 里那 3 秒宽限是空等。真正的优雅关闭需要 IPC spawn 模型（§8b，未实现），或让 daemon 轮询关闭标记文件。

### 8b. daemon 归属与孤儿回收（2026-10-18）

**daemon 是刻意 `detached` + `unref` 的**：这样 GUI 崩溃后它还活着，正在跑的回合能跑完（崩溃永远走不到退出路径）。代价是 GUI 被硬杀会留下没人认领的 daemon，而过去的唯一回收手段是 `daemon-start` 的盲杀 `kill(port)`。注册表把「端口被占 → 杀掉」换成证据，对齐 openchamber 的 `managed-process-registry`。

- **存储**：`<MUSEPI_DAEMON_DIR>/managed/<pid>.json`，我们 spawn 的 daemon 一个进程一个文件。之所以一 pid 一文件而非共享 JSON：多个壳/工作区并发运行，共享文件的读改写在并发下会互相覆盖。在监听成功后才写（从未就绪的进程不值得回收），写临时文件再 rename，崩溃不会留下截断的 JSON。
- **启动协调**：`start()` 先接管已在监听的 daemon，不再重复 spawn；同一 daemon 目录与端口的并发调用共享一次启动。首次编译允许 60 秒，不再在 10 秒时误报失败，超时仍保留子进程 stderr。能力探测统一使用 `daemonMethodProbeParams`，其中 `session.compaction` 使用无副作用的 `entryId`，避免把参数校验失败误判为 daemon 陈旧并触发重启循环。
- **回收条件——三条同时成立，缺一不可**：① pid 在我们的注册表里（我们 spawn 的）；② **身份双向绑定 pid↔端口**——`ws.port`（daemon 自己写的）仍指向记录的端口 **且** `listenerPid(port) === 记录的 pid`；③ 记录的 owner pid 已死。任何无法证实的一律不动：验证必须是正向的，绝不假设。
- **为什么要双向校验**：端口活着只能证明「有个 daemon 在跑」，不能证明「记录里这个 pid 就是它」。一个被回收的 pid 恰好活着、而端口被无关服务占着时，纯存活性校验会放行并把它 SIGTERM 掉——把这个校验削弱成只查存活性时，测试立刻把它自己的 bun 进程杀了（`test/daemon-registry.test.ts` 有 revert-verify）。
- **永远不会成为候选**：别的 GUI、开机自启、终端 `musepi serve` 起的 daemon 从不登记，回收器根本看不见。退出路径仍用 `ownsDaemon()`（`client.pid`），未改动。
- **启动接管门（2026-10-22 修复）：probe→connect 启动路径从不跑回收器。** 回收器只在 `daemon-start`/`daemon-restart` 里运行。GUI 启动时探测 `ws.port` 后直接连上一个「上一个 GUI 已死」（崩溃，或被不可捕获信号杀死——见隐患 (3) 与 §8c）的 daemon，两条 IPC 都不会走到：孤儿被无限期沿用，`client.pid` 永远指向死进程，之后每次正常退出 `ownsDaemon()` 都是 false，daemon 随一次次重开客户端不断累积——正是「退出客户端时 daemon 没有跟着退出」的症状。修复：本地连接成功后，渲染端（`app.tsx` tryUrl）询问新增的 `daemon-orphaned` IPC——证据标准与回收器相同（注册表验证身份 + owner 已死，外来 daemon 永不报告）——随后分两种处置：daemon 空闲时重启（新代码 + 本 GUI 取得所有权）；`session.list` 显示有 working 会话时改用新增的 `daemon-adopt` IPC **收养**（回合跑到一半重启会丢回合）：收养把 `client.pid` 与注册表 `ownerPid` 改写为本 GUI，daemon 继续服务，之后的退出会把它拆掉。重启走 `daemon-restart`，同一启动 URL 有既有的 `capabilityRestarted` 集合兜底防重启循环。
- **dev 重开现在走优雅退出（2026-10-22）——`--quit-request` 经单实例锁转发。** `relaunch-gui.mjs` / `dev-desktop.mjs` 过去用 `process.kill(pid, "SIGTERM")` 停掉旧 GUI；Windows 上那是 `TerminateProcess`（不可捕获），`before-quit` 从不触发，于是每次 dev 重开都恰好制造出上面那种孤儿。现在两个脚本先 spawn 壳自己的 main 入口并传 `--quit-request`：单实例锁把请求转给运行中的实例，其 `second-instance` 处理器看到标志后走正常退出路径（活跃会话防护跳过——程序化重开本身就是显式的重启意图，且旧的兜底行为是无对话框直接强杀；`killOwnedDaemon` 照常执行）。若没有实例在跑，helper 自己拿到锁、看到标志、在建窗之前退出。早于该处理器的实例或卡死的退出，会在约 9 秒宽限后落入旧的 SIGTERM/SIGKILL 清扫。
- **退出路径**：`before-quit` → `killOwnedDaemon()` → 自己 spawn 的 daemon SIGTERM → SIGKILL 升级。所有权现在同样覆盖收养的孤儿：本 GUI spawn 过**或收养过**的 daemon 随退出销毁；外来 daemon（终端 `musepi serve`、开机自启、其他存活 GUI 的）照旧存活。
- **关闭到托盘改为可选（2026-10-23），默认关闭即退出。** 窗口 `close` 门过去在非 darwin 上一律把窗口藏进托盘，于是应用（连同 daemon）在没有可见窗口的情况下继续跑、用户无从察觉——「我关了它但后端还在跑」。现在该门还要求 `readWindowBehavior().closeToTray === true`；默认（文件缺失）放行关闭，落到 `window-all-closed` → `before-quit`，上面那套 daemon 销毁必然执行。偏好存于 `<userData>/window-behavior.json`（由主进程持有——关闭门不能等 daemon 或渲染端），IPC 为 `window-behavior:get` / `window-behavior:set-close-to-tray`，`lib/electron.ts` 暴露为 `getCloseToTray`/`setCloseToTray`，开关在 设置 → 常规「关闭窗口时最小化到托盘」（仅 Windows/Linux；macOS 维持 Dock 持有窗口的惯例）。与 openchamber 对齐：其 `desktopMinimizeToTrayEnabled` 同为可选，默认关。
- **崩溃存活是刻意选择，位置介于两家参考实现之间。** dsh 根本没有 daemon（一个 owned child，`process.once('disconnect')` 自尽，硬杀壳就带走 host）；openchamber 的后端同样随 app 退出，它的回收器只服务于外部 spawn 的 OpenCode 子进程。我们让 daemon 在崩溃后存活（丢一个正在跑的回合太贵），代价就是这套回收器——这正是 openchamber 对它无法掌控的那个 child 所做的同一笔交易。
- **测试**：`test/daemon-registry.test.ts`（绝不误杀：未登记监听者、owner 存活、pid 被回收、死 pid 记账）+ `test/daemon-reaper-reclaim.test.ts`（确实回收：真实子进程监听、owner 已死、回收后端口关闭）+ `test/daemon-orphan-adopt.test.ts`（接管门：身份完整且 owner 已死时报告孤儿；owner 存活 / 外来监听 / 缺 ws.port 一律拒绝；收养把 `client.pid` 与注册表 `ownerPid` 移交给本进程、daemon 保持存活、非孤儿时无动作——测试使用私有 `MUSEPI_DAEMON_DIR`，绝不触碰真实注册表）。

### 8c. 合作式关闭 + 杀树（2026-10-18）

**信号解决不了的问题。** 关闭 daemon 过去只有 `process.kill(pid, "SIGTERM")`。POSIX 上它可捕获（`commands/serve.ts` 会干净收尾）；**Windows 上 Node 把 SIGTERM 映射成 `TerminateProcess`，不可捕获**，所以 daemon 自己的 handler 从未执行，每次关停都是硬杀，正在跑的回合直接丢失；那 3 秒「宽限期」在主要桌面平台上纯属空等。

- **`system.shutdown` RPC**（`daemon/server.ts`）—— 合作路径。几条契约都是承重的：
  - **传输走 daemon 自己的换行分隔 JSON-RPC socket**（`daemon.sock`，unix socket / Windows 命名管道），**不是 WebSocket 端口**。两条通道共用同一个 `handleRpcLine` 分发器，但 WebSocket *客户端* 在对方不是 WS 服务端、或已消失时，会抛出**无法捕获的进程级错误**——实测表现为 `Unhandled error. (ErrorEvent)`，会带走同进程的所有测试（`addEventListener("error")` 与 `onerror` 都拦不住）。普通 stream 错误则归我们处理。
  - **先应答再拆除**：回包在 socket 仍开着时写入（`setTimeout(0)` 把 `close()` 推到 flush 之后）。先拆再答会与关闭中的连接竞争，调用方超时后照样退回硬杀——正是这个 RPC 要避免的。
  - **应答语义是「已受理」而非「已完成」**：完成以监听消失为准；`busy` 报告有多少活跃会话正在干活，供壳层提示。
  - **没有 hook 就报错，不装成功**：未 `setShutdownHook` 的实例（嵌入式/测试）抛出错误，而不是谎报成功。
  - **进程退出是宿主的决定**：`DaemonOptions.onShutdownComplete` 默认 `process.exit(0)`（真实 `musepi serve` 需要——只释放 socket 继续跑会留下一个半死进程占着陈旧 pid），嵌入方可注入自己的实现，从而在不杀宿主的前提下观测完整拆除。
- **`kill()` 阶梯**（`electron/daemon.cjs`）：① 探测端口（启动路径无条件调用 `kill()`，不能在没人监听时还去建连接）→ ② 经 `daemon.sock` 发 `system.shutdown` + 宽限窗口 → ③ Windows 上**在根进程仍存活时**执行 `taskkill /F /T` → ④ SIGTERM + 3s → ⑤ SIGKILL/`taskkill /F` + 2s 确认。
- **为什么 Windows 上 `/T` 必须早于信号**：`/T` 沿**活着的**父子链遍历，而 daemon 刻意把子进程 spawn 成 `detached`（PTY 宿主、扩展 sidecar）。根进程一退出这些链就断了，事后再杀树什么也找不到，幸存者继续持有继承来的 socket——端口一直接受连接却没有服务在背后。把 `/T` 提到任何信号之前，才是升级能回收它们的原因。
- **后代快照是兜底而非主力**：读 Windows 进程表要启动一次 PowerShell（实测空闲 ~2.7s、负载下 ~5.5s），退出不该付这个代价。常规情况由 `taskkill /T` 处理，`descendantPids` 只补 `/T` 看不见的部分。
- **为什么不照抄 IPC spawn 模型**（dsh 的形态：`stdio: [.., 'ipc']` + `disconnect` 自尽）：dsh 能那样做是因为它**没有 attach 场景**——一个 server 进程对一 owner，压根没有 daemon 概念。我们有实例切换、开机自启、终端起的 daemon，所以 daemon 必须活过它的壳。RPC 给出了同样的有序拆除，且不改变归属模型。
- **测试**：`coding-agent/test/daemon/system-shutdown.test.ts`（应答顺序、监听释放、重复关闭幂等）+ `desktop-app/test/daemon-kill-tree.test.ts`（端口释放、后代回收、空闲快路径、旁观进程不受影响）。每个 daemon 测试文件的端口都向 **OS** 申请（`listen(0)`）：套件会并行跑多个 `bun test` 进程，任何固定或 pid 推导的端口段都会跨 runner 撞车。

## 9. 平台适配(2026-08-11)

- **原则**:跨平台特性按平台实现,不因"当前只有 macOS 实现"就把特性/设置项砍掉;只有**硬件层面 macOS 独有**的才隐藏。
- **haptic(macOS 唯一真正专属)**:Taptic Engine 是 macOS 硬件能力,Windows/Linux 无对应用层 API——渲染层 `lib/haptic.ts` 先查 `shellPlatform() === "darwin"`(preload 暴露 `platform`,web 构建为空串)再发 IPC;设置「通知与音效」的开关行**非 darwin 直接不渲染**;main.cjs handler 顶部 darwin 守卫。helper:`electron/haptic-helper.m`(clang 编译的常驻 stdin 进程,NSHapticFeedbackManager;JXA 桥对私有类 NSTrackpadHapticFeedbackPerformer 不暴露方法,osascript 方案 100% 失效),`build:haptic` 编译进 `bun run build`,asarUnpack 出包,dev 缺二进制时 main.cjs 懒编译。
- **keep-awake(跨平台)**:`caffeinate -i`(macOS 二进制)换成 Electron `powerSaveBlocker.start("prevent-app-suspension")`——macOS 映射 `kIOPMAssertionTypePreventUserIdleSystemSleep`(同 caffeinate -i),Windows `ES_SYSTEM_REQUIRED`,Linux ScreenSaver Inhibit;进程退出自动释放,无需杀子进程。
- **open-in-apps / open-with(跨平台)**:`appName` 统一为**绝对路径**(macOS `open -a` 同时接受显示名与路径),open-with 按平台启动——darwin `open -a <path> <dir>`/默认 `open <dir>`、win32 直接 spawn exe 或 `explorer.exe`、linux spawn 绝对路径或 `xdg-open`。发现列表:darwin 扫 /Applications 的 .app;win32 探测常见安装目录(Code/Cursor/Zed/JetBrains/notepad/wt);linux `which` 探测(nautilus/dolphin/终端/code/cursor/zed/kate/gedit)。空列表走渲染层既有 "no apps" 空态。
- **vibrancy/玻璃(跨平台)**:CSS 磨砂(backdrop-filter + 半透明 scrim + `--gui-glass-overlay`)全平台生效;原生 under-window 材质是 macOS 增强,别处 `setVibrancy` 静默 no-op——设置项保留。

## 10. 受管浏览器（Proma 吸收，2026-08-11）

右侧 Browser 工具是**受管浏览器**:页面是渲染进程持有的 DOM `<webview>`(每 tab 一个,跑在持久分区上),agent 的 browser 工具通过本地 CDP 桥**驱动同一批页面**——用户在面板里看到的就是 agent 操作的页面,登录状态天然共享(Proma browser-controller 模式)。当前架构、guest 生命周期协议与 `<webview>` 的实测约束见 §23。

### 架构
- `electron/managed-browser.cjs`:`ManagedBrowserController` —— tab 簿记 + guest 绑定(渲染端上报 `guest-ready`/`guest-gone`)、导航/加载状态、**活动账本**(脱敏:不含页面文本/Cookie/脚本全文)、分区守卫(`persist:musepi-managed-browser`:权限 deny-all、`omp-file://` 预览)、loopback CDP 桥,以及 `agentActivity` 事件(agent 驱动隐藏 tab 时自动唤起面板)。
- **CDP 桥**：loopback HTTP+WS，仿真 Chrome `/json/version` + browser 级 `Target.*`（relay bridge 子集：setDiscoverTargets / setAutoAttach / attachToTarget / createTarget / closeTarget / getTargets）。每个 tab 一个 `webContents.debugger` 会话，puppeteer 多连接复用。WS 帧编解码手写（无 `ws` 依赖）：mask/unmask、分片、ping/pong/close。
- 桥只暴露受管 tabs（`TAB<n>`/`PAGE<n>` 目标 id），**不暴露 GUI 自身窗口**；upgrade 拒绝带 Origin 的请求（网页无法驱动）。
- 前端 `ManagedBrowserPane.tsx`：占位 div + `useLayoutEffect` 投影（ResizeObserver + overlay 生命周期 MutationObserver，流式文本不触发 IPC）+ 工具栏/标签条（Agent 徽标）/活动行；`ContextPanel` 监听 `agentActivity` 自动切到浏览器工具。非 Electron 构建回退旧 iframe pane（`LegacyBrowserPane`）。
- 接线：`main.cjs` whenReady 后 `managedBrowser.start(mainWindow)`；`preload.cjs` 暴露 `managedBrowser*` API；`env.d.ts` 类型。

### 配置（settings-schema + 设置 → 工具 → Grep & Browser）
- `browser.gui`（默认 false）：agent 浏览器工具改用受管浏览器（`connected` kind → `browser.guiUrl`，默认 `http://127.0.0.1:9230`）；优先级 app.cdp_url/path > relay > cdpUrl > cmux > **gui** > headless。
- `browser.policy.restrictToPublic`（默认 false）：仅公网 http/https + DNS rebinding 复查（`tools/browser/policy.ts`，Proma browser-policy 移植；默认关——localhost 是核心功能）。启动浏览器加 `--deny-permission-prompts`。

### 踩坑（验证过的）
1. **about:blank 初始态 debugger 挂死**：对未完成初始加载的 webContents `debugger.attach` 后所有命令永久 pending，导航后才活。修复：`backgroundThrottling: false` + `loadURL("about:blank")` 强制 renderer 启动 + `whenDebuggerReady()`（等 did-finish-load）后再 attach。
2. **`Target.setAutoAttach`（waitForDebuggerOnStart:true）转发到真实 debugger 会 wedged**：Electron 单会话 debugger 无子 target；page 会话里拦截 setAutoAttach/setDiscoverTargets/runIfWaitingForDebugger 本地应答 `{}`。
3. **`Page.captureScreenshot` 在 webContents.debugger 上超时**：改拦截 `capturePage()`（Proma 同款）。
4. **tab 级 attachedToTarget(page) 事件必须带消息级 sessionId**（scope 到 tab 会话），否则 puppeteer 的 `#targetsIdsForInit` 永不完成、`connect()` 死等。

### 验证
- 单测：`browser-policy.test.ts`（URL/私网/DNS）、`browser-gui-kind.test.ts`（kind 优先级，19 断言全过）。
- E2E（`/tmp/managed-browser-e2e.cjs`）：隔离实例 `electron . --remote-debugging-port=9229 --user-data-dir=/tmp/...` → renderer IPC 开面板 → puppeteer `connect({browserURL: 9230})` 驱动（goto/evaluate/title）→ 投影布局 → `fromSurface:false` 截图采样确认页面真实渲染（投影区 #EEEEEE=example.com 底色，区域外 GUI 深色主题）。

### 边界项落地（2026-08-12，均 E2E 验证）
- **agentTabId 分离**：桥维护专用 agent tab（`ManagedBrowser.ensureAgentTab` 浏览器级命令，supervisor 在 gui kind 下经 `browser.target().createCDPSession()` 请求）；agent 永不碰用户标签页，首次 open 自动建 agent tab（`openedByAgent` 徽标 + 自动激活显示）。配套：桥公告 `type:"browser"` 的 browser target（`attached:true`，puppeteer 的 `CdpBrowser.target()` 依赖它）并支持对 `browser` targetId 的 attachToTarget（browser-kind 会话路由到 handleBrowserCommand）；新 tab 的 attach 事件等 `whenDebuggerReady` 后再发（已连接客户端也能收养新建 tab）。
- **omp-file:// 本地预览协议**：`registerSchemesAsPrivileged`（standard+secure+fetch+stream）+ `ses.protocol.handle` 按 pathname 服务本地文件。**规范形式必须带 host**：`omp-file://localhost<绝对路径>`——空 host 会被 Chromium 规范化成 `omp-file://tmp/x`（首段并入 host），handler 拿不到绝对路径。
- **风险告知门**：agent 车道（CDP Page.navigate / Target.createTarget）导航到 file://、带凭据或异常 scheme 时先问 renderer（`managed-browser:confirm` + `confirm-result`，30s 超时自动拒绝，一次一问）；http/https/omp-file 直接放行。拒绝时 CDP 回 `Navigation blocked by the user`，agent 立即看到失败。
- **停止按钮**：账本状态 dispatched→completed/failed/canceled；`managed-browser:stop` → `webContents.stop()` + **关闭 agent tab**（Electron debugger 接受 `Runtime.terminateExecution` 但不中止脚本，关 tab 是唯一可靠硬中止——pending CDP 调用随 target 关闭而拒绝，daemon 工具快速失败）。detach 会让 pending sendCommand resolve 而非 reject，成功标记需在 tab 存活时才写（否则覆盖 canceled）。`Runtime.callFunctionOn` 已映射到 evaluate 活动。
- 9229 remote-debugging 会把受管 view 也列成 target（agent 默认不会碰到；桥面只暴露受管 tabs）。

### 10.1 Agent 活动、接管与操作快照（2026-10-25）

- `electron/managed-browser-activity.cjs` 以 `${connectionId}:${cdpMessageId}` 为活动键。`dispatched → completed|failed|canceled` 只结束对应项，start/settle 都推送状态，`did-stop-loading` 不再结束无关输入。`state()` 优先投影当前 tab 的运行项，再选其他运行项，并给出 residency 使用的完整 `busyTabIds`；后台 tab 不会遮住或解冻其他 tab 的工作。
- `managed-browser:takeover` 只把目标 tab 的运行项标为 canceled，不停止或销毁 guest；`ManagedBrowserPane` 随后调用现有会话 `onStop`。旧的 `managed-browser:stop` 硬中止（含关闭 agent tab）保持独立。回调沿 `ChatView → ContextPanel → BrowserPane` 传递。
- worker 的 `BrowserOperationTracker` 经 `WorkerOutbound.activity` → `tab-supervisor` → `BrowserTool._onUpdate` 发出累计快照。`tab.*` helper 与增强句柄只上报动作/状态/目标，不含填写或输入文本。`RunResultOk.operations` 与最终 `BrowserToolDetails.operations` 保留同一列表，非取消失败也不丢。cmux 复用同一 tracker。原始 `page.*` 调用不猜测为高层动作。
- `ToolCard` 把结构化 browser partial result 适配给共享 renderer；`browser-activity.ts` 为单卡步骤和 `buildToolRuns` 聚合提供解析。重试恢复要求 agent/tab、规范化参数（排除 timeout）、action 和 target 全部匹配且后续成功。已恢复失败仍留在展开历史中，但不计入汇总错误数。
- `BrowserDeviceToolbar` 负责预设、宽高、显示比例和背景。`resolveViewportScale(fitScale, displayScale)` 只覆盖呈现；`syncDevice` 仍负责仿真布局，`managedBrowserSetZoom` 仍负责页面缩放。宽限制 320–7680、高限制 480–4320；`viewportOverflow` 让放大页面滚动。`BrowserControlOverlay` 经 portal 挂到根级、位于 z-900 页面宿主之上，分别呈现当前标签的接管状态与后台标签的越界提示，支持切回 agent 标签，在取消完成前阻止重复接管，并为最后一条活动保留 180ms 退出过渡。`HostRect.clip` 在 transform 前的宿主本地坐标中应用 `viewportClip`，放大页面始终裁在真实 scrollport 内，不覆盖相邻 UI；webview 生命周期约束不变。

### 10.2 最佳实践（使用 + 工程）

**使用（desktop）**
- 模式选择：看得到 agent 的页面 / 在面板里登录 → `browser.gui`；用自己的 Chrome 登录态/扩展/2FA → `browser.relay`；终端或无 GUI → headless（默认）；本地开发服务器 → 保持 `restrictToPublic` 关。
- 凭据：**面板登录 = agent 立即可用**（同分区持久）；从 Chrome 一次性迁移 → 设置 → 浏览器数据 → Import Chrome Data；relay = 你 Chrome 真实 profile。所有凭据仅本地（面板恒显"仅本地存储登录状态"）。
- 登录协作（配额/看板场景）：agent 开登录页 → 面板里手动登录 → agent `waitFor`（URL/元素）或等你说"已登录" → 继续抓数据 → `board` 工具写 `~/.musepi/boards/boards.json`，`data.task` 挂刷新。
- 坑位：`browser.gui` 开而 GUI 未运行 → connected 连不上会报错（非静默 fallback，属预期）；GUI 端口被占会自动试 9230–9239，daemon 侧 `browser.guiUrl` 需对齐非默认端口；改主进程代码要重启 Electron、改 daemon 源码要重启 daemon。

**工程**
- **CDP 桥铁律**：① attach 必须等 renderer 就绪（`whenDebuggerReady`/did-finish-load），否则 debugger 永久挂死；② `Target.setAutoAttach`/`setDiscoverTargets`/`Runtime.runIfWaitingForDebugger` 永远本地应答、不转发（单会话 debugger 无子 target）；③ `Page.captureScreenshot` 拦截走 `capturePage()`；④ tab 级 `attachedToTarget`(page) 事件必须带消息级 sessionId（否则 puppeteer `#targetsIdsForInit` 永不完成）。
- 仿真面以 relay bridge 为基准（browser 级 + tab 级 setAutoAttach 双通道、TAB/PAGE 双 target、createTarget 返回 PAGE id）；升级 puppeteer 版本后先跑 E2E。
- 状态单一权威在主进程：renderer 只投影/读；layout 用单调 revision 丢晚到；URL/账本脱敏只在 main。
- 新设置：settings-schema（ui 组 "Grep & Browser"）+ GUI 设置页 + 优先级链注释 + kind 解析测试（`browser-gui-kind.test.ts` 模式）。
- 验证：单测（policy/kind）→ 隔离实例 E2E（open → puppeteer connect → 驱动 → 投影 → `fromSurface:false` 像素采样：投影区=页面底色、区外=GUI 主题）。
- i18n：键先进对应域文件 `guest-client/src/i18n/zh-CN/<domain>.ts`（英文 pass-through，en 域须同步，详见 `docs/i18n.md`），`t()` 只在 render 时，状态文案复用已有键。

## 12. 用量视图(usage.reports / 托盘 / ContextRing,2026-08-16)

**daemon RPC** `usage.reports`(server.ts,`session.askAnswer` 之后):会话态(`params.sessionId` → live session 的 `fetchUsageReports`)+ 全局态(无 sessionId,空态 composer 用 `ensureRegistry()` 起 registry)。返回 `{ reports, unreportedAccounts, disabledCredentials, reloginDeadlines, activeAccount? }` —— 与 TUI `/usage` 同源(`usage-shared.ts` 共享聚合),`activeAccount` 仅会话态有(● 标记)。

**数据形状**:每**凭据**一个 `UsageReport`(`provider` + `limits[]` + `metadata`);同 provider 多凭据 → GUI 端必须合并,否则:
- 渲染 key 用 `provider` → React 重复 key 警告(托盘历史 bug);
- 每凭据一个折叠区块 → 视觉上堆叠重复块(/usage 面板历史 bug)。

**合并算法**(`packages/desktop-app/src/components/composer/usage-panel.tsx` `UsageProviderSection`,托盘 `tray-menu-main.tsx` `buildUsageRows` 同款):
- 按 `provider` 分组 → 一个折叠区;按 `label|windowId` 分窗口 → 每个窗口一行;
- **列序是 provider 级固定序**:跨窗口平均用量降序、同分按标签 —— **禁止每窗口独立 worst-first 排序**(凭证会"左右乱窜",用户感知为错位)。列上限 4(`.slice(0, 4)`);
- 最右侧 `合计` 列:该窗口各凭据分数的**均值**(TUI 聚合语义),带分隔线;provider 排序 least-pressure 升序(TUI parity);
- 合计列 pct 只显示数字(`55%`,不带 "used")——52px 列宽放不下 "55% used"(截断过)。

**托盘菜单**(`gui-tray-menu`):固定窗口高 `TRAY_MENU_HEIGHT = 440`(main.cjs)——**不要动态 resize**(`tray-menu:set-size` IPC 已删);内容内部滚动(`__scroll` flex:1 + overflow-y:auto);footer padding `10px 10px 14px`(按钮距窗底有呼吸感)。窗口自身 acrylic(DWM),页面内容 chrome 即可。

**用量缓存**(`packages/ai` `AuthStorage.fetchUsageReports`,GUI/TUI/托盘共用):SQLite `cache` 表磁盘持久化 + 5min TTL(`USAGE_REPORT_TTL_MS`,±25% 抖动防 per-IP 429 fan-out)+ 上游失败 last-good 兜底(24h)+ in-flight 合并(多界面并发请求只打一次上游)。daemon 重启后缓存仍在;冷缓存首次查看会阻塞上游一轮(合并保证只一轮)。

**验证套路**:组件级 headless(bun build 临时 entry + 桩 `electronAPI.trayMenu`/props)→ 断言 DOM 列序/合计/无 key 警告;真实托盘需重启 Electron(主进程改动不热重载)。

## 13. slash 补全排序(2026-08-16)

`packages/desktop-app/src/lib/slash-rank.ts` `rankSlashEntries(entries, query, guiNative)`(会话 Composer `use-completion.ts` + WelcomeComposer 共用):
- 排序 tier:name 全等 > 名前缀 > 名子串 > 描述子串;层内 **GUI 原生命令优先**(usage/context —— composer 拦截开面板的命令,同层压过 `clear`/`compaction` 等 daemon 命令);
- 空 query 保持目录序(裸 `/` 列表不重排);非匹配项沉底保序(skill: 查询的幸存者不被丢弃);
- 纯函数 + 单测 `lib/slash-rank.test.ts`(tier/GUI 决胜/稳定序/沉底)。

## 14. 轨迹 Overview 时间轴 + 选择检视(2026-08-21,DSH Trajectory 吸收)

设计规范见 `gui-design.md` §1(轨迹时间轴与检视)。此处记数据契约与坑。

### 数据契约

- **`TrajectoryView` 新 props**:`roundDurations?: RoundDurationMap`(即 `ReadonlyMap<number, number> | readonly (readonly [number, number])[]`;GUI store 暴露 Map 形态,持久化快照/测试以数组形态出现)。来源 = daemon `agent_end` 冻结的整轮用时,键 = 该轮**末条 assistant 消息 tsMs**(`session-store.ts` / `MaterializedView.#roundDurations` 同源)。
- **`trajectory-data.ts`**:事件新增 `tsMs`(数值时间戳);`buildTrajectoryTree(entries, roundDurations?)` 输出的 `TrajectoryTurnGroup` 新增 `startMs`(组内首事件)/`endMs`(组内末事件;**roundDurations 命中时闭合为 `startMs + roundDurationMs`**)/`roundDurationMs`。未命中的 turn **绝不虚构**回合时长(replay/历史会话无 agent_end 即无)。
- **`isTrajectoryEventInRange(ev, startMs, endMs)`**:闭区间判定;**无 `tsMs` 的事件永不命中**(区间模式从不误亮未知时刻)。纯函数,组件与测试共用。
- **`usage` / `durationMs` / `ttftMs`(2026-08-21 补)**:wire `AssistantMessage` 自带 `usage(WireUsage)`/`duration`/`ttft`(settled 回合才有)——MaterializedView **整存 wire message**,所以 `snap.entries[].message` 原样携带,轨迹事件直接提取,**零 daemon 改动**;与 transcript usage 行(`guest-client Transcript.tsx usageRow`,`display.showTokenUsage` 门控)同源。未 settled 的 assistant 事件不虚构统计。
- **`TimelineOverview`**:时间域 = 全部 turn 的 [最早 startMs, 最晚 endMs];无有效时刻(max ≤ min)直接返回 null 不渲染。
- **历史窗口身份与拓扑**:事件 id 来自源 entry/tool-call id,不来自加载窗口内的 journal 轮号。`TrajectoryTurnGroup.id` 是轮起始 entry id,`parentId` 记录最近的父轮,`trajectoryTurnKey` 是共享 UI 状态键;因此地图展开、轨迹折叠/选中、React key 和区间滚动目标在历史前插后仍指向同一轮。无 active-path 时的分支回退索引所有 entry 类型,包括 advisor `custom_message` 链节;嵌套分支边使用记录的父轮,即使父轮自身也在支线。

### 组件行为

- 拖拽区间:**pointer capture** + 位移 ≥3px 才提交;单击段 = 选中该整轮、单击空白 = 清除;`msAtClientX` 经 `getBoundingClientRect` 反算,零 re-render 依赖。
- Esc 键:**先清区间、再清选中**(`window` keydown,依赖 [range, selectedId]——与模态键盘契约同序)。
- 聚焦 = **置灰不裁剪**(`.traj-event--dim` 0.35 + saturate .6),DSH 同款"聚焦而非过滤"。
- 地图数据增长不会强制重新 fit:仅初次适配、显式重置和真正切换横/纵方向会触发 fit。Overview 轮段、地图轮卡、可跳转事件行和独立分支折叠按钮都把单击操作暴露给 Enter/Space,并带可见焦点样式。

### 坑

- **TS 属性收窄不进闭包**:`onPointerEnter={() => d(group.startMs)}` 内 `group.startMs` 被 TS 判回 `number | undefined`——处理器用前先拷局部常量(`const start = group.startMs`)。
- **图标**:oc-icons sprite **无 `focus-3`**——聚焦 chip 用 `target`;新增图标需进 `vendor/oc-icons/sprite.ts`(脚本生成,勿手改文件头)。
- **`fractionalSecondDigits` 不走 TS lib 保证**:精确时刻提示手动拼 `.mmm`(`getMilliseconds().padStart(3,"0")`)。
- **跳转按钮包裹整行 = 行宽塌缩 + 点击吞并**(2026-08-21 真实渲染回归,已在隔离实例 CDP 实测定位):
  1. **flex 塌缩**:把 `.traj-event`(flex,内容 pre-wrap)包进 `display:flex` 的 `.traj-event-jump` 按钮后,行被按 min-content 收缩到 **~83px 宽**(`traj-content` 塌到 11px)、`pre-wrap` 文本逐字换行叠成 **~1000px 高**;加 `flex:1 1 0%` 反而更糟(4px)。**改用 grid `1fr auto`**(`.traj-row { display:grid; grid-template-columns:1fr auto }` + `.traj-event{min-width:0}`)一次性撑满 227px,运行时验证通过。教训:窄面板里 flex 自动收缩 + pre-wrap 内容 = 灾难,1fr 网格列最稳。
  2. **点击语义错位**:按钮包裹行后,点行 = 触发按钮 onClick(跳转 transcript),`traj-row` 的"选中"永远点不出来 → 检视器不可达。修复:行是普通 div(点击选中),跳转改为**独立 hover 显现的小箭头按钮**(`.traj-row:hover .traj-event-jump{opacity:1}`,按钮 `stopPropagation`)。
  3. **提示被裁**:`.traj-ov-tip` 原来放 `overflow:hidden` 的 `.traj-ov-track` **内部**,顶部被裁(实测 tipY 紧贴 trackTop)。移到 wrap 层(track 的兄弟,同宽同坐标空间),`bottom: calc(100% + 6px)` 悬浮条上方。
  - **验证套路**:隔离实例(`electron . --remote-debugging-port=9224 --user-data-dir=/tmp/<name>`)连接→点会话→点轨迹 tab→CDP `Runtime.evaluate` 量 `.traj-event`/`.traj-content`/`.traj-ov-tip` 的 `getBoundingClientRect()`(行宽应 ≈227、内容 ≈155、tipY 在 track 上方);构建用**完整 `bun run build`**(`build:bundle` 只产哈希名 html,缺 `index.html`,reload 会 ERR_FILE_NOT_FOUND)。

### 验证

`packages/desktop-app/test/trajectory.test.ts` 10 用例(tsMs 提取 / turn 时序 / roundDurations Map+数组形态 / 未命中不闭合 / 范围判定 / usage·duration·ttft 提取);`tsgo -p tsconfig.json --noEmit` 全绿;`bun run build:bundle` 通过。CDP/截图验证按 §8 工作流。

## 15. 消息树数据 seam(/tree 语义,2026-08-21)

命名规范化见 `docs/gui-design.md` §0(会话列表 / 消息树 / 轨迹 术语表)。此处记数据契约:

- **现状分裂**:TUI 消息树靠会话级 `session-manager` 的 `leafId()` 在建 entry 时写死 `parentId`(`session-manager.ts:1091`);wire message 事件**全程不带 parentId**;`MaterializedView` 投影消息时硬编码 `parentId: null`(`materialized-view.ts`),仅历史/持久化快照(`fromSnapshot` 原样存储)与老版 transcript 读取路径(server.ts ~397)保留真实 parentId。
- **已落地(向前兼容)**:
  - `wire/src/index.ts`:User/Developer/Assistant/ToolResult 四角色 message 加可选 `parentId?: string | null`(live 事件暂缺)。
  - `MaterializedView.#upsertMessage`:`parentId: message.parentId ?? null`(带即保留,缺即 null)。
  - `packages/desktop-app/src/lib/message-tree.ts`:`buildMessageTree(entries)` / `flattenMessageTree`——从 entry 的 id/parentId 建分支树(孤儿作根、自环安全、兄弟保序);历史快照立即可用,测试 6 用例。
- **live 消息树的剩余 seam**:daemon 发射端在 message 事件上打标(`agentSession.sessionManager.leafEntry()?.parentId` 于转发点 server.ts `agentSession.subscribe` 处)——落实后 GUI 轨迹面板即可加「时间线/分支树」切换(复用 `buildMessageTree`)。TUI `/trace` 方案见 `docs/archive/tui-trace-plan.md`。
- **2026-09-24 更新**:`buildMessageTree` 唯一的画布消费方(`SessionTreeCanvas`)已下线——会话地图收敛为单一轮级视图(§24)。数据 seam 保留:TrajectoryView 的分支树模式仍从 `buildMessageTree` 渲染,live `parentId` 打标依旧是 live 分支视图的前置条件。

## 16. 转录自定义消息渲染 + 流式 markdown 契约(2026-08-22)

`guest-client` `components/transcript/Transcript.tsx` 的 `custom_message` 分支按 `entry.customType` 分派,已处理:

| customType | 渲染 | 数据来源 |
|---|---|---|
| `collab-prompt` | 用户行 + 来源 badge | `details.from` |
| `ttsr` | `TtsrBlock`(警告折叠) | `details.rules[]` |
| `irc:*` | `tr-irc` 行 | `details.message/body` |
| `async-result` | `.tr-async-result` 卡片(每 job 一行「✓ 后台任务已完成 [type] id (耗时)」) | `details.jobs[]` |
| `advisor` | `AdvisorBlock`(severity 色 rail + badge、blocker 计数、>3 条折叠) | `details.notes[]` |
| 其他 | 默认 `tr-custom`(chip `customType` + `content` markdown) | — |

**铁律**:模型-facing 模板(`<system-notice>`、`<advisory severity=…>`)只存在于 `content`(给 LLM 的 payload),GUI 渲染器**只读 `details.*` 干净文本,绝不把模板正文渲染给用户**——`async-result`/`advisor` 都是 2026-08-22 补上 GUI 渲染(此前落入默认 `tr-custom`,把 `<system-notice>`/`<advisory>` XML 原样显示,与 TUI 的 `buildAsyncResultBlock`/`createAdvisorMessageCard` 不对齐)。

**流式 markdown 时机**(答「是不是结束后才渲染」——**不是**):
- `Markdown.tsx` `renderStreamingMarkdown`:流式时 head **随流增长**——每帧把「刚刚成立」的平衡 `\n\n` 块提升为 markdown(段落、列表、以及围栏一闭合即成的代码块),内容是边到边成形;**最后一个**平衡边界之后仍是 RAW TEXT(逐字单次入场动画——切点只能停在平衡边界上正因如此,未闭合围栏保持字面量同理)。`streaming:false` 时只把尾块重解析为真 markdown(复用 head 块,避免整条 `md.parse` 的「卡一下才都渲染」)。切点前移由尾段 DOM pass 处理(清空并重挂,已显示字符不会重播)。
- 思考块按句过 `Markdown`(`tr-think-sentence--live` 入场)。
- DSH(`deepseek-harness`)同款增量:冻结除末尾两块外的全部为缓存 React 元素,尾块每 chunk 经 `IncrementalMarkdownParser` 重解析;已知偏差——跨冻结边界的 reference-style link/footnote 定义流式期字面显示,settle 全量解析自愈。

## 17. OTA 更新渠道 + 三合一按钮 run 级 working 语义（2026-08-22）

### OTA 更新渠道（GitHub release 资产重定向，bitfun parity）

三处同源，统一走 `/releases/latest/download/update-manifest.json`（302 到最新 release 资产，无 api.github.com 限流）：

| 位置 | 用途 | 默认值 |
|---|---|---|
| `packages/desktop-app/electron/updater.cjs` | 主进程 OTA 检查（`checkForUpdates`）+ 更新说明拉取（`fetchManifestNotes`） | `RELEASE_MANIFEST_URL` 常量 |
| `packages/desktop-app/package.json` `update.manifestUrl` | 打包时覆盖 notes 拉取默认 | 同 URL |
| `daemon/server.ts` `updates.check` | daemon 侧版本/notes 探测（遗留——UpdateToast 已改走 `updater-notes`；RPC 保留对等） | 同 URL（硬编码） |

- **解析顺序**（updater.cjs `manifestUrl()`，仅 notes 拉取——electron-updater 的 feed 来自 build publish config）：`OMP_UPDATE_MANIFEST_URL` env → `package.json update.manifestUrl` → `RELEASE_MANIFEST_URL` 默认。
- **404 优雅降级**：repo 公开前 `releases/latest` 404 → `{enabled:false, reason:"no-update-source"}`，设置页显示「尚未发布公开更新源（发布后可用）」；`updates.check` 返回 `{latest:null}`，公告面板不弹。
- **发版契约**：`update-manifest.json`（`{version,url,notes}`）作为名为 `update-manifest.json` 的资产随每个 GitHub release 上传——`/releases/latest/download/<asset>` 自动重定向到最新拷贝，无需改分支。**url 填 dmg 直链、notes 填新功能说明、version 与 package.json 一致**。
- **初始化不能写死 raw.githubusercontent**：旧渠道 `raw.githubusercontent.com/MuseLinn/MusePi/main/packages/desktop-app/update-manifest.json` 在 repo 私有时必 404（等于死链），已全部切到 release 资产。

### 三合一发送/停止按钮：run 级 working（turn 级边界陷阱）

`SendOrStopButton`（`packages/desktop-app/src/components/composer/action-buttons.tsx`）idle 显示发送箭头，working 态变胶囊 + 点阵 bloom + 两标签（「工作中」/「停止」，hover 互换）。**关键陷阱**：

- **`turn_end` 是每工具批次发一次，不是 run 结束**（`agent-loop.ts` `pushTurnEnd` 每个 tool batch 一次；`types.ts`: "a turn is one assistant response + any tool calls/results"）。若用 `turn_end` 清 working，**轮间 provider 准备期按钮会闪回发送箭头**（用户报告 2026-08-22）。
- **正确定界**（`packages/desktop-app/src/lib/session-store.ts`）：`agent_start`/`turn_start`/user `message_start` → `#working = true`；`turn_end` **只清 `#streaming`**；`agent_end` 才清 `#working` + `#streaming`；daemon `{kind:"state", payload:{isStreaming}}` 帧做权威纠正（中止无 turn_end 时兜底）。
- **`#buildSnapshot` 的 OR 陷阱**：旧代码 `working: this.#working || snap.state.isStreaming`——view 的 turn 级 `isStreaming` 在无 turn_end 的中止路径会卡 `true`，把已复位的标志 OR 回去，stop 胶囊永不熄灭。**已改为 store 单一事实源** `working: this.#working`，构造时用 resume snapshot `state.isStreaming` 播种（中途加入正在工作的会话也正确显示）。
- **测试**：`packages/desktop-app/test/session-store.test.ts` 覆盖「run 级边界不闪回 + agent_end 才熄灭 + state 帧兜底」。改按钮/指示器语义先看该文件的 switch 与 `#buildSnapshot`。

### 更新提示 toast（bitfun DailyAppUpdateGate parity）

- 主进程 `main.cjs` 启动后 12s 静默检查，`checkForUpdates()` 得 `newer` 则 `webContents.send("update-available", result)`。
- 渲染端 `UpdateToast.tsx`（`packages/desktop-app/src/components/UpdateToast.tsx`）订阅 `onUpdateAvailable`（preload 暴露），右下角卡片：版本（v当前 → v最新）+ notes + 「下载更新」/「跳过此版本」。**notes 走 `updater-notes` IPC**（主进程拉 manifest，成功后缓存）——不再依赖 daemon RPC——daemon 未连上或 `startup.checkUpdate` 关闭时预览照常可用；notes 超 200 字符出「展开」toggle。
- **下载状态**（updater-state 推送）：`preparing` 由 `updater-download` 同步置位（不确定态进度条——覆盖点击 → 首字节之间 electron-updater 尚未发 `download-progress` 的空窗；重入保护让双击安全），`downloading` 显示百分比 + 已传/总量 MB + `bytesPerSecond`，`downloaded` 显示完成行 + 立即重启。被关掉的 toast 会在 `preparing`/`downloaded` 推送时**复活**——`autoInstallOnAppQuit=false` 下立即重启是唯一安装路径，必须始终可达（设置页的应用内「下载更新」按钮同样依赖该复活）。关闭播 180ms 退出动画（close-timer + `--closing` 类，prompt-dialog parity）；下载失败提供重试 + 「前往下载」。
- **「跳过此版本」按版本记忆**（`localStorage["musepi-update-skip-version"]`，bitfun 同款）——同一版本不再打扰；**更新说明与「新功能」弹窗是两条独立链路**：toast 读 `update-manifest.json` 的 `notes`（纯字符串——`{zh,en}` 形状留给未来拆分 manifest；daemon `updates.check` 两种都透传），弹窗读 `CHANGELOG.musepi.md`。两条链路靠构造保持同步：`gui-release.yml` 用 `sectionMatch`（首个 `## [x.y.z]` 块）从最新一节切出 manifest 的 `notes`，所以发版只写那一节即可。
- 桥接统一走 `packages/desktop-app/src/lib/electron.ts` 的 `ElectronAPI.checkUpdates/onUpdateAvailable/getUpdateNotes` + `UpdateCheckResult` 类型（不在组件里内联 window 断言）。

### 发布产物与 CLI 关系（2026-08-23 实测确认）

**dmg 自包含 daemon，不依赖 `bun run setup` 污染系统**：`daemonCommand()`（`electron/daemon.cjs`）解析顺序——① PATH 上的 `musepi`（仅当用户单独装过）→ ② **打包版 `Resources/app.asar.unpacked/vendor/daemon/musepi`（120M 完整 CLI 二进制，workflow 的 "Build daemon binary + Stage 进 vendor + asarUnpack vendor/daemon/**" 保证必达）** → ③ dev 模式 `bun src/cli.ts serve`。

**发布链路要点**：
- `gui-release.yml` 只发布 **darwin-arm64**（砍掉 x64——x64 runner 打 arm64 dmg 缺 `sherpa-onnx-darwin-arm64` 架构变体，electron-builder 结构性失败）。
- **签名**：mac `identity "-"`（ad-hoc）+ hardenedRuntime + `build/entitlements.mac.plist`（照 openchamber：allow-jit / disable-library-validation 等，解决 Electron JIT + dlopen 原生模块）。ad-hoc 仅消除「完全无签名显已损坏」，**双击打开仍被 Gatekeeper 拦**——要「双击直开」需 Developer ID 签名 + `notarize: true`（需 APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID secrets；workflow `MACOS_SIGNING` 条件已预留）。
- **不像 VSCode**：app 自带 daemon 供 GUI 用，但**不注册 PATH**（`extraResources: []`、无 CLI symlink）。终端敲 `musepi` 默认没有；要终端 CLI 需 `bun run setup`/`bun link` 或 `bun install -g @musepi/pi-coding-agent`，…或给 electron-builder 加 `afterInstall` 符号链接钩子（需管理员权限，且与单独装的 CLI 可能冲突——用户决策项）。

## 18. 近期落地特性（2026-08-24 → 2026-08-26）

早期章节之后落地的契约、RPC 形状与坑；设计意图在 `docs/gui-design.md` §5g，分特性规格见所列文档。

### OTA 经 electron-updater 更新（v0.4.4，2026-08-24）
`docs/archive/ota-update-design.md`。把 §17 的「前往下载」改为 **下载 → 校验 → 安装 → 重启**（electron-updater v6.4.1 + GitHub provider）：
- **配置**：`packages/desktop-app/package.json` build `publish` = `{provider:"github", owner:"MuseLinn", repo:"MusePi", channel:"latest"}`（生成 `latest*.yml`）。**不要手动设 `allowPrerelease`**——6.4.1 按当前版本号自动推导（prerelease 版本 → beta 通道；稳定版 → `/releases/latest`，忽略 prerelease）。
- **IPC**：`updater-check`（富结果 `{enabled,newer,latest,current,notes}`——updateInfo 与 `app.getVersion()` 比对，notes 与 feed 检查并行拉取）/`updater-download`/`updater-install`/`updater-notes`（renderer→main）+ `updater-state`（`idle/available/checking/preparing/downloading(percent+bytes)/verifying/downloaded/error`；2026-09-26 起 `error` 为结构化 `{kind,message,technicalDetails?}`，见下）+ `update-available` + `updater-flash-frame`（2026-09-26，任务栏闪烁）。`autoDownload=false`、`autoInstallOnAppQuit=false`。
- **daemon sidecar**：`updater-install` 先 `kill(daemonPort)` 再 `setImmediate(() => autoUpdater.quitAndInstall())`（setImmediate 先 flush IPC reply）；vendored daemon 随新版 app 一起生效。
- **macOS 需 `.zip`**：MacUpdater `findFile(files,"zip",…)` 无 zip 会抛 `ERR_UPDATER_ZIP_FILE_NOT_FOUND`——`mac.target` 必须含 `"zip"` 且 CI 带上传 `*.zip`（顺带赢 blockmap 差量）。Beta：`-beta` tag → `-c.publish.channel=beta` + prerelease；CI yml 通配从 `latest*.yml` 放宽为 `*.yml`（此前会丢 beta feed 的缺口）。
- **降级**：未签名 Windows NSIS → SmartScreen 确认；ad-hoc macOS dmg → 校验失败回退「前往下载」；Linux AppImage 免签自替换。

### 更新 UX 分层（安装器/更新弹窗设计稿 B 面，2026-09-26）
`docs/archive/0.5.0-installer-update-dialogs-design.md` §3（决策点①-⑧全部按默认建议执行）。在既有 toast **之上**补显式状态机相位与 L-dialog 层（分层共存，不是替换）：

- **状态机**（`electron/updater.cjs`）：`available` 成为显式状态——`update-available` 置 `state.status="available"`，但不会降级进行中的 `preparing/downloading/verifying/downloaded`（手动重查绝不能冲掉「立即重启」入口）；`verifying` 覆盖 download-progress ≥100% → `update-downloaded`（不再有"假 100% 等待"）。`state.error` 结构化为 `{kind, message, technicalDetails?}`——kind 是稳定的 `{check|download|install} × {network|other}` 枚举；纯逻辑分类器 + 退避数学在 `electron/update-logic.cjs`（零 electron import，契约测试 `test/update-logic.test.ts`）。渲染层按 kind 映射语义文案（`update` i18n 域），message + 堆栈折进「技术详情」`<details>`；`checkForUpdates()` 自身返回值的 `error` 仍是纯字符串（设置页契约不变）。
- **轮询退避**（`main.cjs`）：固定 1h `setInterval` 改为失败 ×2 退避（上限 6h）+ ±20% jitter（dsh update-schedule parity；常量与 `nextPollDelayMs` 在 update-logic.cjs）。成功回 1h，首查仍为启动+12s，`OMP_NO_AUTO_UPDATE=1` 仍可全部关掉；退避决策写入 updater.log（"poll: backoff after N failure(s)"）。
- **IPC 只增不改**（preload 既有 API 面不动）：`updater-flash-frame` → `flashUpdateAttention()`——`downloaded` 到达且窗口未聚焦时任务栏闪烁一次（由 UpdateDialog 触发；**不加系统通知**——决策点④）。
- **L-dialog 层**（`UpdateDialog.tsx`，DialogFrame + `gui-dialog--confirm` 紧凑 380px，app.tsx 常驻挂载、`open` 驱动）：① **待重启确认卡**——`downloaded` 持续 ≥10 分钟且 toast 已关/不可见（30s 间隔轮询判一次；每个 downloaded 周期最多一次；「暂不」仅关闭）；② **失败决策卡**——download 或 install 连续失败 ≥2 次：重试（主按钮，Enter）/ 前往下载页（`openExternal` releases）/ 暂不（Escape）。计数在新下载尝试开始、`downloaded` 重新到达或卡片关闭时清零。跨表面信号（toast 可见性、安装宽限、install 失败计数）集中在 `src/lib/update-ux.ts`——纯模块态 + listener，两个组件订阅。
- **安装宽限文案**：`quitAndInstall` 的 15s 宽限期内（update-ux.ts 的 `requestUpdateInstall()` 翻转共享 `installing` 标志），toast 与弹窗都切为不可点的「正在安装更新，安装完成后将自动重启」；安装失败回退并喂给失败决策卡。

### 扩展 P3/P4 接缝（plugin-design.md P 层）
自 2026-08-25 核对（P3 ❌ / P4 service ❌）后已落地。在 `extensibility/extensions/`：
- **`registerNotificationChannel(channel,{label})` → send(message)**：runner 的 `onNotification` sink 把每次 send 转发 → daemon → GUI（与内置 notify 事件并列渲染）；channel+send 在 unload 时整体丢弃，重载即重注册。`ExtensionNotificationMessage { text, title?, kind? }`。
- **`registerThemeToken(key,value)`**：runner 聚合 token（`applyThemeTokens`）；主题**只加新键**（绝不覆盖内置 color/background/symbol）；unload 时丢弃该 token，主题重渲染时移除。
- **`registerService(name,{start?,stop?})`**：长驻后台服务；`start` 在装载时跑（`startServices`），`stop` 在 unload / 会话关闭 / rollback 时跑——有守卫（必被调用、抛出被隔离），且不得残留进程。

### 看板 widget 数据代理缺口 + 调度引擎（board-dashboard.md）
`widget.data` 代理 RPC **未实现**（行情卡为静态默认值；数据源 agent 代理是剩余 M4 工作）；**调度执行引擎已在 GUI 侧实现**（`guest-client` task-run 执行引擎 + BoardPage 30s poll 消费 `data.task.schedule`；手动 run 走同一执行器而非 setTimeout）。

### TUI /trace + /tree
`/tree`（结构投影）与 `/trace`（同一 entry 树的时间/成本投影）都已在 TUI 落地——`tree-selector.ts` `TreeProjection = "tree"|"trace"`、`/trace` slash 命令（`builtin-session.ts` → `showTraceSelector`）。数据源 = tree-selector 的 SessionEntry 树 + live `AssistantMessage.usage/.duration/.ttft`（零新数据依赖）。GUI 侧消息树 seam（`message-tree.ts` buildMessageTree）仍为向前兼容路径。方案：`docs/archive/tui-trace-plan.md`。

### musepi ps CLI
`cli-commands.ts` 注册 `ps` → `commands/ps.ts`（`runPsCommand`）：action `list|info|logs|stop|kill|restart`；flag `-a/--all`、`-j/--json`、`--plain`、`--dir`、`--global`、`-f/--follow`、`--head`、`-n/--lines`、`--grep`、`--timeout`。从 harness 外部查看/控制 daemon-broker 托管进程（机器全局 `--global` 作用域，如 browser-relay）。

### 遥测指标更名 → pi.musepi.agent.*
`telemetry-export.ts` OTel 指标/属性统一命名空间 `pi.musepi.agent.*`（counter：`chat.cost.estimated_usd`、`runs`、`steps`、`chat.calls`、`tool.calls`、`errors`；histogram：`chat.duration`、`tool.duration`；另有 `pi.musepi.agent.run.completed` 事件）。chat token 记录仍打 `pi.gen_ai.agent.id`/`pi.gen_ai.agent.name`。`test/otel-signals-probe.ts` 验证。

### win32 磨砂玻璃修复（2026-08-26）
`gui-base.css`：`html:root, html:root body { background: transparent }`（此前被忽略、带不透明 `var(--bg)` 的一层）；`[data-platform="win32"] .gui-main, [data-platform="linux"] .gui-main { backdrop-filter:none }`（模糊来自窗口材质）；`[data-platform="win32"][data-theme="light"]` scrim 22–58%。

### dsh-desktop 兼容链（运行时 serve 渲染器 + host-mode，2026-08-27）

dsh-desktop 对齐目标是**壳包装运行时提供的渲染器**，而非捆绑 Electron 耦合的 UI。MusePi 的三半：

- **运行时 serve 渲染器** — `musepi serve --web-port <n>` → `daemon/static-web.ts` `startDaemonWeb` 在 loopback HTTP 上 serve 构建好的 `guest-client` SPA（仅纯 GET；JSON-RPC WS 留在 `net.createServer`/`ws-transport.ts` — `Bun.serve` 的 http 兼容层会在升级 socket 上丢字节）。同时 serve 启动配置 `GET /__daemon.json` → `{ wsUrl: "ws://127.0.0.1:<wsPort>/", token? }`（仅 `--remote-token` 时带 token）。渲染器 dist 缺失**非致命** — 壳回退到本地 bundle。
- **壳包装它** — Electron `main.cjs`：设置 `MUSEPI_GUI_COMPAT_URL` 时 `mainWindow.loadURL(compatUrl)`，而非本地 bundle / Vite dev server。
- **渲染器以 host 连接** — `guest-client/src/lib/host-client.ts` `HostClient` 实现 `SessionClient` 接口（与 collab guest 暴露的 `GuestSnapshot` 契约相同）：经 `?token=` 连 daemon WS，`session.list` → `session.subscribe`（初始快照 + `entry`/`event`/`state` 流），渲染复用 guest 的 Transcript/工具卡/composer 不动。App 在读到 `/__daemon.json` 时自动以 host 连接（无 collab 深链 + 配置存在 → `connectHost`，跳过 ConnectScreen）。

坑位：tsgo 下 `server.port` 类型为 `number | undefined`（`const port = server.port ?? options.port`）；host 视图是 **v1 最小**（`recap`/`approval-request`/`ask-request` 事件忽略、`sendUiResponse` no-op、subagent chat/kill 走 `agents.*` rpc）；`guest-client` 绝不能 import `@musepi/desktop-app`（分层：collab-proto ← guest-client ← gui），故 host client 放在 guest-client，GUI 在需要处自己供应 slot-host。

**Frame 叠加 + host 富交互（2026-08-27）：**compat 壳以 `?shell=1` 通知渲染器 — `guest-client/src/lib/compat-shell.ts` `isCompatShell()` 精确匹配值 `"1"`；页面随即加 `.sh-app--compat`（`padding-top:48px`）+ `.compat-titlebar`（48px fixed 拖拽条，`-webkit-app-region: drag`），Electron 以 `compatUrl + "?shell=1"` 加载并沿用既有 `titleBarStyle:"hidden"` + `titleBarOverlay:{height:48}`（win32/linux）。纯浏览器中无效（无 OS 控件）。host 视图现已接线富交互：`HostClient` 把 `ask-request`→`uiRequest`（Composer 渲染，`sendUiResponse`→`session.askAnswer`，经 `#askReqIds` 桥接 daemon 字符串 id ↔ composer 数字 reqId）、`approval-request`→`approvalRequest`（`components/shell/ApprovalCard.tsx` 渲染允许/拒绝 → `tool.approve`/`tool.deny`）、`recap`→notice。`GuestSnapshot`/`SessionClient` 新增 `approvalRequest` + `respondApproval`；collab guest 两处保持 null/no-op。

**Compat slot host（serve 注入,2026-08-28):**guest-client 保持被动渲染器——`musepi serve` 在 `?shell=1`(Electron compat)请求根路径时,把 `compatSlotHostScript()` 注入 `</head>` 前:脚本开自己的 daemon WS(读 `/__daemon.json`),调 `extensions.list`,过滤 `slot:"transcript.node"` 组件,blob-import 已编译 ESM(react 绑定 `window.MusePiReact`,guest-client 入口同 GUI 一样暴露),然后 `window.MusePiCompatHost.register(slot, entryKinds, Component, extensionId)`。Transcript 在未注入 `renderTranscriptNode` 时(独立页/ compat 页)回退查该注册表按 kind 分派——纯浏览器 guest 无注册表,内建渲染不受影响。注入缝在 `static-web.ts`;seam 是 Transcript 条目行的 `data-entry-kind`/`data-entry-id`(被动的 DOM 锚,React 树不改)。

**desktop-shell 扩展 + Shell 三模式（2026-08-28 增补）：**Electron 壳是一等扩展（`kind:"desktop-shell"`, id `desktop-shell:shell`, `builtin-registry.ts`）——`extensions.list` 顶层 `shell: { enabled, mode, webUrl }`（`shell.enabled`/`shell.mode` 设置键驱动，`webUrl` 来自 daemon `--web-port`）；`extensions.setEnabled("desktop-shell:shell", { enabled, mode })` 切换开关与模式并管理 `web.port` 发现文件（壳 `probeWeb()` 读它 loadURL compat or 本地 bundle）。注入脚本按 `registry.shell.mode` 选 slot 集合：compatibility=`transcript.node`；extended/enhanced 加 `composer.dock`/`panel.tab.workbench`/`statusbar`——guest-client 的 `CompatSlotHost`（`lib/compat-slot-host.tsx`，memo 化）按 slot 渲染，App 挂 composer.dock（composer 上方）/statusbar（底部）/workbench 面板（HeaderBar `GuestPanel`）。桌面 host 视图标 `sh-app--host`。

## 19. GUI 吸收轮（2026-08-29）：git 图谱 / 浮动状态卡 / 奖励弹窗 / 最大化层级

- **`git.log` 结构化契约（对旧形状是破坏性变更）**：默认返回 `{ commits: [{ hash, shortHash, author, timestamp(ms), refs: [{kind: "head"|"local"|"remote"|"tag", name}], parents: string[], subject }], hasMore }` —— 由 `git log --all --topo-order --pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%P%x1f%s%x1e` 解析（`limit` 默认 100，多取一条得 `hasMore`；`skip` 翻页）。远端 ref 以 `git remote` 名单分类（本地 `feature/x` 不会误判为 `origin/...`）。参数 `{ cwd?, limit?, skip?, graph? }`；`graph: true` 保留旧 ASCII 字符串（GUI 已不再使用）。**异步 spawn + 10s kill 守卫**——不再用 spawnSync（曾冻结整个 daemon 事件循环，同 git.status 教训）。GUI：`ContextPanel` 的 `GitLogPane` 经车道求解器 `packages/desktop-app/src/lib/git-graph-lanes.ts`（`solveGraphLanes`，纯函数 + `packages/desktop-app/test/git-graph-lanes.test.ts`）渲染 ZCode 风格表格：first parent 保道、其余 parent 开道/并入、滞留列以 `kind: "join"` 汇入节点。加载更多 = 累积 commits 整表重算，跨页车道连续。行点击复制完整 hash（1.2s「已复制」反馈）。
- **`git.status` `numstat` 参数**：`{ numstat: true }` 额外返回 `git diff HEAD --numstat` 的增删行合计（二进制 "-" 行跳过）——浮动状态卡的 +N/−M 徽章消费。
- **浮动状态卡**（`packages/desktop-app/src/components/StatusCards.tsx`，挂在 ChatView 转写包裹层，z-4 位于加载骨架之下）：Git 卡（15s `git.status` 轮询 + 分支弹层复用 `git.branches`/`git.checkout`，错误走共享 `musepi-gui-toast` 通路）、智能体卡（`snap.progress` 运行/已结束分拆；已用时按本挂载首次 sighting 计时——wire 载荷无起始时间戳）、待办卡（扫描 entries 取最新 `todo` toolResult 的 `details.phases`）。折叠态持久化在 localStorage `musepi-gui-status-cards`；全部卡片为空时整栈不渲染。
- **Transcript `jumpRequest` prop**（`{ timestamp, nonce }`）：消息树/轨迹/画布/分支条跳转的唯一入口。先扩展尾部窗口（目标索引 − 20 行上下文）与压缩折叠（`setCompactedOpen`）直到目标行挂载，再 scrollIntoView + `tr-flash-highlight`（定义在 transcript.css，宿主无关）。旧的 `packages/desktop-app/src/lib/transcript-jump.ts`（行未挂载时回退 scrollTop 0）已删除——调用方传 `requestJump(ts)`，nonce 由 ChatView 持有。
- **奖励弹窗**（`packages/desktop-app/src/components/RewardOverlay.tsx`）：`changelog.startup` 返回 `reward` 时由 AnnouncementOverlay 挂载（读可选 `<agentDir>/reward.json`：`{ id, amount` 必填，brand/label/subtitle/expires/success/primaryUrl/secondary 可选`}`）。只弹一次语义走既有公告流（force peek 可重开）。动效分层——tilt 包裹层（指针写 `--tilt-x/--tilt-y`）、idle 漂浮、一次性入场——同一 `transform` 永远只有一个动画源；数额用 CountUp 滚动；打开时 `sfxFor("complete")`；`gui-motion-off`/reduced-motion 全部降级。新增 i18n 域 `reward.ts`（zh+en，两侧 index.ts 查重守卫同步注册）。
- **最大化层级（用户：前后内容重叠）**：三处修复——(1) `.gui-pane-maximize-backdrop` 遮罩（fixed、top 48px、z-840、点击还原）垫在 z-850 面板下；(2) `.gui-float-scrollbar` z 100000 → 30（fixed 元素此前画在最大化面板之上；层级降为转写局部）；(3) 最大化期间抑制 agent 浏览自动切视图（`onManagedBrowserState` → `onViewChange("browser")`，经 `maximizedRef` 镜像）。**坑**：fixed 定位元素进根层叠上下文——任何高于浮动面板的 z-index 都会穿透；新增浮层前先 grep 审计 `z-index`。
- **原生视图的布局/遮挡机制已整体删除**(随 2026-09-12 的 `<webview>` 迁移,见 §23):slot 投影、重投影信号(scroll/focus/visibilitychange)、几何遮挡判定(`lib/overlay-block.ts`)、页面加载 epoch/revision 水位线、4px 手柄让位——它们存在的唯一理由都是「页面是恒定画在 DOM 之上的原生视图」。dev 主进程仍带 `--remote-debugging-port=9224`(与管理浏览器自己的 CDP 桥 9230 是两个不同服务)。
- **扩展中心加载失败相位**（dsh PluginInventory 对齐）：`stateLabel` 以 `loadError` 优先（「加载失败」），列表行（主树 + 搜索结果）显示红点（`gui-ext-dot--error`）+ `gui-ext-item-tag--err` 徽章——坏扩展不必点进详情即可见。

### 侧栏排序 / tab 动效 / 切换卡顿打磨（2026-08-29，用户反馈第二轮）

- **会话列表点击重排修复**:`SessionList` 的 `statusTime` 排序曾以 `working(+2)/unread(+1)` 为主键——但两个标志都会因点击行而翻转(打开清未读、离开掉 working),行在光标下每次切换都上下跳动。现排序纯按最后活跃时间(`sessionSortKey` 降序 + 稳定 id 决胜);working/未读保留为纯视觉行标记(脉动点、加粗)。分组(`GroupedSessionList` 日期桶)本就按最后活跃。
- **分组/项目 tab 动效**:胶囊新增滑动 thumb(`.gui-tab-thumb`,`data-tab` 驱动 `translateX(calc(100% + 2px))`,200ms spring——两个 pill 固定宽,几何确定无需测量),胶囊内激活 pill 自身填充转透明(类的基础 `--active` 填充保留给其他使用方)。列表容器按视图 key(`archived | groups | projects`)重挂载并 160ms 淡入(`.gui-tab-pane-in`)。
- **切换错峰动画收紧**:错峰 reveal(guest-client `transcript.css`,`data-switched` 标记来自 ChatView)存在两份冲突阶梯——packages/desktop-app/src/styles/gui-pet.css 以不同延迟复制了 guest-client 规则,胜负取决于打包顺序。已删重复(transcript.css 单一来源),时长 300→240ms、尾延迟 210→120ms(最后一行 ~360ms 就绪,原 ~510ms),并补 motion-off/reduced-motion 全关。
- **骨架屏闪烁阈值 150→250ms**:快速本地切换期间旧会话内容保持可见(加载期间不卸载),只有真正慢的打开(历史会话重激活)才出骨架。
- **发送路径审计(无需改动)**:composer 立即清空文本(`onSend` 即发即忘),store 按约 10 Hz 合批流事件突发(见 §50)并折叠连续 `message_update`,快照尾部截断 200 条(`tailSnapshot`),`session.send` 的侧栏刷新挂在发送 ack。感知延迟在 daemon 侧,不在 GUI。
- **dsh 上游扫描(用户已 pull)**:新提交为 code-mode→PTC 改名、Connection 自持 RPC 传输(移除 ApiProxy)与 session-export 下载路由——结构性清理,本轮对 musepi GUI 无可吸收项;此前吸收的缝(Notifier 帧脏合并、插件清单)未变。
### 透明审计 + compat 壳玻璃（2026-08-29，「该透明的区域仍没有透明」）

- **审计结论**:gui(本地 bundle)的玻璃管线端到端完好——Electron 主进程以 `backgroundColor #00000000` + Win11 `backgroundMaterial:"acrylic"` / macOS `vibrancy` 建窗,`gui-vibrancy` 切换材质与底色,`gui-base.css` 以 `html:root, html:root body { background: transparent }`(特异性压过 guest-client base.css 的实心 `var(--bg))` 保根层透明,`.gui-main`/`.gui-pane-side--immersive` 铺半透明 scrim。若本地 bundle 仍不透明,按序排查:设置 → 外观 → 窗口透明开关(`musepi-gui-glass-enabled`,关=强制 `--gui-glass-overlay:100%` + 不透明窗底)、Windows 个性化 → 颜色 → 透明效果(系统级关闭会让 DWM acrylic 渲染成实色,应用侧无解)、insider 构建 DWM 偶发异常。
- **实际缺口已修复**:玻璃契约此前只存在于 gui bundle。壳加载 SERVE 的 guest-client 渲染器时(compat 链——`MUSEPI_GUI_COMPAT_URL` 或 daemon `web.port` 发现文件且 `shell.enabled` 默认开),页面通篇实心 `--bg`:侧栏、顶栏、主体四周永远不可能透明。修复:`guest-client/src/lib/native-glass.ts`——当 compat 标记(`?shell=1`)与 Electron bridge(`setWindowGlass`)同在,渲染器加 `sh-native-glass`(html/body 透明、`sh-app` scrim 100%→38%、头栏/侧轨混合 80%→45%,见 shell.css)并把主题镜像到窗口材质;`enableNativeGlass()` 在 app 导入时执行,首帧即玻璃。纯浏览器 guest(无 bridge/标记)保持实心画法;Android/移动壳不受影响。

## 20. Windows NSIS 快捷方式持久化(2026-08-30)

**症状**:OTA 更新后桌面快捷方式消失。**根因**(两层):

1. **electron-builder `KeepShortcuts` 保留机制**——首次安装向 `HKCU\Software\<APP_GUID>` 写入 `KeepShortcuts=true`(GUID = appId 的 UUID v5,`multiUser.nsh` 的 `INSTALL_REGISTRY_KEY`)。后续安装时 `installSection.nsh` 读它:带 `KeepShortcuts=true` 且 exe 存在 → 走**保留分支**(仅在新旧路径不同时改名;`oldLink == newLink` 时**不重建**)。用户/清理工具删掉的桌面快捷方式,任何后续更新都不会重建。
2. **`createDesktopShortcut:"always"` 对更新无效**:它只定义 `RECREATE_DESKTOP_SHORTCUT`(NsisTarget.js),该分支被 `${ifNot} ${isUpdated}` 门控——electron-updater 以 `--updated` 参数拉起安装器(NsisUpdater.js 参数 `["--updated","/S",...]`),所以更新永远跳过桌面重建,即便设了 "always"。

**修复**(open-design custom-NSIS parity):`packages/desktop-app/release/ensure-shortcuts.nsh` 定义 `customInstall` 宏——`installSection.nsh` 在文件安装完成后调用它(`!ifmacrodef customInstall`)。它**无条件** `CreateShortCut` 桌面 + 开始菜单快捷方式(绕过 `keepShortcuts`/`isUpdated` 门控)并通知壳。经 `packages/desktop-app/package.json` 的 `nsis.include` 接线。

**验证**(真实安装器,0.4.7):
- 全新安装 → 桌面(本机桌面被重定向到 `D:\Desktop`;用 `[Environment]::GetFolderPath('Desktop')` 查,不是 `%USERPROFILE%\Desktop`)+ 开始菜单快捷方式均创建。
- **OTA 路径**:删掉桌面快捷方式 → 带 `--updated` 重装(electron-updater parity)→ 桌面快捷方式重建——`KeepShortcuts=true` + `isUpdated=true` 下默认模板做不到,可归因于该宏。
- 注册表核对:测试期间确认 `HKCU\Softwaree444d0e-2326-5f07-be39-027b4a8e8598`(APP_GUID)的 `KeepShortcuts=true`。

## 21. 任务中心加固（2026-09-03）：cron 契约、时区语义、运行历史

任务中心页（`packages/desktop-app/src/components/ScheduledTasksPage.tsx` + `TaskCenterViews.tsx`）是 daemon cron 存储（`~/.musepi/crons.json` + `crons.runs.json`；调度器在 `coding-agent/src/daemon/server.ts`，合并/校验/下次运行在 `daemon/crons.ts`）的唯一 GUI 客户端。

### cron.* RPC 契约

- `cron.list → { tasks, runs }` —— runs 为**全局最近 20 条**（磁盘窗口 100 条；按任务查历史用 `cron.runs`）。
- `cron.upsert { task } → { tasks, task }` —— 校验后走 `mergeCronTask(existing|undefined, task, now, defaultCwd)`（`daemon/crons.ts`）：新建任务用显式字段白名单，**必须在此携带 `model`/`thinkingLevel`**（曾有回归在新建时把两者静默丢掉）；编辑走 spread 合并。`nextRunAt` 重算（停用时清空）。collab guest host 镜像同一调用，默认 cwd 用 `sessionManager.getCwd()`。
- `cron.delete { id, cleanup? }` —— `cleanup:"delete"` 删除任务跑过的全部会话（journal + 行 + transcript 文件）并清空其运行记录。
- `cron.toggle { id, enabled }` / `cron.runNow { id }`（即发即忘；`runNow` 不在 guest 可变更白名单内——只读链路不能触发运行）。
- `cron.runs { id?, limit? } → { runs }`（新增）—— 按任务的运行历史，新→旧，默认 50 / 上限 100；只读，guest 可调用。
- `cron.nextRuns { schedule, count? } → { runs: epoch[] }`（新增）—— 编辑器 cron 预览改由 daemon 自己的解析器计算，客户端副本（`nextCronRuns`）已删除（单一事实源）。

### crons.changed 广播（新增）

每次 cron 变更与运行开始/结束后，daemon 在 events.subscribe 流上广播 `{ type: "crons.changed", at }`（与 extensions.changed 同 seq 机制；payload 只带时间戳——客户端重拉 `cron.list`）。消费方：`ScheduledTasksPage`（即时刷新）与 app 级运行完成通知。两者均**保留轮询兜底**（页面 30s / app 20s）；collab guest 收不到广播，维持纯轮询。

### 调度语义（crons.ts）

- `schedule.timezone`（IANA）端到端生效：墙上时间、闲时窗口、cron 表达式都按该时区求值（`zonedTimeToEpoch`，Intl 两步偏移，DST 安全；cron 按日历日展开、保留 Vixie dom/dow 语义、日回溯上限 4 年）。未设置/非法时回退本机时区——全部既有行为不变。非法时区串由 `validateCronSchedule` 拒绝。
- 运行状态：以 `agent_end` 的最后一条 assistant 消息判定——`stopReason "aborted"/"error"`（含 `errorMessage`）记 error，其余记 success。`finish` 拒绝覆盖已结算的 run（中止与 agent_end 竞态）。限制：只检查最后一条消息。
- `constrainToIdleWindow(at, window, from, tz?)` 闲时窗口按任务时区解释。

### 坑

- 编辑器时区下拉曾默认 `Asia/Shanghai`，而 daemon **完全忽略该字段**（next-run 全按本机时间算）——静默错位。草稿现在默认空选项「主机时区」，显式时区会显示在调度标签里。
- 看板视图的暂停/恢复曾调用不存在的 `cron.update` 并用 `.catch(() => {})` 吞掉拒绝——无信号的死 UI；daemon 只有 `cron.toggle`/`cron.upsert`。`rpc.request` 的方法名是不检查的字符串：接新调用方时务必 grep daemon 的 handler switch。
- 日历周起始是共享逻辑：页面日历（`TaskCalendarView`）与编辑器 `CalendarPicker` 都用 `packages/desktop-app/src/lib/appearance.ts` 的 `weekStartIndex()`/`orderedWeekdayKeys()`；星期文案来自 `scheduled sun..sat` 词表——禁止硬编码周日开头或 `["日","一",…]`。

## 22. 底部终端面板 + 浏览器地址栏打磨（2026-09-12）

- **终端 ANSI 调色板**：`TerminalPanel.tsx` 的 `xtermTheme()` 现在提供完整 16 色 ANSI 集，全部为**具体 hex** —— xterm 的 canvas 渲染器无法解析 `var()`/`oklch` 字符串，CSS 变量字符串会静默回落到 xterm 内置调色板（浅色主题下 `ls`/`git status` 对比度差）。取值由 `tokens.css` 的 oklch token 解析而来（oklch→sRGB 换算；见各槽位的 `note` 注释）。无 token 的槽位（blue、浅色的 `black`/`white`/`brightWhite`）选 WCAG 对比度合格值并在注释里注明来源。bright 系列复用基础值（对齐 openchamber `convertThemeToXterm`）。
- **终端回滚缓冲为 10,000**（openchamber 同值）；长构建输出必须能滚回去。`scrollback` 是 xterm 构造器状态——对已打开的终端**不生效**；主题色可以（`term.options.theme` + `refresh`）。
- **终端选区 → 对话输入框**：xterm `onSelectionChange` 状态驱动宿主上方的「附加到对话」小按钮；点击后通过**共享的** `musepi-gui-insert-text` window 事件（元素选择器/ContextPanel 同一通道）把选中文本送进输入框——不新建第二条插入通路。
- **浏览器地址栏键盘导航**：`onAddressKeyDown`（`ManagedBrowserPane.tsx`）用纯函数 `stepSuggestionIndex`（`src/lib/suggestion-nav.ts`）处理 ↑/↓；两个方向都**穿过 -1（"未选中"）回绕**，保证输入中的地址始终一键可达；Enter 打开高亮建议。高亮索引与鼠标 hover 共用同一个 `suggestionIndex` 状态（同时驱动 `aria-selected` 与 `.gui-browser-suggestion--active` 样式），键盘与指针永远不会不一致。建议列表变化时重置索引（`useLayoutEffect` 监听 `addressValue`/`suggestionsOpen`）。

## 23. 右面板拖宽 + 托管浏览器 `<webview>` 架构（2026-09-12）

- **右面板拖宽**(`ContextPanel.tsx`,手柄 `.gui-pane-resize-x`)现走 `lib/use-pointer-drag.ts`(capture + 过 4px 阈值后 `preventDefault` + pointerId 过滤)。两条踩过的规则:(1) 释放回调**绝不能读 render 闭包里的 `width`**——它持有 pointerdown 那次 render 的值,于是旧的吸附用的是拖拽**起点**宽度,每次拖完都弹回;起止宽度改存 ref。(2) 手势期间必须加 `body.gui-resizing`——它是 `user-select: none`(gui-settings.css)与面板 220ms 宽度过渡逃逸(gui-chat.css)的唯一开关;不加则拖拽会选中沿途文本、且每一跟随帧都变成动画。吸附点(300/480/800)需 ≤24px 半径,否则其它宽度根本不可达。`app.tsx` `startResize` 的 `"right"` 分支是死码(只有侧栏在调),已删。
- **托管浏览器已是 DOM 里的 `<webview>`,不再是原生视图**(2026-09-12 迁移):`ManagedBrowserHost`(在 `app.tsx` 挂载一次)为每个标签持有一个 `<webview partition="persist:musepi-managed-browser">`,并用 fixed 定位浮在面板槽位 rect 上;`ManagedBrowserPane` 只渲染 chrome 并上报该 rect。原生视图强加的一切都消失了:没有 `set-layout` 投影、没有遮挡探测(`lib/overlay-block.ts` 已删除)、没有原生视图时代的让位规则——页面现在参与 DOM 层叠;但迁移当时设想「按普通 z-index/命中测试就够」的两处缺口必须显式补上(见后两条)。
- **三条实测约束决定了这里的形状,勿「顺手简化」掉**(Electron 43 隔离 harness):(1) **在 DOM 中移动元素会销毁 guest**(元素留在原地成为死壳),故所有 guest 挂在同一个稳定父节点下、永不 reparent/卸载——切标签只切 `opacity` + `pointer-events`。(2) **guest 处于 `display:none`/移出视口/零尺寸时 `capturePage()` 永不 settle**(`opacity:0` 与被遮挡仍可截),故隐藏只用 `opacity`:面板关闭时宿主仍按最后 rect 挂载,这正是 agent 无需展开面板也能对后台标签截图的原因。`electron/managed-browser.cjs` 另把截图限时 1.5s 并重试一次(冷启动 guest 可能错过首帧)。(3) **绝不要给元素设 `display`**:Electron 的 shadow 样式是 `:host { display: flex }`,而 guest 内部 iframe 的高度**只**来自这个 flex 上下文(`flex: 1 1 auto`,iframe 自身不声明高度)——内联 `display: block` 会废掉该 flex 布局,把 guest 压成**替换元素默认的 150px**,而元素盒子仍是满高:页面于是只铺满顶部、下方一片空白(用户:面板打开网页后高度不正常)。宽度不受影响(iframe 自己写了 `width: 100%`),高度会。实测(2026-09-12,真 GUI):槽位/元素 339×606 而 guest 视口 339×150;去掉覆盖后 339×606,此后 guest 能跟随面板最大化(1199×622)与收起/展开。
- **要画在网页之上的东西必须离开面板的层叠上下文**(2026-09-12):`.gui-chat-surface` 带 `z-index: 5`,于是整个应用表面——**包括面板自己的 chrome**(`.gui-browser-chrome` 的 `z-index: 500`)——都位于根级页面宿主(900)之下,面板内任何 z-index 都够不到页面。因此地址栏下拉与「更多操作」菜单改走 `useFloatingMenu`(仓内唯一的浮层实现):它的 portal 落在 `#root` 成为 `.gui-menu-popup`(z-index 4100,应用 z 阶梯顶端),这才是它们能盖住网页的原因。两条菜单的 CSS 只保留布局(shell 负责定位、进出场与关闭),与其它菜单同一契约。真 GUI 实测:菜单打开时 `elementsFromPoint()` 返回的是菜单自己的子元素,不会是 `WEBVIEW`。
- **右面板拖宽手柄要活下来需要三件事**(2026-09-12,同一层级问题):(1) 手柄必须留在面板内(`.gui-pane-right--inner` 是 `overflow: hidden`),而页面宿主按槽位 rect 定位——于是槽位留 **6px 内缩**(`.gui-browser-slot { margin: 6px }`),网页卡片不再压到手柄;(2) 手柄提到面板 chrome 之上(`z-index: 600` > chrome 的 500),整条边都能拖,而不只是 chrome 以下那段;(3) 拖拽需要**手势护盾**(`.gui-drag-shield`,手柄 pointerdown 即挂起,z-index 950):主渲染帧里的 pointer capture 在指针落到网页 guest(OOPIF)上之后**收不到**移动事件(实测:同一次手势,向左移动有事件、向右移进页面区域给主渲染进程 **0** 个 pointermove),因此由护盾承接 move/up。没有它,向右拖(收窄)连 4px 阈值都过不去。网页卡片自身的圆角来自**宿主**的裁剪(`.gui-managed-host` 的 `border-radius` + `overflow: hidden`,对齐槽位半径),因为 guest 画出来的是方块。
- **迁移后的所有权划分**:渲染端拥有标签元素、导航与选择;主进程拥有分区策略(权限 deny-all、`omp-file://` 预览)、9230 上的 loopback CDP 桥与活动台账。协议:渲染端→主进程 `guest-ready`/`guest-gone`/`active-tab`/`visibility`;主进程→渲染端 `create-tab`/`select-tab`/`close-tab`(另有收窄后的 `state` 与同意门)。`managed-browser.cjs` 只在**校验 session 属于托管分区之后**才用 `webContents.fromId` 绑定 guest —— 这道校验就是安全边界(被攻陷的渲染端不得把手边的任意 guest 塞进桥)。
- **guest-ready 的判据是 `dom-ready`,不是 `did-attach`**:在 dom-ready 之前,webview 的所有方法(含 `getWebContentsId()`)都会抛「The WebView must be attached to the DOM and the dom-ready event emitted」(实测;失败形态是标签静默绑定不上,15s 后 `Target.createTarget` 超时)。`reportGuestReady` 幂等,宿主另在挂载时探测一次,覆盖「监听器注册前 guest 已 attach」的情况。
- **浮动状态卡**:分支触发器必须**切换**(`setBranchOpen(v => !v)`)——`useFloatingMenu` 刻意跳过落在锚点上的 mousedown,并假定调用方自己的 click 负责关闭,所以只开不关的处理函数会让菜单无法从打开它的按钮收起。工作区更改的文件列表改用共享 `Reveal`,不再用裸 `{cond && …}`。
- **测试基建坑(给 desktop-app 加组件测试前必读)**:本包用 happy-dom 做纯 DOM 探针;但**挂载 React** 的测试(`createRoot` + `act` + happy-dom)在**失败路径**会挂死 runner——Bun 1.3.14 不打印任何结果,进程 RSS 涨过 3GB 且永不退出(已复现两次;通过路径正常,约 1.6s)。desktop-app 的测试请限制在纯逻辑 + DOM 探针;浏览器面板改用隔离 Electron harness(配方:`/tmp/wvapp`,真 `managed-browser.cjs` + `MUSEPI_MANAGED_BROWSER_PORT` + 最小协议渲染端)或 §8 的 CDP 流程。
- **`src` 每个元素只给一次**(别绑到会被导航更新的 URL state):guest 报回导航后宿主会重渲染,活绑的 `src` 会重设元素、重载页面并**顶掉在途加载**——表现就是那条红色 `ERR_ABORTED (-3) loading '<url>'` 横幅(已在 harness 复现)。`entrySrc(tabId, url)` 固定创建时的 URL 并带回归测试;之后的导航只走 `loadURL`/主进程。主进程另把「被顶掉」的加载视作「正在加载」而非错误。
- **宿主的 rect 必须在「纯位移」时也复测**:ResizeObserver 只在槽位**尺寸**变化时触发,于是侧栏折叠、面板拖动、视图切换都会让宿主停在旧 rect(页面看起来变大/被裁,点击坐标整体错位)。现面板按 200ms 低频 + `transitionend`/resize/scroll 复测,且 `setPaneRect` 对相同 rect 直接返回,复测不产生重渲染。
- **隐藏的宿主必须不可命中**:外层设 `pointerEvents: "none"` 时,标签层若写 `"auto"` 会**在 `none` 父级内部重新开启命中测试**(CSS 语义),透明 guest 便继续吞掉本属于起始页的点击。标签层的条件是 `visible && active`。
- **视口预设缩放的是宿主要不是槽位盒子**(`lib/browser-viewport.ts` 的 `fitViewport`,openchamber parity):页面必须保留预设的**布局**宽度——只在槽位上写 `max-width` 会让 flex 把它收缩回面板宽度,于是「1440 预设 + 420 面板」跟没设预设一样(还被裁)。现由面板按内容区算出 `scale = min(1, 可用宽/预设宽)` 并随槽位 rect 一起上报,宿主按预设尺寸渲染 + `transform: scale(...)`。宿主放在 `z-index: 900`:高于最大化面板(850)、低于应用的弹层/菜单/提示(更高),所以最大化时页面不再被埋。
- **面板宽度是「窗口相对预算」,且组合器底栏必须可换行**:拖拽上限 = 「面板右缘 − 会话列左缘 − 会话列最小宽(420px)」(拖拽起点量取;两条边在该手势期间固定),窗口 resize 时连持久化宽度一起重新钳制(`lib/panel-width.ts`)。输入框底栏(`.gui-composer-row`)必须允许 `flex-wrap`:两侧都是固定尺寸图标按钮,不换行时窄组合器下必然相撞;右组还需要 `min-width: 0`(chip 截断)与 `margin-left: auto`(换行后仍靠右)。
- **agent 操作高亮走 CDP 通道**(2026-09-12,proma parity):桥转发的 `Input.dispatchMouseEvent` 按下事件会把落点元素通过 Blink 检查器覆盖层闪一下(`DOM.enable` + `DOM.getNodeForLocation` + `Overlay.highlightNode`,`AGENT_HIGHLIGHT_MS` = 900ms 后自动清除;下一次操作移动该框而不是叠加)。**`DOM` 域必须在桥自己的 debugger session 上开启**——渲染端在别处开启不会带过来,而且失败是静默的(`Overlay.*` 照常接受调用,唯一线索是 `agent highlight failed: DOM should be enabled first` 这条 warn)。页面里不注入任何东西,高亮失败也绝不影响 agent 的动作。
- **设备预设由主进程按面板上报的槽位施加**(2026-09-12):面板通过 `managed-browser:set-device` 上报 `{preset, viewport}`,主进程据此下发 `Emulation.setDeviceMetricsOverride` + `Emulation.setUserAgentOverride` + 触摸模拟(移动档)或清空覆盖(自适应档)。**模拟视口正是「手机档无论面板多宽都按 393 布局」的原因**,也是「桌面 1440 档真的按 1440 布局」的原因——没有它时页面仍按面板自身宽度布局,只有 UA 变了。实机逐档实测:手机 → `MOBILE-UA, mobile=true, layout=393`,桌面 → `layout=1440`,自适应 → 桌面 UA + 槽位尺寸。
- **折叠必须「上报」而不是从几何推断**(2026-09-12):`managedBrowserVisibility` 是主进程 `panelVisible` 的镜像,而 `panelVisible` 决定 agent 活动露出(`emitState({agentActivity:true})` → 渲染端切到浏览器视图并展开已折叠的面板)。折叠时面板仍保持挂载(`.gui-pane-right--inner--closed` 为 `width: 0`),于是「按 rect 推断可见性」可能一直是 `true`(实测:槽位元素停在 ~1px,永远不会是 0),露出因此永不触发——这正是「agent 在干活但我什么都看不到」。现由面板直接上报 `open` prop(`ContextPanel → BrowserPane → ManagedBrowserPane`);端到端实测:折叠态 + 一次 agent 侧按下 → `agentActivity: true` 推送 → 面板展开。
- **`start()` 需可重入,且任一 IPC 通道重复注册会拖垮整座桥**(2026-09-12):`ManagedBrowserController.start()` 会重新注册 `managed-browser:*` 处理器,因此同进程内第二次调用(窗口重建)会抛 `Attempted to register a second handler for '<channel>'`;由于该拒绝发生在 `start()` 内部,`startServer()` 永不执行、桥从未绑定——面板所有调用回 `unknown tab`,而 `http://127.0.0.1:9230/json/version` 无响应、`/json/list` 无目标。已用 `ipcRegistered` 标志 + `if (this.server) return this.port` 兜住。同一失效形态也可由单纯的重复注册触达(一次多写的 `managed-browser:set-device` 就是如此),请保持每个通道只注册一次。
- **像素验证必须在「可见窗口」上做**(2026-09-12,harness 备注):Electron 窗口被遮挡时 Chromium 会停止合成,此后所有截取路线拿到的都是冻结帧——`capturePage()`、guest 自身 CDP 的 `Page.captureScreenshot`、win32 窗口截取与整屏截取结果互相矛盾或全黑,读起来就像「效果根本没画」。agent 侧视觉效果的验证请用渲染端状态(DOM class、`localStorage`、推送状态)或在窗口置于前台时进行;折叠判据用 `localStorage["musepi-gui-right"]` / 轨道按钮的 `aria-label`,而不是截图。

## 24. advisor 卡片、设置页 fill 契约、面板最大化、会话地图、输入框草稿（2026-09-12）

- **advisor 提醒到达渲染端有两种形状,两种都必须渲染**(2026-09-12):持久化会话存的是 `{type:"custom_message", customType:"advisor", display:true, details:{notes:[…]}}`,但**实时投影**(`packages/sdk/src/materialized-view.ts` 的 `#upsertMessage`)过去会把 role 为 `custom` 的消息拍成普通 `message`,而 transcript 的 `case "message"` 把它送进 `default: return null` —— 于是重载后能看到、运行中看不到。现投影对 role `custom`/`hookMessage` 输出 `custom_message` 形状,渲染端两条路径共用同一个 `renderCustomMessage`(`Transcript.tsx` 的 `case "custom_message"` + 由 `readLiveCustomMessage` 收窄的实时 `case "message"` 分支)。`.tr-entry` 包装层改由 `EntryRow` 持有并在其之前返回 null,因此不画任何内容的条目(daemon trace `type:"custom"`、model/thinking-level 变更、`display:false`)不再留下空行。
- **内部滚动的设置页必须挂 `.gui-settings-content--fill`**(2026-09-12):不挂时页面容器保持 `overflow-y: auto`、`.gui-ext-body` 的网格行停在 `auto`,于是滚动归页面所有,该网格里的面板无界增长。扩展页(智能体 → 扩展)缺这个类,而插件/市场两个并排面板(同一网格单元的另一种占位者)压根没有布局规则:实测 5577px / 2019px,溢出「槽位注册表」行约 4900px。现与历史会话页同一机制挂 fill,两个并排面板自行声明 `display:flex; flex-direction:column; min-height:0`。同一页另两处:空详情占位符的 `min-height: 300px` 会让它在矮面板上偏心(fill 下已去掉),行内徽标的 `flex-shrink: 0` 会把尾部开关挤出列表的 `overflow-x: hidden` 边缘(现改为可收缩 + 省略号)。
- **最大化量的是会话卡片,不是视口**(2026-09-12):`.gui-pane-right--maximized` 此前是视口相对浮层(`top: 48px; right: 0; height: calc(100vh - 48px)` 外加内联的 `min(1280px, calc(100vw - 80px))` 宽度),完全无视会话卡片的 `m-2` 内缩与 `rounded-2xl` 圆角,并盖住会话列与部分侧栏。现由 `useLayoutEffect` 把 `.gui-chat-surface` 的实测盒(`closest('.gui-chat-surface').getBoundingClientRect()`)写进 `--pane-max-left/-top/-width/-height`,并以 `ResizeObserver` 跟随该容器复测,窗口缩放、侧栏折叠、轨道拖拽都保持贴合;圆角与底色复用 `--radius-2xl` 与 `--color-surface`。**验证注意**:几何只有在入场动画结束后才可比 —— 动画进行中 `.gui-view-enter` / `.gui-scene-chat` 是 `transform`/`filter` 祖先(实测中途为 0.985 缩放 + `blur(10px)`),此时 `position: fixed` 后代以它们为定位基准;被遮挡/节流的窗口会冻结该动画并报出假偏差(我们量到 267px/70px,正是容器自身原点)。
- **会话地图收敛为单一轮级投影,消息级画布下线**(2026-09-24 收敛,取代 2026-09-12 的下述记录):会话页「地图」tab 只进 `TurnMapCanvas`(轮节点,`layoutTurnMap`)。第二套投影(`SessionTreeCanvas`,9985 张消息卡,经 Shift+点 tab 或顶栏按钮进入)已删除——同数据源的两套视图且 B→A 无回路,读起来就是死胡同;消息级分支结构仍可在 ContextPanel → TrajectoryView 的分支树模式查看(`lib/message-tree.ts` 为它保留)。推论:(1) `mapDetail` state 与 Shift+点击旁路移除,地图 tab 永远进轮级地图。(2) 轮卡两态:**折叠 = 单行紧凑卡**(`tm-node--compact`:Turn 徽章 + 摘要 + 事件计数 + 用时;布局高度 `TURN_NODE_COMPACT_H`),**展开 = 全卡 + 泳道事件行**;单击切换,顶栏有全部展开/全部折叠(`expand-up-down`/`contract-up-down` 图标),展开集合仅会话内内存态(不进 URL/localStorage)。(3) 泳道行对齐 TUI /trace 信息密度:工具行带净化后的单行参数摘要(`replaceTabs`,CSS 省略号——TUI 的 `truncateToWidth` 是终端宽度 API,DOM 渲染无此角色),assistant 行带 `↑in ↓out` 用量(≥10k 缩写为 `12.3k`)、请求耗时与 TTFT(共用 `durationText`)。(4) `layoutTurnMap` 加方向参数:`"v"`(默认;主线垂直、分支横向开列)与 `"h"`(主线水平、分支纵向开行——车道行带行底水位,展开卡把后续行推开而不重叠)。选择持久化在 localStorage `musepi.map.direction`(缺失/非法 → `"v"`),平移/缩放/迷你导航/搜索两方向均可用;迷你导航条纵向靠左、横向靠底。(5) 右键菜单语义:跳转 = 纯导航(滚动定位,不动 leaf);切换到此分支 = `session.branchAt` 移动 leaf(显式语义,`switchToNode`);重答/分叉保持原语义——三个树操作(切换/重答/分叉)现在都走 chat 路径的 `runTreeOp` 守卫:运行中先确认 → 停止 → `waitWorkingCleared` → 执行,与重试/撤回同一收敛路径保护。(史:2026-09-12 的链段折叠删除——`SessionTreeCanvas` 曾把超过 24 节点的链折成「链段折叠」胶囊;当时已端到端删除并连带移除 6 个 i18n key——「地图不折叠」规则的出处,现改写为轮卡两态语义。)
- **输入框草稿覆盖附件,且共用同一个重置守卫**(2026-09-12):文本草稿原本就是 per-session(`musepi-gui-draft:<sessionId>`),但附件只存在于 React state,于是切换会话时要么把旧会话的 chip 漏进新会话、要么在欢迎页往返后丢失。现 chip 与文本并列持久化(`musepi-gui-draft-attachments:<sessionId>`,`{dataUrl, mimeType, name}` 的 JSON,仅在非空时写入),恢复与跳过由**同一个** `sessionResetRef` 守卫,旧会话状态绝不可能被写入新会话的 key;chip 的 id 只是渲染身份 —— 写入时丢弃、读取时从模块级序列重新分配(每实例计数器会与后续粘贴撞 id)。

## 25. 视图包装层的宽度预算 + swarm 进度与排队「立即发送」契约(2026-09-13)

- **视图包装层绝不可按内容撑宽**(`.gui-view-enter`,`gui-board.css`):它是 `.gui-shell` 的 flex item,`min-width: auto` 会把自动最小尺寸定成**内容的最小内容宽度**。扩展中心的 provider 标签行一宽,整页就被推到 2430px(1568 窗口实测):详情栏与半个标签行在窗口外、左侧导航右移(用户:扩展设置面板右偏移出界面)。给包装层 `min-width: 0` 后页面回到窗口宽,横向溢出交回给子元素自己的滚动容器(实测 2448 → 1568;塞入 6 个长标签时标签行在 915px 盒内以 1245px 横滑,整页不变)。新增任何整屏视图包装层都继承这条规则。扩展中心各面板自身的上下界是另一条契约(见 §24)。
- **所有 swarm 展示面共用同一条进度规则**:`agentProgressFraction`(`guest-client` 的 `tool-render/tools/task.tsx`)——终态成员为满,运行中按 `n/(n+2)` 随工具调用数增长(daemon 不流总量,因此不编造百分比),未开工为空。TUI 任务卡的 `computeProgress` 是同一条规则,任一侧改动都要同步。guest 侧运行态的填充**必须有背景色**(`tv-swarm-bar-fill` 默认 `--tv-accent`):没有背景时实时条画的是一块透明内容,观感就是「根本没有进度条」。桌面端状态行用同一个比例渲染在 `gui-status-bar` 轨道(54×4)里并复用该填充,`--tv-accent` 桥接到应用强调色。
- **TUI 任务 widget 与发起它的那次 `task` 调用绑定**:`tool_execution_*` 事件带 `toolCallId`,异号 `update`/`end` **必须忽略** —— `task-swarm` 这个 widget key 是全局的,否则另一次调用会覆盖在跑的这份成员表,面板在两个成员列表之间闪烁(`0/3` ⇄ `0/4`)。网格的 id 列取**最长成员 id 的可见宽度**并补齐,而不是 `String(count).length`:按数量算会把格子排得过窄,每行都超出终端宽度。
- **「立即发送」是跳队 —— 插到队首,绝不重排到队尾**(`session.queuedSend` → `AgentSession.sendQueuedMessage`):引导队列每个注入边界只取**队首**一条,而 RPC 此前把点击的消息取出后又追加到队尾 —— 它要等前面已排队的消息逐个投递完,面板上该行一直不消失(按钮读起来像没反应)。现取出的条目重新注入 steer 队列**队首**,下一个注入边界即发;面板点击后立刻按 daemon 权威快照重读,不等 3s 轮询。测试陷阱:由此触发的队列 drain 是 0 延迟 post-prompt 任务,fake timers **拦不住**它 —— 应 mock `agent.continue` 并在注入边界上断言投递顺序(steer-idle-drain 套件);continue 若 mock 成 no-op,队列不空、drain 会无限重新武装。

## 26. 用户消息展开/收起的高度动效(2026-09-13)

- **clamp 预览是「落定态」,绝不是折叠切换过程中的实时形状**(guest-client `transcript-content.tsx` 的 `UserText`):长用户消息(设置 → 聊天 → 折叠较长的用户消息,`musepi-gui-chat-collapseuser`)此前点击时直接翻转 `-webkit-line-clamp: 2` ⇄ `display: block` —— 硬切、无动效,违反 §3 的高度 morph 标准。现改走共享的 `useCollapseHeight`(`lib/use-collapse.ts`,扩展出 `closedHeight`/`onSettled`),在预览高度与全文高度之间按 transcript 的 220ms spring 过渡(与 `tr-think`/`tr-advisor` 折叠体同一语言)。**时序契约**:`--clamped` 类在展开开始时摘除、收起落定后才套回(`onSettled`)—— morph 期间套着 clamp 会让内容中途突然截成 2 行;预览高度必须在 clamp 挂着时缓存(渲染副作用里快照 `clientHeight`),因为 hook 测量时 DOM 已经切到另一侧;收起落定**不可**写 `--h: auto` —— 此时 body 还没套回 clamp,会闪出一帧全文高度(clamp 的 CSS 规则自带 `height: auto`,无视 `--h` 里残留的 px)。

## 27. 状态面板:单卡分区 + 胶囊 morph(2026-09-13)

- **右上角悬浮状态区是一张卡内的分区,不是三张卡**(`StatusCards.tsx` + gui-chat.css):git/子智能体/待办此前是三张独立磨砂卡纵向堆叠,折叠控制是悬在堆叠外左上角的小圆点(`top:-7px;left:-14px`),折叠态是纯静态胶囊。现对齐 ZCode 状态面板:单卡 + 可折叠分区(弱化标题行、chevron 悬停浮现 —— 纯 CSS),内容区限高 `min(64dvh, 32rem)` 内部滚动,收起控制钉在卡内右上角(absolute 定位,不随内容滚走;首个分区头用右内边距给它留位)。Git 分区行序对齐 ZCode:更改(+N/−M 折叠明细) → 分支切换 → 提交或推送。三种形态共用同一个 HeightMorph 挂载元素(高度按差值 240→480ms + 160ms 内容淡入;圆角/背景/阴影随类翻转 240ms 缓动 —— 宽度直接切换,ZCode 同款取舍),且必须长得**互不混淆**:**收起 = 胶囊**,999px 圆 pill,只承载 更改 + 彩色差异统计(干净回退分支 + ↑↓,无 git 时回退智能体/待办计数)—— 形状与措辞就是区分度;**折叠标题卡**(ZCode display-mode "auto"):transcript 列宽 < 560px(右栏展开 + 小窗,对堆叠的 `offsetParent` 挂 ResizeObserver)时,展开态以单行 `Git 工具 +N −M ⤡` 卡呈现 —— 点击强制展开完整面板,列宽恢复后自动回到 auto;其余情况为完整面板。紧凑形态的统计条件是 `(文件数 || added || deleted)` —— 纯 mode/perm 变更 numstat 为 0/0 但确有改动,只数文件列表会把读数清空。ZCode 的 ⋯ 展开策略菜单没有对应物(本地只有 `musepi-gui-status-cards` 一个持久化布尔),未移植。窄聊天护栏:视口相对的 `max-width` 放在 `.gui-status-cards` 包装层 —— 收缩包裹的卡片上写百分比会按自身内容宽解析,等于没有约束。
- **分支菜单是完整的弹层,不是裸列表**(`StatusCards.tsx` + daemon `git.checkout`):对齐 ZCode 分支弹层 —— 搜索框(客户端 `includes` 过滤;菜单局部状态每次打开时重置,避免残留过滤词藏住新列表)、「分支」分区标签、当前分支的非交互块(✓ + 脏文件数「未提交的更改：N 个文件」,复用更改行同一份 `git.status` `changedFiles`)、过滤后的切换列表,以及「创建并检出新分支…」——点击换成内联输入框(Enter 提交、Escape 取消),调 `git.checkout` 新增的 `create: true` 参数 → `git checkout -b`(增量参数,欢迎页选择器的普通路径不变)。「Git 图谱」刻意未做成独立项:musepi 的 git 面板本身就承载车道图历史,更改/提交或推送打开的就是它 —— 再加第三个同目标入口是噪音。

## 28. 设置记忆:工作区记忆卡 + 预览下载(2026-09-13)

- **设置 → 记忆新增工作区记忆卡**(`settings-sections/memory.tsx` + daemon `memory.workspace` / `memory.workspaceRead` / `memory.workspaceReveal`):对齐 ZCode 记忆面板,数据源是**既有**的按 cwd 记忆根(`getMemoryRoot(agentDir, cwd)` → `~/.musepi/agent/memories/<encodeProjectPath(cwd)>`,即合并管道写入的那批目录)。仅标题 + 描述头 —— **无开关**:后端启停本就在下方 schema 选择器里,同一设置放两个控件是重复(用户指出)。其下是工作区记忆目录浏览器:工作区选择器(`getMemoriesDir()` 下的目录,标签显示**文件夹名** —— 解码有损的 `encodeProjectPath` slug 取末段,基名撞车时带上父段消歧,tooltip 给原始 slug)、N 条记忆计数、名称搜索、刷新,以及文件行(图标 + 名称 + 相对时间,复用 transcript 域相对时间 key):单击把文件读进面板内查看器(`memory.workspaceRead`:仅裸文件名、仅 `.md`、512KB 上限),悬停的文件夹按钮在系统文件管理器中显示(`memory.workspaceReveal`,daemon 宿主侧执行:`explorer /select` / `open -R` / `xdg-open` —— 远程 daemon 即在远程机器上打开,与其它 daemon 侧路径语义一致)。
- **图片灯箱新增下载按钮,操作组下移**(guest-client `image-lightbox`):下载 + 关闭渲染为一行(`.tr-img-lb-actions`,top 76px / right 16px —— 比原来的单个 X 更退一步,像 ZCode 预览头部一样避开窗口部件、成对呈现)。下载把 src 重新 fetch 成 blob(`data:` 与远程 URL 都可用),按 blob mime 命名为 `musepi-image-<时间戳>.<扩展名>`,fetch 失败时回退为新标签打开源地址而不是无响应。
- **紧凑形态加固 + 两处空壳开关**(同轮,用户指出):状态 mini/pill 的差异条件不再被 `gitStale` 清空 —— 一轮轮询的滞后数字好过空白(链条 统计 → 文件数 → 分支 → "—" 总有产出),mini 的回退分支名从 faint 提到 muted(浅色卡上几乎不可见),`.gui-status-mini` 以 `space-between` 把展开按钮钉在右侧,行不再读作「标签-空白-按钮」。MCP 服务器的开关和 外观 → 信息状态条 的开关此前渲染为**空心胶囊** —— 两处 `gui-toggle` 按钮都缺 CSS 所定位的 `.gui-toggle-knob` 子元素(已补)。信息状态条开关此前也不实时生效:只写 localStorage,而 storage 事件同文档不触发 —— 现翻转时派发 `musepi-statusbar-info-changed`(`setStatusBarEnabled`,house 的 `musepi-dotmatrix-changed` 模式),`SessionStatusBar` 监听之;效果预览在开关开启时用真实 `gui-statusbar-info` 类渲染带示例分段的状态条。
- **浮动滚动条:闲时变浅不消失,吃豆人轨可拖拽**(`FloatingScrollbar.tsx` + gui-misc.css):覆盖滚动条在滚动停止 ~1s 后不再消失 —— 淡为 30% 透明度的幽灵轨(`data-idle`;悬停拇指恢复全不透明),进度随时可以按住拖动。双拇指共用同一拖拽契约(`onThumbDown`,按下即唤醒、保持抓取偏移);吃豆人皮肤此前**完全没有**拖拽处理 —— 现在 pac 字形在 `[data-visible]` 期间(含闲时)接回指针事件,12px 字形外套 24px 透明命中环(`::after` inset -6px)。轨道线本身保持 `pointer-events: none`(绝不吞内容上的点击)—— 只有拇指接入,既保住「幽灵轨不得拦截点击」的既有保证,又恰好让出拇指大小的一条作为把手。
- **会话侧栏:ZCode 列表对齐一轮**(`SessionSidebar.tsx` / `SessionList.tsx` / gui-misc.css,用户指出):① 运行中指示器改为 8 芒星标**旋转**(`.gui-tree-working-spin`,ZCode ✳ parity —— 原为呼吸圆点;欢迎页提醒行保留脉动点);② 「近期」重复区块从三个 tab 全部移除 —— 它把下方分组/文件夹里已有的会话在顶部再列一遍,白占列表头部空间;`isRecentlyActive` 助手与其测试一并删除;③ 分组 tab 底栏保持**日期分组** —— 曾试过按项目文件夹自动分组「空间」,已回退(用户:与项目 tab 设计重合);导入的会话改为在导入时自动归纳进**可编辑**自定义分组(见 §30)。
- **分组 tab 的全部展开/收起覆盖自定义分组**(`SessionSidebar.tsx`):tab 行按钮切换 `groupsAll`(null/true → 全部收起,false → 全部展开);自定义组是分组 tab 唯一的折叠块(「空间」已回退,见 §28③),展开/收起不再需要驱动文件夹块。
- **子会话子树并入同一个全部展开/收起,并带动画**(`SessionList.tsx` + `SessionSidebar.tsx`,用户反馈):父行 chevron 折叠原是每个 `SessionList` 实例各自的 `useState`(定时任务区/各项目块/未分组区各渲染一份列表),tab 行按钮对子会话完全不生效。状态提升为模块级存储(`useSyncExternalStore`;持久化键不变,仍是 `musepi-gui-session-collapse`),另维护「有子会话的父行」id 注册表;项目 tab 按钮调用 `setAllSubtreesCollapsed`,与 `collapseAllProjects` 同方向(有收起则全展开,全展开则全收起)。折叠改为两阶段行高补间,不再瞬时剪枝:`leaving` 保持子树挂载、每行 `<li>` 补间到 0px(240ms 后提交并剪除),`entering` 先提交再长高(0px → 自然高度)——与 `use-collapse.ts` 同一 240ms `cubic-bezier(0.22,1,0.36,1)` 阶梯(`useLayoutEffect`,展开行首帧不会闪全高;动画期间重复点击忽略)。`animFor` 用剪枝前树建的父链映射取最近带相位祖先,子树剪除前每行都能拿到相位。`useSyncExternalStore` 必须给第三个 `getServerSnapshot` 参数,否则 `renderToString` 测试直接崩。
- **浮动滚动条在容器死亡时收回**(`FloatingScrollbar.tsx`):闲时幽灵化让进度条获得了「余生」,容器被卸载后幽灵会永久悬在无关 UI 上 —— 进入设置后仍挂着会话列表的幽灵轨(用户报告)。轨可见期间跑一个 ~600ms 的探活(`targetGone()`:已断连**或**尺寸归零)并完全收回(`hideForGood`:摘除 `data-visible`/`data-idle`、清空拖拽目标);140ms 的 settle 检查与 1s 的 idle 定时走同一判断,滚动后立刻切界面也在一个探活周期内收回,不再滞留。

## 28b. 浮动滚动条:按容器 keyed 的轨池 + 拆分热路径(2026-10-05)

- **浮层按容器分配槽位,不再是全应用一条轨**(`FloatingScrollbar.tsx`)。`window` capture 阶段的 `scroll` 能看到每个可滚动容器,槽位首次见到容器时绑定(`bind`),经统一的 `retire` 回收。两个各自独立滚动的窗格现在各有自己的轨 —— 扩展中心的列表列与详情列都能显示位置。`MAX_RAILS`(6)个槽位占满时回收**最冷**的一条,所以用户正在动的容器总能保住轨。
- **所有退出路径收敛到 `retire`** —— 已卸载、尺寸归零、两轴都不再溢出、或被池回收。`measure` 对每一种都返回 `false`,调用方随即回收。这修掉了「残轨」这一类缺陷:旧 `update()` 里 `overflowY` / `scrollHeight` / 零矩形三处提前 `return` 会把上一次定位的轨留在屏幕上,而 `remeasure()` 对同样情况的处理与它们并不一致。
- **measure / position 拆分**(`measure` 冷路径,`position` 热路径)。`measure` 在第一次写之前就把各轴都读完 —— 矩形、`scrollHeight`/`clientHeight`、`scrollWidth`/`clientWidth`,以及解出的 `vScale`/`hScale`(每个滚动像素对应多少拇指像素),因此不会触发第二次布局。`position` 只读 `scrollTop`/`scrollLeft`,只写 `transform`。测量只由「盒尺寸真的可能变了」的路径触发:首次绑定、窗口尺寸变化、内容增删、指针移入、换皮肤(它们都置 `needsMeasure`,由 `measure` 清掉)。稳态滚动帧零布局读、零布局写。
- **滚动按帧合并**(`scheduleUpdate`)。帧内重新读池,而不是捕获某个 scroll 事件的目标,所以同一帧内滚动的两个容器都会被处理。旧的闭包捕获的是本帧**第一个**目标,其余全部丢弃。
- **程序化滚动的意图闸**。轨只为真实手势打开:`wheel`、`touchstart`、`touchmove`,或滚动按键(`SCROLL_KEYS`:方向键、PageUp/PageDown、Home/End、空格)落在 `INTENT_WINDOW_MS` 内。虚拟器占位写入、auto-follow、高度变形、焦点恢复不再闪出轨道。已经打开的轨不受此闸影响 —— 它只决定是否**打开**。
- **容器悬停唤醒,仅鼠标**(`pointerenter`/`pointerleave` 绑在容器上):悬停可滚动区域即显示其轨并重新测量,因为被抑制的轨可能持有过期几何。触摸与触控笔在接触时同样触发 `pointerenter`,故排除在外,否则每次点击都会闪一下轨。
- **单一移动 idle deadline**(`armIdle`),取代每个 scroll 事件的 `clearTimeout`+`setTimeout`:一次滚动突发只改写 `hideAt`,已装载的定时器重新检查并按剩余延时自我重装。闲时仍是拖拽把手 —— 轨淡为幽灵、拇指保持可抓 —— 但**槽位**在 `RELEASE_MS`(5s)后归还,池因此始终可用。
- **双轴比例拇指**。两种皮肤都按可见比例定拇指长度,下限 `MIN_THUMB`(24px)、上限为轨道;吃豆人字形走满轨,已吃豆串用 `scaleY(进度)` 使进度表达不产生布局。无溢出的轴拿到的是**零长**拇指而非满长 —— 满宽的条会读成「横向还有更多」。横向拇指(`.gfs-h`)与纵向一样是拖拽把手。
- **`stackZ` 不再按元素缓存**。祖先层级在运行时变化(提示条挂载、最大化面板升到 850、菜单打开),缓存的层级比产生它的状态活得更久,把轨画到了它本该跟随的遮罩之下。现在每次测量重走一遍。
- **观察器按槽位持有,随槽位一起释放**。`ResizeObserver` 同时观察容器与其直接子节点(转写多一个回合、虚拟器换行都不会让滚动容器本身改变尺寸),`MutationObserver` 观察直接子节点变动,两者都在 `retire` 里 `disconnect()` —— 于是被回收的槽位既不累积观察目标,也不钉住已脱离文档的子树。
- **常显偏好**(`scrollbar-skins.ts`:`readAlwaysShowScrollbar` / `saveAlwaysShowScrollbar` + `SCROLLBAR_ALWAYS_CHANGED_EVENT`,存储键模块内私有),在外观页与皮肤选择器并列一个开关。打开后轨出现即显示,并绕过 idle 闸。
- 契约测试:`test/floating-scrollbar.test.tsx`(16 例)覆盖轨池(两条同时在用、回收、观察器释放)、retract 收敛(不溢出、卸载、零尺寸)、热路径(零布局读;通过劫持 `style.setProperty` 断言只写 `transform`)、双轴比例拇指、意图闸、常显、闲时,以及不缓存的层级解析。
- **刻意不动**:系统滚动条仍全局隐藏(`gui-base.css`)—— 那是产品模型,而轨池正是修掉它代价的方式。轨池的代价是同时在用轨的上限为 6,超出即回收最冷的一条。
- **设置行标签规范下沉到 CSS;索引库开关补 knob;使用统计热力图流式自适应**(同轮,用户指出):① `.gui-settings-row > div:first-child { flex: 1 1 0%; min-width: 0 }`(gui-chat.css,嵌套规则)—— 行是 `flex-wrap: wrap`,裸标签 `<div>` 按描述的 max-content 计宽,长中文文案一溢出就把开关挤到下一行(浏览器与 Computer Use 各行);需要特例的行仍可用显式 flex 工具类覆盖。② 索引库两个开关与此前 MCP/信息状态条是同一个缺 `.gui-toggle-knob` 的问题(已补)。③ 使用统计热力图原为固定 11px 网格(~690px),宽面板大片留白 —— 现为居中的 `max-w-[920px]` 图,53 个周列分享剩余宽度(`flex-1`,上限 15px),单元格 `aspect-square w-full` 跟随列宽,月份/星期标签镜像列几何(星期行 `1fr` 拉伸),任意宽度下都对齐。

## 29. 会话排序:打开不得重排(2026-09-13)

- **`sessions.updated_at` 取最后条目时间,绝不取持久化墙钟**(daemon `view-store.ts` 的 `upsert`):侧栏一切排序(组内行序、日期分桶、文件夹先后)都吃 `updatedAt`,而它来自 view-store 的 `sessions.updated_at` —— 该列在**每次**快照持久化时都写 `Date.now()`。打开历史会话必持久化两次(activate 引导 + 闲置关闭 dispose 的无条件 upsert),于是**看一眼**旧会话就把它的时间戳刷成现在,会话直接跳到所在组/文件夹顶部(用户:从会话列表进入一个很早的会话会改变会话在列表的位置)。现改为 `max(entries[].timestamp, createdAt)` —— 真正的最后活动语义,与两个参照一致:openchamber 的 `time.updated` 是服务端最后**数据变更**(查看永不 bump);bitfun 的左栏排序注释明写 "does not use `lastActiveAt`, so rows do not jump to the top on click"(他们踩过同一个坑,`lastActiveAt` 只留给非排序面板)。物化快照缓存表保留墙钟新鲜度戳 —— 只有查询表变了。jsonl 合并路径(`listAllSessions` 的 mtime)本就是数据变更语义,不动。自愈:修复后首次持久化会把被污染的 `updated_at` 回落为该会话真实的最后消息时间。契约钉在 `view-store.test.ts`(打开型持久化不动 `updatedAt`;新消息才 bump;空会话回落 createdAt)。

## 30. 目标继续模式多选 + 导入自动归纳(2026-09-13)

- **声明了选项的数组设置渲染为多选芯片**(`SchemaSettings.tsx` + `settings-schema.ts`):`goal.continuationModes` 是 `type: "array"` —— TUI 对无 options 的数组直接隐藏(仅配置文件可见),GUI 则把所有数组渲染为逗号输入框,于是「目标继续模式」在 TUI 是列表、在客户端成了文本框。现 schema 键声明 `ui.options`(`interactive` —— 运行时唯一消费的模式,见 `interactive-mode.ts #scheduleGoalContinuation`;取消勾选即关闭目标自动继续),GUI 的数组分支对声明了成员的数组渲染按压芯片(TUI `MultiSelectSubmenu` 同构:点击翻转成员资格,存储值不在声明集合内时保留兜底芯片)。无 options 的数组维持逗号输入(扩展路径等自由列表)。
- **导入的会话在导入时自动归纳进可编辑的自定义分组**(`ImportSessionsSetup.tsx` + daemon `import.session`):daemon 的 `import.session` 现返回新会话 id(`imported.getSessionId()`);复制循环结束后,对话框把导入的 id 折进 `musepi-gui-groups` —— 每个工作区一个自定义分组(以文件夹基名命名,同名合并进既有分组),经 `musepi-gui-groups-changed` 事件让侧栏实时重读(storage 事件同文档不触发)。分组是普通 CustomGroups —— 可像任何手动分组一样重命名/换色/拖拽;普通(非导入)会话永不自动分组,分组 tab 底栏保持日期分组 —— 不与项目 tab 设计重合(用户:引导导入的会话自动归纳,正常使用不自动分组,且是可编辑分组而非空间)。

- **输入框模型菜单获得 openchamber 的 收藏/最近 结构**(`ModelSelector.tsx`):收藏与最近使用渲染为**可折叠分区**(每区标题带 chevron 与计数;折叠为菜单内会话态),替代此前收藏静默置顶;「最近」是新的 provider/id 键最近使用存储(`musepi-gui-recent-models`,上限 5,每次真实选择时压入),与收藏共用 external-store 形态。菜单带 openchamber 的键盘契约 —— 搜索框打开即聚焦,↑↓ 在**可见**行间移动巡游高亮(折叠分区跳过,鼠标悬停同步),回车选择 —— 列表下方钉住底部提示 `↑↓ 导航 · ↵ 选择`;搜索框上方另有可选的 添加新提供商 动作行,打开设置供应商页(自 `app.openSettings` 经 ChatView/Composer/WelcomeComposer 接入;无入口的选择器省略该行)。

- **已完成轮次的折叠头改为 openchamber 活动 行,并配默认状态设置**(guest-client `round-collapse.ts` / `transcript-content.tsx` / `Transcript.tsx` + 聊天设置):折叠头读作 `活动 · 更改了 N 个文件 +A/−R · 探索了代码库 · 运行了 N 条命令 · <预览>` —— 是「做了什么」的活动摘要,不再是时长 + 裸计数。冻结时长仍在其原有位置(最终回复下的已工作行),头部与计时不再重复。新增 `exploreCount` 统计 read/grep/glob/ast-grep/fetch/web-search/inspect-image 调用,支撑「探索了代码库」段;无更改/探索/命令的轮次回退到裸工具数。**折叠资格是结构性的**(openchamber `projectTurnRecords` parity),不再依赖时长:每个闲置的「用户消息→最后 assistant 回复」轮次只要含工具/命令工作就折叠,包括最后一轮已完成轮次;仅最后用户消息之后的活跃流式尾部保持展开,旧会话即使没有 daemon `roundDurations` 也能正确折叠。默认折叠状态成为设置项(设置 → 聊天 → 活动默认展开,`musepi-gui-chat-roundfold`,openchamber activityDefaultState parity):每轮的开关集合存的是**相对默认的偏离**(默认折叠时存展开轮,默认展开时存折叠轮),翻转设置即时重读既有轮次、无需迁移,单轮手动开关始终优先。

## 31. 自定义供应商按模型协议覆写 + retry_failure 卡片(2026-09-14)

- **自定义供应商编辑器支持按模型设置协议与工具能力**(`desktop-app/custom-provider.tsx` + daemon `server.ts` 的 `models.add`):每个模型行现已带「API 格式」选择器(`继承供应商协议` / `openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`)与「支持工具」开关。`models.add` 会把每个模型的 `api` 与 `supportsTools` 回写进 `models.yml`(显式值写入该字段;`null` 删除覆写以恢复自动;`undefined` 则省略)。切勿因单个模型把一个供应商整体改为某协议——同一网关下的其他模型可能用不同协议。已在 Cresc.dev / `gpt-5.6-terra` 上验证:Chat Completions 一旦带工具 schema 就会截断成空 SSE,而 `/v1/responses` 带工具正常,因此该模型需要的是**按模型** `openai-responses` 覆写,而非整供应商覆写。
- **模型能力优先于会话工具注册表**(`agent.ts` 的 `syncContextBeforeModelCall`):当 `activeModel.supportsTools === false` 时,请求上下文发送 `tools: []` 而非会话的工具目录。这避免有损的 OpenAI 兼容网关收到它们会静默截断成空停止重试循环的工具 schema。该覆写仅用于显式标记不支持的工具模型;支持工具的模型(或未解析的模型)保留完整目录。
- **终端自动重试失败现在会渲染真实的 transcript 卡片**(`turn-recovery.ts` → `session-context.ts` → `sdk/materialized-view.ts` → `guest-client Transcript.tsx`):此前终端空停止重试被从历史中丢弃、GUI 无任何条目,只留下空白/分支壳,只有 TUI 打印了错误。现 `turn-recovery` 会追加一条持久 `custom_message`(`customType: "retry_failure"`,`display: true`,`details: { attempt, providerEmptyOutput, outputTokens }`),并从后续模型上下文排除;`materialized-view` 同时把 `auto_retry_end {success:false}` 投影为单条 `retry_failure` 条目(幂等——若已存在则跳过,因此重载 + 实时事件不会重复);`Transcript.tsx` 将其渲染为红色错误卡片(`transcript.css` 中的 `tr-retry-failure` / `tr-retry-failure-chip` / `tr-retry-failure-message` / `tr-retry-failure-attempt`),显示「模型错误」、最终错误文本与重试次数——既非通用自定义 chip,也非 `branch_summary`。

## 32. 审批记忆、统一归档、会话工作树(2026-09-15)

- **托盘「始终允许」现在真的会持久化策略**(`electron/main.cjs` + `src/tray-menu-main.tsx` + `electron/tray.cjs`):托盘**两套界面**(原生菜单 + 自绘毛玻璃菜单)点批准时都发了 `remember: true`,而 `main.cjs` 的 `respond-approval` 分支只读 `approved`/`id`/`sessionId`——该字段被静默丢弃,按钮行为与「允许一次」完全一致。托盘 socket 新增请求/应答助手(唯一 id 经 pending 表结算;`traySend` 那个固定 `"tray"` id 的即发即弃通道仍承担状态推送),该分支现改为经 `settings.get`/`settings.set` 读-改-写 `tools.approval[tool] = "allow"`。审批包装器在**每次调用时**实时读取该记录(`wrapper.ts` → `settings.get("tools.approval")`),因此同一工具下次调用直接跳过询问、无需重启;必须做合并是因为 `settings.set` 会整体替换该记录。两套界面都必须带上 `tool`——它就是策略键。
- **统一会话归档 + 迁移**(`guest-client/src/lib/session-archive.ts`):桌面端写 `musepi-gui-archived`(`{sessionId, archivedAt, cwd}` 数组),而 guest/mobile 壳写 `musepi-collab-archived`(纯 `string[]`),于是同一个 daemon 在两个客户端上呈现**两份互不相干**的归档,清除站点数据会把全部会话「取消归档」,且桌面端三个组件各自直接操作 localStorage、还用了两个不同事件名。现在:单一 key(`musepi-sessions-archived`)、单一事件(`musepi-sessions-archived-changed`,并把两个旧事件名重新派发,让未迁移的监听者继续刷新)、一次性**读取迁移**(并集两个旧 key 并归一化两种形状),以及唯一的 React 绑定 `useArchivedSessions`(侧栏、头部归档动作、任务中心清理、guest 工作区视图共用)。旧 key 有意**保留在磁盘上、只是不再写入**——老构建仍读它自己的那份;若每次读取都回并旧 key,会把用户在这里取消归档的条目复活。订阅通知合并进一个 microtask,因为一次写入会派发三个事件而订阅者三个都监听。
- **「移至新工作树」从禁用桩变成真动作**(`GuiHeader.tsx` + daemon `worktree.create` + `utils/session-worktree.ts`):会话 ⋯ 菜单里原本是一个永久 `disabled` 的条目(`title="worktree unavailable"`),没有任何代码路径能启用它——daemon 侧根本没有工作树 RPC,只有 `musepi worktree` CLI(且它是对代理托管工作树做 `list`/`clear`)。但这条链路的两半其实都在:`git.worktree.add/list/prune`(`utils/git.ts`,已扩出 `createBranch` + `startPoint` 以表达 `-b <名> <路径> <起点>`——带 `-b` 时新分支与起点是两个不同 ref)与 `SessionManager.moveSession`(`agent-session.ts`),后者早已可经 `/move` 斜杠命令从任意客户端触达(它是 `handle` 支持的,故 daemon 的 `session.slashCommand` 会执行完整的 cwd 换根:重载设置、重载插件、通知配置/标题变更)。`worktree.create { cwd, branch?, startPoint?, createBranch? }` 返回 `{ path, branch, repoRoot, reused }`;工作树落在 `getWorktreesDir()`(`worktree.base` 设置 / `MUSEPI_WORKTREE_DIR`)下,**每个「分支 + 仓库哈希」一个目录**,因此两个项目可以同名分支。GUI 弹窗输入分支名 → 调 RPC → 执行 `/move <路径>` → toast 结果。复用判定基于**已注册**的工作树列表(磁盘上存在但未注册的同名目录会被报错,绝不删除),返回路径统一 `path.resolve`,使复用路径与新建路径完全一致。`git worktree add` 在 Windows 上要数秒——daemon 测试需显式 30 秒预算,而非 bun 默认的 5 秒。

## 33. 消息撤回/重试语义 + 最大化锚点修复（2026-09-15）

- **撤回（⤺，用户消息下方）现在定位到父节点**（`ChatView.tsx` `rewindFromUserMessage`）：此前 `session.branchAt` 传的是用户消息**自身**，该消息仍留在激活路径上。用户反馈的语义是「回退到撤回处的上一节点」——对用户消息即其父节点，消息本身也随之退出激活路径（区别于 onEdit：保留节点并回填文本；也区别于重试：保留节点并重新作答）。被弃用的尾段作为兄弟分支留在树上（地图/轨迹仍显示），不做截断。重试（重试＝对同一用户消息节点发起新一轮尝试）语义原本就正确，未改动。
- **最大化锚点改为会话列而非 surface**（`ChatView.tsx` `.gui-chat-column` + `ContextPanel.tsx` 测量副作用）：`.gui-chat-surface` 是整张圆角应用卡片，**内部还包含面板与 rail**，所以用它的矩形做最大化会把 rail 一并吞掉；而 `.gui-pane-maximize-backdrop` 原本是 `fixed` 全窗口（顶栏以下）的 48% 变暗层，把会话侧栏和 rail 一起压暗（即用户反馈的「除顶栏外一层阴影遮罩」/「左面板与顶栏色差」）。现在浮起的面板与遮罩都取测量到的会话列矩形（`--pane-max-*` 同时写到两个元素，遮罩加 ref），最大化只压暗聊天卡片，侧栏与 rail 保持可见可点。
- 仍待实跑复验：开多个 tab 后最大化（rail 可见可点、变暗只覆盖聊天卡片）；树中部用户消息上点撤回（其后消息从会话消失、地图/轨迹节点数不变、撤销跳回可恢复）。
- **2026-09-24 更新——撤回链路改为 daemon 推送驱动**：① 客户端不再自行解析父节点：`rewindFromUserMessage` 把用户消息**自身** id 传给 `session.branchAt`，daemon 的 user→parent 映射（`navigateTree` 把 leaf 落到 `parentId ?? null`）同时覆盖普通情形与撤回到根（首条用户消息 → `resetLeaf`，`editorText` 回填原文）。原先客户端对 null parentId 的拦截（RPC 未发出就 toast「分支切换失败」）已移除；返回 `leafId` 为 null 时客户端钉 `"root"` 哨兵（与 `role:timestamp` view key 无碰撞）。② `session.branchAt` 成功后现在会广播一条写进 journal 的 `session_leaf_moved` wire 事件（`packages/wire` 的 `AgentEvent` 成员；走 `publishWireEvent`，seq 即 journal seq，`session.catchup` 可重放）——此前该 RPC 静默移动 leaf，而 GUI store 只从事件流学习，永远渲染撤回前的快照。`GuiSessionStore` 经 `onLeafMoved` hook 处理：`session.resume` 重取快照 → `reloadFromSnapshot`（水位对齐快照 cursor、清 reorder/gap 状态、保留 store 身份使 jumpBack dock 存活）。③ 消息流激活路径过滤去掉「须已分叉」前提：改为显式 leaf pin + `leafWalk.complete`（拓扑不可信的断链仍整体禁用过滤），线性会话撤回后尾段立即消失，不必等分叉存在。④ `TurnHeader` 移除「第 N 轮」编号（窗口相对下标，长会话/翻页/分支下必然与导航条的 daemon 全量 `session.turns` 计数不一致）；轮次导航条是唯一权威计数。
- **树操作共用一个守卫（`runTreeOp`，2026-09-24）**：重试 / 撤回 / switchToNode（分支切换）/ forkFromMessage 在 `ChatView.tsx` 里都走同一段「运行中确认 → 停止 → `waitWorkingCleared` → 执行」。收敛路径铁律（branchAt 必须等在途回合真正收敛后发出）现在同样覆盖分叉与节点切换——在途回合下分叉会截取到飞行中的快照。纯导航（`requestJump`）依旧不设守卫。会话地图右键菜单建立在其上：跳转是唯一无守卫项；切换到此分支/重答/分叉分别经 `switchToNode`/`runTreeOp`/`forkFromMessage` 继承守卫（§24）。

## 34. 输入与窗口陷阱：输入法合成态、任务栏缩略图、听写、回退横幅（2026-09-17）

- **输入框的合成状态标志必须能自愈**（`packages/desktop-app/src/components/Composer.tsx` 的 `composingRef`）：合成期间 `onKeyDown` 对任何按键都提前返回，该标志在 `compositionend` 释放——但合成被**中断**时这个事件根本不会触发（切窗、取消候选、Esc、渲染进程重载）。于是标志永久为真：之后再按 Enter 全都石沉大海，而鼠标点「发送」绕开键盘路径照常可用，只有重启能恢复（用户报的「挂后台一会儿 Enter 就失效」）。现在三层兜底：失焦/获得焦点即清零（失焦必然终止合成）、`compositionupdate` 负责续期、而一个既不是 `keyCode 229`（Chromium 对合成中按键的标记）又不在 `isComposing` 的按键判定标志过期并清零。Enter 不参与最后这条规则，因为 WebKit 会在 `compositionend` **之后**补发 keyCode 13 的确认 Enter。
- **未闭合项——中文输入开头吞字**：尚无复现，未定案。已排除：受控值滞后（无 `useDeferredValue`/防抖，`onChange` 里 `value={text}` 同步更新）、草稿回填（`use-draft-persistence.ts` 的还原只以 `sessionId` 为键）、全局按键监听（app.tsx 只处理 ⌘/Ctrl 组合）、按住空格讲话（不存在该功能）。要想钉死，需要提供：用的是哪款输入法（微软拼音/搜狗等）、是否只在**冷启动后的首次**合成出现、丢的是**拼音字母**（从未上屏）还是**已上屏的汉字**。
- **Windows 任务栏缩略图全白**（`electron/main.cjs` 的 BrowserWindow）：不设 `backgroundColor` 时 DWM 窗口初始表面是白色，Aero peek 画的就是这层初始表面而非页面内容；现设为 `#1e1c1a`，与应用的深色背景一致。（#6）
- **听写返回空 PCM——「要点两次」**（`lib/voice.ts` 的 `recordPcm`）：它一开始录音就 resolve，调用方拿到的只是最初几毫秒缓冲的内容（通常是空的），设置里的 `vadEndMs` 也从未生效。现在 VAD 静音、时长上限、手动停止三条路径统一汇入一个 `finish()`：组装完整 PCM、断开音频图、关闭麦克风后才 resolve；在 `getUserMedia` 尚未返回时就取消的场景由 `onaudioprocess` 内部关流，麦克风指示灯必定熄灭。（#9）
- **回退横幅属于会话状态**（`ChatView.tsx` 的 `jumpBack`/`jumpDockOpen`）：它的 undo 目标是**上一个会话**的叶子，切换会话后再撤销会把外来节点 id 发给 `session.branchAt`（"branch failed"）。现在会话切换与任何显式节点跳转（面包屑/树）都会清空它（其 undo 目标正是刚被跳走的叶子），并新增 ✕ 关闭：只收起横幅、**停留在当前回退位置**，兄弟分支仍可从面包屑与行内动作回到。（#12）
- **含糊的 issue 先分诊、不臆测**：不少条目开头只是一句话现象（#7 最初报「第一条消息就 429」，实为 Cloud Code Assist 网关把开场的 `<system-conventions>` XML 块判成滥用；上面那条中文吞字也是同一形态）。先记录假设、补齐能区分根因的事实，再动手——没复现就补补丁，正是把回归带进版本的常见方式。
- **文件编辑器要点**：预览体必须保持子块所依赖的 flex 列布局（`gui-chrome.css` 的 `.gui-filepane-preview-body` → `display:flex; flex-direction:column; flex:1; min-height:0`），否则自动撑高的 textarea 会把保存工具栏顶出面板；保存按钮还必须接 `FilePane.tsx` 里真实的 `saving` 状态，而不是常量 `false`。

## 35. 语音输入第二轮：中文简繁归一、单相位听写状态机、输入框内波形反馈（2026-09-20）

- **Whisper 中文输出繁体——解码后用 OpenCC 归一**（`packages/coding-agent/src/stt/zh-hans.ts` + `asr-worker.ts`）：内置的 `onnx-community/whisper-small` q8 对 `zh` 偏向繁体（其中文训练语料偏台湾），而 transformers.js 与 sherpa-onnx 都没有 decoder prompt 可偏置文字方向，事后转换是唯一可靠修法。`normalizeChineseScript(text, language)` **仅在 language 钉住 `zh*` 时**执行 OpenCC `t→cn`（zh-CN 界面会自动播种 `language:"zh"`；TW/HK 用户用 auto 可保留繁体），懒加载 `opencc-js`（约 1 MB 词典，首次中文转写时才加载），加载失败降级为原文。调用点包住 `asr-worker.ts` 两条引擎路径的 `decodeSegment` 返回（批量与流式共用同一收敛点）。单测：`packages/coding-agent/test/stt-zh-hans.test.ts`（转换、简体/英文/未钉语言透传、空串安全）。
- **双布尔失步——听写改单相位状态机**（`components/composer/use-dictation.ts`）：旧的两个 composer 各自维护 `dictating` + `transcribing` 两个布尔，点停止时两个 flag 同时清掉、而 transcribe RPC 这时才开始——整个转录等待期渲染成 idle（「按钮的反馈先结束、文字才凭空出现」）。`useDictation` 建模单相位 `idle → recording → transcribing → idle`；recording 中 toggle 乐观进入 transcribing，而 transcribing 中再 toggle 会真正调 `cancelActiveDictation()`——修掉旧代码「只清 UI、在途转录结果照样落进输入框」的泄漏。Esc 在任意非 idle 相位取消（document 捕获阶段），卸载同样取消，`optsRef` latest-ref 模式让回调始终读到最新 props 而不重建会话。`Composer.tsx` 与 `WelcomeComposer.tsx` 消费同一 hook（重复的 flag 逻辑已删除）。
- **麦克风按钮只承动效，文案移进输入框**（`composer/action-buttons.tsx`）：`VoiceStatusStrip` 位于 textarea 上方，包含 13 根真实 RMS 驱动的波形、多层声环、录音时钟/转写状态、预留的临时文本区和 Esc 提示，不播放自主循环波形；减少动态效果时保留静态等价信息。样式在 `gui-composer.css`，反馈经 `role="status"` / `aria-live="polite"` 播报。
- **流式与机主门控共用 daemon 前端**（`lib/voice.ts`、`voice/frontend/*`、`stt/stt-controller.ts`）：桌面 PCM 块经 `voice.frontendStream*` 进入前端；`partial` 只更新预览，接受或灰区分段才插入文本。任一灰区分段都强制审阅并禁止自动提交，拒绝的音频不会进入 ASR。`strict` 只接受已确认语音；`off` 保持原 ASR 与提交触发行为。ASR 回调按分段 id 绑定，待推理队列最多四段，取消后迟到事件失效。TUI 在 `off` 下沿用原 ASR 流，其余模式共用前端。
- **前端性能与降噪回退**：每段只取前三秒计算机主嵌入，完整音频仍交给 ASR。可选 DPDFNet 仅在估计峰值/噪声底比值低于 6 时运行，高信噪比语音保持原样，避免清晰语音被降噪损伤。真实 win32/x64 验收（18 个逻辑 CPU）记录前端 RTF 0.118、尾部 P95 488ms、干净语音相对 CER/WER 均为 0、旁人自动提交为 0；日志不含转写或声纹向量。
- **声纹录入与本地模型生命周期**：`voice.speaker*` RPC 在当前 agent 目录只保存归一化向量与阈值，不保存原始录入音频。四段有效录入加独立验证后原子提交档案，取消或失败保留旧档案。`stt.modelDelete` 与 `tts.modelDelete` 拒绝非法键和下载中的删除，先停止所属 worker，再只删除注册表解析出的缓存目录。设置页使用精确的 `Speech` 分组，缓存行提供确认删除，且当前页面不会立即自动重新下载。

## 36. 画板：点击 chip 编辑的是 A0，而不是 A1 的粘贴副本（2026-09-20）

- **画板的真实内容是笔画列表，所以「完成」现在同时交出一份 scene**（`components/SketchPad.tsx` + `lib/sketch-scene.ts`）：过去完成只导出 PNG，而点击 chip 又把那张 PNG 当底图挂回去——每一笔、每个图形和文字全部融成**一张位图**，再编辑只能在图上涂（「粘贴了图片而已」），任何一处旧细节都改不回来。现在 `SketchPad` 接收 `initialScene`，并以 `onDone(dataUrl, scene)` 交出场景；composer 把 scene 挂在 chip 上（`ComposerAttachment.sketchScene`），点击 chip 即恢复**笔画**——每个对象重新可选、可拖、可缩放、可擦除；再次「完成」是像素与 scene 一起换，来回编辑多少次都不退化。场景格式 `{ v: 1, w, h, strokes }`：`w`/`h` 是当初作画的板面尺寸，`sceneStrokesFor(scene, w, h)` 把笔画等比缩放进即将渲染的板面（尺寸变化 >1% 才视为真正的缩放；压力值原样透传，线宽随同一系数走）。序列化时量化（坐标 0.1px、压力 0.01）——这是让复杂画板不进 MB 级的关键。
- **恢复不进 op、也不置 `dirty`**：恢复出来的是画板的**开场内容**而非用户动作——Ctrl+Z 不能把它删掉，未改动的画板关闭也不能弹丢弃确认。笔画 id 从恢复集之后续号（`nextStrokeId`），因为两个节点共用 id 会让橡皮与选择工具命中错误对象。
- **有 `initialScene` 时抑制整图导入**（导入 effect 的条件是 `src && !initialScene`）：否则会把 chip 自己的 PNG（含导出时烤进去的主题底色）叠在活笔画之上。
- **scene 经 `strokesRef` 镜像读取，不读渲染闭包**（`finish`）：快照发生在 `closeTextEditor()` 之后约 80ms，刚提交的文字标签还没进到那一帧的 `strokes`——那样会出现「PNG 上有字、存下来的 scene 里没有字」。
- **场景持久化是刻意的尽力而为**：`attachmentDraftPayload` 仅当 `sketch && !sceneHasImage(scene)` 且整体载荷在 1.5MB 预算内时才带 scene；超预算或场景内含导入图片（会再带一份全尺寸 base64）时只丢 scene、保住 chip——否则一次配额错误会把整份草稿一起丢掉。无 scene 的 chip（恢复的草稿、改动前数据、lightbox 里来的普通图片）回落到旧的整图重开路径，不会退化成「打不开画板」。
- **`parseSketchScene` 是存量数据的闸门**：版本未知、步长不对（钢笔笔画被截成非 3 的倍数＝最后一点丢了压力值）、坐标非有限，都只丢**那一条**笔画，其余整板保留。NaN 一旦进入 Konva 会让节点整块空白，所以序列化也绝不写出非有限坐标。单测：`packages/desktop-app/test/sketch-scene.test.ts`（各步长往返、量化、垃圾拒绝、等比缩放、压力透传）。

## 37. 文字标签是一个盒子而非锚点：随文本自动增高，且与图形一样可缩放（2026-09-20）

- **文本笔画现在持有真实矩形——`[x, y, w, h]` 而不是 `[x, y]`**（`lib/sketch-geometry.ts` + `components/SketchPad.tsx`）：旧实现只存一个锚点，宽度每次渲染都由 `label.length * fontSize * 0.62` 重算，于是一整句话永远是单行、直接冲出画板、高度永不增长。现在 `textAutoBox(size, label, boxW)` 把文本交给 `wrapTextLines` 量一遍后返回适配的 `{ w, h }`，高度为 `行数 × textFontSize(size) × 1.25`。`textLineHeight` 是唯一的行高来源：Konva 节点以 `wrap="word"` + 同一个 `1.25` 渲染，所以「画出来的文本」与「量出来的盒子」不可能对不上。**宽度策略与度量来源在 §38 定稿**（`0.62` 估算与「回缩到最宽行」都已被取代——前者截断中文，后者会丢掉用户拖出的宽度）。
- **标签与其他对象共用角手柄**（`SketchPad.tsx`）：缩放手柄层过去用 `selected?.tool !== "text"` 把关，这就是文字唯独不能缩放的原因。现在 `strokeExtent` 给文本与图片相同的 `{x, y, w, h}` 分支，`scalePoints` 对其原点做仿射、对边长乘原始因子，`shiftPoints` 只移原点——文字因此走的是与图形**完全相同**的拖动/缩放/擦除代码路径，没有一处文字专属的缩放数学可供漂移。**注意这个闸门有两处**（渲染层与 `onPointerDown`），§38 记录了只删一处导致「手柄能画、拖不动」的教训。
- **编辑改为双击**（单击标签过去会直接打开插入符，让文字成了唯一拖不动的对象）：现在首次点击与任何对象一样是选中＋拖动，`onDblClick` 才在该标签自身的盒子上重建 `<textarea>`（`textEditor` 带 `w` 与 `pinned`，既有标签取 `points[2]` 并钉住、新建取 `TEXT_DEFAULT_W` 且自适应）。`closeTextEditor` 对插入与编辑两种情形都把量好的盒子写回 `points`。
- **编辑浮层真正会换行增高**（`styles/gui-composer.css`）：`.gui-sketch-text-input` 为 `min-width: 60px` / `max-width: min(420px, 90%)` / `max-height: 60vh`，配 `white-space: pre-wrap` + `overflow-wrap: break-word`（原为 `white-space: pre`、90px 下限、320px 上限）——浮层随输入字符增高，而不是让一行无限横向滚下去。
- **旧的两位数字标签原地迁移**（`lib/sketch-scene.ts`）：`expectedPointCount("text")` 改为 4，`parseStroke` 用 `legacyTextBox(x, y, label, size)` 升级存量 `[x, y]`——此处**必须先清空 `points` 再 push**：把 4 数盒子追加到已有的 2 数锚点会得到 6 数的 `[x, y, x, y, w, h]`，之后每一次 `strokeExtent` 都会读错角点。`strokeBox` 去掉了 `text` 参数：文本与图片一样返回自身矩形，不加 padding。单测：`test/sketch-geometry.test.ts`（`textAutoBox` / `wrapTextLines` / `textFontSize` / 四数 `strokeExtent` / `scalePoints` ×2）与 `test/sketch-scene.test.ts`（四数往返、旧锚点迁移）。

## 38. 文本度量来自画布，而不是估算（2026-09-20）

- **`0.62` 的字宽估算把每一条中文标签都截断了**（`lib/sketch-geometry.ts`）：盒宽用 `字符数 × 字号 × 0.62`，那是拉丁文的平均值。汉字步进约 1.0em，宽了约 1.6 倍——六个 24px 汉字「估算」出 89px，实际占 ~144px。于是盒子被夹到 `TEXT_MIN_W`，Konva 把标签画成只露前三个字（用户反馈：「我输入了六个字了但文本框只显示三个」）。现在宽度取自**真实画布度量**：`measureTextWidth(text, fontSize)` 持有一个懒创建的后台 2d context 并调用 `measureText`——这正是 Konva 自己的 `Text._getTextWidth` 经由 `Shape.js` 那个唯一的 dummy context 所做的操作，所以盒子和实际绘制出的行从构造上就一致。`wrapTextLines` / `textAutoBox` / `caretWrapWidth` 接受可选的 `TextMeasure`，几何模块因此保持无画布、可单测（测试注入模拟真实中英比例的桩）；不传则回落到旧估算，供迁移路径使用。
- **文字要在「两处」按工具把关的地方都补上**——渲染层**和** `onPointerDown`：上一轮从手柄渲染条件里删掉了 `selected?.tool !== "text"`，却在缩放拖动分支里留下了同一个闸门，于是角手柄画出来了、拖了却毫无反应（命中后 `scaleRef` 没被赋值就返回了）。今后任何按工具的把关都必须从这两半同时移除，否则手柄只是装饰。
- **用户选定的宽度是指令，不是提示**——`textAutoBox` 把 `boxW` 同时当作**下限**与换行上限。只有某一行真的放不下（一个不可断的长词）才会超出它，因为那时截断会藏起字形。若回缩到最宽行，就会静默丢弃一次刻意的缩放：把盒子拖宽、重打两个字，宽度就没了。
- **`caretWrapWidth` 是三个表面唯一的宽度策略**（编辑浮层、虚线选中框、提交）：**钉住**的宽度（`textEditor.pinned`——重编辑既有标签，或拖过角手柄）原样保留；未钉住的（全新建的插入符）自适应到最长一行，**上限为 `TEXT_DEFAULT_W`**。没有这个上限，长句子会不断把自己的盒子撑宽而永不换行——那正是「盒子不跟文字走」这个 bug 换了张皮。一个表达式、三个调用点，所以插入符换行的位置就是标签将要换行的位置。
- **文字标签按字断行，而不是按词**（`wrapTextLines`）：中文没有空格，只按词切分会让整句中文永远停在一行。`segmentWords` 保留拉丁词完整、在中文字之间断开，并把连续空格挂到它**前面**的单元上（这样换行后的行不会以造成断行的空格开头）。超长的单词独占一行，与 Konva 的 `wrap="word"` 一致。
- **字体是一个共享常量，画布字体每次调用都要设**：`TEXT_FONT_STACK` 同时交给 Konva `Text` 节点的 `fontFamily` 与度量的 `ctx.font`，`.gui-sketch-text-input` 在 CSS 里用同一栈——浮层此前解析的是 `font: inherit`（composer 的字体，不是标签的），所以一提交就能看出文字重排。度量在无画布时（单测，或 `getContext` 缺失的桩 DOM）降级而非抛错：在那里抛错会让整个画板在提交时崩掉。
- **`measureTextWidth` 会在渲染中被调用，所以必须便宜**：context 只创建一次，且每次度量后恢复原先的 `ctx.font`——这是「一次按键」与「一次卡顿」的区别。

## 41. 设置壳层:槽位替换退役聊天列覆盖层(2026-09-24)

- **设置壳层改为复用主布局**,不再覆盖聊天列(`.gui-settings-host` 退役):壳层激活期间,设置导航填入应用侧栏槽位、内容填聊天列。`app.tsx` 渲染 `<div id="gui-settings-nav-slot">` 作为侧栏槽位替身;`SettingsView` 在 layout effect 里按 id 发现它并把导航列(现为受控组件 `components/SettingsNav.tsx`)**portal** 进去——单一状态持有者、两个挂载点。导航列在槽位内 `w-full`,设置导航继承侧栏可调宽度的宽度语言。
- **Keeper 而非卸载**:真实 `SessionSidebar`(`.gui-side-keeper`)与聊天列 header + surface(`.gui-chat-col-keeper`)在壳层激活期间保持挂载、仅 display:none——与 alt 页面已有的 `.gui-chat-keeper` 同一契约。关闭设置即恢复;CSS 动画会重播,因为 `display:none → flex` 会重启 `gui-view-blur-in`。150ms 的 `leavingSettings` 窗口让壳层挂到 blur-out 播完(导航槽用 `.gui-slot-leave`;聊天包装层复用 `.gui-view-leave`——它的 `flex:1` 会把导航槽横向撑大,所以单独立类)。
- **决策表**:`src/lib/settings-shell.ts`(`computeSettingsShellState`)是 app.tsx 渲染所依据的唯一决策点;`test/settings-shell.test.tsx` 钉死 open/leaving/closed 三态表与导航的受控点击→`onSelect(id)` 链(用户报的「点击扩展不切换」就死活在这条链上)。
- **玻璃层只能有一层**:`.gui-settings-view` 与 `.gui-settings-nav-slot` 均为 `background: transparent`——`.gui-main` 已涂刷工作区唯一的 scrim 层(`.gui-sidebar` 是同一先例)。设置表面再刷一遍玻璃配方等于在 `.gui-main` 的 88% 之上又叠 88%,设置壳层看起来就比主界面深(设置/主界面色差,2026-09-24 修复)。导航与内容之间的视觉分隔由 `.gui-settings-surface`(圆角卡片)承担,不靠面板级背景。
- **坑——Windows 上做交互实测**:Electron 后台窗口的 timer 节流(窗口隐藏一段时间后 1 次/分钟)会让任何等待页面 `setTimeout` 链的 CDP 探针看起来像挂死。探针实例要带 `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows` 启动(`scripts/cdp-settings-probe.ts` 走原生 CDP WebSocket 发 Runtime.evaluate;完整 open→switch→close 证据见 2026-09-24 任务报告)。

## 42. web_search 工具卡:结构化失败、实时进度、显示名(2026-09-27)

- **`SearchRenderDetails` 新增两个 wire 字段**:`providerLabel`(provider 显示名——`response.provider` 原始 id 是 `mojeek` 这类配置语法,不是 UI 文案)与 `progress`(`{ current, failed }`,仅出现在链路中途的流式 update 上)。两者都由 `packages/coding-agent/src/web/search/index.ts` 的 `executeSearch()` 填写;GUI 渲染器(`client-core/src/tool-render/tools/web-search.tsx`)优先用 `providerLabel`,对旧 daemon 回落到 id。
- **失败渲染成卡片,不是文本转储**:daemon 的 `Error: …` 内容文本是给模型看的。GUI body 以 `details.error` 为门,渲染 `Note tone="err"`(本地化标题 + 详情),完全跳过 `ResultText`——旧的 `{errorMsg && !resultTextOf(result) && …}` 条件是死代码,因为失败结果的内容文本永远非空。host 暴露 `openSettings` 时,卡片附一个跳到提供商设置区的按钮。
- **链路中途进度走标准 tool-update 通道**:`executeSearch()` 每次尝试 provider 前发一个 update(`details.progress` + `Trying <label>…` 内容行)。TUI 渲染为带框的「Trying X」面板并列出已失败的 provider;GUI 把内容行显示在卡片实时流区域(`session-store` 的 `partialResult` → `ToolCard` 的 `partial`)。GUI 进度路径无需改动渲染器——只需 daemon 发事件。
- **`ToolRenderHost.openSettings?(section?)`** 是第四个 host 能力(继 openAgent/sendPrompt/saveImage 之后):ChatView 把它接到 app.tsx 的 `openSettings`(两处调用点都接),任何工具卡都能提供「去设置里修」跳转。没有设置界面的 host 不实现它,按钮自动隐藏。
- **有序数组设置在 GUI 可编辑**(`ui.ordered: true`,如 `providers.webSearchOrder`):`SchemaSettings` 把已选 chip 按存储顺序排在前面(位置 = 优先级)并附 ←/→ 移动按钮(`lib/ordered-options.ts`,与 TUI ordered-multiselect 对齐);无序数组保持原先的声明序 chip 开关。

## 43. 技能市场安装状态机(2026-09-27,roadmap M2-2.2)

- **`skills.marketplace.install` 升级为状态机驱动、非阻塞**:RPC 校验参数后立即返回 `{ ok, installId }`,进度与终态经全局广播事件 **`marketplace.install.state`** 推送(载荷 = `{ type, at, ...view }`,`view` 为 `{ installId, source, slug, repo?, name?, state, kind?, message?, scripts?, stagingDir?, startedAt, updatedAt }`)。理由:旧的阻塞式在 15s RPC 超时内装不完大包,失败也只有一条裸文案。**Breaking**:响应不再携带 `{ name, dir }`。
- **状态枚举**:`inspecting → downloading → verifying → (awaiting-approval) → installing → done`,任何进行态可到 `failed { kind: network | script-declined | invalid | conflict | unknown }` 与 `cancelled`。三条恢复契约:断网在下载阶段归类 `failed{kind:"network"}`(重试 = 从头安装,不做断点续传——zip 与浅克隆都是秒级小载荷);取消(见下)清理全部半成品 staging/目标路径;安装内容含可执行脚本(`.sh/.bat/.cmd/.ps1/.exe/…` 扩展名或 `package.json` install hooks)时暂停在 `awaiting-approval` 并附文件清单——`skills.marketplace.approve {installId, approve:true}` 继续,`approve:false` 落为 `failed{kind:"script-declined"}` 且不落盘(有意选 failed 而非 cancelled:用户明确否决了安装)。
- **新增 RPC**:`skills.marketplace.status` → `{ installs: view[] }`(进行中在前,终态记录新→旧,上限 20);`skills.marketplace.cancel {installId}` → `{ status: "cancelled" | "not-running" }`(受理 = 终态事件随后到,与 dsh `cancelInstall` 同语义);`skills.marketplace.approve {installId, approve}` → `{ ok }`(仅 `awaiting-approval` 态有效)。实现:`src/skills/marketplace-install-machine.ts`(daemon 侧每笔安装一个记录,staging 落 `mkdtemp("musepi-mkt-")`,abort 接进 `fetchBytes`/`shallowClone`);事件广播经 `MarketplaceServiceDeps.onInstallState` → `EventService.broadcast` 接线。
- **GUI 接线(`SkillMarketView`,最小实现)**:安装点击拿 `installId` 并锁卡片;视图级 `rpc.addEventListener` 按 installId 过滤 `marketplace.install.state` 推进状态行(`skill market install progress` 提示 + 取消按钮;`awaiting-approval` 时渲染批准/拒绝/取消)。终态收敛:`done` → 既有回读 + 提示,`cancelled` → 提示,`failed` → 语义文案(`kind:network` 与 `kind:script-declined` 各有专属字符串)+ 重试按钮。卡片角标在安装中变为可点取消。i18n key 落 client-core 的 `general` 域(zh + en)。
- **边界**:插件商店(`marketplace.install`,本地注册表走 `MarketplaceManager`)与裸 `skills.install`(添加技能对话框)是独立链路,本次不做收敛——状态机只覆盖远程技能市场路由。

## 44. Agent 浏览器接管:托管浏览器成为桌面端默认(2026-09-27)

- **新 RPC `browser.managedBridge { url: string | null }` → `{ url }`**:桌面 GUI 上报它本地 CDP 桥**实际**绑定的端口(9230-9239 是重试区间,`browser.guiUrl` 的 9230 默认值经常不对);`url: null` 表示撤销。登记落在 `packages/coding-agent/src/tools/browser/managed-bridge.ts`,是**连接级运行时状态**——`DaemonServer.dropGlobalEventTarget`(unix socket 与 WS 两条传输共同的关闭钩子)会撤销该连接的登记,所以 GUI 一走就不会留下一条把 agent 指向死端口的陈旧登记。端点只接受回环 http(s)(`normalizeManagedBrowserUrl`,取 `origin`),远端 CDP 一律拒绝。
- **`browser.gui` 的判据是两半**(`managedBrowserEnabled(settings)`):显式配置过的设置恒优先——包括 `false`;只有**没配置过**时才回落到「本进程里有没有活着的桥」。把默认值写进 settings 的方案被否:① 会把「此刻开着桌面应用」这个瞬时事实固化;② 无法区分「从未配置」与「显式关过」(`Settings.isConfigured` 能)。它之上的优先级不变:`app.cdp_url`/`app.path` > relay > `browser.cdpUrl` > 托管浏览器 > 无头。
- **`settings.get` 回传实际生效值**:桥活着且没存过值时,`browser.gui` 回答 `true`,设置开关显示的是 agent 真正会用的通道,而不是在活通道上显示关闭。点关会写入显式 `false`,解析随即尊重它。
- **提示词按通道注入**:`browser.md` 新增 "Managed browser channel" 条目(页面在面板里可见、`computer` 看不到它们),`computer.md` 新增「内嵌页面在这里不可见」规则,两者都在 `{{#if managedBrowser}}` 之后——CLI/TUI 场景永远看不到这段应用内浏览器文案。`BrowserTool.description` 与 `ComputerTool.description` 经 `prompt.render` 传入该标志。
- **GUI 侧**:`lib/managed-browser-bridge.ts` 订阅托管浏览器宿主 store(主进程经 `wireHost` 推送 `port`),按 (rpc, port) 去重后推给 daemon——宿主状态每秒变好几次。在 `app.tsx` 与其它 rpc effect 并列接一次。`browser.managedBridge` 已加入 `REQUIRED_DAEMON_METHODS`,让「同版本号但代码陈旧」的 daemon(dev/工作区场景)重启,而不是静默缺了这条接管链路。
- **设置 → 浏览器**在运行状态下拆成两条通道:「托管浏览器桥」(实际绑定端口 + agent 标签页是否存在,直读渲染端宿主 store,与右栏面板同源)与「共享无头浏览器」(原 `browser.endpoint` 行);新增可编辑的 `browser.guiUrl` 与通道优先级说明。`BrowserGuiHint` 改为首次打开浏览器面板即触发(不必等 agent 先跑一次无头调用),文案改为与通道无关的中性表述。
## 45. 查找栏 / 撤销 toast / 面板增量（2026-10-02，openchamber v2.1.0 parity）

设计侧：`gui-design.md` §5x。三件低风险吸收，未触碰布局模型。本节末尾的工具链陷阱
耗时最多 —— 动下列任何文件前先读。

### 45.1 `session.search` 新增 `sessionId` 作用域

`ViewStore.search(query, limit = 50, sessionId?)` —— `packages/coding-agent/src/daemon/view-store.ts`；
`ViewStoreService.search(params: {query?, limit?, sessionId?})` 负责透传。

**为什么这个作用域是必需项而非优化项。** ⌘F 只搜一个会话，而 `session.search` 是带 `LIMIT`
的跨会话 `LIKE`。没有作用域时，**别的会话**的命中会吃掉 limit，把当前会话的结果饿死 ——
而串进来的命中比查不到更糟：那一行的 `timestamp` **就是** transcript 的跳转键，所以一个
外来命中会滚到错误的行，或者根本滚不到。未知 `sessionId` 必须返回 `[]`，绝不能退化成
无作用域搜索（断言见 `test/daemon/view-store.test.ts`）。

### 45.2 复用 `requestJump`；不要造第二条「把消息露出来」的路径

`ChatView.requestJump(timestamp)`（`ChatView.tsx`，约 2055 行）已经是「把这行放到屏幕上」
的唯一属主。它会翻历史分页直到目标条目出现、在目标早于压缩点时展开折叠，然后
`virtualizer.scrollToIndex(…, {align:"center"})` 并闪烁该行。TurnRail、消息树画布、
轨迹图全部走它。

**因此查找栏完全不持有任何滚动几何** —— `ChatFind.tsx` 是纯展示组件，把 timestamp 交回
调用方。若你后续加「复制消息链接」（§46 待办），也走这里；第二条路径必然在分页与压缩
两个 case 上漂移。

它声明在查找块**之后**，所以查找块通过 `requestJumpRef.current`（一个在 effect 里赋值的
ref）触达。保留这个间接层 —— 反过来做就得把 `requestJump` 移到 `loadOlder` 之上。

命中顺序：daemon 按时间倒序返回，所以 ↑ 朝当下走、↓ 回溯历史。查找栏只在**选中项的
timestamp** 变化时跳转，而不是随 query 变化，因此打字时不会每个按键都拽一次视口。
仅靠 debounce 不能给 RPC 排序 —— 单调 token（`findTokenRef`）负责丢弃已废弃 query 的
慢响应。

### 45.3 Action-toast store：为什么归档不需要确认对话框

`packages/desktop-app/src/lib/action-toast.ts` —— 纯模块状态 + 监听集（视图侧用
`useSyncExternalStore`），对齐 `lib/update-ux.ts`。**刻意不用** session store 的
`notices`：那些由 daemon 推送，而 GUI 本地的撤销必须是同步的。

**归档是 localStorage 列表编辑**（`client-core/session-archive.ts`：`archiveSession` /
`unarchiveSession` 是纯列表变换），所以反向操作零成本 —— 无需 RPC 回滚，无需确认对话框。
这正是两个归档入口（侧栏行菜单，以及「归档并立即跳走」的头部动作）都无条件给撤销的全部
理由。

**同文案替换，绝不堆叠** —— 约束落在 store 里，因为连续归档三个会话不该立起一堵一样的
toast，而最新那条撤销是唯一仍可操作的。`dismissActionToast` 对未知 id 是静默 no-op
（不发通知）：toast 自身的定时器与点击处理都可能触发。

**更新（2026-10-22）——角落同柱、kind、应用通知路由。** 浮窗栈迁入右下角 `.gui-toast-corner`
包装器（app.tsx 把 `<UpdateToast/>` 与 `<ActionToastStack/>` 一起渲染进去）：应用通知与
OTA 卡片共享一根锚定列——卡片落在角落、药丸叠在其上方——而不是两个独立 fixed 元素在同一组
坐标上互相覆盖。toast 新增 `kind`（`info` | `success` | `error`，默认 `info`），渲染为
前导图标，图标与描边按 kind 微染（玻璃底色保持中性）。应用级 `musepi-gui-toast` 事件改
路由进这条栈（此前进 `setError` 的顶部横幅）：detail 接受纯字符串或 `{message, kind}`，
缺省 `error` 以保留旧横幅语义；守护进程连接类错误仍走顶部横幅。`pushActionToast` 保持
向后兼容（kind 可选）。
### 45.4 面板增量

`CommandPalette.tsx`：面板组新增 Reload UI；**粘贴 session id 精确命中**（`exactSession`
useMemo，声明在读取它的搜索 effect **之前** —— biome 的 `noInvalidUseBeforeDeclaration`
强制这个顺序）；query 在关闭时捕获、打开时回填。精确 id 查询完全跳过 RPC，并把 id 作为该行
的副标题显示，让这次命中读起来是刻意的，而不是像出了 bug。

### 45.5 工具链陷阱（此处耗时最多 —— 编辑前必读）

- **`edit` 工具会重写缩进，并可能悄悄把整个 tab 缩进文件压平成空格。** 实测：
  `ChatView.tsx` 在一次**单行** import 编辑后从 `tab=2554` 变成 `tab=0`；两个 `gui-*.css`
  同理。`GuiHeader.tsx` 还因崩溃时的半截写入彻底损坏（65504 字节 NUL —— 正好是 64KB 缓冲
  边界；已从 HEAD 恢复并重放改动）。**对 tab 缩进文件请用字节级精确替换**（读原始文本 →
  `.Replace(old, new)` → `WriteAllText` 配 UTF8 无 BOM 编码器），否则你会交付一个 6000 行的
  纯空白 diff。对大文件做 `edit` 后务必检查 `git diff --stat`。
- **biome 只检查相对 `main` 有改动的文件**（`biome.json` 的 `vcs.defaultBranch` +
  `useIgnoreFile`）。干净 HEAD 能通过，是因为「没有文件有改动」。你一旦动了某个遗留文件，
  它既有的缩进债立刻浮现，`check:ts` 随之失败 —— `app.tsx`、`ChatView.tsx`、
  `CommandPalette.tsx`、`GuiHeader.tsx`、`SessionSidebar.tsx` 全都有这笔债。解法是对该文件跑
  `biome check --write`，代价是整文件重排；diff 会很大但纯属机械改动（并发的 `6bb37eb6a`
  提交对 `TrajectoryView.tsx` 做过同样的事）。这是全仓债务，不是某次改动引入的。
- **biome 不管 CSS** —— `files.includes` 只有 `*.ts` / `*.tsx`。把 `.css` 路径传给
  `biome check --write` 会绕过该过滤并重排文件（tab → 2 空格，约 6000 行）。永远不要把 CSS
  喂给 biome。
- `gui-workspace.css` 不在 `gui-chat.css` 的层叠里；查找栏的规则与它依赖的 transcript 规则
  同放在 `gui-chat.css`。

### 45.6 验证

`bun run check:ts`（biome + i18n dup-key + client-UI i18n 门控 + tsgo）、`bun test
packages/desktop-app/test`（694）、`bun test packages/coding-agent/test/daemon`（328）。
新增契约测试：会话作用域搜索（跨会话泄漏）、action-toast 的替换/堆叠/id 隔离。
⌘F 需要实机手动过一遍 —— 该查找栏由只存在于桌面壳里的窗口级快捷键驱动。

## 46. 场景位移时的光束冻结（2026-10-09）

输入框的 border beam（旋转彩色描边，`vendor/border-beam`）是遮罩锥形渐变的逐帧重绘
——`@property` 角度动画 + `mask-composite`，不是合成器 transform。welcome↔session 场景
FLIP 位移（`ChatView.morphFrame`）期间，这份重绘叠加在位移自身的 transform+blur 动画里，
就是「空态输入框位移到会话态卡顿」的元凶。空态 placeholder 走马灯（WelcomeComposer 里
4s 一次的 `setInterval`）排查过、不是原因——4 秒一次 setState 不产生逐帧成本，且它随场景
一起卸载。

- **两侧都冻结，只冻结位移这一程**：`.gui-scene--leaving .gui-border-beam`（离场侧的
  composer，比如聚焦中的空态输入框）和 `.gui-scenes[data-scene-morph] .gui-border-beam`
  （覆盖**进场侧**的 beam——会话态 composer 的 beam 由 `working` 驱动，聊天场景挂载时就
  可能已在淡入）都对 wrapper、两个伪元素和 `[data-beam-bloom]` 钉
  `animation-play-state: paused !important`（对齐 beam vendor 的 `pausedAnimationsRule`）。
  beam 保持可见、定格在旋转中途——不能用 `display:none`，那会跳变。
- **窗口标记**：`morphFrame` 在 `.gui-scenes` 上设 `data-scene-morph`，`flight.finished`
  时清除；用模块级代际计数（`sceneMorphGeneration`）——快速来回切换会在旧 resolve 触发前
  开出新一程位移，过期的 resolve 不能清掉新标记。
- **beam 的显示窗口在源头同时收短**：WelcomeComposer 的两条提交路径（`sendText` 的普通
  路径与 design rail 路径）发送时即 `setBeamOn(false)`——此前提交后 textarea 仍持有焦点，
  beam 一直转到离场场景淡完为止。
- **pulse 系列不动**：它们的呼吸本就走限帧的 `pulseDriver` rAF，且 `ApprovalCard` 的
  beam 不在 `.gui-scenes` 里。

## 47. 会话态专注形态：布局阶段钉帧 + 单一高度驱动（2026-10-09）

会话态 composer 的专注模式形态（⌘⇧E，`ChatView` 的 `composerWrapRef` effect）有两个毛病：
高度动画掉帧，以及 composer 先整体上移再放大。

- **顺序错误（「整个输入框先上移然后才放大」）**：形态动画跑在被动 `useEffect` 里——
  画的之后才执行。展开时同一个 commit 里转录区 wrapper 被卸载
  （`focusMode ? "hidden" : flex-1`），浏览器先画出一整帧 commit 后的布局：剩下的 flex
  列更高，底部锚定的 composer 在 WAAPI 高度动画还没开始前就已经跳到了新的底边。现在改成
  `useLayoutEffect`，在首帧绘制前钉住起始高度并启动动画——composer 原地生长（与欢迎页
  form 形态已用的布局阶段纪律一致；`WelcomeComposer` 里 flash→回弹→再生长的注释就是同一
  个教训的出处）。
- **帧率**：同一时刻有两个高度驱动——wrap 类自带的 `transition: height 280ms`（
  `.gui-composer-wrap`）加上同一属性上的 WAAPI 动画，两条 280ms 曲线逐帧互抢。新增
  `.gui-composer-wrap--morphing` 标记类（只钉住动画窗口，由同一个版本化的 finish/定时器
  清理释放）对 wrap 及其 textarea/`.gui-composer-frame` 后代钉 `transition: none`
  （textarea 自动的 `height 160ms` 过渡否则会以第二次布局追着逐帧布局跑）。与
  gui-settings.css 的 `.gui-welcome-form.gui-morphing` 抑制同一套做法。
- 尺寸无变化的切换现在立即释放钉住的高度，不再钉帧并播放 0px 动画。

## 48. 专注形态位置补偿 + HeightMorph 中断恢复（2026-10-09）

§47 落地后实测的跟进：「先上移」的观感在布局阶段钉帧后依然存在，供应商折叠卡在半路冻住。

- **位置补偿，两个 composer 都改**：纯高度动画的第一帧画在 morph 窗口的布局位置上，而那
  就是稳态位置——composer 还是「跳」（跳变只是从转录区卸载挪进了 morph 自身）。两个 morph
  现在都先钉**目标**尺寸、量出落位后的布局 top，再把 `translateY(preTop − layoutTop) → none`
  与尺寸关键帧一起动画。首帧 = 真实的切换前 rect，末帧 = 稳态，上下两条边都沿曲线走（
  「按边距比例放大」的观感）。切换前的 top 在 render 阶段捕获（ChatView 的 `prevWrapTop`、
  WelcomeComposer 的 `prevSize.top`）——那时 DOM 还是上一个 commit 的布局。
- **转录区用 `visibility` 隐藏，不再 `display:none`**（`.gui-chat-body--focused-hidden`，
  `height: 0; flex: 0 0 auto`）：display 移除会把 body 从 flex 列里抽掉，composer 的落位
  在一帧内移动；留在布局流里以 0 高度存在，列几何保持稳定。聚焦期间 wrap 钉
  `margin-top: auto`（`.gui-composer-wrap--bottom-anchor`），落位 top = 列底 − 钉住高度。
- **composer morph 窗口内的 beam 冻结**：`.gui-composer-wrap--morphing` 与
  `.gui-welcome-form.gui-morphing` 都在 morph 窗口内暂停 composer 光束的动画——输入框聚焦
  时（beam 在转）切专注模式，逐帧锥形渐变重绘叠在 morph 的逐帧布局上就是卡顿。
- **HeightMorph 中断恢复**（`HeightMorph.tsx`）：快速来回点 显示全部 ⇄ 折叠 会在旧过渡
  未结束时启动新 morph；旧 run 留下的内联 `height + overflow: hidden` 钉帧还在，新 run 量
  `offsetHeight` 量到的是裁剪盒——网格「动画」到那个卡死的裁剪上，半路冻住。现在每次 run
  在测量前先清掉残留的内联钉帧，且清理函数在被打断时（React 重跑 effect 会先执行）恢复
  自然布局——被打断的 morph 不可能活过自己的 run。


## 49. 统一插件清单里的插件包归属（2026-10-10）

统一插件清单（`UnifiedPluginsView`）合并了两条描述同一插件的链路，两端口径相反：

- `plugins.packages` —— 每个已装包目录一条（`path` 由 `path.join` 拼出，Windows 下为反斜杠）；
- `extensions.list` —— 包目录下的扩展模块，各自带着自己的入口路径。

包是列表的唯一行；模块收进详情弹层的「包含的组件」，插件自己的设置组件挂载在弹层的
设置段。归属判定由 `isPathInside(child, parent)` 决定。

**契约**：`isPathInside` 比较 `path.relative(resolve(parent), resolve(child))` 并拒绝 `..`
与绝对路径结果 —— 直接回答「是否在目录内」，而不是假定两侧拼写出同一个分隔符；同时它
会拒绝只共享前缀的同级目录（`demo` 下的 `demo-extra`）。用例钉在
`packages/desktop-app/test/plugin-path-scope.test.ts`。

**设置界面**：`settings.item.<extId>` 卡片与精确槽位 `settings.extensions`（插件自带管理
面板如账号池注册处）的组件，都由 `ExtensionsCenter` 按扩展分组渲染，并带上
`settingsScope` 读写代理，使需要落盘设置的面板不会拿到空代理。

**第三方插件要求**（见 `docs/extensions-dev.md` §6）：声明 `musepi.extensions`、声明
`musepi.icon` 作为品牌标识，并把面板注册到 `settings.extensions`；**禁止
`import from "react"`**（daemon 会把 `React` 标识符改写为 `window.MusePiReact`）。

## 50. 流式渲染节奏 + store 窄订阅（2026-10-18）

**契约**：一轮实时对话不得按 daemon 帧数重绘整个外壳。

- **`GuiSessionStore` 以约 10 Hz 合批，不再逐动画帧刷新。** `apply()` 先入队；一批里的
  第一帧在下一个微任务刷新（首 token 延迟不变），随后开启 100 ms
  （`FLUSH_COALESCE_MS`）窗口累积其余事件。33 ms 实测过：比这个窗口多花约 6% CPU，
  视觉无差别。一次刷新 = 一次快照重建 + 一次 emit。
- **`#applyNow` 是纯变更。** 它返回「有没有可观察的变化」，自己不再重建、不再 emit；
  调用方每批只 commit 一次。只承载**其它会话** subagent 流量的帧返回 `false`，
  因此完全不产生渲染。`approval-request` / `recap` 仍同步生效——用户正卡在弹窗上，
  不能让他等合批窗口。
- **订阅方按切片选取。** `useStoreSelector`（packages/desktop-app/src/lib/use-store.ts）
  在新选取值相等时保留旧引用，于是「快照对象换了」本身不再触发重渲染。`GuiHeader`
  只订阅 `{working, streaming, approvals, cwd, titleCandidate}`——它此前每次对话流
  刷新都整块重渲染，而实际只读两个布尔。
- **轮询只发布真变化。** `session.contextUsage`（3 秒）与 `session.list`（5 秒，原本
  已按 key 去重）在 `setState` 前比较；空闲会话此前每个 tick 都重渲染一次状态栏。

**验证**：`packages/desktop-app/test/session-store-batching.test.ts`（每批一次 emit、
外来帧零次）、`test/use-store-selector.test.tsx`（无关字段不重渲染、选中字段重渲染）。

## 51. HTML 卡片答案回读（2026-10-18）

面用 `musepiSubmit(text, data)` 提交，宿主转成一条用户消息。**宿主接受后要把
「接受的是哪一条」告诉面**——否则卡片只能变灰，面没有任何办法渲染「你选了 A」。

- 线格式：向卡片自己的 frame 投递 `{type: "musepi-widget-answered", text, data}`。
  `data` 是面自己提交的结构化载荷，在可序列化且小于 8 KB 时原样回传。
- 面可见面：`window.musepiWidgetAnswer`（等同 `__MUSEPI_ANSWER__`，让在答案之后
  才启动的面在 load 时也能读到）、带 `detail` 的 `musepi-widget-answered` DOM 事件、
  以及 `<html>` 上的 `data-musepi-answered`（注入样式据此变灰）。
- 答案在 frame load 时重放：主题切换会重写 srcdoc，不重放的话面会回到「看起来还能答」。
- 仍然是非阻塞设计：用户点下去时智能体那一轮已经结束。需要在同一轮内据答案调整，
  仍是 `ask` 工具的职责。

## 52. session-less 插件 RPC 的 load-once 生命周期（2026-10-18）

**契约**：槽位面板的 RPC 必须每次都派发到**同一个已加载的扩展模块实例**——与实时
会话完全一致。

`ext.call` 过去每次调用都：(a) 拿扩展 id 去比对一次全量 `loadAllExtensions`
扫描（会执行**每一个已装扩展**的 factory）；(b) 重新 import 入口。装上插件后调
`auth_hub.pool.status` 实测单次 3.5s+；面板挂载时发 4 个 RPC，还没渲染第一行就
把 GUI 的 15 秒 RPC 预算烧光——观感就是「插件自己的数据永远加载不出来」。两处改动：

- **`ExtensionService.call` 走快路径**：直接 `invokeExtensionRpc` 装载入口，用
  settings 的禁用清单 + `existsSync` 把关，不再做全量清单扫描。要紧的那道守卫仍在：
  路径装不动、方法没注册，照样抛错。
- **load-once + 显式失效**（取代原来的 10s TTL）：`extensionLoadCache` 一直持有
  已加载实例，直到 `invalidateExtensionLoadCache()`。所有变更路径——装卸、启停、
  配置写入、HMR watcher——本来就都汇到 `invalidateExtensionsCache()` /
  `invalidateExtensionCaches()`，现在一并清它，所以改动立刻生效，而面板刷新不再
  重复付加载成本。

**验证**：`packages/coding-agent/test/extension-artifact-compiler.test.ts` 统计
factory 运行次数：连续两次派发必须只跑 1 次，失效后必须跑到 2 次（计数器挂在
`globalThis` 上，模块重新 import 掩盖不住重跑）。

## 53. RPC 等待耐心与「仍在处理」提示（2026-10-18）

**契约**：慢但健康的请求绝不显示成失败；长等待必须让人看出它在推进。

GUI 的单个请求上限原本是 15 秒。有两件事合理地超出它：`session.create`
会为新上下文实例化扩展集（daemon 恢复多个会话时要数秒），模型回合可能在
provider prep 里待一会。15 秒时两者都变成一个红色的「请求失败」横幅，而重试
一次立刻成功——调用方读到的是一个假失败。上限现在 45s，而且这么做是安全的，
因为**探活不是这个定时器的活**：keepalive 环（每 20s ping、45s 全静默后强关）
负责判断 socket 是否已死，而 socket 死掉时所有在途请求会一次性以
「connection closed」拒绝。

`session.create` 保留自己的 120s 上限——它是 GUI 发起的最慢的一件事。

**等待可见。** `withSlowHint`（packages/desktop-app/src/lib/rpc-slow-hint.ts）
设 2.5s 阈值，之后每秒 tick 一次并带回已用时间。它不改变请求结果，且请求一
落定就清掉 interval（不留漏跑的 ticker）。冷启动骨架把它渲染成
「正在加载会话… 已等待 N 秒」，用等宽数字，数字跳动不移布局。

**验证**：`packages/desktop-app/test/rpc-slow-hint.test.ts`——快请求不 tick；
慢请求 tick 且 elapsed 递增；失败仍以自身错误拒绝（提示是附加的，不是替代）；
请求结束后没有 ticker 存活；秒数助手按展示取整。


## 54. 滚动锚定补 scroller 盒观察、顶栏减法与实例迁移、侧边通道角色语义（2026-10-21）

**最新消息被 composer 遮挡的根因与修复**（`client-core` Transcript 跟随钉底 effect）：原 ResizeObserver 只 observe 内容盒（`.tr-root`）。视口尺寸变化——拖窗口、切布局、新开会话——只改滚动视口盒、不动内容盒，scrollTop 保持原位，底部几条消息滑进输入框底下；切走再切回之所以"又好了"，是重挂时的一次性重钉盖住了症状。修复：RO 同时 observe `scrollerRef`（视口盒）与内容后的 tail sibling，跟随期任何视口或尾部变化都重锚 live edge；上翻释放 `following` 后，tail 增长不得抢滚动。「回到底部」按钮经 `registerComposerInsetReader` 读取当前 composer inset 与浮动面板 clearance，并在这两项实测高度之外再保留 24px 安全间距，输入框、附件/引用卡和统计行改变高度时仍停在上方安全区；web 不注入 reader，保留 CSS 24px。EN 版滚动锚定条目已同步。

**Composer inset publisher 跟随聊天场景。** `ChatView` 在 `showChat` 变为 true 时启动 `ResizeObserver`，不再只在组件首次挂载时尝试。欢迎页进入会话后，wrap 的实测高度会发布给已注册及后续注册的 reader，不会永远停留在 CSS 默认值。

**空态提示保持静态**（`WelcomeComposer.tsx`）：placeholder 与会话输入框使用同一基础文案，补充提示只在挂载时选择一次，不再创建轮播 interval。`ComposerFrame` 复用 `SpotlightCard` 的指针光晕，共享组件直接更新光晕样式，指针移动不会重渲染输入区子树；frame 保持 `overflow: visible` 以容纳桌宠和浮层，光晕继承圆角并在减少动态效果时移除。

**专注与看板合集几何**：带桌宠的专注输入框把桌宠放在顶边内侧 6px，并在整个文本栈上方预留 64px；空态 textarea 使用 `box-sizing: border-box`，水平 padding 不再挤压 placeholder 提前换行。看板首页采用 flex 纵列，快捷输入条通过 `margin-top: auto` 与 `position: sticky; bottom: 14px` 固定在底部，短内容与长滚动页面均成立；合集卡片与「新建看板」共用 300px 最小高度。

**合集预览使用显式渲染模式**：`BoardPage` 通过 widget 注册表传入 `preview`。`WidgetFit` 同时观察容器与内容，并取 `min(1, 容器宽/内容宽, 容器高/内容高)`，避免异步内容从任一轴溢出。预览单元格持有外圆角，其直接 widget 卡面减去 4px padding。汇率、股票、历史和音乐预览渲染种子数据，不启动 fetch、JSONP、interval 或音频 `requestAnimationFrame`；不传 `preview` 时保留真实看板的实时行为。

**composer 停靠栏胶囊几何**（`gui-workspace.css`）：`.gui-composer-dock` 从 `align-items: stretch` 改 `flex-start`——连接器胶囊按内容自适应宽、靠左，不再整行铺满（`.gui-slot-error` 单独 `align-self: stretch` 保全宽）；ChatView 悬浮 composer 包裹 `pb-3 → pb-1`，「性能与用量」胶囊与底部间距收紧。

**顶栏减法**：GuiHeader 移除 terminal / board / 右侧面板三个按钮；terminal 开关迁至 RightRail 底部组（新增 `terminalOpen`/`onToggleTerminal` prop，激活态 `gui-right-rail-btn--active`）；实例菜单整块迁出为 `InstanceButton.tsx`（自包含：system.meta 轮询、GitHub latest release 角标、hosts `/healthz` 可达性探测、browserHost 诊断，props 仅连接事实 + 增删改回调；`useSyncExternalStore` 第三参 getServerSnapshot 必填——静态渲染测试走 renderToStaticMarkup 会炸），挂侧栏 footer 左侧。GuiHeader 保留 `terminalOpen/onToggleTerminal`（开发服务器/项目动作要先开 dock）。app.tsx 实例 props 从 GuiHeader 调用点迁到 SessionSidebar 调用点。

**侧边通道模型角色语义**（daemon `agent-session.ts #sideChannelModel` + 设置页选择器）：`sideChannelModel` 现在接受角色别名（`@tiny`、legacy `pi/tiny`、`*`）——经 `resolveModelRoleValue` 按角色分配实时解析，改角色模型即生效；纯 catalog id 仍走直查（旧配置兼容）；未知值回落会话模型。角色形状判定用新导出的 `isModelRoleAliasValue`（`model-resolver.ts`）。设置页选择器改为「跟随会话模型 / 跟随 TINY 角色 / 其余八个角色 / 具体模型」的顺序，存量具体模型仍可显示与选择。测试：`test/model-resolver.test.ts` 新增 `isModelRoleAliasValue` 5 例（@tiny 解析、legacy 前缀、* 别名、纯 id 否定、未配置自定义角色否定）。

## 55. 顶栏会话 preview 标签与按 ID 菜单（2026-10-25）

`lib/session-tabs.ts` 持有 preview 迁移 helper。`openPreviewTab` 在原索引替换旧 preview，不改变已固定的 id；没有 preview 时经既有上限逻辑追加。`pinPreviewTab` 与 `clearPreviewTab` 返回下一个 preview id；app 用独立键 `musepi-gui-session-preview-tab-id` 持久化，不与 ids/顺序键混存。关闭、关闭其他、删除同步更新两类持久化值；排序只改 ids/顺序。

`SessionTabsStrip` 为「⋯」和右键构造同一组 `ContextMenuItem[]`。菜单回调接收所在行 id，而非当前 store id。`GuiHeader` 将回调接到既有重命名、剪贴板、只读 `session.snapshot` 导出、mini chat、`worktree.create` + `/move`、归档与删除路径。导出和工作树因此能对非当前会话执行，无需订阅或激活；归档同样不改变当前选择。标签行携带 `cwd` 供工作树 RPC 使用。

最近会话 `MenuPopup` 由非 tab 标题和标签带外的紧凑按钮共享，因此 tab 模式保留新建与最近会话导航，且不改变标签标题盒。标签测试在 `afterAll` 恢复入口 locale，只移除自身 hosts。隔离 seed 在切换前记录 `preSeedLocale`，收尾恢复该精确值，最终文件分别验证英文与非英文入口。

**验证**：`SESSION_TAB_TEST_ENTRY_LOCALE=zh-CN bun test packages/desktop-app/test/session-tabs-strip-00-isolation-seed.test.ts packages/desktop-app/test/session-tabs.test.ts packages/desktop-app/test/session-tabs-strip.test.tsx packages/desktop-app/test/session-tabs-strip.test.tsx-after.test.ts packages/desktop-app/test/session-tabs-strip.test.tsx-after.test.ts-locale.test.ts packages/desktop-app/test/session-markdown.test.ts` 覆盖迁移、持久化、尺寸、固定手势、每个按 ID 动作、tab 模式导航与跨文件隔离；将入口改为 `en-US` 验证另一方向。`bun --cwd=packages/desktop-app run check` 覆盖 Biome 与类型。

## 56. 历史新鲜度与有限轮次索引分页

- **历史恢复会比较缓存与 SDK transcript 的新鲜度。** `session-host.snapshot` 不再因为 ViewStore 快照存在就直接返回。缓存最新条目早于 transcript 尾部时，恢复会跳过该快照和 journal，改为投影 transcript；时间相同则保留缓存投影。普通会话与独立写入的 advisor recorder 都走这一判定，缓存末尾的 user 消息不会遮住已经完成的 assistant 回复。
- **首屏 transcript 窗口保持有界。** `session.resume`、`session.snapshot`、`session.subscribe` 经 `tailSnapshot` 返回最新 200 条及 `tail.hasMore`/`tail.beforeId`；`session.history` 保留既有 `beforeId` 游标，按时间正序返回更早条目。游标失效会明确返回 `stale`，不会用重叠的最新页冒充向前分页。
- **`session.turns` 支持可选的轮次游标分页。** 传入 `limit` 时返回最新的有限轮次页；`beforeTurn` 使用本页最老轮次的 `entryId` 向前翻页且不重页。分页响应携带 `hasMore`、`remaining`、`nextBeforeTurn` 和 `stale`。不传这些参数时仍返回旧客户端需要的完整索引。
- **桌面分页按 store 隔离且单在途。** `GuiSessionStore.loadOlder` 共享同一个在途请求，在快照中公开 `historyLoading`，并用快照代际丢弃刷新或销毁后才完成的旧页面。传输失败和空页保留已加载条目、结束 loading，并通过既有 `historyBlocked` 提示失败，不会无限重复请求。`ChatView` 只在发起分页的 store 仍为当前 store 时恢复前置内容的滚动锚点；advisor 只读路径不挂载 `SessionErrorDock`，因此 advisor-only 记录不会触发普通会话的无应答复检。
- **地图与轨迹共用同一个有界窗口。** 打开地图或轨迹不再主动补齐全量历史；`TurnMapCanvas` 的加载更早按钮通过与对话相同的 store 路径只请求下一页，定位旧消息时才按目标继续翻页。两个视图都在保留已加载条目的同时展示加载中与历史终止状态。`session.turns` 使用 `limit: 200`，已加载轮次按 `entryId` 合并，前插页面不会让导航条重复或乱序。

当前的 display-context 传输、FilePane 引用生产者、子会话折叠和角色/回退模型思考等级契约见 **`docs/gui-context-and-session.md`**。
