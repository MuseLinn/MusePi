# MusePi GUI 实现笔记(契约与坑)

> 状态:**活文档**(2026-08-06 建立,从 `gui-design.md` 拆出)——`packages/gui` / `packages/desktop-web` 实现的**事实记录**:daemon RPC 契约、IPC 形状、算法语义、踩坑与验证方法。与实现同步,实现文件为准。
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

- **renderer keepalive**(`packages/gui/src/lib/rpc.ts`):请求 15s 超时(`REQUEST_TIMEOUT_MS`)防永挂;每 20s 发 `system.ping`(`KEEPALIVE_INTERVAL_MS`),45s(`KEEPALIVE_DEAD_MS`)无任何响应 → `ws.close()` 强制触发重连(浏览器 WS 无 ping 能力,这是标准替代)。
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
- **添加账号** = GitHub OAuth Device Flow(client_id `178c6fc778ccc68e1d6a` 即 gh CLI 公开客户端;`github.authStart` POST /login/device/code → GUI 显示 user_code + 打开 verification_uri + 按 interval 轮询 `github.authPoll`(pending/slow_down 续轮询;拿到 access_token 后 `gh auth login --with-token` stdin 导入 gh keyring——**所有 gh RPC 立即生效**))。注意 gh 配置在 `$HOME/.config/gh`(token 在 macOS Keychain)——**隔离 HOME 的 daemon 看不到用户 gh 认证**(测试用 mock gh + GH_CONFIG_DIR 组合)。
- **身份** = 提交身份列表(localStorage `musepi-gui-git-identities` + `musepi-gui-git-default-identity`,两步 prompt 新建,默认徽章,confirm 删除)——**git.commit 消费**(`-c` 注入)。
- **工作区变更面板**(openchamber GitView/ChangesPanel parity):三组(已暂存/未暂存/未跟踪 + 可选已忽略),每行 hover stage/unstage(`git.stage` = `git add -- <paths>`;`git.unstage` = `git restore --staged --` fallback `git reset HEAD --`),header 有平铺/树形视图切换 + Gitignored 开关(`git.status {ignored}` → `--ignored` 标志解析 `!!` 行)+ 提交按钮。
- **项目笔记面板**(ContextPanel NotesPane,2026-08-06 openchamber 对齐):快速笔记(daemon notes.get/set,3000 字符上限 + `{n}/3000` 计数,**400ms debounce 自动保存 + blur 立即落盘**)+ **待办列表**(localStorage `musepi-gui-todos:<cwd>`;**openchamber 语义**:header「待办 {count} 项」、每项 120 字符、添加插入到第一个已完成项之前、勾选完成移到末尾(completed-last)、清除已完成按钮(0 完成时 disabled)、删除 ✕)+ **计划文件**(daemon `plans.list/get/save/delete`,存 `agentDir/plans/<cwdHash>/<时间戳>-<slug>.md`,格式 `# 标题\n\n内容`——标题从首行 `# heading` 解析;GUI:「计划 {count} 个文件」header + `+` 新建(两步 prompt:标题+内容)+ 列表(标题+日期+删除)+ 打开查看(等宽 pre))。**存储设计**:与 openchamber 的 `~/.config/openchamber/projects/<id>.json` 不同——musepi 用 agentDir 文件(与 notes 同款,不碰用户项目)。**未做**(说明):dnd 拖拽排序、待办发送到会话、文件导入、聊天消息「保存为计划」按钮、CodeMirror PlanView。
- **prompt 对话框修复**(prompt-dialog.tsx,2026-08-06):确定按钮对 prompt 分支原来 `finish(true)` → 返回 **null(等于取消)**——prompt 只能靠 Enter 确认,点确定无效——改为 `state.kind === "prompt" ? finish(value.trim()) : finish(true)`。**bun build CSS 坑**:bun 的 CSS 解析器**不支持 `@layer` 裸语句**(`@layer a, b, c;` 报 Unexpected token,错误位置漂移到注释里的 `*` 误导调试)——**块形式** `@layer a {} @layer b {}` 可以(语义等价,声明层顺序)。base.css 的层顺序声明已用四空块替代。
- **文件预览与编辑器交互**(FilePane.tsx,2026-08-06):文件树支持**目录折叠**(点目录行 toggle,caret 旋转)、**点击文件预览**(内嵌右栏)、**右键菜单**(打开预览/在应用中打开/复制路径/刷新,复用 ContextMenu 组件)。预览分类:`fs.readBytes`(base64+mime+size,8MiB 默认 cap/32MiB 硬 cap)读文件 → 文本(TEXT_EXT + 前 4KB 无 NUL 判定,`<pre>` 等宽滚动)/图片(Blob URL + `<img>`)/**PDF 内嵌 pdf.js 渲染**(pdfjs-dist@6,逐页 canvas → data URL;渲染失败(加密/损坏)回退 `openWith("", path)` 系统默认应用)/其他二进制系统打开。**pdf.js worker**:bun build 不支持 `?url`/`?raw` 查询导入(bare 与相对路径都失败)——构建脚本 `cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs dist/pdf.worker.min.mjs`,`GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", location.href)`(file:// 同源 worker 正常)。**坑**:workspace.tree 的 entry.path 是**相对会话 cwd**,而 fs.readBytes 按 **daemon cwd** 解析——FilePane 必须显式拼接 `${cwd}/${entry.path}`(测试侥幸通过只因两者相同);复制路径同样用绝对路径(VS Code 语义)。预览 blob URL 在 preview 变化时 revoke 防泄漏。
- **内嵌浏览器**(ContextPanel BrowserPane,2026-08-06):**Electron `<webview>`**(main.cjs `webviewTag: true` + `web-contents-created` popup 拦截——target=_blank 原地 loadURL,http/https only;partition `persist:omp-browser`;webpreferences `contextIsolation=yes, sandbox=yes`),**web 构建 iframe fallback**(isElectron 检测)。功能:地址栏(缺 scheme 补 http://)、后退/前进(URL 历史栈 + disabled 态)、刷新、在浏览器中打开、快捷端口、**视口尺寸预设**(自适应/手机 393×852/平板 768×1024/桌面 1440×900——容器宽度控制,居中)、**元素选取**(bitfun/openchamber parity):注入 `BROWSER_INSPECT_SCRIPT`(Promise.withResolvers,`webview.executeJavaScript(script, true)` 跨域执行)——hover 高亮 + 标签 tooltip + click 捕获 {tag, text≤500, selector(CSS path,≤6 层), outerHTML≤2000} → `window.dispatchEvent("musepi-gui-insert-text")` → Composer 监听追加「网页元素 <tag>：text + 选择器: selector」到草稿。webview 的 did-finish-load 用 ref addEventListener(React webview JSX 类型无事件 props;Electron 全局类型有 WebViewHTMLAttributes)。**三家参考**:bitfun=Tauri 原生 webview eval 注入 + context pill(`#element:` token);openchamber=Electron webview + 截图高亮附件(capturePage);craft-agents=BrowserView+CDP(Runtime.evaluate,agent 驱动 ref 点击,无用户点选 UI)——musepi 采用 bitfun/openchamber 的用户点选模式。**未做**:截图附件(capturePage + 高亮矩形,需要 main IPC——元素元数据已含 text/outerHTML 够 agent 用)。**测试教训**:CDP `dispatchKeyEvent` Enter 不带 text 时不触发表单 implicit submission——用 `form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))`;React 受控 input/select 用 native setter + input/change 事件;webview 是独立 CDP target(可对其 Input.dispatchMouseEvent 模拟页面点击)。
- **提交对话框**:textarea(⌘⏎ 提交)+ **19 个内置 gitmoji**(carloscuesta/gitmoji 子集,离线可用——openchamber fetch remote JSON 7d 缓存,musepi 选择内置)+ 身份(`git.commit` 用 `-c user.name/email` **注入不落 repo config**——openchamber 写 local config,musepi 桌面设置不该静默改用户仓库;身份来自设置 Git tab 默认身份)。
- **树形视图**:按首个路径段分组(`changesTree` 简化版),目录行可折叠。
- **daemon cwd 语义**(2026-08-06 修复):git RPC 原作用于 `#host.cwd()` = **daemon 启动目录**(非会话 cwd)——git 视图显示的是 daemon 所在仓库,切换项目会话不改变它(既有设计)**——已修复**:5 个 git RPC(log/diff/status/stage/unstage/commit)接受 `params.cwd`,优先 `path.resolve(params.cwd)`,空则 fallback `#host.cwd()`;GUI 的 GitLogPane/DiffPane 传 `snap.state.cwd`(会话权威 cwd,与 FilePane/NotesPane 同源),load 的 useCallback 依赖补上 `cwd`。**E2E 验证**(隔离 daemon cwd=/tmp/git3 + /tmp/gitrepo):无 cwd → `not a git repository`(不再误读 daemon 仓库);status 显示 a.txt M/c.txt ??;`ignored:true` → x.log;stage a.txt+c.txt → staged 2;commit `-c user.name/email` → 身份注入成功且 **repo config 未被写**(git config user.name 仍 Test User);unstage/diff/log 正常;daemon cwd 零泄漏。**tsgo 幻影错误教训**:tsgo 增量缓存可能拿旧源文件做类型检查(354 行 `"completed"` 报成 `"done"` 无重叠)——遇到不可能的错误先 `rm -rf node_modules/.cache/tsgo` 重跑。
- **Git 偏好设置**(设置页 Git tab):更改视图 radio/gitmoji 开关/显示 Gitignored 开关——localStorage `musepi-gui-git-view`/`musepi-gui-gitmoji`/`musepi-gui-git-show-ignored`,与 DiffPane 同 key 联动。

## 4. 会话设置与清理(算法)

- **会话默认值组** = 默认模型(`ModelSelector` 无 sessionId → `models.listAvailable`,写 `musepi-gui-default-model`——WelcomeComposer 读同 key)+ 默认思考等级(segmented,`musepi-gui-default-thinking`)+ 自动标题(`musepi-gui-autotitle`)+ 显示删除对话框(`musepi-gui-confirm-delete`)。
- **会话保留组** = 启用自动清理(`musepi-gui-autoclean`)+ 保留时长 stepper 1-365 天(`musepi-gui-autoclean-days`,默认 30,关闭时行 `gui-settings-row--disabled` 降透明+pointer-events:none)+ 过期动作归档/删除(`musepi-gui-autoclean-action`)+ 手动清理(`gui-btn` + 「当前可清理:{0}」)。
- **候选算法**(openchamber parity):`session.list` 按 timestamp 排序,**排除当前会话 + 最近 5 个活跃**后,`updated < now - N天` 者为候选;执行后已处理 id 进本地 `cleanedRef`(会话内不再提示)。自动模式每小时检查一次、24h 冷却(`lastRunRef`)。
- **动作语义**:归档 = `session.close`(live 会话转 daemon 快照;**SDK 文件会话 close 报错被吞**——daemon 刻意不碰 workspace 文件);删除 = `session.delete`(**2026-08-11 起永久删除**:journal 文件 + materialized.db 物化行 + SDK transcript 主文件(`<sessionsDir>/<project>/<timestamp>_<sid>.jsonl`)+ 同名 artifacts 目录——修复前只删 journal/db 行,jsonl 残留导致 `listAllSessions()` 文件扫描重新列出、历史列表"复活"已删会话)。**已知语义**:`knownSessions` 的 `listAllSessions()` 有 10s TTL 缓存(`#historyCache`)——删除后列表最多延迟 10s 刷新;`session.list` 也可能显示"已删但缓存未过期"的会话,非 bug。**实现坑**:删除 transcript 用 `Bun.Glob.scanSync()` 返回**相对路径**,必须 `path.join(sessionsRoot, f)` 再 unlink/rm——裸相对路径按 daemon cwd 解析 → ENOENT 抛错中断循环。
- **删除确认统一在 `deleteSession`**(`useConfirm()` 弹窗,Escape/backdrop/取消/确定都可关;GuiHeader 与 SessionSidebar 不再自弹——避免双弹;开关关=直删)。

## 5. 伙伴实现细节(双窗口:pet.html + bubble.html,2026-08-11 更新)

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
- **双窗口架构**(2026-08-06 拆分,2026-08-22 窗口材质改为全平台透明):气泡与交互面板迁出 pet 窗口,独立 **bubble 窗口**(`bubble.html` → `src/bubble-main.tsx`)。**窗口尺寸完全内容驱动**——`report()`(RO 观察 `.pet-bubbles`/`.pet-panel` + animationend 补报 + 300ms 延迟补报)→ `bubble-set-size` IPC → `setBubbleSize` → `syncBubbleWindow`(窗口 setSize + 锚定)。**窗口是全平台 per-pixel 透明窗**(`transparent: true`,`hasShadow: false`)——曾用 macOS under-window vibrancy,但 vibrancy 把整个窗口矩形画成磨砂玻璃(圆角面板四周露出"底色"环),与"只有卡片自身有面"冲突;现由卡片自绘玻璃(半透明 tint + 顶部高光 + 发丝线)。**bubble 窗口是全部 6 个 BrowserWindow 中唯一"渲染后报告尺寸"的窗口**(其余:pet/mini 固定、pin widget 创建时预计算、glow/main 全屏)——所有"内容驱动窗口动效"问题都集中在这里。
- **锚定数学**(`syncBubbleWindow`,main.cjs):锚**角色 sprite**(`petRect`,非窗口——320 窗口比居中 sprite 宽,窗口居中会挂屏外)→ `x = petCx - bubbleW/2`, `y = petCy - bubbleH - 6`,workArea clamp;`petWindow.on("move")` → `watchPetMove` 拖拽跟随。
- **折叠↔展开宽高双轴 morph**(2026-08-11,修复"宽度跳变"):`stackMorph = { from: {width,height} }`,morph effect 对 width+height 双属性过渡(320ms overshoot);switchStack 捕获 from rect、渲染分支 inline 锁 from、effect lift→测 to→锁回→reflow→过渡。**关键坑**:lift 测量必须 `el.style.width = ""`(清 inline 回 CSS `max-content`),**`"auto"` 对块级元素=撑满包含块**(覆盖 max-content 后 toW 退化为窗口宽→宽度过渡静默跳过);折叠卡禁用 `width: min(240px, 70vw)`(vw 依赖与内容定宽窗口形成收缩振荡)。
- **面板入场 gating(宽度先行,2026-08-11,修复"先右半再全显")**:面板 mount 时 `opacity:0`,等窗口 resize 事件(120ms 兜底)→ 加 `pet-panel--in`(320ms 入场,`forwards` 保持终态——基础规则已 opacity 0)。根因:面板 316px 在气泡堆宽度(~140px)窗口内渲染,窗口 resize 经 IPC 滞后一帧——先露右半、左半突现;叠加 keyframes 烤的 `translateX(-50%)`(absolute 居中残留)把 flow 定位面板左移半宽。bubble 版用 flat keyframes(`pet-panel-in-flat`,无水平位移)。**通用模式**:内容驱动窗口的入场动效必须等窗口尺寸稳定(`resize` 事件)再播——见 gui-design.md §5c clawd-on-desk 分析。
- **report 动画尺寸**(2026-08-11,修复面板打开窗口闪烁):report 对进行中 CSS 动画的元素用 `offsetWidth/offsetHeight`(布局盒,不含 transform)——`getBoundingClientRect` 含 scale(0.98) 缩小值,动画中报告会把窗口定小、animationend 后跳变;检测 `el.getAnimations().some(a => a.playState === "running")`。
- **mount effect dead code**(2026-08-11,biome noUnreachable 报出):`return bridge?.onPetActivity?.(...)` 提前 return 吞掉后续 `requestPetState`——订阅 teardown 用 `const off = ...; void sideEffect(); return off` 模式。

## 6. CSS 反模式清单(全部踩过坑)

1. **自定义属性自引用/循环**(`--border: var(--border)`)→ guaranteed-invalid,静默消失。**同坑复发**:浮层 scrim 想写 `--gui-glass-overlay: max(95%, var(--gui-glass-overlay))` 是自引用,静默回退继承值——必须直接覆盖 `background` 本身。
2. **calc 长度×百分比**(`calc(28px * 100%)`)→ 非法,静默回退 0。
3. **transform 动画 keyframes 替换静态 transform**(`translate(-50%,-50%)` + scale 关键帧)→ 动画期间锚点丢失跳位;纯 opacity 或把完整 transform 写进关键帧。
4. **backdrop-filter 首帧闪烁** → 两阶段挂载(先 opacity 0 上屏,下一帧加动画类)。
5. **挂载即动画会杀死磨砂**(2026-08-06 实测,与 4 同根):带 `transform: scale` 的 `gui-menu-in` 若在**挂载帧直接播放**(ContextMenu/Pop 旧实现),Chromium 真实屏幕合成器**跳过 backdrop 采样,且动画结束后不重采样**——菜单永久渲染成普通半透明(背后文字直接透出,无磨砂);`useFloatingMenu` 的两阶段(挂载帧无动画类,下一帧 rAF 加 `--entered`)不受影响。**CDP 截图(offscreen 合成)仍显示模糊,是最大误导源**——曾据此误判"transparent 窗口 blur 全失效"(electron#30412 是长期未解决的独立问题,但本 GUI 的菜单 blur 一直可修),错误地用 95% scrim 覆盖全部浮层(用户立刻发现"全都不是磨砂了",已回退)。修复:ContextMenu/Pop 两阶段进入(`--pending`/`--entered` 类),Pop 调用方类移除自带 animation。**验证浮层磨砂必须真实屏幕截图(screencapture -l 窗口 ID),CDP 截图/计算样式不算数。** **全浮层统一(2026-08-11)**:共享 hook `useTwoPhaseEnter(active)`(gui/src/lib/use-two-phase-enter.ts,两 rAF 后返回 `--entered` 后缀,close 时重置)——接入此前越轨的 5 处:Board 放大/小组件任务/引导遮罩/⌘K 命令面板(改常驻挂载+退出动画)/选区工具条(补入场退场);base `opacity:0` + `--entered` 使 motion-off 自然瞬现。这些点此前是**挂载帧直接播 `gui-fade-in`(纯 opacity,无 scale)**——属本条风险类的轻度变体,未在真实屏幕实测失效,但契约上违反两阶段,统一后消除差异。
5. **flex 子项缺 `min-width:0`** → 内容撑破/尺寸不一致;flex 子项 `margin-inline:auto` 会击败 stretch。
6. **popup/浮层被祖先 overflow/transform 裁剪** → portal 到 body。
7. **rAF 节流闩锁未在帧回调内释放** → 后续事件被吞。
8. **SVG stroke 渐变必须 `gradientUnits="userSpaceOnUse"`**(2026-08-06 图标渲染实测):`stroke="url(#g)"` 配默认 objectBoundingBox 单位在 Chromium 渲染器(Chrome/Electron headless)整条 stroke **渲染为空白**,同渐变 fill 正常;显式坐标 + userSpaceOnUse 即恢复。涉及 app 图标 SVG 渲染(build/icon.svg)时必踩。
9. **无层(unlayered)规则压制所有 @layer 规则**(2026-08-06 侧栏 tabstrip 贴边根因):desktop-web base.css 的 `*{margin:0}` 是 unlayered,Tailwind v4 utility 全部在 `@layer utilities`——cascade 里 **unlayered 恒胜所有 layer**,于是侧栏 `mx-2.5/mt-3/ml-auto` 等全部 margin utility 静默算成 0px(胶囊贴左边缘、右侧按钮簇紧跟胶囊、`mt-3` 间距消失),而 padding utility 正常(没有 universal padding reset),症状极具迷惑性。修复:reset 移入 `@layer base`,前置空 `@layer theme/base/components/utilities {}` 块钉死顺序(tailwind CLI 会把 `@layer a,b,c;` 语句规范成这种空块形式,构建幂等)。教训:**GUI 里 Tailwind margin utility 不生效先查 unlayered universal margin reset**。
10. **误截断源文件的恢复路径**(2026-08-06 事故记录):`head -c <N>` 按**字节**截断大 CSS(8251 行 ≈ 370KB),git 无 WIP 提交、无 sourcemap、无 TM 快照时,唯一完整恢复源是**上次 `bun run build` 的 dist 压缩 CSS**(含全部规则):①选择器集合 diff(HEAD vs dist)枚举 WIP 规则;②从 dist 提取每条规则(压缩单行,按 `{` 平衡扫描 + 向前回溯选择器列表起点,合并逗号组合块);③`@media` 内规则记录上下文;④@keyframes 逐一比对(注意 `ag-*/tr-*/tv-*/spin` 等属 desktop-web,勿混入 gui.css);⑤格式化重排后追加,带恢复注释。恢复后功能等价,格式/注释丢失。**教训:大文件截断前先 `wc -c`;**给重要 CSS 定期 `git add`(index blob 可救)。
11. **legacy keyframes 烤静态 transform 在 flow 布局下错位**(2026-08-11):面板 keyframes 烤 `translateX(-50%)`(旧 absolute 居中残留),新布局已 `transform: none`(flow + margin 居中)——动画播放时把元素左移半宽,"先露右半再突现左半"。**教训:改布局定位方式时必须同步审计 keyframes 里的静态 transform;动画与静态布局解耦用 flat keyframes(只动位移/缩放/模糊的相对量)**。
12. **动画中 `getBoundingClientRect` 含 transform**(2026-08-11):scale(0.98) 入场动画中 rect 是缩小值——内容驱动窗口按它报告会把窗口定小,animationend 后跳变。**内容尺寸报告对动画中元素用 `offsetWidth/offsetHeight`(布局盒)**;检测 `el.getAnimations().some(a => a.playState === "running")`。
13. **锁宽测量 `width:"auto"` 覆盖 CSS `max-content`**(2026-08-11):morph 测量目标宽度时 `style.width = "auto"` 对块级元素=撑满包含块(覆盖 CSS `width:max-content`),toW 退化为容器宽 → 宽度过渡静默跳过(高度正常,视觉"只缩高不缩宽"再跳变)。**必须 `style.width = ""`(删 inline 声明回 CSS 值)**。
14. **浮层卡面 class 双应用 = 嵌套双画圆角**(2026-08-15,自定义强调色选色器):`useFloatingMenu(…, { className })` 的 class 落在**外层 portal 容器**,内容组件根若带**同一卡面 class**(ColorPickerPanel 根 `gui-color-picker`),两层同时拿到磨砂+圆角+阴影 → 背景多画一层圆角容器(`div.gui-menu-popup.gui-color-picker.gui-menu-popup--entered > div.gui-color-picker`)。规则:**卡面 class 只能出现在一层**——传 className 时内容平铺(proj/todo/queue/creds 类);不传时内容根自持卡面(quota/context/color-picker 类)。验证:`document.querySelectorAll('.gui-color-picker').length === 1` 且外层 computed `border-radius: 0`、`background: transparent`。

## 7. macOS 应用图标处理(2026-08-06 查证 + 修复)

三条独立路径,规则完全不同:

1. **打包版 Dock / Finder 图标** = bundle 内 `Contents/Resources/icon.icns`(electron-builder 默认 `buildResources/icon.icns` = `build/icon.icns`)。LaunchServices 解析 bundle 时**自动应用系统 squircle 遮罩** → icns 必须全出血 1024 方形、**绝不能自画圆角**(否则双重圆角)。生成链:SVG → 1024 PNG → `iconutil -c icns`(10 档 16-1024 @1x/@2x)。release 打包后手动同步 bundle icns(md5 一致)。
2. **dev 模式 Dock 图标** = `app.dock.setIcon(image)`:官方语义只是"贴图到 NSDockTile",**不经过 LaunchServices,系统遮罩不生效** → 传全出血方形 PNG 就是方角(用户看到"图标是方的"的根因)。dev 必须用**预圆角 PNG**(`build/icon-dock.png`)。**填充率以 kimi 实测为准 = 80.5%**(2026-08-06 `/Applications/Kimi.app/Contents/Resources/icon.icns` 解出 1024,alpha bbox x100-923):深色卡 824/1024 居中 + 四角 superellipse n=5 切圆 + 四周对称透明边距。**全出血 100% 会让 Dock 里图标比 kimi 大 ~24%**(用户"始终大一点"根因;92% 内缩版仍 >80.5%);"禁止内缩"的上一版结论错误——kimi 官方桌面资产就是卡中卡,与邻位 app 视觉统一优先。Python/numpy 生成。打包版 icns 同样带 80.5% 边距(卡中卡是设计,不是遮罩错误)。
3. **窗口 icon**(`BrowserWindow icon`)= Linux/Windows 窗口 chrome;macOS 上 Cmd+Tab/窗口预览由系统按 bundle/Dock 图标渲染(全出血 + 系统遮罩),窗口预览显示"大方块"是**窗口内容预览**而非图标,系统行为。

**splash 内嵌 logo**(`src/vendor/logo.png`)= UI 内 img,系统遮罩不适用,同样要预圆角版本(512,与 icon-dock 同源同参数);`.gui-splash-logo` **不能再加 CSS border-radius**(双重圆角)。换图标 = 三处同步:`build/icon.icns`(打包)+ `build/icon-dock.png`(dev Dock)+ `src/vendor/logo.png`(splash/内嵌)。

## 8. 验证工作流(改 UI 的必做项)

- 启动隔离实例:`electron . --remote-debugging-port=9223 --user-data-dir=/tmp/<name>`(同 daemon 只读连接,不打扰用户实例),CDP 驱动(`browser` 工具 `cdp_url` 连接)。
- 布局/动画断言:采样 getBoundingClientRect/background-position/getAnimations 帧轨迹;动画平滑度受窗口遮挡影响(后台窗口 rAF 节流),对比要同条件。
- 视觉确认:`tab.screenshot({selector})` + 视觉模型检查;重建用 `bun run build`(`desktop:run` 不重建,吃旧 dist)。
- 宠物验证:设置页 CDP attach 断言 10 卡 + 选中态 + 图标 14px;帧循环用 100ms 采样 `backgroundPosition` 枚举所见列(必须 ⊆ 有效列);真实光标用 Swift `CGEvent(mouseMoved/leftMouseDown/leftMouseUp).post(.cghidEventTap)`(AppleScript `set mouse position` 在 macOS 26 报 -2740);`screencapture -l <windowID>` 偶发全空帧是捕获伪影,验证闪烁用 `-R` 区域截图。
- **气泡/面板逐帧验证**(2026-08-11 套路):主窗口 eval `window.electronAPI.setPetVisible(true)` → `petSetPanel(true)`(创建 bubble 窗口)→ bubble target 内 rAF 推 `{iw, panel.getBoundingClientRect()}` 采样数组 → 主窗口 `toggleBubblePanel()` 触发 → 1.5s 后读采样。断言:面板 mount 帧 `opacity:0`、窗口 resize(事件)后才出现动画、面板 rect 全程在窗口内(`l ≥ -4 && r ≤ iw+4`,排除 scale 动画的微小越界);状态变化压缩打印(相邻相同帧折叠)。面板 toggle 走 `pet-toggle-panel`(发 `pet:panel-toggle` 事件)——`pet-set-panel` 只确保窗口存在,不会开面板。
- 注意:CDP 附加实例偶发 React onClick 委托失效(按钮无响应、键盘/直接 fiber 调用正常)——判定为环境产物,换键盘路径验证,勿当应用 bug。

## 9. 平台适配(2026-08-11)

- **原则**:跨平台特性按平台实现,不因"当前只有 macOS 实现"就把特性/设置项砍掉;只有**硬件层面 macOS 独有**的才隐藏。
- **haptic(macOS 唯一真正专属)**:Taptic Engine 是 macOS 硬件能力,Windows/Linux 无对应用层 API——渲染层 `lib/haptic.ts` 先查 `shellPlatform() === "darwin"`(preload 暴露 `platform`,web 构建为空串)再发 IPC;设置「通知与音效」的开关行**非 darwin 直接不渲染**;main.cjs handler 顶部 darwin 守卫。helper:`electron/haptic-helper.m`(clang 编译的常驻 stdin 进程,NSHapticFeedbackManager;JXA 桥对私有类 NSTrackpadHapticFeedbackPerformer 不暴露方法,osascript 方案 100% 失效),`build:haptic` 编译进 `bun run build`,asarUnpack 出包,dev 缺二进制时 main.cjs 懒编译。
- **keep-awake(跨平台)**:`caffeinate -i`(macOS 二进制)换成 Electron `powerSaveBlocker.start("prevent-app-suspension")`——macOS 映射 `kIOPMAssertionTypePreventUserIdleSystemSleep`(同 caffeinate -i),Windows `ES_SYSTEM_REQUIRED`,Linux ScreenSaver Inhibit;进程退出自动释放,无需杀子进程。
- **open-in-apps / open-with(跨平台)**:`appName` 统一为**绝对路径**(macOS `open -a` 同时接受显示名与路径),open-with 按平台启动——darwin `open -a <path> <dir>`/默认 `open <dir>`、win32 直接 spawn exe 或 `explorer.exe`、linux spawn 绝对路径或 `xdg-open`。发现列表:darwin 扫 /Applications 的 .app;win32 探测常见安装目录(Code/Cursor/Zed/JetBrains/notepad/wt);linux `which` 探测(nautilus/dolphin/终端/code/cursor/zed/kate/gedit)。空列表走渲染层既有 "no apps" 空态。
- **vibrancy/玻璃(跨平台)**:CSS 磨砂(backdrop-filter + 半透明 scrim + `--gui-glass-overlay`)全平台生效;原生 under-window 材质是 macOS 增强,别处 `setVibrancy` 静默 no-op——设置项保留。

## 10. 受管浏览器（Proma 吸收，2026-08-11）

右侧 Browser 工具从"独立 webview"升级为**受管浏览器**：Electron 主进程持有 `WebContentsView`（每 tab 一个），agent 的 browser 工具通过本地 CDP 桥**驱动同一个实例**——用户在面板里看到的页面就是 agent 操作的页面，登录状态天然共享（Proma browser-controller 模式）。

### 架构
- `electron/managed-browser.cjs`：`ManagedBrowserController` —— tab 生命周期（`persist:omp-managed-browser` 持久分区，凭据跨重启留存）、导航/加载状态、**活动账本**（脱敏：不含页面文本/Cookie/脚本全文）、布局投影（renderer 报 slot rect → 乘 zoomFactor → `view.setBounds`）、权限 deny-all、`agentActivity` 事件（agent 驱动隐藏 tab 时自动唤起面板）。
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

### 10.1 最佳实践（使用 + 工程）

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
- i18n：键先进对应域文件 `desktop-web/src/i18n/zh-CN/<domain>.ts`（英文 pass-through，en 域须同步，详见 `docs/i18n.md`），`t()` 只在 render 时，状态文案复用已有键。

## 12. 用量视图(usage.reports / 托盘 / ContextRing,2026-08-16)

**daemon RPC** `usage.reports`(server.ts,`session.askAnswer` 之后):会话态(`params.sessionId` → live session 的 `fetchUsageReports`)+ 全局态(无 sessionId,空态 composer 用 `ensureRegistry()` 起 registry)。返回 `{ reports, unreportedAccounts, disabledCredentials, reloginDeadlines, activeAccount? }` —— 与 TUI `/usage` 同源(`usage-shared.ts` 共享聚合),`activeAccount` 仅会话态有(● 标记)。

**数据形状**:每**凭据**一个 `UsageReport`(`provider` + `limits[]` + `metadata`);同 provider 多凭据 → GUI 端必须合并,否则:
- 渲染 key 用 `provider` → React 重复 key 警告(托盘历史 bug);
- 每凭据一个折叠区块 → 视觉上堆叠重复块(/usage 面板历史 bug)。

**合并算法**(`gui/src/components/composer/usage-panel.tsx` `UsageProviderSection`,托盘 `tray-menu-main.tsx` `buildUsageRows` 同款):
- 按 `provider` 分组 → 一个折叠区;按 `label|windowId` 分窗口 → 每个窗口一行;
- **列序是 provider 级固定序**:跨窗口平均用量降序、同分按标签 —— **禁止每窗口独立 worst-first 排序**(凭证会"左右乱窜",用户感知为错位)。列上限 4(`.slice(0, 4)`);
- 最右侧 `合计` 列:该窗口各凭据分数的**均值**(TUI 聚合语义),带分隔线;provider 排序 least-pressure 升序(TUI parity);
- 合计列 pct 只显示数字(`55%`,不带 "used")——52px 列宽放不下 "55% used"(截断过)。

**托盘菜单**(`gui-tray-menu`):固定窗口高 `TRAY_MENU_HEIGHT = 440`(main.cjs)——**不要动态 resize**(`tray-menu:set-size` IPC 已删);内容内部滚动(`__scroll` flex:1 + overflow-y:auto);footer padding `10px 10px 14px`(按钮距窗底有呼吸感)。窗口自身 acrylic(DWM),页面内容 chrome 即可。

**用量缓存**(`packages/ai` `AuthStorage.fetchUsageReports`,GUI/TUI/托盘共用):SQLite `cache` 表磁盘持久化 + 5min TTL(`USAGE_REPORT_TTL_MS`,±25% 抖动防 per-IP 429 fan-out)+ 上游失败 last-good 兜底(24h)+ in-flight 合并(多界面并发请求只打一次上游)。daemon 重启后缓存仍在;冷缓存首次查看会阻塞上游一轮(合并保证只一轮)。

**验证套路**:组件级 headless(bun build 临时 entry + 桩 `electronAPI.trayMenu`/props)→ 断言 DOM 列序/合计/无 key 警告;真实托盘需重启 Electron(主进程改动不热重载)。

## 13. slash 补全排序(2026-08-16)

`gui/src/lib/slash-rank.ts` `rankSlashEntries(entries, query, guiNative)`(会话 Composer `use-completion.ts` + WelcomeComposer 共用):
- 排序 tier:name 全等 > 名前缀 > 名子串 > 描述子串;层内 **GUI 原生命令优先**(usage/context —— composer 拦截开面板的命令,同层压过 `clear`/`compaction` 等 daemon 命令);
- 空 query 保持目录序(裸 `/` 列表不重排);非匹配项沉底保序(skill: 查询的幸存者不被丢弃);
- 纯函数 + 单测 `lib/slash-rank.test.ts`(tier/GUI 决胜/稳定序/沉底)。

## 14. 轨迹 Overview 时间轴 + 选择检视(2026-08-21,DSH Trajectory 吸收)

设计规范见 `gui-design.md` §1(轨迹时间轴与检视)。此处记数据契约与坑。

### 数据契约

- **`TrajectoryView` 新 props**:`roundDurations?: RoundDurationMap`(即 `ReadonlyMap<number, number> | readonly (readonly [number, number])[]`;GUI store 暴露 Map 形态,持久化快照/测试以数组形态出现)。来源 = daemon `agent_end` 冻结的整轮用时,键 = 该轮**末条 assistant 消息 tsMs**(`session-store.ts` / `MaterializedView.#roundDurations` 同源)。
- **`trajectory-data.ts`**:事件新增 `tsMs`(数值时间戳);`buildTrajectoryTree(entries, roundDurations?)` 输出的 `TrajectoryTurnGroup` 新增 `startMs`(组内首事件)/`endMs`(组内末事件;**roundDurations 命中时闭合为 `startMs + roundDurationMs`**)/`roundDurationMs`。未命中的 turn **绝不虚构**回合时长(replay/历史会话无 agent_end 即无)。
- **`isTrajectoryEventInRange(ev, startMs, endMs)`**:闭区间判定;**无 `tsMs` 的事件永不命中**(区间模式从不误亮未知时刻)。纯函数,组件与测试共用。
- **`usage` / `durationMs` / `ttftMs`(2026-08-21 补)**:wire `AssistantMessage` 自带 `usage(WireUsage)`/`duration`/`ttft`(settled 回合才有)——MaterializedView **整存 wire message**,所以 `snap.entries[].message` 原样携带,轨迹事件直接提取,**零 daemon 改动**;与 transcript usage 行(`desktop-web Transcript.tsx usageRow`,`display.showTokenUsage` 门控)同源。未 settled 的 assistant 事件不虚构统计。
- **`TimelineOverview`**:时间域 = 全部 turn 的 [最早 startMs, 最晚 endMs];无有效时刻(max ≤ min)直接返回 null 不渲染。

### 组件行为

- 拖拽区间:**pointer capture** + 位移 ≥3px 才提交;单击段 = 选中该整轮、单击空白 = 清除;`msAtClientX` 经 `getBoundingClientRect` 反算,零 re-render 依赖。
- Esc 键:**先清区间、再清选中**(`window` keydown,依赖 [range, selectedId]——与模态键盘契约同序)。
- 聚焦 = **置灰不裁剪**(`.traj-event--dim` 0.35 + saturate .6),DSH 同款"聚焦而非过滤"。

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

`packages/gui/test/trajectory.test.ts` 10 用例(tsMs 提取 / turn 时序 / roundDurations Map+数组形态 / 未命中不闭合 / 范围判定 / usage·duration·ttft 提取);`tsgo -p tsconfig.json --noEmit` 全绿;`bun run build:bundle` 通过。CDP/截图验证按 §8 工作流。

## 15. 消息树数据 seam(/tree 语义,2026-08-21)

命名规范化见 `docs/gui-design.md` §0(会话列表 / 消息树 / 轨迹 术语表)。此处记数据契约:

- **现状分裂**:TUI 消息树靠会话级 `session-manager` 的 `leafId()` 在建 entry 时写死 `parentId`(`session-manager.ts:1091`);wire message 事件**全程不带 parentId**;`MaterializedView` 投影消息时硬编码 `parentId: null`(`materialized-view.ts`),仅历史/持久化快照(`fromSnapshot` 原样存储)与老版 transcript 读取路径(server.ts ~397)保留真实 parentId。
- **已落地(向前兼容)**:
  - `wire/src/index.ts`:User/Developer/Assistant/ToolResult 四角色 message 加可选 `parentId?: string | null`(live 事件暂缺)。
  - `MaterializedView.#upsertMessage`:`parentId: message.parentId ?? null`(带即保留,缺即 null)。
  - `packages/gui/src/lib/message-tree.ts`:`buildMessageTree(entries)` / `flattenMessageTree`——从 entry 的 id/parentId 建分支树(孤儿作根、自环安全、兄弟保序);历史快照立即可用,测试 6 用例。
- **live 消息树的剩余 seam**:daemon 发射端在 message 事件上打标(`agentSession.sessionManager.leafEntry()?.parentId` 于转发点 server.ts `agentSession.subscribe` 处)——落实后 GUI 轨迹面板即可加「时间线/分支树」切换(复用 `buildMessageTree`)。TUI `/trace` 方案见 `docs/tui-trace-plan.md`。

## 16. 转录自定义消息渲染 + 流式 markdown 契约(2026-08-22)

`desktop-web` `components/transcript/Transcript.tsx` 的 `custom_message` 分支按 `entry.customType` 分派,已处理:

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
- `Markdown.tsx` `renderStreamingMarkdown`:流式时,已闭合的 `\n\n` 边界块立即渲染成 markdown(跨帧复用),**未定稿的尾块以 RAW TEXT 逐字累积**(单次入场动画);`streaming:false` 时只把尾块重解析为真 markdown(复用 head 块,避免整条 `md.parse` 的「卡一下才都渲染」)。
- 思考块按句过 `Markdown`(`tr-think-sentence--live` 入场)。
- DSH(`deepseek-harness`)同款增量:冻结除末尾两块外的全部为缓存 React 元素,尾块每 chunk 经 `IncrementalMarkdownParser` 重解析;已知偏差——跨冻结边界的 reference-style link/footnote 定义流式期字面显示,settle 全量解析自愈。

## 17. OTA 更新渠道 + 三合一按钮 run 级 working 语义（2026-08-22）

### OTA 更新渠道（GitHub release 资产重定向，bitfun parity）

三处同源，统一走 `/releases/latest/download/update-manifest.json`（302 到最新 release 资产，无 api.github.com 限流）：

| 位置 | 用途 | 默认值 |
|---|---|---|
| `gui/electron/updater.cjs` | 主进程 OTA 检查（`checkForUpdates`） | `RELEASE_MANIFEST_URL` 常量 |
| `gui/package.json` `update.manifestUrl` | 打包时覆盖默认 | 同 URL |
| `daemon/server.ts` `updates.check` | GUI `AnnouncementOverlay` 新版探测 | 同 URL（硬编码） |

- **解析顺序**（updater.cjs `manifestUrl()`）：`OMP_UPDATE_MANIFEST_URL` env → `package.json update.manifestUrl` → `RELEASE_MANIFEST_URL` 默认。
- **404 优雅降级**：repo 公开前 `releases/latest` 404 → `{enabled:false, reason:"no-update-source"}`，设置页显示「尚未发布公开更新源（发布后可用）」；`updates.check` 返回 `{latest:null}`，公告面板不弹。
- **发版契约**：`update-manifest.json`（`{version,url,notes}`）作为名为 `update-manifest.json` 的资产随每个 GitHub release 上传——`/releases/latest/download/<asset>` 自动重定向到最新拷贝，无需改分支。**url 填 dmg 直链、notes 填新功能说明、version 与 package.json 一致**。
- **初始化不能写死 raw.githubusercontent**：旧渠道 `raw.githubusercontent.com/MuseLinn/MusePi/main/packages/gui/update-manifest.json` 在 repo 私有时必 404（等于死链），已全部切到 release 资产。

### 三合一发送/停止按钮：run 级 working（turn 级边界陷阱）

`SendOrStopButton`（`gui/src/components/composer/action-buttons.tsx`）idle 显示发送箭头，working 态变胶囊 + 点阵 bloom + 两标签（「工作中」/「停止」，hover 互换）。**关键陷阱**：

- **`turn_end` 是每工具批次发一次，不是 run 结束**（`agent-loop.ts` `pushTurnEnd` 每个 tool batch 一次；`types.ts`: "a turn is one assistant response + any tool calls/results"）。若用 `turn_end` 清 working，**轮间 provider 准备期按钮会闪回发送箭头**（用户报告 2026-08-22）。
- **正确定界**（`gui/src/lib/session-store.ts`）：`agent_start`/`turn_start`/user `message_start` → `#working = true`；`turn_end` **只清 `#streaming`**；`agent_end` 才清 `#working` + `#streaming`；daemon `{kind:"state", payload:{isStreaming}}` 帧做权威纠正（中止无 turn_end 时兜底）。
- **`#buildSnapshot` 的 OR 陷阱**：旧代码 `working: this.#working || snap.state.isStreaming`——view 的 turn 级 `isStreaming` 在无 turn_end 的中止路径会卡 `true`，把已复位的标志 OR 回去，stop 胶囊永不熄灭。**已改为 store 单一事实源** `working: this.#working`，构造时用 resume snapshot `state.isStreaming` 播种（中途加入正在工作的会话也正确显示）。
- **测试**：`packages/gui/test/session-store.test.ts` 覆盖「run 级边界不闪回 + agent_end 才熄灭 + state 帧兜底」。改按钮/指示器语义先看该文件的 switch 与 `#buildSnapshot`。

### 更新提示 toast（bitfun DailyAppUpdateGate parity）

- 主进程 `main.cjs` 启动后 12s 静默检查，`checkForUpdates()` 得 `newer` 则 `webContents.send("update-available", result)`。
- 渲染端 `UpdateToast.tsx`（`gui/src/components/UpdateToast.tsx`）订阅 `onUpdateAvailable`（preload 暴露），右下角卡片：版本（v当前 → v最新）+ notes + 「前往下载」/「跳过此版本」。
- **「跳过此版本」按版本记忆**（`localStorage["musepi-update-skip-version"]`，bitfun 同款）——同一版本不再打扰；**更新说明与「新功能」弹窗是两条独立链路**：toast 读 `update-manifest.json` 的 `notes`，弹窗读 `CHANGELOG.musepi.md`，发版两处都要填。
- 桥接统一走 `gui/src/lib/electron.ts` 的 `ElectronAPI.checkUpdates/onUpdateAvailable` + `UpdateCheckResult` 类型（不在组件里内联 window 断言）。

### 发布产物与 CLI 关系（2026-08-23 实测确认）

**dmg 自包含 daemon，不依赖 `bun run setup` 污染系统**：`daemonCommand()`（`electron/daemon.cjs`）解析顺序——① PATH 上的 `musepi`（仅当用户单独装过）→ ② **打包版 `Resources/app.asar.unpacked/vendor/daemon/musepi`（120M 完整 CLI 二进制，workflow 的 "Build daemon binary + Stage 进 vendor + asarUnpack vendor/daemon/**" 保证必达）** → ③ dev 模式 `bun src/cli.ts serve`。

**发布链路要点**：
- `gui-release.yml` 只发布 **darwin-arm64**（砍掉 x64——x64 runner 打 arm64 dmg 缺 `sherpa-onnx-darwin-arm64` 架构变体，electron-builder 结构性失败）。
- **签名**：mac `identity "-"`（ad-hoc）+ hardenedRuntime + `build/entitlements.mac.plist`（照 openchamber：allow-jit / disable-library-validation 等，解决 Electron JIT + dlopen 原生模块）。ad-hoc 仅消除「完全无签名显已损坏」，**双击打开仍被 Gatekeeper 拦**——要「双击直开」需 Developer ID 签名 + `notarize: true`（需 APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID secrets；workflow `MACOS_SIGNING` 条件已预留）。
- **不像 VSCode**：app 自带 daemon 供 GUI 用，但**不注册 PATH**（`extraResources: []`、无 CLI symlink）。终端敲 `musepi` 默认没有；要终端 CLI 需 `bun run setup`/`bun link` 或 `bun install -g @musepi/pi-coding-agent`，或给 electron-builder 加 `afterInstall` 符号链接钩子（需管理员权限，且与单独装的 CLI 可能冲突——用户决策项）。
