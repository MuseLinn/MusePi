# musepi-omp 插件/扩展体系能力清单

调研日期 2026-10-06。仓库 `C:\Users\unive\projects\harness-engineering\musepi-omp`。
每条结论带 `文件路径:行号`；无证据处显式标注「推测，未验证」。

行号以工作区当前文件为准（`[System.IO.File]::ReadAllLines` 计行，1-based）。

---

## 1. 插件包形态

### 1.1 npm 包结构

插件就是一个普通 npm 包，安装到 `~/.musepi/plugins/node_modules/<name>`：

- 插件根目录与 manifest 路径：`packages/coding-agent/src/extensibility/plugins/manager.ts:229-230`（`getPluginsDir()` + `getPluginsNodeModules()` 建目录）
- 宿主自身也是一个 npm 包：`plugins/package.json` 名为 `musepi-plugins`、private — `manager.ts:239-250`
- 运行时配置锁文件 `musepi-plugins.lock.json`：`manager.ts:191`（`getPluginsLockfile()`）
- bun lockfile `~/.musepi/plugins/bun.lock`：`manager.ts:514`
- 项目级覆写：`manager.ts:214`（`getProjectPluginOverridesPath(cwd)`）

### 1.2 `package.json` 的 `musepi` 块

**权威字段是 `musepi`，`omp`/`pi` 为旧上游兼容遗留（继续可读）**：

- 扩展侧读清单：`packages/coding-agent/src/extensibility/extensions/loader.ts:788-793`
  ```
  const manifest = pkg.musepi ?? pkg.omp ?? pkg.pi;
  ```
- 插件侧读清单：`packages/coding-agent/src/extensibility/plugins/loader.ts:308`（同形态）
- 插件清单 config/resources/components 解析：`packages/coding-agent/src/extensibility/extensions/plugin-manifest.ts:70-77`
- 能力报告侧：`packages/coding-agent/src/extensibility/plugins/capability-report.ts:111`（`[musepi, omp, pi]` 顺序遍历）
- `installer.ts:84,133` 也读 `pkg.musepi || pkg.omp || pkg.pi`

`musepi` 块声明的字段（权威类型在 wire 包）：

| 字段 | 类型定义位置 | 说明 |
|---|---|---|
| `extensions` | `packages/wire/src/plugin-config.ts:47-52`（`PluginComponentDecl` 另见 loader.ts:780-783） | 入口文件数组 |
| `config` | `packages/wire/src/plugin-config.ts:12-30`（`ConfigFieldDesc`） | 配置字段表，类型 `boolean\|number\|string\|select\|path`，带 `min/max/step/options/label/restart` |
| `resources` | `packages/wire/src/plugin-config.ts:33-38`（`PluginResources`） | `disk`/`memory`/`setupMinutes`/`models` 资源卡 |
| `components` | `packages/wire/src/plugin-config.ts:47-52`（`PluginComponentDecl`） | 「包含的组件」子单元声明，带 `entry` 的是独立装载单元 |

`PluginManifest` 另有 `tools` / `hooks` / `commands` / `features` / `version` — `packages/coding-agent/src/extensibility/plugins/types.ts`（由 `manager.ts:31` 导入）。

### 1.3 入口文件形态

**default-export factory**：`(pi: ExtensionAPI) => void | Promise<void>`。

- 提取逻辑：`packages/coding-agent/src/extensibility/extensions/loader.ts:78-81`
  ```
  const candidate = typeof module === "function" ? module : module.default;
  return typeof candidate === "function" ? candidate : null;
  ```
  即 **bare function export 或 `.default` 都接受**。
- 无有效 factory 的诊断：`loader.ts:632`（`Extension does not export a valid factory function`）
- 入口解析顺序（目录）：manifest `extensions` 优先 → `index.ts` → `index.js` — `loader.ts:814-858`（`resolveExtensionEntries`）
- manifest 声明的入口若全部不存在，则**回落到 index.ts/js**（`loader.ts:829-831` 的 `if (entries.length > 0)`）；注意这与 `plugins/loader.ts:336-338` 注释宣称的「manifest 权威、抑制 index 回落」语义**不一致**（见 §9 缺口）。
- 目录扫描规则（不递归超过一层）：`loader.ts:860-906`（`discoverExtensionsInDir`）
- 内置 hook 目录约定 `hooks/pre/` `hooks/post/`：`loader.ts:907-925`

---

## 2. 装载与发现

### 2.1 `ExtensionRuntime`

`packages/coding-agent/src/extensibility/extensions/loader.ts:93-193`。

- 承载三张**待处理队列**（延迟到会话初始化再落地）：
  - `pendingProviderRegistrations` — `loader.ts:95`
  - `pendingMediaProviderRegistrations` — `loader.ts:96`
  - `pendingDesignSystemRegistrations` — `loader.ts:97`
- 所有 action 方法（`sendMessage`/`setModel`/`getCommands`/…）在未初始化时**抛 stub 错误** `ExtensionRuntimeNotInitializedError` — `loader.ts:83-87`，逐方法见 `loader.ts:130-192`。这是「注册与运行时分离」铁律的实现。

### 2.2 `discoverExtensionPaths` 的四类来源

`packages/coding-agent/src/extensibility/extensions/loader.ts:947-1046`，四类：

| # | 来源 | 行号 | 场景 |
|---|---|---|---|
| 1 | capability API — `extensionModuleCapability`，provider 限 `["native", "musepi-extensions"]` | `loader.ts:984-990` | ambient：`.omp`/`.pi` 原生扩展 + `~/.musepi/agent/extensions` 自有扩展。**刻意跳过 claude/codex/gemini/opencode 外部扩展目录**（注释见 `loader.ts:977-983`，引用 #4198） |
| 2 | `hookCapability` 的 JS/TS hook factory | `loader.ts:997-1005` | ambient 钩子；非 ambient 时只扫本次 configuredPaths 的包内 `hooks/{pre,post}`（`loader.ts:1006-1010`） |
| 3 | 已安装插件入口 `getAllPluginExtensionPaths(cwd)` | `loader.ts:1013-1015` | `~/.musepi/plugins/` 装出来的插件 |
| 4 | **显式 configuredPaths** | `loader.ts:1017-1043` | 用户手写：目录走 manifest/index/一层扫描（`loader.ts:1028-1039`），否则当单文件直接收（`loader.ts:1042`）。等价 DSH 的「用户 patch 层插自定义行」 |

- 去重：`loader.ts:960-966`（`seen` Set 按 resolved path）
- 禁用过滤：`loader.ts:958` — 只按 `extension-module:<name>` 前缀 id 过滤
- `ambient` / `includeAmbientHooks` 开关：`loader.ts:940-945`
- 组合入口 `discoverAndLoadExtensions`：`loader.ts:1053-1062`

### 2.3 加载管线

`loadExtensions` → `loader.ts:756-777`：

1. **兼容性预检先于任何 import** — `loader.ts:740-754`：读 `agentDir/compatibility.json` 豁免清单，`compatibilityGateForExtensionPath` 判定；非 `exempted` 的不兼容项直接进 errors 不 import（`loader.ts:747-750`）。豁免命中放行但打警告（`loader.ts:751`）。
2. `importExtensionModule` 逐路径 import（`Promise.all`，互相不阻塞）— `loader.ts:756`
3. `bindExtension` 逐个跑 factory — `loader.ts:760`
4. 单个失败只进 `errors`，不 abort 整体 — `loader.ts:762-765`

### 2.4 discovery provider 优先级（跨 harness 的覆盖序）

`packages/coding-agent/src/discovery/agent-plugins.ts:39-41` 注释说明排序意图。实测各 provider 的 `PRIORITY`：

| provider | priority | 文件:行 |
|---|---|---|
| builtin-defaults | 1 | `discovery/builtin-defaults.ts:22` |
| vscode | 20 | `discovery/vscode.ts:16` |
| github | 30 | `discovery/github.ts:42` |
| cline | 40 | `discovery/cline.ts:17` |
| cursor / windsurf | 50 | `discovery/cursor.ts:37`, `discovery/windsurf.ts:31` |
| opencode | 55 | `discovery/opencode.ts:45` |
| gemini | 60 | `discovery/gemini.ts:41` |
| agents / claude-plugins / codex | 70 | `discovery/agents.ts:28`, `discovery/claude-plugins.ts:32`, `discovery/codex.ts:44` |
| agent-plugins（agent-plugins.org 标准） | 75 | `discovery/agent-plugins.ts:41` |
| claude | 80 | `discovery/claude.ts:35` |
| omp-plugins | 90 | `discovery/omp-plugins.ts:47` |
| builtin（native） | 100 | `discovery/builtin.ts:42` |

### 2.5 capability 缝（18 个能力通道的声明面）

`packages/coding-agent/src/capability/`，每个文件一个能力定义：

| 能力 id | 文件:行 |
|---|---|
| `context-files` | `capability/context-file.ts:28` |
| `extension-modules` | `capability/extension-module.ts:24` |
| `extensions` | `capability/extension.ts:38` |
| `gui-motion` | `capability/gui-motion.ts:31` |
| `hooks` | `capability/hook.ts:28` |
| `mcps` | `capability/mcp.ts:95` |
| `instructions` | `capability/instruction.ts:26` |
| `prompts` | `capability/prompt.ts:24` |
| `rules` | `capability/rule.ts:287` |
| `settings` | `capability/settings.ts:24` |
| `skills` | `capability/skill.ts:59` |
| `slash-commands` | `capability/slash-command.ts:26` |
| `ssh` | `capability/ssh.ts:32` |
| `tools` | `capability/tool.ts:28` |
| `system-prompt` | `capability/system-prompt.ts:25` |
| rules 默认源 | `capability/rule.ts:18`（`BUILTIN_DEFAULTS_PROVIDER_ID = "builtin-defaults"`） |

`native` provider（`discovery/builtin.ts`）**一次性注册全部能力面** — 导入见 `discovery/builtin.ts:11-25`（context-file / extension / extension-module / hook / instruction / mcp / prompt / rule / settings / skill / slash-command / system-prompt / tool 共 13 类）。

---

## 3. 注册面（全集）

`ExtensionAPI` 接口定义：`packages/coding-agent/src/extensibility/extensions/types.ts:1237-1684`。
能力缝声明头注释：`types.ts:10-27`。

### 3.1 模块访问（4 项）

| 成员 | 行号 |
|---|---|
| `pi.logger` | `types.ts:1243` |
| `pi.typebox`（legacy shim） | `types.ts:1246` |
| `pi.arktype` | `types.ts:1249` |
| `pi.zod` | `types.ts:1252` |
| `pi.pi`（coding-agent 导出） | `types.ts:1255` |

### 3.2 事件订阅 `pi.on(...)` — 48 个事件

`types.ts:1261-1321`。全集：

`resources_discover`、`session_start`、`session_before_switch`、`session_switch`、`session_before_branch`、`session_branch`、`session_before_compact`、`session.compacting`、`cache_warming_decision`、`session_compact`、`session_shutdown`、`session_before_tree`、`session_tree`、`context`、`before_provider_request`、`after_provider_response`、`before_agent_start`、`agent_start`、`agent_end`、`session_stop`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`auto_compaction_start`、`auto_compaction_end`、`auto_retry_start`、`auto_retry_end`、`retry_fallback_applied`、`retry_fallback_succeeded`、`ttsr_triggered`、`todo_reminder`、`goal_updated`、`credential_disabled`、`input`、`tool_approval_requested`、`tool_approval_resolved`、`tool_call`、`tool_result`、`user_bash`、`user_python`、`mcp_notification`。

### 3.3 `register*` 面 — 21 个方法

| 方法 | 声明 | 实现 | 落入的 `Extension` 字段 |
|---|---|---|---|
| `registerTool` | `types.ts:1328` | `loader.ts:265-272` | `tools` |
| `registerFileWriteFallback` | `types.ts:1359` | `loader.ts:274-276` | `fileWriteFallbackHandlers` |
| `registerFileDeleteFallback` | `types.ts:1384` | `loader.ts:278-280` | `fileDeleteFallbackHandlers` |
| `registerCommand` | `types.ts:1391` | `loader.ts:282-291` | `commands` |
| `registerSetting` | `types.ts:1403` | `loader.ts:293-295` | `settings` |
| `registerComponent` | `types.ts:1409` | `loader.ts:297-304` | `components` |
| `registerRpc` | `types.ts:1417` | `loader.ts:306-314` | `rpcs` |
| `registerSkill` | `types.ts:1423` | `loader.ts:316-…` | `skills` |
| `registerToolView` | `types.ts:1430` | `loader.ts:323-…` | `toolViews` |
| `registerPrompt` | `types.ts:1435` | `loader.ts:337-…` | `promptSections` |
| `registerMode` | `types.ts:1441` | `loader.ts:341-…` | `modes` |
| `registerShortcut` | `types.ts:1444` | `loader.ts:349-…` | `shortcuts` |
| `registerFlag` | `types.ts:1453` | `loader.ts:359-…` | `flags` |
| `registerMessageRenderer` | `types.ts:1495` | `loader.ts:369-…` | `messageRenderers` |
| `registerAssistantThinkingRenderer` | `types.ts:1498` | — | `assistantThinkingRenderers` |
| `registerNotificationChannel` | `types.ts:1512` | — | `notificationChannels` |
| `registerService` | `types.ts:1521` | — | `services` |
| `registerThemeToken` | `types.ts:1530` | — | `themeTokens` |
| `registerStatusBarSegment` | `types.ts:1537` | — | `statusBarSegments` |
| `registerProvider` / `unregisterProvider` | `types.ts:1641`, `1649` | `loader.ts:525-533` | 走 runtime 队列（非 Extension 字段） |
| `registerMediaProvider` / `unregisterMediaProvider` | `types.ts:1658`, `1664` | `loader.ts:535-543` | `mediaProviders` + runtime 队列 |
| `registerDesignSystem` / `unregisterDesignSystem` | `types.ts:1675`, `1681` | — | `designSystems` + runtime 队列 |

另有两个在 `LEDGERED_VERBS` 中但**不在 `ExtensionAPI` 接口签名里**的动词（见 §4.3）：
`registerComposerShape`、`registerProvider`（后者有，见上）。

### 3.4 查询 / 动作面

| 成员 | 行号 |
|---|---|
| `setLabel` | `types.ts:1463` |
| `getFlag` | `types.ts:1466` |
| `pi.config.get` / `pi.config.getAll` | `types.ts:1483-1488`，实现 `loader.ts:241-257` |
| `sendMessage` | `types.ts:1548` |
| `sendUserMessage` | `types.ts:1554` |
| `appendEntry` | `types.ts:1560` |
| `exec` | `types.ts:1563` |
| `getActiveTools` / `getAllTools` / `setActiveTools` | `types.ts:1566`, `1569`, `1572` |
| `getCommands` | `types.ts:1575` |
| `setModel` | `types.ts:1578` |
| `getThinkingLevel` / `setThinkingLevel` | `types.ts:1581`, `1584` |
| `getServiceTiers` / `setServiceTier` | `types.ts:1587`, `1593` |
| `getSessionName` / `setSessionName` | `types.ts:1599`, `1602` |
| `pi.events`（EventBus） | `types.ts:1683` |

### 3.5 `registerComponent` 的槽位全集

**单一权威**：`packages/collab-proto/src/extension-slots.ts:12-23`。

- exact 槽（7 个）：`extension-slots.ts:13-21` — `panel.right`、`rail.right`、`settings.extensions`、`composer.dock`、`composer.left`、`composer.right`、`transcript.node`
- prefix 槽族（5 个）：`extension-slots.ts:22` — `panel.tab.`、`settings.tab.`、`rail.`、`settings.item.`、`settings.action.`
- 注册时**未知槽名直接抛错**（扩展整体加载失败，fail-loud 不静默）：`loader.ts:297-304`（`assertKnownComponentSlot`）；诊断文案 `types.ts:298-301` 注释
- 能力报告侧镜像同一组常量（防漂移但**是复制而非引用**）：`capability-report.ts:72-87`

### 3.6 `registerTranslations`（i18n）

插件/扩展文案注册是**两套并列的运行时 seam**，不是 `pi.extensions` 的方法：

- GUI/渲染端：`packages/client-core/src/i18n/index.ts:140`（`registerTranslations`），导出 `packages/client-core/src/index.ts:96`；GUI 宽松查键 `tLoose` 在 `packages/client-core/src/i18n/index.ts:129`，导出 `packages/client-core/src/index.ts:102`
- TUI/CLI 端：`packages/coding-agent/src/i18n/index.ts:64`（同名不同实现，`TranslationMap` 类型）
- 内置代码也在用这个 seam（自证是公共面）：`packages/desktop-app/src/i18n/voice.ts:95,101`、`packages/desktop-app/src/i18n/preview.ts:21,27`
- 注释明确「the same runtime seam plugins use」：`packages/desktop-app/src/i18n/voice.ts:5`

### 3.7 `registerRpc` 的运行时限制

`types.ts:1411-1417` 与 `types.ts:2195-2199`：handler 跑在 daemon 的扩展加载上下文，**裸 runtime** —— `pi.exec`/`pi.logger`/纯计算可用，会话绑定动作（`sendMessage`/`setModel`）不可用。

### 3.8 `registerSkill` 的边界

`types.ts:1419-1423` + `types.ts:2205-2215`：虚拟技能（无 backing SKILL.md），`content` 为 SKILL.md 风格 markdown。消费面在 `daemon/services/marketplace-service.ts:225`（合并进 `skills.list`）。

---

## 4. 生命周期

### 4.1 启停粒度

三个层级，互不重叠：

**① 整包启停** — `extensions.setEnabled` → `settings.disabledExtensions`
- RPC：`daemon/services/extension-service.ts:84`
- 实现：`extension-service.ts:493-598`，写 `disabledExtensions` 于 `extension-service.ts:584,592`
- id 形态 `kind:name`：`extensions-center/types.ts:221`（`makeExtensionId`）
- loader 侧消费：`loader.ts:958`（`extension-module:<name>`）、`capability/index.ts:138`
- MCP 特例：`mcp:` 前缀走 denylist 对账 — `extension-service.ts:577-584`

**② 插件「包含的组件」独立启停** — `extensions.setComponentEnabled`
- RPC：`extension-service.ts:88`，路由 `daemon/server.ts:2054-2056`
- 实现：`extension-service.ts:608-670`
- **内置单元径**（`builtin-registry` 声明了 `components`）：写隐藏黑名单键，key/id 由 `componentDenyTarget(declared.deny, component)` 映射 — `extension-service.ts:659-664`。deny 通道定义见 `extensions-center/builtin-registry.ts:190-195`：`tool` → `tools.disabled`、`browser-backend` → `browser.disabledBackends`、`file-backend` → `file.disabledBackends`、以及 stt/tts/terminal 引擎通道
- **user 插件径**（`extension-module:<name>`）：先经 cordis fiber 运行时真实挂载/拆卸，成功才持久化 — `extension-service.ts:630-656`；失败时先 reconcile 再重试一次（`extension-service.ts:639-644`）
- 未声明组件直接拒绝（不发明语义）— `extension-service.ts:624`, `657`
- 存储键：`<plugin>/<component>` — `extension-service.ts:646`；设置键 `disabledExtensionComponents` 声明在 `config/settings-schema.ts:667`
- TUI 侧同径：`extensions-center/extension-dashboard.ts:270`, `301`

**③ 内置镜像设置** — `settingsMirror`
- 声明：`extensions-center/builtin-registry.ts` 每项的 `settingsMirror`
- 读回：`builtin-registry.ts:638-643`（`builtinMirrorDisabled`；`unsetDisabled` 项未设置时按禁用）
- 消费点：`daemon/services/extension-service.ts:231,245`、`extensions-center/state-manager.ts:748`

另有 **provider 级** `extensions.setProviderEnabled` — `extension-service.ts:86,726`；
以及 **`extensions.setForceEnabled`**（与 disabled 正交，显式启用被优先级 shadow 的同名项）— `extension-service.ts:85,700-723`。

### 4.2 HMR / `reloadExtension`

**watcher（500ms debounce）** — `daemon/server.ts:1011-1047`：
- `fs.watch(root, { recursive: true })` 挂在 `resolveExtensionWatchRoots` 解析出的根上 — `server.ts:1014-1028`
- tick 动作（`server.ts:1031-1047`）：失效 extensions 扫描缓存（`server.ts:1035`）→ 失效 marketplace skills 缓存（`server.ts:1038`）→ 失效组件编译缓存 `invalidateExtensionCaches`（`server.ts:1039`）→ 广播 `extensions.changed`（`server.ts:1040`）→ 会话级重载（`server.ts:1045`）
- watcher 回调的 filename 在 Windows 递归 watch 下不可靠 → **改用逐文件 mtime 比对决定谁要重载** — `server.ts:1042-1044` 注释

**源码图 mtime 快照**（v2，子模块改动也热生效）：
- 图走查 `collectExtensionModules` — `extensibility/plugins/legacy-pi-compat.ts:2079`（另见 `2294`、`2573`）
- 变更判定 `extensionEntriesNeedingReload` — `legacy-pi-compat.ts:1903-1932`。无快照的入口**一律报为 changed**（`legacy-pi-compat.ts:1908-1911`，宁可多一次重读也不漏真编辑）；mtime 比较用 `!==` 而非 `>`（`legacy-pi-compat.ts:1922-1925`）
- cache-bust tag 单调递增 `nextLegacyPiLoadTag` — `legacy-pi-compat.ts:2039`，用于给相对 import 加 `?mtime=`（`legacy-pi-compat.ts:2679`）

**runner 层重载** — `extensibility/extensions/runner.ts:1060-1092`：
1. 找不到入口 → 空结果（`runner.ts:1063-1065`）
2. **重载失败保留旧实例**（无回滚，因为尚未改动任何东西）— `runner.ts:1069-1073`
3. 旧 handlers 先清空，防同一事件双跑 — `runner.ts:1077-1079`
4. `toolRegistrationListeners` 带到新实例 — `runner.ts:1082-1084`
5. `extensions[index]` 原地替换 + 记录新 mtime（`runner.ts:1085-1086`）
6. 停旧服务 / 启新服务 / 重放 theme token — `runner.ts:1087-1089`

**会话层忙门控** — `session/agent-session.ts:4742-4771`：
- `isStreaming` 时挂起到**单槽 pending**，返回 `{ deferred: true }` — `agent-session.ts:4745-4748`
- `#performExtensionReload` 只删除**新模块未重注册**的旧工具名 — `agent-session.ts:4766-4769`
- prompt 区块随之重建（防止混代）— `agent-session.ts:4762`
- 同样门控也用于运行时加载 `loadExtension` — `agent-session.ts:4781-4791`

**广播链路** `extensions.changed`：
- 产生点 `EventService.broadcastExtensionsChanged` — `daemon/services/event-service.ts:83-87`
- watcher 触发 — `server.ts:1040`
- 各类服务变更后也扇出：`extension-service.ts:38`, `654`, `668`, `696`, `721`；`marketplace-service.ts:30,314,333`
- 事件载荷形态 — `event-service.ts:13`

**`extensions.reloaded`（会话内事件）** — `server.ts:1108-1133`：
- 载荷 `{ extensionPath, removedTools, errors, deferred, at }` — `server.ts:1111-1118`
- 走标准 seq 编号空间（journal + view 同一序号）— `server.ts:1119-1124`

### 4.3 cordis 动态装载：verb ↔ 撤销账本

`daemon/cordis-dynamic-extensions.ts`：
- `LEDGERED_VERBS` 共 23 个 — `cordis-dynamic-extensions.ts:309-334`（含 `on` + 22 个 `register*`）
- 每个 verb 的卸载撤销逻辑 — `cordis-dynamic-extensions.ts:359-519`（`undoRegistration`，`default` 返回空函数 `cordis-dynamic-extensions.ts:516-517`）
- 跨扩展 command 名碰撞守卫 — `cordis-dynamic-extensions.ts:525-526`, `840`, `853`
- 动态插件组 fiber — `cordis-dynamic-extensions.ts:536-546`
- 组件启停 user 插件径 — `cordis-dynamic-extensions.ts:787-791`

---

## 5. 安装面

### 5.1 `PluginManager` 能力全集

`packages/coding-agent/src/extensibility/plugins/manager.ts:178-1155`。类 `PluginManager` 于 `manager.ts:178`。

| 能力 | 行号 |
|---|---|
| `install(spec, options)` | `manager.ts:484-702` |
| `uninstall(name)` | `manager.ts:707-735` |
| `list()` | `manager.ts:740-791` |
| `link(localPath)` | `manager.ts:796-853` |
| `setEnabled(name, enabled)` | `manager.ts:862-869` |
| `setPluginEnabled(name, enabled)` | `manager.ts:472-482` |
| `getEnabledFeatures` / `setEnabledFeatures` | `manager.ts:878-881`, `886-909` |
| `getPluginSettings` / `setPluginSetting` / `deletePluginSetting` | `manager.ts:918-926`, `931-938`, `943-949` |
| `doctor(options)`（含 `--fix`） | `manager.ts:958-1113` |
| 模块函数 `validateSetting` | `manager.ts:1169-1203` |
| 模块函数 `parseSettingValue` | `manager.ts:1208-1218` |

`install` 的 spec 形态：`manager.ts:452-465` 注释 —— npm spec（可带 `[features]`）、namespaced git shorthand、完整 git URL、tarball、绝对路径。校验：`validatePackageName`（`manager.ts:52-62`）/ `validateGitSpec`（`manager.ts:71-75`）。

### 5.2 spec 分类（刚新增的安装面）

`packages/coding-agent/src/extensibility/plugins/spec-classifier.ts`：
- 四类：`registry` / `git` / `tarball` / `path` — `spec-classifier.ts:27`，联合类型 `spec-classifier.ts:29-46`
- 非法 spec 抛 `InvalidInstallSpecError` — `spec-classifier.ts:49-57`
- git shorthand host 表 — `spec-classifier.ts:64-72`
- 已知 forge host 白名单 — `spec-classifier.ts:101-110`
- 本地路径必须绝对（相对路径会解析到插件目录内）— `spec-classifier.ts:12-15` 注释
- 分类器**不碰文件系统** — `spec-classifier.ts:17-19` 注释

### 5.3 安装状态机（刚新增）

`packages/coding-agent/src/extensibility/plugins/plugin-install-machine.ts`：
- 状态集 `inspecting`/`installing`/`done`/`failed`/`cancelled` — `plugin-install-machine.ts:46`
- 失败分类 `spec`/`scripts`/`install`/`unknown` — `plugin-install-machine.ts:58`
- 终态记录保留 20 条 — `plugin-install-machine.ts:115`
- 单安装输出保留 2000 行 — `plugin-install-machine.ts:118`
- 同 spec 并发安装拒绝（会争抢同一个 plugins/package.json）— `plugin-install-machine.ts:164-171`
- **没有 `awaiting-approval` 阶段**，理由写在 `plugin-install-machine.ts:28-37`：`bun install` 不传 `--trust`，bun 默认不执行依赖 lifecycle 脚本，所以拖入的包跑不了自己的 postinstall，没有可拦的东西
- 停机等待回滚落地 — `plugin-install-machine.ts:217-243`

### 5.4 daemon L2 服务与 5 个 RPC

`packages/coding-agent/src/daemon/services/plugin-install-service.ts`：
- routes 表 — `plugin-install-service.ts:77-83`：`plugins.install` / `plugins.install.status` / `plugins.install.cancel` / `plugins.install.output` / `plugins.uninstall`
- `done` 时额外失效插件缓存 + 广播（否则 GUI 显示一个永不上线的插件）— `plugin-install-service.ts:95-100`
- 事件载荷：`plugins.install.state`（`plugin-install-service.ts:103`）、`plugins.install.output`（`plugin-install-service.ts:105`）
- 卸载是阻塞的，不走状态机 — `plugin-install-service.ts:143-155`
- daemon 停机取消全部在途安装 — `plugin-install-service.ts:157-164`

### 5.5 GUI 安装面

- 对话框 `packages/desktop-app/src/components/PluginInstallDialog.tsx:60`（含拖放区 `:175-…`）
- 挂在工具栏 — `packages/desktop-app/src/components/UnifiedPluginsView.tsx:582`
- 拖入取路径走 preload `webUtils.getPathForFile` — `PluginInstallDialog.tsx:144`，preload 暴露 `getDroppedFilePath`（类型 `packages/desktop-app/src/env.d.ts:15`）
- 渲染端重载后**重认领**在途安装 — `PluginInstallDialog.tsx:119-157`

### 5.6 CLI 侧 — `musepi plugin <verb>` 全部存在

`packages/coding-agent/src/cli/plugin-cli.ts:153-181` 的 dispatch 表：

| verb | 行号 |
|---|---|
| `install` | `plugin-cli.ts:153`（实现 `:345-…`，usage `:351-357`） |
| `uninstall` | `plugin-cli.ts:156`（实现 `:464-…`） |
| `list` | `plugin-cli.ts:159`（实现 `:535-…`） |
| `link` | `plugin-cli.ts:162`（实现 `:589-…`） |
| `doctor` | `plugin-cli.ts:165`（实现 `:609-…`） |
| `config` | `plugin-cli.ts:171`（实现 `:741-…`，`config validate` `:869-…`） |
| `enable` | `plugin-cli.ts:174`（实现 `:903-…`） |
| `disable` | `plugin-cli.ts:177`（实现 `:911-…`） |
| `marketplace` | `plugin-cli.ts:180`（实现 `:206-…`） |
| `discover` | `plugin-cli.ts:284-…` |
| `upgrade` | `plugin-cli.ts:308-…` |
| `features` | `plugin-cli.ts:648-…` |

`musepi plugin install` usage 明示支持 `@musepi/exa`、`name@marketplace`、`github:user/repo`、`https://github.com/user/repo#v1.0`、`./path/to/local/plugin` — `plugin-cli.ts:353-357`。

另有别名命令 `install-extension`（`plugin install`/`plugin link` 的别名）— `packages/coding-agent/src/cli/command-help.ts:68`。

### 5.7 marketplace

`packages/coding-agent/src/extensibility/plugins/marketplace/`：
- `MarketplaceManager` — `marketplace/manager.ts:81`，构造选项 `marketplace/manager.ts:57-77`
- `addMarketplace(source)` — `marketplace/manager.ts:98-…`（重复名拒绝 `:104-109`）
- 注册表 `registry.ts`（marketplaces + installed_plugins 两张表）
- `.claude-plugin/marketplace.json` 目录清单解析 — `marketplace/fetcher.ts`（`fetcher.ts:199` 被 `docs/extensions-dev.md §16` 引用）
- 源分类 `classifySource`（local / git）— `marketplace/manager.ts:116`
- CLI 侧构造 `makeMarketplaceManager` — `plugin-cli.ts:196-205`
- TUI 侧 — `slash-commands/helpers/marketplace-manager.ts:16-17`
- daemon 侧 — `daemon/services/marketplace-service.ts:193-…`
- TUI 斜杠命令 — `slash-commands/builtin-marketplace.ts`（`BUILTIN_MARKETPLACE_SLASH_COMMANDS` 在 `:43`）
- 自动更新 — `plugins/marketplace-auto-update.ts:29`

### 5.8 daemon 扩展/插件 RPC 全集

`packages/coding-agent/src/daemon/services/extension-service.ts:81-94`：

```
extensions.list / extensions.raw / extensions.setEnabled /
extensions.setForceEnabled / extensions.setProviderEnabled /
extensions.setConfig / extensions.setComponentEnabled /
extensions.setVersionExemption / ext.call /
plugins.list / plugins.packages / plugins.setEnabled
```

缓存 TTL 10s — `extension-service.ts:138`。

---

## 6. 能力/兼容性判定

### 6.1 `capability-report.ts` 判据

`packages/coding-agent/src/extensibility/plugins/capability-report.ts`：

- 三档 verdict — `capability-report.ts:34`：`runnable` / `partial` / `incompatible`
- 报告结构 — `capability-report.ts:44-50`：`verdict` / `missing` / `unhostedSlots` / `summary`
- **判定只读磁盘 package.json，绝不加载插件代码** — `capability-report.ts:12-15` 头注释
- 依赖判定：
  - 遍历 `peerDependencies` + `dependencies` — `capability-report.ts:173-176`
  - 本底座可满足的命名空间 — `capability-report.ts:59`：`@musepi/`、`musepi-`、`pi-`、`@earendil-works/`（另 `react`/`react-dom` 特判 `capability-report.ts:237`）
  - 外来 harness scope — `capability-report.ts:62`：`@(deepseek-ai|anthropic-ai|huanlin|michengai|omdsh)/`
  - 裸包名的「外来运行时」启发式 — `capability-report.ts:246-248`：`-(harness|host|runtime|cordis|dsh)$`
  - 只有命中上述两条才算 missing（自带第三方库不算）— `capability-report.ts:181`
- 入口判定：声明的入口不在盘上 → `missing.push("entry <path>")`，属 load-blocking — `capability-report.ts:187-192`
- 槽位判定：**文本扫描**入口源码找点号分隔标识符 — `capability-report.ts:134-152`，正则 `capability-report.ts:139`；未托管槽 → `partial`
  - 本底座托管槽集合（复制自 extension-slots）— `capability-report.ts:72-87`
  - 明确说明：运行时算出来的槽名读不到，**缺命中不作为兼容性证据** — `capability-report.ts:130-132`
- 终判 — `capability-report.ts:198-199`：有 missing → incompatible；有 unhostedSlots → partial；否则 runnable
- 中文 summary 文案 — `capability-report.ts:250-262`
- 入口读取顺序 `musepi` → `omp` → `pi` — `capability-report.ts:111`（这就是 `docs/handoff-plugin-install.md §6` 提到的坑的正解）

### 6.2 兼容性预检（另一条独立通道：semver peer 判定）

`packages/coding-agent/src/extensibility/plugins/plugin-compatibility.ts`：
- 头部文档把与 DSH 的差异逐条写明 — `plugin-compatibility.ts:7-26`
- 参与判定的 peer 前缀 `@musepi/`（单版本线，全部对照宿主运行时版本）— `plugin-compatibility.ts:35`, 注释 `:8-10`
- workspace 协议 — `plugin-compatibility.ts:38`
- 区间语法双探针校验（`Bun.semver.satisfies` 对非法区间返回 true 不抛错）— `plugin-compatibility.ts:60-71`
- 预发布运行时按 base 版本复检（等价 `includePrerelease`）— `plugin-compatibility.ts:73-79`
- 豁免走精确 `name@version` — `plugin-compatibility.ts:19-21`；存储 `plugins/compatibility-store.ts`
- **装配期生效**：预检先于任何 import — `extensions/loader.ts:735-754`

因此存在**两条互补的兼容性通道**：
1. `plugin-compatibility.ts` — 装配期 semver 预检（阻断 import，可豁免）
2. `capability-report.ts` — 安装后静态能力报告（不阻断，只提示）

### 6.3 `ExtensionItem` 的 17 条贡献通道

`Extension` 结构体：`packages/coding-agent/src/extensibility/extensions/types.ts:2081-2142`。

**注册容器（Map/数组，逐一可清空）—— 19 个字段**：

| # | 字段 | 行号 | 来源 register* |
|---|---|---|---|
| 1 | `handlers` | `types.ts:2085` | `on` |
| 2 | `tools` | `types.ts:2086` | `registerTool` |
| 3 | `toolRegistrationListeners` | `types.ts:2087` | 内部 |
| 4 | `assistantThinkingRenderers` | `types.ts:2088` | `registerAssistantThinkingRenderer` |
| 5 | `fileWriteFallbackHandlers` | `types.ts:2089` | `registerFileWriteFallback` |
| 6 | `fileDeleteFallbackHandlers` | `types.ts:2090` | `registerFileDeleteFallback` |
| 7 | `messageRenderers` | `types.ts:2091` | `registerMessageRenderer` |
| 8 | `composerShapes` | `types.ts:2092` | `registerComposerShape` |
| 9 | `commands` | `types.ts:2093` | `registerCommand` |
| 10 | `flags` | `types.ts:2094` | `registerFlag` |
| 11 | `shortcuts` | `types.ts:2095` | `registerShortcut` |
| 12 | `settings` | `types.ts:2099` | `registerSetting` |
| 13 | `components` | `types.ts:2102` | `registerComponent` |
| 14 | `promptSections` | `types.ts:2106` | `registerPrompt` |
| 15 | `modes` | `types.ts:2108` | `registerMode` |
| 16 | `rpcs` | `types.ts:2113` | `registerRpc` |
| 17 | `skills` | `types.ts:2117` | `registerSkill` |
| 18 | `toolViews` | `types.ts:2121` | `registerToolView` |
| 19 | `notificationChannels` | `types.ts:2125` | `registerNotificationChannel` |
| 20 | `services` | `types.ts:2128` | `registerService` |
| 21 | `themeTokens` | `types.ts:2132` | `registerThemeToken` |
| 22 | `mediaProviders` | `types.ts:2135` | `registerMediaProvider` |
| 23 | `designSystems` | `types.ts:2138` | `registerDesignSystem` |
| 24 | `statusBarSegments` | `types.ts:2141` | `registerStatusBarSegment` |

⚠️ **`docs/extensions-dev.md:423` 与 `docs/handoff-plugin-install.md:127` 说「17 条贡献通道」并引用 `types.ts:2085-2142`，但实测该区间是 24 个字段。** 文档的「17」与当前代码不符（推测：文档写于通道较少时，未随新增通道更新）。本清单以代码为准。

---

## 7. 失败与回滚

### 7.1 装载失败的降级行为

**逐路径隔离，绝不 abort 整批** — `extensions/loader.ts:756-770`：
- `Promise.all` 并行 import（互相不阻塞）
- 每个 `bindExtension` 失败只 push 进 `errors` 并 `continue`（`loader.ts:762-765`）
- 返回结构 `LoadExtensionsResult { extensions, errors, runtime }` — `types.ts:2231-2235`

**factory 抛错时回滚注册队列** — `loader.ts:585-614`：
- 三个队列各做 checkpoint（`loader.ts:590-592`）
- 抛错时 splice 回 checkpoint 后重抛（`loader.ts:596-613`）
- 理由注释：扩展 A 可能 unregister 扩展 B 排队的条目（`loader.ts:581-584`）

**import 失败降级为错误字符串，不抛** — `loader.ts:637-640`（`Failed to load extension: ${message}`）。

**无效 factory 降级** — `loader.ts:628-634`。

**兼容性不兼容：不 import，直接进 errors** — `loader.ts:747-750`。

**错误上报到 GUI（fail-loud）** — `extensions-center/types.ts:82-84`（`loadError` 字段，「dashboard 与 agent 感知层可见 —— fail-loud，不静默消失」）；写入点 `extensions-center/state-manager.ts:247`。

**TUI 侧启动诊断文案** — `extensions/load-errors.ts:5-12`（`formatExtensionLoadNotifications`，含 `replaceTabs`/`shortenPath` 消毒）。

**重载失败保留旧实例** — `extensions/runner.ts:1069-1073`。

### 7.2 安装失败的回滚（`#rollbackFailedInstall`）

`packages/coding-agent/src/extensibility/plugins/manager.ts:383-414`。**覆盖 3 类文件**：

| # | 覆盖物 | 行号 | 语义 |
|---|---|---|---|
| 1 | `plugins/package.json` | `manager.ts:389` | 整文件写回快照 `packageJsonBefore` |
| 2 | `plugins/bun.lock` | `manager.ts:394-399` | 装前不存在 → `rm`（`manager.ts:395-396`）；装前存在 → 写回 `bunLockBefore`（`manager.ts:397-398`） |
| 3 | `plugins/node_modules/<actualName>` | `manager.ts:407-413` | 先 `rm -rf`（`:408`），若有装前快照则 `cp` 回（`:412-413`） |

- 快照采集：`#snapshotInstalledPackage` — `manager.ts:352-370`（`mkdtemp` 到 `os.tmpdir()/omp-plugin-backup-`，`:366-368`；用 `verbatimSymlinks` 保住符号链接）
- 快照清理：`#cleanupSnapshot` — `manager.ts:372-381`（在 `finally` 中，`manager.ts:699-701`）
- 快照时机：装前、解析出 `existingActualName` 之后 — `manager.ts:524-529`
- **触发覆盖范围**：整个 `try` 块的所有退出路径 —— 包管理器失败、spec 非法、校验失败、取消 — `manager.ts:673-685`（注释 `manager.ts:674-678`）
- **取消判定看 signal 而非错误**：`options.signal?.aborted` → `InstallAbortedError` — `manager.ts:691-697`（kill 进程必留非零码，否则取消会被误报成失败；注释 `manager.ts:552-555`）
- 回滚本身失败 → 组合错误消息，不静默 — `manager.ts:686-690`
- 装前 manifest / lockfile 快照采集 — `manager.ts:508`, `manager.ts:514-521`
- `bun update`（重装已有 git 插件刷新 pin）也在回滚覆盖内 — `manager.ts:600-612`
- 装后扩展校验失败（入口不在盘上 / load 报错）也回滚 — `#validateInstalledExtensions` `manager.ts:416-442`，调用点 `manager.ts:661`
- 依赖的 lifecycle 脚本不会被执行（bun 默认）— `plugin-install-machine.ts:28-37`

---

## 8. 配置

### 8.1 两套并存的配置面

**① 旧 `PluginSettingSchema`（PluginManager 侧，TUI 用）**
- 类型定义：`packages/coding-agent/src/extensibility/plugins/types.ts:93`（`StringSetting | NumberSetting | BooleanSetting | EnumSetting`）
- 容器：`types.ts:48`（`settings?: Record<string, PluginSettingSchema>`）
- 校验函数 `validateSetting`：`manager.ts:1169-1203`
- 解析函数 `parseSettingValue`：`manager.ts:1208-1218`
- CRUD：`manager.ts:918-949`（全局 `musepi-plugins.lock.json` 的 `settings[name]` 与项目覆写 `settings` 合并，项目覆盖全局 — `manager.ts:920-925`）
- TUI 渲染：`modes/components/plugin-settings.ts:235`, `542`

**② 新 `ConfigFieldDesc`（manifest 声明式，GUI 扩展中心用）**
- 类型：`packages/wire/src/plugin-config.ts:12-30`
- 解析 `parseConfigFields`：`packages/wire/src/plugin-config.ts:130`（逐字段 fail-soft）
- 解析 `parsePluginResources` / `parsePluginComponents`：`plugin-manifest.ts:49-50`（实现在 `wire/src/plugin-config.ts:198` 等）
- 钳制 `coerceConfigValues`：`packages/wire/src/plugin-config.ts:275`（daemon 与 GUI 单一权威）
- manifest 读取：`extensions/plugin-manifest.ts:45-60`（从入口向上找最多 4 层 package.json，`plugin-manifest.ts:24`；坏 JSON 按「无插件声明」处理，`plugin-manifest.ts:80-83`）
- 运行时读取 `pi.config`：`extensions/loader.ts:241-257`

### 8.2 `ConfigFormRenderer`

`packages/desktop-app/src/components/ConfigFormRenderer.tsx:18`（dsh 式插件配置表单，头注释 `:8`）。
- 接入点：`packages/desktop-app/src/components/UnifiedPluginsView.tsx:155`
- 写入走 `extensions.setConfig` RPC，失败回滚该键并显示错误 — `UnifiedPluginsView.tsx:112`, `129`

### 8.3 配置存储位置

| 配置 | 路径 | 依据 |
|---|---|---|
| 插件 manifest 配置值 | `<agentDir>/extensions/plugin-config.json` | `extensions-center/plugin-config-store.ts:20-22` |
| 形状 | `{ [extensionId]: { [key]: value } }`，键空间与 `disabledExtensions` 一致（`extension-module:<name>`） | `plugin-config-store.ts:4-5`；键构造 `extensions/loader.ts:255` |
| 写入 | 逐键写穿透 + 进程内缓存 | `plugin-config-store.ts:54-65` |
| 损坏处理 | 损坏/缺席 → 空表，绝不抛错阻断扩展登记（fail-soft） | `plugin-config-store.ts:36-42`，注释 `:6-8` |
| 旧 PluginManager 配置 | `musepi-plugins.lock.json` 的 `settings[name]` | `manager.ts:918-938` |
| 插件启停 | `musepi-plugins.lock.json` 的 `plugins[name].enabled` | `manager.ts:862-869` |
| 扩展启停 | settings 的 `disabledExtensions` | `extensions-center/types.ts:221`；schema `config/settings-schema.ts:631` |
| 组件启停 | `disabledExtensionComponents`（`<plugin>/<component>`） | `extension-service.ts:645-650`；schema 注释 `config/settings-schema.ts:667` |
| 兼容性豁免 | `agentDir/compatibility.json` | `extensions/loader.ts:742`（`resolveCompatibilityPath()`）；RPC `extension-service.ts:672-698` |
| 插件包管理 | `~/.musepi/plugins/{package.json, bun.lock, node_modules/}` | `manager.ts:229-230`, `514` |

### 8.4 `restart` 生效域

三种：`none`（默认，立即）/ `session`（扩展加载时快照）/ `daemon`（需重启 daemon）— `packages/wire/src/plugin-config.ts:28-29`；语义说明 `extensions/types.ts:1478-1482`。

---

## 9. 已知的 TODO / 未实现 / 缺口

### 9.1 代码内的 TODO/FIXME/未实现标记

**扩展子系统内几乎没有 TODO 注释** —— `grep TODO|FIXME|XXX|HACK|not implemented|待实现|未实现|暂不支持` 在 `packages/coding-agent/src/extensibility/` 只命中 9 处，且**没有一处是真 TODO**：
- `extensibility/legacy-pi-coding-agent-shim.ts:541`, `700`, `717` —— legacy shim 对 `operations` 参数的显式拒绝（`"...operations is not supported: the built-in ... tool ..."`），是**有意的兼容边界**，不是未实现
- 其余 5 处是 `input(` 函数名被 grep 误命中（`extensions/types.ts:291`、`hooks/types.ts:79`、`extensions/runner.ts:172-173`）

**daemon 侧**：
- `daemon/services/file-service.ts:24` —— 「已知差距：分页文本流与文件系统变更 feed **尚未实现** —— 列入 M2 增强候选」。这是真实未实现项。
- `daemon/server.ts:7480` —— `throw new Error("autostart not supported on this platform")`（平台门，非插件面）
- `extensibility/plugins/marketplace/manager.ts:307` —— 「尚未 import」（指某条依赖尚未被 import，属设计说明非 TODO）

**已知明确否掉的方向**（记录在 `docs/handoff-plugin-install.md §5`，非代码 TODO）：
- P3 Claude Code 兼容层不做（DSH 覆盖面更窄）— `handoff-plugin-install.md:123`
- 拖入的脚本批准闸门不做（bun 不执行依赖脚本，无可拦物）— `handoff-plugin-install.md:125`
- 用户 patch 层（`cordis.patch.yml`）不做（能力已有等价物）— `handoff-plugin-install.md:127`
- bundle 概念不引入 — `handoff-plugin-install.md:129`

### 9.2 实测发现的缺口（代码证据，非文档）

**① `PluginManager` 漏读 `musepi` 块** — 唯一不一致的读法：

| 文件 | 行号 | 读法 |
|---|---|---|
| `plugins/manager.ts` | `615`, `624`, `754`, `761`, `793`, `826`, `1005`, `1039-1040` | `pkg.omp \|\| pkg.pi`（**无 musepi**） |
| `plugins/installer.ts` | `84`, `133` | `pkg.musepi \|\| pkg.omp \|\| pkg.pi` ✅ |
| `plugins/loader.ts` | `117-128`, `297-308` | `musepi` 优先 ✅ |
| `plugins/capability-report.ts` | `111` | `[musepi, omp, pi]` ✅ |
| `extensions/plugin-manifest.ts` | `70-77` | `pkg.musepi ?? pkg.omp ?? pkg.pi` ✅ |
| `extensions/loader.ts` | `788-793` | `pkg.musepi ?? pkg.omp ?? pkg.pi` ✅ |

后果：`PluginManager.install` 构造的 `InstalledPlugin.manifest`（`manager.ts:624`）对**只声明 `musepi` 块的插件**会是 `{ version }` 兜底，于是 `manager.ts:661` 的 `#validateInstalledExtensions` → `resolvePluginManifestEntries(plugin, "extensions")`（`plugins/loader.ts:436`）读到空数组 → `manager.ts:418-420` 直接 return，**安装期扩展校验对 musepi-block 插件整体失效**。同样影响 `manager.ts:761` 的 `list()` 与 `manager.ts:1040` 的 `doctor()`（后者会把正常插件报成 "No omp/pi manifest"）。
注：`docs/handoff-plugin-install.md:136` 只记录了 `capability-report.ts` 绕过 `InstalledPlugin.manifest` 的那半，**没记录 `manager.ts` 本身也漏读**。

**② 扩展 loader 的 manifest 回落与插件 loader 语义相反**
- `extensions/loader.ts:817-832`：manifest `extensions` 若全部 stat 失败，**回落到 index.ts/js**
- `plugins/loader.ts:336-338` 注释明确宣称的语义：「manifest 是权威：列出 extensions 就抑制 index/scan 回落，缺失的声明文件要被报告而不是被诱饵 index 静默替换」
- 两处对同一情形给出不同行为（推测：`extensions/loader.ts` 是会话侧较早的路径，`plugins/loader.ts` 是插件侧较新的严格化，未回填）

**③ `capability-report.ts` 的托管槽集合是复制而非引用**
- 权威：`packages/collab-proto/src/extension-slots.ts:12-23`
- 复制：`capability-report.ts:72-87`（含 `HOSTED_SLOT_PREFIXES` 5 项 + `HOSTED_SLOT_EXACT` 7 项）
- 注释自称「Mirrors」（`capability-report.ts:66-67`）—— 两处新增槽位需要手动同步，否则 `partial` 判定失真。

**④ 槽位扫描是正则文本匹配，非 AST**
- `capability-report.ts:139` — `["'\`]([a-z]+(?:\.[a-z]+)+)["'\`]` 扫的是**任意点号分隔字符串字面量**，不限于 `registerComponent` 的 slot 实参
- 后果：插件里任何形如 `"foo.bar"` 的字符串都可能被当作槽位名并误判为 unhosted（造成假 `partial`）；反过来运行时拼出的槽名读不到（漏判）
- 代码自己承认这点：`capability-report.ts:130-132`（「运行时算出的槽名无法这样读，所以缺命中绝不作为兼容性证据」）—— 但缺命中同样会制造假 `runnable`。

**⑤ `registerSkill` 虚拟技能不进 agent 上下文**
- 文档已声明边界（`docs/extensions-dev.md:226`）：技能中心可见可读，但**不进入 agent 的 loadSkills 自动装载**
- 代码侧：`marketplace-service.ts:225` 只合并进 `skills.list`；`extensibility/skills.ts:144`（文件扫描路径，独立）

**⑥ MCP 不随扩展启停**
- 文档已声明（`docs/extensions-dev.md:169`）：MCP 连接由配置层启动、`MCPManager` 按 cwd 共享，`SourceMeta` 是配置来源非扩展来源

**⑦ 重载无事务、内存态不迁移**
- 文档已声明（`docs/extensions-dev.md:166-167`）：失败重载保留旧实例（代码佐证 `runner.ts:1069-1073`）；旧 handler 先清后推新存在 ~ms 双跑窗口（代码佐证 `runner.ts:1077-1079` 先清空再替换）
- `runner.ts:1056-1058` 的注释「submodule edits do not hot-reload（Bun module cache: only the entry specifier is re-keyed）—— touch the entry to pick up submodule changes」**与 v2 实际行为矛盾**：`legacy-pi-compat.ts:1903-1932` 已按整张源码图比对。这是**过期注释**，未随 v2 更新。

---

## 10. 内置基建清单（硬编码 → 插件化目标）

以下能力**当前是硬编码**，不经过插件化。每条给出所在文件，这是后续插件化的目标清单。

### 10.1 内置 LLM 工具（32 个）

`packages/coding-agent/src/tools/builtin-names.ts:1-33`：

`read`、`bash`、`edit`、`ast_grep`、`ast_edit`、`ask`、`debug`、`eval`、`github`、`glob`、`grep`、`lsp`、`inspect_image`、`browser`、`computer`、`checkpoint`、`rewind`、`security_scan`、`task`、`hub`、`todo`、`web_search`、`write`、`board`、`widget`、`memory_edit`、`retain`、`recall`、`reflect`、`learn`、`manage_skill`

- 工厂表 `BUILTIN_TOOLS`：`packages/coding-agent/src/tools/index.ts:424`（`Record<BuiltinToolName, ToolFactory>`）
- 隐藏工具 3 个：`builtin-names.ts:37` — `yield`、`goal`、`think`
- 合并点 `tools/index.ts:599`（`{ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS }`）
- 消费点：`sdk.ts:3202`, `3896-3897`, `4098`, `4104`, `4108`
- 旧名别名：`builtin-names.ts:41-44`（`search`→`grep`、`find`→`glob`）
- MCP 工具名约定 `mcp__<server>_<tool>`：`builtin-names.ts:66-67`

### 10.2 内置斜杠命令（按域分文件）

| 域 | 常量 | 文件:行 |
|---|---|---|
| registry | `BUILTIN_SLASH_COMMAND_REGISTRY` / `BUILTIN_SLASH_COMMAND_DEFS` | `slash-commands/builtin-registry.ts:38`, `:58` |
| TUI 视图 | `BUILTIN_SLASH_COMMANDS` | `slash-commands/builtin-registry.ts:103` |
| 内部 | `BUILTIN_SLASH_COMMANDS_INTERNAL` | `slash-commands/builtin-registry.ts:116` |
| 保留名 | `BUILTIN_SLASH_COMMAND_RESERVED_NAMES` | `slash-commands/builtin-registry.ts:55` |
| session | `BUILTIN_SESSION_SLASH_COMMANDS` | `slash-commands/builtin-session.ts:148` |
| modes | `BUILTIN_MODE_SLASH_COMMANDS` | `slash-commands/builtin-modes.ts:188` |
| marketplace | `BUILTIN_MARKETPLACE_SLASH_COMMANDS` | `slash-commands/builtin-marketplace.ts:43` |
| lifecycle | `BUILTIN_LIFECYCLE_SLASH_COMMANDS` | `slash-commands/builtin-lifecycle.ts:63` |
| control | `BUILTIN_CONTROL_SLASH_COMMANDS` | `slash-commands/builtin-control.ts:14` |
| collaboration | `BUILTIN_COLLABORATION_SLASH_COMMANDS` | `slash-commands/builtin-collaboration.ts:228` |

### 10.3 内置设计体系（5 套，id 稳定保留）

`packages/coding-agent/src/presets/design-systems.ts`：
- `BUILTIN_DESIGN_SYSTEMS` — `design-systems.ts:44`
- 内置 id 保留检查 `isBuiltinDesignSystem` — `design-systems.ts:138`
- 扩展注册表合并 — `design-systems.ts:177`, `188`
- 扩展注册防撞抛错 — `design-systems.ts:150`, `153`
- 扩展注册表本体 — `design-systems.ts:142`

（id：`minimal` / `glass` / `editorial` / `neubrutalism` / `darkneon`，见 `extensions/types.ts:1776`）

### 10.4 内置预设 / 模式（modes）

`packages/coding-agent/src/presets/`：
- `BUILTIN_MODE_TEMPLATES` — `presets/resolve.ts:260`
- `BUILTIN_TEMPLATE_REVISION = 5` — `presets/resolve.ts:332`
- 扩展声明模式的兜底查找 — `presets/resolve.ts:92`
- 预设 = 扩展白名单 + 提示词区块 + settings 覆盖，文件在 `~/.musepi/modes/<id>.json`（`daemon/server.ts:1049-1052` 的 `#modesDir()`）
- 扩展声明模式合并进列表 — `daemon/server.ts:2142`；SDK 查找 — `sdk.ts:1578`
- 资产策略（与 `BUILTIN_DESIGN_SYSTEMS` 的 promptSection 对应的指令段）— `presets/asset-policy.ts:31`

### 10.5 内置扩展注册表 `BUILTIN_EXTENSIONS`（GUI 可见的部署物）

`packages/coding-agent/src/extensibility/extensions-center/builtin-registry.ts:207-624`，共 **11 类 kind / 20 项**：

| kind:name | 语义 | 行号 |
|---|---|---|
| `style:task-card-swarm` | settingsMirror `display.taskCardStyle` | `builtin-registry.ts:208-216` |
| `desktop-shell:shell` | settingsMirror `shell.enabled`（Electron 壳一等扩展） | `builtin-registry.ts:217-225` |
| `skill:*` ×6 | **annotate-only**（不产生独立行，只给扫描行打 builtin 标记） | `builtin-registry.ts:227-233` |
| `magic-keyword:ultrathink` | settingsMirror `magicKeywords.ultrathink` | `builtin-registry.ts:235-242` |
| `magic-keyword:orchestrate` | settingsMirror `magicKeywords.orchestrate` | `builtin-registry.ts:243-250` |
| `magic-keyword:workflow` | settingsMirror `magicKeywords.workflow` | `builtin-registry.ts:251-258` |
| `theme:builtin-themes` | **readonly**（无启停语义） | `builtin-registry.ts:260-267` |
| `tool-render:builtin-cards` | **readonly** | `builtin-registry.ts:269-276` |
| `voice:stt` | settingsMirror `stt.enabled`；组件 ×3（whisper/sensevoice/parakeet，deny `stt-engine`）；配置字段 ×4 | `builtin-registry.ts:280-347` |
| `voice:tts` | settingsMirror `speech.enabled`；组件 ×2（kokoro/melotts-zh，deny `tts-engine`）；配置字段 ×5 | `builtin-registry.ts:348-421` |
| `terminal:terminal` | **readonly**（无总开关）；组件 ×2（bun-pty/node-pty，deny `terminal-backend`）；配置字段 ×3 | `builtin-registry.ts:425-477` |
| `browser:browser` | settingsMirror `browser.enabled`；组件 ×3（launch/attach/gui，deny `browser-backend`）；配置字段 ×2 | `builtin-registry.ts:478-521` |
| `computer:computer` | settingsMirror `computer.enabled`（`unsetDisabled`）；组件 ×1（deny `tool`）；配置字段 ×2 | `builtin-registry.ts:522-555` |
| `lsp:lsp` | settingsMirror `lsp.enabled`；组件 ×1（deny `tool`）；配置字段 ×2 | `builtin-registry.ts:556-589` |
| `file:file` | **readonly**；组件 ×4（read/write/search/index，deny `file-backend`） | `builtin-registry.ts:593-623` |

辅助函数：
- `findBuiltinDef` — `builtin-registry.ts:627-631`
- `builtinMirrorDisabled` — `builtin-registry.ts:638-643`
- `annotateBuiltinExtensions` — `builtin-registry.ts:650-661`
- `builtinExtensionEntries` — `builtin-registry.ts:666-685`
- deny 通道映射注释 — `builtin-registry.ts:190-195`
- 注册表语义头注释 — `builtin-registry.ts:7-20`
- 契约测试 `builtin-registry.test.ts`（含 themes 交集断言 `:72`、bundled skills 交集 `:49`、tool-render 交集 `:78`）

### 10.6 内置主题

`packages/coding-agent/src/modes/theme/loader.ts`：
- `BUILTIN_THEMES` — `theme/loader.ts:17`
- `getBuiltinThemes()` — `theme/loader.ts:23`
- 内置 token 键白名单 `BUILTIN_THEME_TOKEN_KEYS` — `modes/theme/theme.ts:115`
- 主题消费 — `theme.ts:817`

### 10.7 内置媒体 / 图像 provider

`packages/coding-agent/src/tools/image-providers.ts`：
- 内置 provider 为**闭联合成类型**，扩展 id 撞内置即抛 — `image-providers.ts:98-107`
- `registerMediaProvider` 防撞 — `image-providers.ts:107`, `110`
- 内置宽高比表 — `tools/image-gen.ts:476`

### 10.8 内置频道 / 插件描述符 / blob 目的地 / 终端后端 / 规则源

| 能力 | 常量/函数 | 文件:行 |
|---|---|---|
| 频道插件 | `BUILTIN_PLUGINS` | `channels/plugins.ts:41` |
| Blob 目的地 | `BUILTIN_BLOB_DESTINATIONS` | `blob-broker/destinations.ts:58`；元数据表 `config/settings-schema.ts:89` |
| 终端后端 | `registerBuiltinTerminalBackends` | `daemon/terminal-provider.ts:211` |
| 内置规则源 | `BUILTIN_RULE_SOURCES` | `discovery/builtin-rules/index.ts:46`；默认源 id `capability/rule.ts:18` |
| 组合器形状 | `BUILTIN_COMPOSER_SHAPES` | `config/settings-schema.ts:106` |
| 内置模型角色 | `BUILTIN_MODEL_ROLES` | `daemon/server.ts:6965` |
| 内置 mental model 种子 | `BUILTIN_SEEDS` | `hindsight/mental-models.ts:69` |

### 10.9 bundled skills（6 个）

`packages/coding-agent/src/bundled-skills/index.ts:19-26`，`BUNDLED_SKILL_NAMES` 于 `:31`：

`widget-design`、`musepi-help`、`musepi-extension-dev`、`ui-ux-pro-max`、`board-design`、`musepi-contributing`

单一清单源（安装器 + 扩展中心注册表共用，契约测试取交集）— `bundled-skills/index.ts:1-9`。

### 10.10 其他内置硬编码面

| 能力 | 位置 |
|---|---|
| 内置 TUI 命令（bundled custom commands） | `extensibility/custom-commands/bundled/ci-green/index.ts`、`.../review/index.ts`（后者 601 行） |
| 内置 hub 工具通道 | `tools/index.ts` 的 `hub`、`board`、`widget` 工具 |
| 主题包（modes 主题包，raw.themes = `getBuiltinThemes()`） | `builtin-registry.ts:266` |
| tool-render 卡片工具包 | `builtin-registry.ts:275`（权威清单在 client-core `tool-render/card-tools.ts`，此处是快照快照） |
| legacy pi shim（上游 pi 包兼容层） | `extensibility/legacy-pi-coding-agent-shim.ts`（1384 行）、`legacy-pi-ai-shim.ts`、`legacy-pi-tui-shim.ts`、`legacy-typebox.ts`、`plugins/legacy-pi-compat.ts`（2556 行） |
| hooks 引擎 | `extensibility/hooks/{loader,runner,tool-wrapper,types}.ts` |

---

## 附：调研方法与可信度

- 所有行号用 `[System.IO.File]::ReadAllLines` 计数（1-based），避免 PowerShell `Get-Content | Measure-Object` 的末行偏差（例如 `types.ts` 实为 2246 行而非 Measure-Object 报的 1999 行）。
- 读了全文的文件：extensions-dev.md、handoff-plugin-install.md、extensions/types.ts（关键区段）、extensions/loader.ts、extensions/runner.ts、extensions/load-errors.ts、extensions/plugin-manifest.ts、extensions-center/{types,builtin-registry,plugin-config-store}.ts、plugins/manager.ts、plugins/capability-report.ts、plugins/spec-classifier.ts（前 120 行）、plugins/plugin-install-machine.ts、plugins/plugin-compatibility.ts、plugins/loader.ts、plugins/marketplace/manager.ts（部分）、daemon/services/{extension-service,plugin-install-service}.ts、daemon/cordis-dynamic-extensions.ts（关键区段）、daemon/server.ts（关键区段）、packages/wire/src/plugin-config.ts（部分）、packages/collab-proto/src/extension-slots.ts、bundled-skills/index.ts、tools/builtin-names.ts、desktop-app/src/components/PluginInstallDialog.tsx（部分）、desktop-app/src/components/UnifiedPluginsView.tsx（grep 验证）。
- 未能穷尽逐行读的文件（用了 grep + 区段读）：`plugins/marketplace/{fetcher,registry,types,source-resolver,cache}.ts`、`daemon/extension-artifact-compiler.ts`、`desktop-app/src/lib/slot-host.tsx`、`client-core/src/i18n/index.ts`、`extensibility/extensions-center/{state-manager,extension-list,extension-dashboard,inspector-panel}.ts`、`discovery/*`（除 grep 优先级外）、`extensibility/legacy-pi-compat.ts`（仅关键函数）。这些区域的**逐条细节**属推测，未验证。
- `docs/extensions-dev.md` §14–§16 的多数 file:line 引用经本次核对**准确**；但 §15 的「17 条贡献通道」与 `types.ts:2085-2142` 不符（实为 24 字段，见 §6.3），`handoff-plugin-install.md §6` 记录的 `manager.ts` 漏读 `musepi` 块这一半**缺失**（见 §9.2 ①）。