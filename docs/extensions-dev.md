---
layout: default
title: Extension development contracts
status: living
summary: OMP/MusePi plugin boundaries, authoring workflow, lifecycle, and production acceptance criteria.
scope:
  - packages/coding-agent/src
  - packages/client-core/src
  - docs/capability-seams.md
---

# MusePi 扩展开发规范(Agent 版)

[English](extensions-dev.md) | [中文](extensions-dev.zh-CN.md)

> 给 LLM agent(以及人类开发者)的 musepi-omp 扩展开发指南。本文件回答三个问题:
> 1. OMP Plugin 与 MusePi Plugin 的划分与兼容边界;
> 2. 一个扩展从零到落地要走哪些步骤、遵循什么结构;
> 3. 验收标准(怎么做才算"产品级扩展")。

## 1. OMP Plugin vs MusePi Plugin

musepi-omp 是 oh-my-pi 的 fork,扩展运行时同源,但 musepi 在**加载、管理、GUI 集成**三层做了增强。写扩展前先分清你落在哪一侧:

| 维度 | OMP Plugin(上游兼容) | MusePi Plugin(musepi 增强) |
|---|---|---|
| **运行时 API** | `@musepi/pi-coding-agent` 的 `ExtensionAPI`(与上游 `pi` 同名,`pi.on/registerTool/registerCommand/...`) | 同左,`ExtensionAPI` 完全兼容 —— OMP 扩展无需改动即可在 musepi 运行 |
| **入口形态** | 一个 TS/JS 模块,默认导出 factory `(pi: ExtensionAPI) => void` | 同左;可选携带 `package.json`(名称/描述/触发词)供 GUI 展示 |
| **加载路径** | `src/extensibility/extensions/loader.ts`(Bun import) | 同左;另加 `discoverAndLoadExtensions` 合并 discovery provider 结果(native 优先) |
| 发现/安装 | 无插件管理器(手动放 node_modules) | `musepi plugin install|link|uninstall|list|enable|disable`(`PluginManager` + `MarketplaceManager`),`musepi-plugins.lock.json` 记录 |
| **GUI 集成** | 无 | 设置「扩展」tab + 侧栏入口(`ExtensionsCenter.tsx`),daemon `extensions.list` RPC,TTL 10s 缓存。Cordis 包启停写 `settings.disabledExtensions` 的裸包名,组件状态写 `disabledExtensionComponents` 的 `<package>/<component>`;其他发现项保留自身 ID,`mcp:` 前缀走 mcp.json |
| **运行时管理** | 无 | daemon 统一扫描(`extensions.list` → 树:provider → kind → item)、`extensions.setEnabled` |

**结论**:能力上 **OMP Plugin ⊂ MusePi Plugin**。新扩展一律按 MusePi Plugin 写(免费获得 GUI 管理);只在纯 OMP 环境跑才按上游最小形态写。

### 术语:扩展(extension)与插件(plugin)

上表的 "OMP Plugin / MusePi Plugin" 是 2026-08 的历史措辞,按**运行时来源**命名;按**产品叫法**,同一件事在界面与命令上有两个名字,当前并存:

| 产品叫法 | 运行时 | 目录 | 消费者 API | 谁能写 |
|---|---|---|---|---|
| **扩展**(Extension) | pi/omp 遗产的 runtime 扩展 | `extensibility/extensions/` | `pi.registerTool / pi.on / …`(`ExtensionAPI`) | 上游生态已发布,勿改品牌名 |
| **插件**(Plugin) | MusePi 自有插件系统 | `extensibility/plugins/` | 包安装 + `package.json` 的 `musepi` 清单 | 新增能力沿用此面 |

- 命令行已经是 plugin 一侧:`musepi plugin install / link / uninstall / list / enable / disable`。
- GUI 里 pi/omp 遗产归设置侧「**扩展与插件**」控制中心;自有插件系统品牌一律「**插件**」。
- 两者的分界是**来源**不是能力:一个用 `pi.extensions` 装载的模块在界面上也可能表现为一个卡片。

An ordinary plugin package declares its entries, configuration, and resources in `package.json`'s `musepi` block and uses the runtime lock for enablement. The application profile selects bundles through `musepi.profile.bundles`, with row overrides in its `cordis.patch.yml`; Only `musepi.profile.bundles` is supported; DSH profile fields are ignored. Agent presets are declared as plugin rows inside that same composition and resolve in file > profile > extension order. Their new-session default lives in the profile's `agent-preset-registry.config.selectedDefault`; once a session starts, its preset is locked and its existing composition is retained. Component switches remain independent of the parent switch: a component selection is preserved while its parent is off, but the component is not active until both gates allow it.

The Plugins view manages packages and profile bundles at one card granularity. Ordinary package switches use the runtime lock; bundle switches update `musepi.profile.bundles`, and selected-but-unreadable bundles stay visible. Detailed layer and row composition remains available through `bundles.composition` without a separate Composition tab. Preset rows mount as real Cordis fibers in each session: `isolate` creates service-specific child realms, and switching modes disposes the old preset fibers before mounting the new composition. Plugin-owned skills are declared with `registerSkill` beside the plugin's other resources and disappear with that plugin; the Android emulator uses this lifecycle.

Creator quick-create sends only the user's natural-language requirement. Its preset prompt owns the operational workflow: call `modes.save` with the complete new definition, then call `modes.validate` with the persisted id. `modes.save` performs structural, inheritance, and extension-existence checks before writing; `modes.validate` performs the mount check. A failed check must be repaired and repeated before completion is reported. Host UI instructions must not be appended to the user message.

Desktop releases must stage self-contained first-party plugin bundles with the daemon. Run `bun packages/coding-agent/scripts/stage-desktop-daemon.ts --binary <daemon-binary>` after compiling it. The script compiles and validates `bundled-plugins` and `desktop-plugins` under `packages/desktop-app/vendor/daemon`, including every entry declared by `musepi.extensions` and `musepi.components`; component styles remain beside the compiled component. Direct and transitive JavaScript dependencies are bundled, while the terminal PTY bridge and its native runtime packages are copied into the staged layout. Electron unpacks this directory and passes both absolute roots to the daemon through the platform-delimited `MUSEPI_BUNDLED_PLUGIN_ROOTS` variable. Development discovery retains its source-tree fallbacks; a release must not depend on source trees or development dependencies.

Discovered JavaScript and TypeScript hooks use the production extension chain: `discoverExtensionPaths()` → `hookCapability` → `loadExtensions()` → `ExtensionRunner`. The legacy `HookRunner` exports remain for public API compatibility and their direct consumers; they are not a second production execution path. TUI settings and plugin entries read the same schema, discovery results, and Cordis enablement state as the desktop client. The TUI does not introduce a separate installer or plugin-state store.

## 2. 扩展能做什么(能力面)

一个扩展模块可以组合:

- 事件处理:`ctx.on("session_start" | "tool_call" | "tool_result" | "message" | ...)`。每个 session-bound agent(主 agent 与每个子 agent)各拿一份独立 runner,`session_start` 携带 `{ agentId, source }`(`source` 为 `main` 或 `subagent`);生命周期事件 `session_start`、`session_shutdown`、`session_before_*`、`tool_call`、`tool_result`、`context` 与 `input` 已迁到 runtime 的 Cordis 事件上下文：除 shutdown 用 `parallel`（并发、互不阻塞）外，其余都用 `serial`（顺序）。`tool_result` / `context` / `input` 的改写由派发侧累积：监听器只返回自己的 patch，后者能看到前者的修改。流式/通知事件（`message_*`、`tool_execution_*`、`turn_*`）用 `parallel` 并发派发，零监听时直接跳过；其余单次通知（`session_switch/branch/tree`、`agent_start/end`、`auto_compaction_*`、`auto_retry_*`、`todo_reminder` 等）用 `serial` 保持注册顺序。`user_bash` / `user_python`（首个非空结果即中断）与 `resources_discover`（按扩展路径累积）同样走 `serial`；`before_agent_start`（消息 + systemPrompt 累积）、`before_provider_request`（payload 逐次改写）、`after_provider_response`、`cache_warming_decision`（最后一个 action 生效）也已迁移，`credential_disabled` / `mcp_notification` 走单次通知通道。至此所有插件事件都由 Cordis 派发，旧的 `Extension.handlers` 表、`hasHandlers` 的 map 分支和 runner 里的手写兜底循环已删除——事件注册与派发只剩一份实现。`session.compacting` / `session_stop` 也走 `serial`：前者保留最后一个有效结果；后者在“要继续且带上下文”时立即中断并返回该结果，`event.signal` 由执行器合成到 handler 预算里。`ctx.on(event, handler, { prepend })` 对所有事件可用：已迁事件里它是 Cordis 的全局顺序，legacy 事件里它只在同一扩展内提前。`tool_result` 的改写由派发侧累积：监听器只返回自己的 patch，后者看到前者的修改（last-write-wins）。`tool_call` 保持 fail-closed：超时或抛错都返回 `block: true`，首个 block 立即中断；非 block 结果仍按“最后一个有效值”保留。`session_before_*` 保持旧契约——只有 `cancel: true` 中断链，其余结果记为“最后一个有效值”并继续；超时包装在监听器内部，错误仍走 runner 的 error 通道，`handler timed out after Nms` 文本不变。`on()` 返回的 disposer 只注销该监听（Cordis `ctx.on` 语义），插件卸载仍清空它注册的全部监听；`session_shutdown` 与该 runner 的定时器、文件回退一起清理；服务与内存后端 provider 归插件实例，只在卸载/重载时停止。会话级注册（`ctx.promptHost`、`ctx.session.on`、会话处理器里注册的 `ctx.effect`）必须放在 `session_start`，所以 `apply` 是实例 setup，`session_start` 才是会话 setup。
- LLM 工具:`ctx.tools.register({ name, description, parameters, execute })`(进入工具注册表,权限链照常生效)。有副作用的工具在执行前会 flush 唯一一条 start intent 与宿主 journal；只有可证明只读的工具才声明 `requiresDurableIntent: false` 跳过该屏障，未声明的插件/MCP 工具默认需要屏障。
- 会话日志写入:`ctx.ensureSessionOnDisk()`、`ctx.appendCustomEntry(type, data)`、`ctx.flushSession()` 让工具持久化自定义条目;写入前检查 `signal`,并处理 `sessionManager` 只读快照无法写入的情况。
- 会话维护接入:`ctx.settings.get(key)` 读取当前会话设置;`ctx.isIdle()` 与可选的 `ctx.isSettled()` 构成空闲门禁,`ctx.hasDraftInput()`(仅终端宿主提供)报告编辑器是否有未提交草稿;`ctx.runIdleCompaction()` 触发压缩,`ctx.runEphemeralTurn()` 生成 recap,`ctx.getGoalModeState()` / `ctx.getTodoPhases()` 提供锚点,`ctx.recordRecap()` 落库、`ctx.showRecap()` 交给宿主展示。`musepi-idle-maintenance` 插件只用这些缝调度,计时器归插件,不归各宿主控制器。
- 子智能体:`ctx.subagents.register({ name, description, systemPrompt, external })`;本地 Agent 必须提供非空 `systemPrompt`,外部 Agent 改为提供一次性 `external(context)` 执行器,并复用现有 task 进度、取消、超时、结果卡片和完整 Markdown 产物。子智能体类型本身已是 Cordis 插件能力;本地子智能体的多轮接续属于运行时生命周期(`hub send` / `agents.chat` / 冷恢复),不需要第二个 Agent 定义。共享任务板等团队协作应是独立 Cordis 插件,可参考 DSH 将团队服务、模型工具与 UI 拆包的做法,不要把任务所有权塞进子智能体注册。
- 斜杠命令:`ctx.commands.register(...)`(TUI `/cmd` + GUI 命令面板)
- 快捷键/flags、自定义消息渲染、会话/消息注入(`sendMessage` / `sendUserMessage` / `appendEntry`)
- **工具执行拦截**:每个工具执行都被扩展拦截层包裹(`tool_call` / `tool_result` 事件可介入)

内置命令名(如 `/memory`)默认保留给核心实现:第三方扩展注册同名命令会被跳过并记录冲突告警。随宿主分发的第一方插件(`bundled-plugins/`、`desktop-plugins/`)注册同名命令即接管该名字,内建实现作为插件缺席或编译失败时的回退,命令补全与分发都优先走插件。

## 3. Agent 开发规范(步骤)

### 3.1 结构

```
packages/<your-ext>/
  package.json        # name(必填,kind:name 的 name)、description、触发词
  index.ts            # 默认导出 factory
  src/…               # 实现拆分(可选)
```

**package.json 约定**(供 GUI ExtensionsCenter 展示与启停 id):

```jsonc
{
  "name": "@musepi/awesome-tool",       // id = `extension:<name>`(与 kind 前缀)
  "description": "一句话描述",
  "main": "index.ts"
}
```

### 3.2 factory 骨架

```ts
import type { ExtensionAPI } from "@musepi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // 注册阶段:只能调注册类方法(on/registerTool/registerCommand)
  pi.registerTool({
    name: "awesome_tool",
    description: "做了什么",
    parameters: { /* JSON Schema */ },
    async execute(params, ctx) { return "结果"; },
  });
  pi.on("session:start", async (info) => { /* ... */ });
}
```

### 3.3 铁律

1. **注册与运行时分离**:factory 执行 = 注册阶段,`sendMessage` 等运行时动作要等 `ExtensionRunner.initialize` 后(事件回调里用,不在 factory 顶层用)。
2. **不阻塞加载**:loader 逐模块 import,单个扩展抛错只记 `per-path load errors`,不 abort 整个加载。你的扩展要自行 try/catch 边界。
3. **权限链照常**:registerTool 的工具仍走 permission 链(approval 等),不要绕过。
4. **可发现性**:描述写清触发词/能力,供 TUI/GUI 的扩展列表与 agent 路由。
5. **GUI 启停兼容**:新扩展默认启用;要可关,确保 `disabledExtensions` 里 `extension:<name>` 能完全禁用它(加载层检查该 id)。

### 3.4 验收标准(产品级)

- [ ] `musepi plugin link <path>` 后 `musepi plugin list` 可见,`extensions.list` RPC 返回(provider/kind/描述/状态正确)
- [ ] GUI 设置「扩展」tab 能开关它,开关状态重启后保持(`settings.disabledExtensions` 写入)
- [ ] 工具/命令在 TUI 与 GUI 两条路都可触发(TUI 直接,GUI 经 daemon 会话)
- [ ] 错误路径不炸进程:加载失败/运行时异常有日志且可恢复
- [ ] 文档:`README` 写清安装(link 或 marketplace)、能力、配置

## 4. 内置扩展 vs 第三方

- **native/内置配置**(`discovery/builtin.ts`):`~/.musepi/agent` 与 `.musepi/` 配置文件扫描项,`extensions.list` 里 provider = native。native provider 自 0.5.0(M2.1)起在 TUI/GUI 的 provider tab 可见(不再 skip-native),无 provider 级开关(daemon 拒绝禁用 native)。
- **第一方 Cordis 包**(`src/bundled-plugins/*/package.json` + `extensibility/extensions-center/builtin-registry.ts`):语音、终端、浏览器、文件、computer、LSP、桌面壳、任务卡片、主题与工具卡片均由真实插件包发现。第一方包与外部 MusePi 包使用相同身份和生命周期。包名是管理 ID,`disabledExtensions` 中的裸包名是包启停的唯一事实源;`voice:stt` 等 MusePi 早期独立 ID、`settingsMirror` 和旧 deny-list 不再参与解析或兼容读取。
  - `musepi.components[].entry` 定义独立子 fiber。`disabledExtensionComponents` 中的 `<package>/<component>` 是组件启停的唯一事实源;关闭组件只反注册该组件的服务或效果,同包其他 entry 不受影响。`tools.disabled` 只负责独立的工具过滤,不充当组件状态存储。
  - `configStorage: "settings"` 的字段与设置页共用存储。`stt.enabled`、`speech.enabled`、`browser.enabled`、`computer.enabled` 和 `lsp.enabled` 等领域配置继续控制各自功能,但不决定包状态。`terminal`、`browser`、`computer` 等 provider/service 由包或 entry 组件注册,宿主通过服务名消费;卸载 effect 负责反注册。
  - `readonly: true` 的主题和工具卡片是只读集合/组合包。它们没有独立 entry 组件,不宣称包内每个主题或渲染器都能分别启停;daemon 与 UI 都拒绝无效包开关。
  - `desktop-shell` 是宿主组合入口。包开关还维护 `shell.enabled` 与 `web.port` 连接副作用;`task-card-style` 已接入真实会话注册。
  - `annotate: true` 仍只给 bundled skills 的既有扫描行打内置标记,不生成重复条目。内置 hooks 仍全部由文件或插件扫描发现。
  - `musepi-subagent-codex`、`musepi-subagent-claude-code`、`musepi-subagent-kimi-code`、`musepi-subagent-codebuddy` 与 `musepi-subagent-opencode` 是实验性一次性子智能体包。Codex 使用官方 app-server JSON-RPC,其余产品使用各自流式 JSONL CLI;包只持有可执行文件、原生模型、产品权限与环境配置,不在加载时启动进程。外部 Agent 拒绝显式 model/effort override、plan mode、结构化输出 schema 和隔离 worktree;进程终止、输出上限、错误和产物仍由共享 task 执行器处理。
  - 五个包共用 `task/external-executable-probe.ts` 注册 `probeExecutable` RPC。配置页打开、路径失焦或手动重检时按当前工作目录解析 PATH 或显式路径，并以 5 秒超时执行一次 `--version`，显示解析路径和版本；找不到、非零退出与超时均显示失败。检测只证明 CLI 可执行，不验证原生模型、凭据或后续任务可用性。`env` 在失焦时校验 JSON 对象与字符串值，输入修正时清除旧错误。
- **第三方生态发现**:Pi、OMP、Codex 与 Claude 的扩展、技能、Commands 和 MCP 继续由各自独立 provider 适配,不使用 MusePi 已退休的第一方 ID。`kimi-code` provider 读取 `$KIMI_CODE_HOME`(默认 `~/.kimi-code`)与项目 `.kimi-code/`,支持用户和项目 Skills、MCP,以及 `plugins/installed.json` 中启用插件的 Skills、Commands 和 MCP;插件 MCP 使用官方 `plugin-<pluginId>:<serverName>` 命名。当前不接入 Kimi 的 hooks、agents、systemPrompt 或 sessionStart。
- **插件安装**(`~/.musepi/plugins/`):provider = user,可启停。
- 测试/示例扩展(如 `harmony-leak` 夹具)是测试资产,不算产品扩展。

## 5. 相关文档

- `docs/extensions.md` —— 扩展运行时 API 全量(事件、注册方法、生命周期图)
- `docs/extension-loading.md` —— 发现与加载规则(module 路径、discovery provider)
- `docs/plugin-lifecycle.md` —— Cordis 注册与消费、fiber 状态、依赖、销毁及迁移验收
- `docs/plugin-manager-installer-plumbing.md` —— 插件管理/市场安装管线
- `docs/user-facing-packages.md` —— 用户面包(CLI/特性)
- `docs/gui-implementation.md` §2 —— GUI 扩展控制中心契约(daemon RPC、TTL、启停语义)

## 6. UI 组件贡献(renderer-side slots,2026-08-16)

扩展可以向桌面 GUI 贡献 React 组件——daemon 编译、GUI 动态挂载、HMR 即时生效:

```ts
import type { ExtensionAPI } from "@musepi/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.registerComponent({
		slot: "panel.tab.greeting", // 右面板动态 tab(panel.tab.<任意 id>)
		moduleUrl: "./ui/greeting.tsx", // 扩展目录内相对路径
		label: "Greeting card",
	});
}
```

**组件契约**(编译时强制):
- 默认导出 React 组件;
- JSX 使用 `window.MusePiReact.createElement`。`react`、`react-dom`、`react-dom/client` 和 `react/jsx-runtime` 的普通或 type-only import 都由 daemon 映射到宿主 React，不会打包第二份 React；不得绕过这条映射，自行打包或从其他地址加载 React。
- **Injected props (all optional)**: `{ rpc, sessionId, cwd, slot, extensionId, panelTab, fileWorkspace, page, chatView, panelShell, browser, formatTokens }`. `rpc` is the daemon bridge; `sessionId`/`cwd` identify the active session; `slot`/`extensionId` identify the contribution. `panelTab` is present for `panel.tab.*` and carries the current instance's `id/surface/target/label/readOnly/dedupeKey`, including in split columns. The reserved `panel.tab.files` mount also receives `fileWorkspace`, the host-owned file-tab, draft, reveal-request, and editor-history contract. The single `app.chat` mount receives `chatView`, the host-owned session, workspace, right-panel, and terminal contract; it must not copy that state. The `panel.shell` mount receives the full right-panel contract through `panelShell`; `panel.tab.browser` receives `{ open, openRequest, onTakeover }` through `browser`. Full-page slots receive navigation under `page`; `app.capability` specifically receives `page: { tab, onTabChange, onBack }`, not top-level navigation props. `formatTokens` keeps numeric readouts consistent with the host transcript. Components must remain usable when any prop is absent.
- **样式**:组件内 `import "./x.css"` 会被 daemon 提取并在挂载时注入 `<style data-slot-css>`(组件卸载即移除)——不要依赖全局样式文件;
- **失败可见**:编译失败/加载失败在宿主处以红色错误块显示(不再静默消失);运行时错误有 `gui-slot-error` 样式。

**槽位清单**(daemon `assertKnownComponentSlot` 校验,未知槽名注册会抛错;单一权威见 `packages/collab-proto/src/extension-slots.ts`):
- `panel.tab.<id>` — 右面板动态 tab。默认提供 rail 启动入口；声明 `availability: "on-demand"` 时不进入 rail、空状态或新建菜单，只由会话内容或工具结果中的 `details.panelTab` 描述符打开。描述符使用 `surface: "ext:panel.tab.<id>"`，可携带 `target`、`dedupeKey` 和 `label`；失败工具结果不会打开标签。`panel.tab.files` 是保留特例：它映射到持久化 surface `files`，不进入通用扩展 launcher，也不接受 `ext:panel.tab.files` 作为第二个 surface。
- `panel.shell` — full right-panel shell (single). The `panel` plugin owns tabs, split layout, and maximize presentation; `app.chat` does not bundle it.
- `app.overlay` — root-level fixed overlay (single): owns the floating horizontal/vertical scroll rail and portals itself to `document.body`. The host keeps the built-in `<FloatingScrollbar/>` as the fallback when no contribution is mounted.
- `browser.host` — persistent managed-browser guest host (single), mounted at the app root independently of `panel.tab.browser`. Both artifacts bind the same `window.MusePiManagedBrowserHost` store instead of bundling separate copies.
- `settings.tab.<id>` — 设置页左侧导航项:扩展声明一个设置页即出现在设置导航,内容区挂载组件。
- `sidebar.panel.<destination id>` — 二级左栏面板(2026-11-08):宿主按 rail 目的地 id 取唯一贡献,挂进 `.gui-side-keeper`,由 `data-panel` 决定显隐;几何读 keeper 上的 `--gui-side-w`,不接宿主专用 props。编译插件通过宿主模块表共享 `lib/scheduled-task-nav`(`task-nav`),否则会拿到另一份快照 store。插件停用或编译失败时宿主回退内置面板,目的地仍可用。
- `rail.<id>` — 右缘图标轨(前缀命名空间;`rail.right` 是保留的精确槽)
- `composer.dock` / `composer.left` / `composer.right` — 输入卡上方行 / 工具栏两端(list 语义,多扩展可同槽)
- `panel.right` / `settings.extensions` — 旧保留槽(仍可用)。**`settings.extensions` 是插件自带设置面板的推荐槽位**（2026-10-10 起由 `ExtensionsCenter` 承载,见下):注册到该槽的组件与 `settings.item.<extId>` 卡片一并按扩展分组渲染,并注入 `settingsScope` 读写代理。
- `settings.item.<extId>` — 扩展设置卡片(2026-08-17;2026-08-20 起展示于**扩展中心底部**,随插件 inventory):按扩展 id 派发一张卡片,组件经 `settingsScope` prop 读写设置键(见下)。
- `settings.action.<id>` — 单行偏好槽(2026-08-20):组件挂到设置页"通用"分区末尾,功能插件贡献单行偏好(语言/外观/Enter 行为),无需整 tab 或整卡。
- `settings.appearance.item` — 内置外观页的行/分区座位(2026-11-10,list 语义;dsh `settings.general.item` 同构命名):贡献渲染在外观页内容之后。插件**自己选择座位**:只放内置页、只放扩展中心(`settings.item.<extId>`)、或两处都注册;组件收到注入的 `slot`,可为不同座位渲染不同内容。`ui-theme` 用该座位把滚动条设置放回外观页（dsh 的 theme bundle 同构）。

**设置面板宿主**(2026-10-10):注册到 `settings.extensions` 的组件由**扩展控制中心**
底部的「扩展设置」分区承载 —— 与 `settings.item.<extId>` 卡片同框,按 `extensionId`
(扩展入口路径)分组,每组一张 `gui-ext-settings-card`。两者挂载时都拿到
`settingsScope`(`{ get(keys), set(key, value) }`,经 daemon `settings.get`/`settings.set`),
组件必须把它当**可选**处理(只挂在 RPC 桥上的宿主不传)。插件包详情弹层
(`PluginPackageDialog`)同样挂载 slot 以 `settings.` 开头且 `extensionId` 位于包目录下的
组件 —— 这就是第三方插件(如 musepi-auth-hub)设置界面的落点。

**数据流**:daemon `bun.build` 把模块编译为自包含 ESM(react 绑定宿主实例)→ `extensions.list` 返回 code → GUI `SlotComponentHost` blob: 动态 import 挂载。**信任模型**:扩展本就在 daemon 进程执行任意代码,渲染其组件不构成新提权。

**Host modules**: a compiled component shares app modules that carry React context or module-level state (`prompt-dialog`, `action-toast`, `floating-menu`, …) through `window.MusePiHostModules` instead of bundling a second copy. The contract, the current entries, and the steps for adding one are in §19.

**Panel instance example**: the bundled `compaction-summary` Cordis plugin registers `panel.tab.compaction`; its UI reads `panelTab.target` and calls `session.compaction { sessionId, entryId }`. Session-bound content must use a validated daemon RPC like this, not the bare `registerRpc` runtime, which does not provide session actions. Restored tabs persist only the entry id; stale async responses must be ignored after the target changes or the component unmounts.

**File-workspace example**: the bundled `file-workspace` Cordis plugin registers the reserved `panel.tab.files` slot. It reads `panelTab.dedupeKey` to distinguish tree roots from file pages and receives the host-owned `fileWorkspace` contract for drafts, dirty state, reveal requests, and history. Disabling the plugin removes the file renderer and launch entries; it does not transfer tab or draft ownership into the plugin.

**Android emulator example**: the bundled `android-emulator` plugin contributes `panel.tab.android-emulator`, extension-scoped RPC methods, and the `android_emulator` Agent tool. Configure absolute `adbPath` and `emulatorPath` values when those executables are not on `PATH`. The panel can start an AVD, display and operate the device, install an APK from the current workspace, launch an activity, and inspect UI hierarchy and logs. Its bundled `android-emulator` skill defines the build → install → launch → wait → screenshot/UI-tree/logcat verification loop. PNG polling is not a video stream, and text injection accepts only single-line printable ASCII. Disabling the plugin removes its registrations and disposes the shared service; pre-existing devices are not terminated.

**设置卡片(settings.item + settingsScope)**:注册 `slot: "settings.item.<extId>"`(extId = 扩展目录名)的组件,会在**扩展中心**(设置 → 扩展)底部按扩展获得一张卡片(扩展未启用则不显示)。组件收到额外 prop `settingsScope = { get(keys: string[]): Promise<Record<string, unknown>>, set(key: string, value: unknown): Promise<void> }` —— 经 daemon `settings.get`/`settings.set` RPC 读写设置。**键名自由命名,建议用 `扩展名.xxx` 前缀**(与 registerSetting 的 `display.taskCardStyle` 同约定)避免与其他扩展冲突;写入只放行 registerSetting 注册过的键,未注册键写会抛 read-only。**写时校验(registerSetting 的 `validate` 字段)**:扩展可为注册的设置键提供 `validate(value)` 回调——返回错误字符串即拒写(daemon `settings.set` RPC 抛错,GUI 显示原因),返回 `void` 放行。schema 无法表达的约束(端点可达性、跨键一致性、枚举外值)由此在**写入时**拒绝,而非用到时才炸。无任何扩展注册该槽位时分区显示空态文案。

**热插拔(v2,HMR 全量)**:扩展源码/配置变更 → daemon watcher(500ms debounce)① 清缓存并广播 `extensions.changed`(需先 `events.subscribe`)→ GUI 插槽即时重载(~1s),`ExtensionsCenter`/`PluginsSection` 监听同事件即时刷新;② 对每个活跃会话比对**运行时源码图的 mtime 快照**后执行 `reloadExtension`(不依赖 fs.watch 的 filename —— Windows 递归 watch 的 filename 不可靠),完成后发会话内事件 `extensions.reloaded`。会话内工具/命令/handlers 下次调用生效。

**Cordis 宿主级组合 HMR**:`ProfileModuleGraph` 合并所有在役组合行的源码图，accepted 变更沿 importer 反向传播，未接受模块记为 declined。生产装载链保留每行的 `rowId`、`config` 和附加 `inject`，同一 entry 的多行独立重载。受影响行作为一个事务先预导入全部替代模块，再逆序销毁旧 fiber 并逐行 apply；导入或 apply 失败会恢复旧实例，成功后才刷新图快照。externals 只记录 pending 并要求重启宿主。Track B 的会话级重载继续使用下述语义，不把 Cordis 的组合事务误套到 legacy runner。

**v2 契约(子模块边界、忙门控、MCP)**:
- **子模块改动同样热生效,无需 touch 入口**:装载时对入口的**运行时源码图**做一次走查(`collectExtensionModules`,含静态 `import`、CJS `require` 与动态 `import()`;type-only import/export 被编译擦除,不进入该图),快照逐文件 mtime;daemon 的变更判定按这个快照逐文件比对(`extensionEntriesNeedingReload`),任一图内文件变了就重载它的入口。重载本身一直是好的 —— cache-bust tag 单调递增(`nextLegacyPiLoadTag`),`onLoad` 钩子把它盖到每个相对 import 上,整图重新读盘 —— 坏的是**没人通知有东西该重载**。
  图内 specifier 一律发**裸路径 + `?mtime=`**,不是 `file://`:Bun 对 `file://` 忽略 query(会命中缓存),对裸路径才按键。这条原先只在 POSIX 生效,Windows 上整图退回 `file://` 而静默不刷新 —— 入口能重载、它的子模块不能,正是这个不对称。
- **重载语义(无事务)**:失败的重载(语法错误等)保留旧实例并上报错误,不破坏现状;成功的重载 = 旧实例 handlers 先清空、新模块工厂运行(重注册的 handler 无双跑)、`toolRegistrationListeners` 带到新实例(新工具按名覆盖推入会话注册表)、`extensions[]` 原地替换。返回 `removedTools` = 旧工具名,会话侧删除**未被新模块重注册**的旧名。
- **内存态不迁移**:重载重建模块实例,扩展自行持久化状态(settings/磁盘);在途异步副作用(已发出的 fetch/定时器)不回收,尽力而为。
- **忙会话门控**:会话 streaming(`isStreaming`)时重载挂起到单槽 pending,`agent_end`(含延迟 agent_end flush)空闲时补做;不引入队列/锁。
- **MCP 不随扩展关闭**:MCP 连接由配置层启动、`MCPManager` 按 cwd 多会话共享,`SourceMeta` 是配置来源非扩展来源 —— 扩展重载不触碰 MCP server 生命周期;扩展自行管理自有连接。

**参考实现**:`examples/extension-component/`(示例)、`packages/coding-agent/src/daemon/extension-components.ts`(编译/聚合)、`packages/desktop-app/src/lib/slot-components.tsx`(渲染)、`ExtensionRunner.reloadExtension` + `AgentSession.reloadExtension`(v2 会话级重载)。

## 7. 扩展 daemon RPC(registerRpc,2026-08-20)

扩展向 daemon 注册 JSON-RPC 方法,GUI 槽位组件经 `extensionCall` prop 回调自己的 daemon 侧逻辑 —— 组件从"展示"变成"可交互":

```ts
import type { ExtensionAPI } from "@musepi/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.registerRpc("greet", (params, ctx) => {
		const { name } = (params ?? {}) as { name?: string };
		return { greeting: `hello ${name ?? "world"}`, cwd: ctx.cwd, sessionId: ctx.sessionId };
	});
	pi.registerComponent({ slot: "panel.tab.rpc-demo", moduleUrl: "./ui/rpc.tsx" });
}
```

**调用链**:组件 prop `extensionCall(method, params)` → daemon RPC `ext.call { extensionId, method, params, sessionId }` → daemon 校验扩展为 active extension-module → 调 handler。`extensionCall` 自动绑定当前组件的 `extensionId`,组件无需知道自己是谁:

```tsx
export default function RpcDemo({ extensionCall }: SlotComponentProps): React.JSX.Element {
	const [msg, setMsg] = React.useState<string>("");
	return (
		<button onClick={() => void extensionCall?.("greet", { name: "musepi" }).then((r: any) => setMsg(r.greeting))}>
			{msg || "greet"}
		</button>
	);
}
```

**约束(裸 runtime)**:handler 在 daemon 的扩展加载上下文运行(与槽位组件编译同一次 factory 调用)——`pi.exec`/`pi.logger`/纯计算可用;**会话绑定 actions(sendMessage/setModel/…)不可用**(抛 stub 错误)。需要会话能力时在 handler 里只做计算/IO,把结果返回给组件。

**错误面**:未知扩展(非 active / 不存在)/ 未知方法 / handler 抛错 → JSON-RPC 错误,组件 `extensionCall` promise reject;方法名按扩展隔离,不同扩展可注册同名方法。

## 8. 扩展注册技能(registerSkill,2026-08-20)

扩展声明**虚拟技能**(无 backing SKILL.md 文件),与文件扫描技能同框展示:

```ts
pi.registerSkill({
	name: "my-skill",
	description: "技能说明",
	content: "# My Skill\n\n正文(SKILL.md 风格 markdown)",
	hide: false,
});
```

**展示面**:
- daemon `skills.list` 合并返回(`_source.provider === "extension"`,`filePath: ""`,content 随行);
- `skills.read` 直接返回 `content`(无文件读);
- `skills.delete` 拒绝(仅 user 级文件技能可删);
- GUI 扩展中心 / TUI /extensions 技能类目下出现,归入"扩展声明" provider 节点;
- 扩展禁用/卸载 → 技能自动消失(HMR watcher 同时失效 skills 缓存)。

**边界**:虚拟技能**不进 agent 的 loadSkills 自动装载**(那是文件扫描路径)——技能中心可见 + 可读,但不会作为上下文注入 agent;需要注入的扩展请写真实 SKILL.md 文件。

## 9. 扩展注册魔术关键词(registerMagicKeyword,2026-10-11)

扩展贡献一个**魔术关键词**:输入框里单独出现的词,提交时向模型追加一条隐藏提示。

```ts
import deepdiveNotice from "./prompts/deepdive-notice.md" with { type: "text" };

pi.registerMagicKeyword({
	name: "deepdive",
	description: "在输入框里单独输入 deepdive,即请求一次带证据链的深度分析",
	notice: deepdiveNotice.trim(),
	noticeType: "deepdive-notice", // 可选,默认 `<name>-notice`
});
```

**契约**:
- 匹配与内置关键词同规则:小写、散文边界(`keywordInProse`),因此 `deepdiving` / `Deepdive` / `deepdive.ts` / 行内代码里的 `deepdive` 都不触发;
- 提示以 `role: "custom"`、`display: false`、`attribution: "user"` 追加 —— 模型可见,transcript 不显示;
- 开关走 `magicKeywords.<name>` 设置键,并受总开关 `magicKeywords.enabled` 门控;**该键从未写入时按停用处理**(扩展不能因为没人配置就开始改模型行为);
- 提示词正文放在 `.md` 文件里用 `with { type: "text" }` 导入(不内联拼字符串)。

**生命周期**:注册进 loader 的 pending 队列,会话初始化时 replay 进 `modes/magic-keyword-registry`;扩展卸载/禁用时按 sourceId 移除 —— 关键词不会活过声明它的扩展。

**可运行样板**:`examples/plugin-magic-keyword`(关键词 + 自带设置面板 + RPC 完整一套)。


扩展为**指定工具名**贡献 transcript 渲染器,替换内置渲染器:

```ts
pi.registerToolView("my_tool", { moduleUrl: "./views/my-tool.tsx", label: "My Tool View" });
```

**模块契约**(与 registerComponent 同编译管线,blob import + `window.MusePiReact`):
- 默认导出两种合法形状之一:
  - **React 组件**:作为全卡 Card 渲染,收到 `ToolRenderProps` `{ name, args, result, running, host, kind, intent }`;
  - **ToolRenderer 对象** `{ Summary, Body?, Card? }`(guest-client 内置注册表同构)。
- 工具名 = wire 工具名(扩展自己 registerTool 的工具名,或覆盖内置如 `bash`);扩展渲染器**优先于内置**(`resolveToolRenderer` 先查外部表)。

**分派**:daemon 编译 → `extensions.list.toolViews` → GUI `useExtensionToolViews`(ChatView 挂载)blob-import 并注册进 guest-client tool-render 外部表 → `ToolView` 按名分派。编译失败的 view 携带 `error`,回退内置/generic 渲染器,不破坏 transcript。

**参考实现**:`packages/client-core/src/tool-render/registry.ts`(`registerExternalToolRenderers`)、`packages/desktop-app/src/lib/slot-host.tsx`(`useExtensionToolViews`)、`packages/coding-agent/src/daemon/extension-artifact-compiler.ts`(`collectToolViews`)。

## 9.1 扩展 widget 类型（registerWidget）

扩展可以同时声明一种卡片类型的元数据与渲染器：

```ts
pi.registerWidget({
	type: "metric",
	label: "指标",
	fields: [{ key: "value", type: "number", label: "数值" }],
	defaults: () => ({ value: 42 }),
	tone: "default",
	moduleUrl: "./ui/metric.tsx",
});
```

- **元数据在 daemon 侧**：`widget` 用它校验 payload、生成 agent schema；`board` 用它校验卡片类型（会话无关的 board RPC 也能校验，不依赖渲染器是否编译过）。
- **渲染器走与 registerComponent 相同的编译管线**：模块默认导出 React 组件，收到 `{ data, update, sendPrompt?, preview?, annotateCapture? }`；不要 `import react`，用编译器注入的 `React`（`window.MusePiReact`），否则会多一份 React 实例。
- **分派**：daemon 编译 → `extensions.list.widgets` → 宿主用 `loadExtensionWidgets`（`client-core`）blob-import 并 `registerExternalWidgets`；桌面 `useExtensionWidgets`（ChatView）与 guest/移动端 `BoardPanel` 共用同一份加载器。同名覆盖内置类型，picker、内联卡与看板共用同一份。
- **运行时校验**：`widget` / `board` 调用时把 `ctx.getRegisteredWidgets()` 合并进类型表；`board.save` / `widget.schema` 这类无工具上下文的 RPC 读 daemon 进程索引（`registerWidget` 写入）。插件类型因此能真正通过校验，而不只是出现在扩展清单里。
- **与 registerToolView 的区别**：后者按工具名替换整条工具渲染；本项按卡片类型新增/替换一个 widget 渲染器。
- **参考实现**：`packages/coding-agent/src/bundled-plugins/visuals/`（`metric` / `clock` 试点，`widget-compile.test.ts` 端到端校验编译产物）。

## 9.2 主题 bundle：滚动进度轨皮肤（registerScrollbarSkin）

主题 bundle 可以贡献横向/纵向浮动滚动轨的皮肤。皮肤是**数据**，不携带渲染器模块——轨道由宿主绘制，插件只声明外观：

```ts
pi.registerScrollbarSkin({
	id: "builtin-snake",              // 与内置同 id 即覆盖
	displayName: "Snake",
	base: "gummy",                    // "gummy" 胶囊 / "pacman" 豆轨
	colors: {
		accent: "var(--color-accent)",  // 跟随主题变量
		track: "color-mix(in oklab, var(--color-text-faint) 30%, transparent)",
		eaten: "transparent",
	},
	size: 10,                         // 6–24px
});
```

- **校验**：loader 要求 `id`/`displayName`/`base`/三个颜色/数值 `size`；颜色值若含 `url()`、`image-set()`、`expression()` 直接抛错（这些值会写入 CSS 自定义属性，不能成为网络/执行面）；`pacGlyph` 只接受 `data:` URL。
- **数据流**：daemon 装载 → `collectScrollbarSkins` → `extensions.list.scrollbarSkins` → 桌面 `useExtensionScrollbarSkins`（ChatView）→ `scrollbar-skins` 宿主模块 → 浮动轨与外观选择器读同一份目录。
- **优先级**：contributed → imported（用户导入的 zip）→ built-in，按 `id` 去重，插件可覆盖内置皮肤。插件停用后 contributed 清空，内置目录仍在，轨不会失去皮肤。
- **内置目录归 `ui-theme` 渲染端 bundle 所有**：`packages/desktop-app/src/plugins/ui-theme/` 内的 `skins.ts` 定义 snake / gummy-rainbow / pacman，`rail.tsx` 渲染、`rail.css` 提供样式、`settings.tsx` 提供外观卡；`index.ts` 注册 `app.overlay` + `settings.item.ui-theme`。宿主保留同构兜底，供 bundle 停用、编译失败或 guest/mobile 宿主使用。
- **daemon 主题插件仍可贡献皮肤**：`registerScrollbarSkin` 是给 daemon 侧主题包的稳定缝；内置目录不再由 `builtin-themes` 注册，避免两个所有者。
- **编译插件共享注册表**：`scrollbar-skins` 在 `EXTENSION_HOST_MODULES` 中（路径 `plugins/ui-theme/skins`），编译后的 `app.overlay` 覆盖层读取的是宿主实例，而不是打包副本（见 §19）。
- **参考实现**：`packages/desktop-app/src/plugins/ui-theme/`（`rail.tsx` / `rail.css` / `skins.ts` / `settings.tsx` / `index.ts`）。

## 10. 扩展 transcript 节点渲染(transcript.node seat, DSH 粒度, 2026-08-27)

扩展为**指定节点 kind** 贡献 transcript 渲染器。对应 DSH `conversation.chat.node` 的单一"聊天节点 seat"槽：按节点 kind(entryKey) 分发，命中即"拥有"该条目的渲染，未命中回退到内建渲染(fallback)。

**注册**:

```ts
pi.registerComponent({
	slot: "transcript.node",
	moduleUrl: "./ui/my-node.tsx",
	label: "My Chat Node",
	entryKinds: ["message:user"], // 派发键(transcriptNodeKind)
});
```

**模块契约**(与 registerComponent 同编译管线, blob import + `window.MusePiReact`):
- default export React component, 收到 `SlotComponentProps.node`: `{ entry, kind, turnIndex?, children? }`。
  - `entry` = 原始 `SessionEntry` wire 值;`kind` = `transcriptNodeKind(entry)` 派发键;
  - `children` = 内建 MusePi 对该条目的渲染 —— 组件可包含它做"增强"(保留官方骨架), 或完全自绘(**拥有**该 kind)。
- 未命中的 kind -> 内建渲染(children 直接返回), 等价 DSH fallback。

**分派**: daemon 编译(透传 `entryKinds`) -> `extensions.list.components` -> GUI `useSlotComponents(rpc, "transcript.node")` -> `renderTranscriptNode`(ChatView) 按 kind 过滤(`selectTranscriptNodeComponents`) -> 命中组件收到 `node` 上下文拥有渲染, 未命中回退内建。组件集只在 `extensions.changed` 变化, 不随 stream 帧变(memo 安全)。

**防置换**: 扩展声明的 kind 只影响该 kind 条目的渲染; 内建类型(message/compaction/branch_summary/model_change 等)仍由宿主持有, 扩展只能经 `children` 基座增强声明的 kind。与 DSH 一致 —— 官方 sidebar/conversation 的 owner 始终是宿主, 插件贡献到 seat, 不覆写核心。

**参考实现**: `packages/client-core/src/components/transcript/Transcript.tsx`(`transcriptNodeKind`/`renderTranscriptNode`)、`packages/desktop-app/src/lib/slot-host.tsx`(`selectTranscriptNodeComponents`/`SlotComponentMount`)、`packages/coding-agent/src/daemon/extension-artifact-compiler.ts`(`collectSlotComponents` 透传 `entryKinds`)。

## 11. 桌面壳与 Shell 模式(desktop-shell, dsh-desktop parity, 2026-08-28)

Electron 壳由第一方 Cordis 包 `desktop-shell` 提供,与其他 MusePi 包使用同一生命周期:
- `extensions.list` 顶层返回 `shell: { enabled, mode, webUrl }` —— 壳连接状态(`shell.enabled` 设置键)、DSH 三模式、daemon serve 的渲染器 origin。
- `extensions.setEnabled("desktop-shell", { enabled, mode? })` 切换包状态与模式(写包名到 `disabledExtensions`,并维护 `shell.enabled`/`shell.mode` 与 `web.port` 发现文件 —— 壳进程据此决定 loadURL 运行时渲染器 or 本地 bundle)。
- daemon `--web-port` serve 渲染器(`guest-client/dist`) + `/__daemon.json`(wsUrl/token); 壳 `probeWeb()` 读 `web.port` 自动发现。

**Shell 三模式**(DSH compatibility/extended/enhanced):
- `compatibility`(默认): 注入脚本只注册 `transcript.node` —— 扩展贡献聊天节点。
- `extended`: 注入脚本额外注册 `composer.dock` / `panel.tab.workbench` / `statusbar`; guest-client 的 `CompatSlotHost` 按 slot 渲染注册组件(composer 上方 dock、底部状态条、workbench 面板)。
- `enhanced`: 渲染器侧同 extended, 壳保留原生 titlebar(原生 UI 面板预留)。

**注册表契约**: daemon 注入脚本(`static-web.ts` `compatSlotHostScript`, 仅 `?shell=1`) blob-import 已编译组件 → `window.MusePiCompatHost.register(slot, entryKinds, Component, extensionId)`; guest-client 初始化注册表(`main.tsx`), `Transcript`/`CompatSlotHost` 只读消费。纯浏览器 guest 无注入脚本 → 注册表为空 → 内建渲染。

## 12. 设计体系贡献(registerDesignSystem, M3 §3, 2026-09-27)

扩展可注册命名设计体系(风格资产包),供 design 模式页的预览 rail 选择与引用:

```ts
pi.registerDesignSystem({
  id: "my-brand",                  // kebab-case;撞内置/撞已注册即抛
  label: "My Brand",
  description: "一句话描述(hover 浮卡)",
  swatches: ["#0f172a", "#e2e8f0"], // 色卡,≤6 色
  tokens: { "--accent": "#38bdf8" }, // gui token 覆盖片段,只允许既有阶梯键,禁止新造 token
  promptSection: {
    name: "design-system",
    order: 40,                     // 固定 40:位于 mode 预设区块之后
    text: "给 agent 的设计简报(色彩/材质/排版基调)",
  },
});
pi.unregisterDesignSystem("my-brand");
```

- 消费面:daemon `design.systems.list` RPC 合并返回内置五套(`minimal`/`glass`/`editorial`/`neubrutalism`/`darkneon`,id 稳定保留)与扩展注册项(带 `source: "builtin" | "extension"` 徽章);GUI 选中后把 id 写入 `projectMetadata.designSystemId` 建会话,会话引导时 `promptSection.text` 经 PromptComposer 注入 system prompt(source `design-system`)。
- 防撞契约:扩展 id 撞内置抛 `registerDesignSystem: id "x" collides with a built-in design system`,重复注册抛 `... is already registered`(与 registerMediaProvider 同形态)。
- 生命周期:随扩展加载注册、reload/unload 按来源整源清除,下一次 prompt 重建即生效。
- 类型:`DesignSystemConfig` 见 `packages/coding-agent/src/extensibility/extensions/types.ts`。

## 13. 插件清单配置(manifest config/resources + pi.config,dsh 插件管理页 parity,2026-09-30)

扩展的 package.json 可在 `musepi` 块下声明**配置字段表**与**资源占用卡**(`musepi` 为权威清单字段;旧上游的 `omp`/`pi` 块继续可读,新扩展一律写 `musepi`):扩展中心详情页据此渲染 dsh 式管理视图(配置表单 + 资源卡),扩展运行时经 `pi.config` 读取同一份值。

### 清单声明

```json
{
  "name": "voice-input",
  "musepi": {
    "extensions": ["index.ts"],
    "experimental": true,
    "config": [
      { "key": "enabled", "type": "boolean", "default": true, "description": "启用语音输入" },
      { "key": "threshold", "type": "number", "default": 0.5, "min": 0, "max": 1, "step": 0.05 },
      { "key": "model", "type": "select", "default": "base", "options": ["base", "large"], "restart": "session" },
      { "key": "prompt", "type": "string", "default": "你好" },
      { "key": "bin", "type": "path", "default": "" }
    ],
    "resources": { "disk": "120MB", "memory": "350MB", "setupMinutes": 2, "models": [{ "name": "stt-base", "size": "75MB" }] }
  }
}
```

- `experimental` 只接受字面值 `true`，会沿 daemon 条目传到普通包和模块卡片并显示本地化「实验性」标签；缺省和其他值不标记。
- `icon` 是插件自己的标记:emoji、文字字形或 `http(s)://`/`file://` URI。插件列表与详情优先使用它,图片按 `contain` 缩放,解码失败回退名字字形。
- `presetOnly` 只接受字面值 `true`:`true` 的 persona 包只在 Agent 预设里按会话提供,不出现于能力中心的插件列表;完整库存仍在 设置 → 扩展与插件。
- 字段类型:`boolean | number | string | select | path`;number 可带 `min/max/step`,select 必须给 `options`。
- `restart` 生效域:`none`(默认,立即) / `session`(新会话) / `daemon`(重启 daemon)。
- fail-soft:manifest 是用户可写 JSON,坏字段逐个被丢弃进结构化 errors(详情页有可见警告),好字段照常生效,绝不拖垮扩展登记。

### 运行时读取

```ts
export default async function (pi: ExtensionAPI) {
  const threshold = await pi.config.get<number>("threshold"); // 钳制后的值,未写过 = 声明默认
  const all = await pi.config.getAll(); // 完整值表(只含声明键)
}
```

- 取值与扩展中心表单、`extensions.setConfig` 写入共用同一条 `coerceConfigValues` 钳制链路(daemon/GUI 单一权威在 `@musepi/pi-wire`):存储坏值回退声明默认,未声明键 `get` 返回 `undefined`、`getAll` 被过滤。
- 生效语义:`restart: "none"` 字段每次调用现读——GUI 表单改完立即可见;`session` 字段在扩展加载时快照,新会话/重载后生效;`daemon` 字段约定需重启 daemon。
- 存储落点:`<agentDir>/extensions/plugin-config.json`,键空间与 `disabledExtensions` 一致(`extension-module:<name>`)。

契约与类型:`ConfigFieldDesc`/`PluginResources`/`coerceConfigValues` 见 `packages/wire/src/plugin-config.ts`;存储见 `packages/coding-agent/src/extensibility/extensions-center/plugin-config-store.ts`;运行时读取见 `ConcreteExtensionAPI.config`(loader.ts)。

## 14. 插件安装(spec 安装与能力报告,2026-10-06)

市场(`marketplace.*`)只覆盖已收录的包。自己做的、还没发布的插件走本节的 spec 安装面:插件页工具栏「安装插件」直接填包名、git 地址、压缩包或本机绝对路径。

### RPC

| 方法 | 入参 | 出参 |
|---|---|---|
| `plugins.install` | `{ spec, force? }` | `{ installId }`(立即返回,不阻塞到安装结束) |
| `plugins.install.status` | — | `{ installs: PluginInstallView[] }` |
| `plugins.install.cancel` | `{ installId }` | `{ status: "cancelled" \| "not-running" }` |
| `plugins.install.output` | `{ installId }` | `{ lines: PluginInstallOutputLine[] }` |
| `plugins.uninstall` | `{ name }` | `{ name, application?, applied?, deferred? }` |

事件(daemon 广播,渲染端按 `installId` 对账):
- `plugins.install.state` — 状态迁移,载荷同 `PluginInstallView`;
- `plugins.install.output` — 包管理器输出的每一块,带 `stream`;
- `plugins.apply.state` — 装/卸/升级/启停对活跃会话的应用结果:`{ change, packageName, application: "applied" \| "pending", applied, deferred, errors }`。

### spec 分类

`parseInstallSpec`(单一权威,`extensibility/plugins/spec-classifier.ts`)把 spec 分四类,安装按类走不同分支:

| 类别 | 例子 | 包名来源 |
|---|---|---|
| `registry` | `acme-plugin`、`@scope/plugin@1.2.3` | spec 自身 |
| `git` | `github:owner/repo#v1`、`https://github.com/owner/repo` | 装后 diff `plugins/package.json` |
| `tarball` | `/path/pkg.tgz`、`https://host/pkg-1.0.0.tgz` | 装后 diff |
| `path` | `C:\dir\pkg`、`/home/me/pkg` | 装后 diff |

- 本地路径必须绝对:GUI 输入框没有工作目录可依,相对路径会被解析到插件目录内。
- 三段式 http(s) URL 仅在 host 属已知 forge(github/gitlab/bitbucket/codeberg/sr.ht/gitee/gitcode)时读作仓库;其它 host 需带 `.git` 后缀自证。否则一个网页链接会启动必然失败的克隆。
- 取消与失败是两回事:取消后插件目录已还原、不带失败分类,GUI 文案与动作都不同。

### 入口校验、打包与分享

安装校验使用生产 `mountPlugin` 链解析每个 `extensions` 入口，因此纯 Cordis 的 `name` / `inject` / `Config` / `apply` 与 legacy 默认导出 factory 都按各自真实语义检查。校验在独立 runtime 和 event bus 上执行，成功后立即调用 `disposePluginPrimitives` 释放资源；入口缺失或挂载失败会拒绝安装并触发既有回滚，不会留下半安装状态。

`musepi plugin pack [path] [-o dir] [--json]` 在本地生成可分发的 `.tgz`。它要求包具有 `name`、`version` 和 `musepi` / `omp` / `pi` 清单，检查声明的入口存在后调用 `bun pm pack`，不访问 registry，也不执行 publish。将生成的文件发给接收方后，可在插件页拖入，或执行 `musepi plugin install <tarball 绝对路径>`。绝对 `.tgz` 路径按归档安装，不会误入目录 link 分支。需要公开发布时，仍使用包 registry 的发布流程；`plugin pack` 本身不发布。

### 拖入安装

安装框本身是拖放目标:把 `.tgz` / `.tar.gz` / `.zip` 压缩包或一个插件文件夹拖进去,绝对路径直接落到 spec 字段,随后与手输路径走同一条安装路径。未发布、自建、只在同事机器上存在的插件因此不需要先发布。

取路径走 preload 暴露的 `webUtils.getPathForFile`(`electron/preload.cjs` 的 `getDroppedFilePath`)。Electron 32 起渲染端的 `File.path` 已移除,渲染器没有别的办法知道拖进来的是什么位置;取不到路径时该 API 返回空串,调用方必须区别对待而不是当作路径去装。

拖放只接受 bun 能读的归档或目录。文件夹没有扩展名可判,一律接受;文件按扩展名判 —— 拖进一个 `.docx` 或 `.png` 会在落进输入框之前就拒绝,而不是让包管理器报一个"无法解析的 spec"。

**拖入不会执行被拖包的安装脚本。** `PluginManager.install` 跑 `bun install <spec>`,不传 `--trust`,而 bun 默认不执行依赖的 lifecycle 脚本(除非该包进了项目的 `trustedDependencies`)。因此拖入一个带 `postinstall` 的包,它自己的脚本不会运行。这与技能市场的 `awaiting-approval` 阶段不同 —— 那里拦的是"下载后的文件会被 loader 求值",插件安装没有这一步可拦;真要加批准闸门,先要决定的是"插件安装允许执行什么",不是界面怎么摆。

### 能力报告(装上 ≠ 能跑)

`describePluginCapability`(`extensibility/plugins/capability-report.ts`)在安装完成后静态判定该插件能否在本底座加载,三档:

- `runnable` — 声明的依赖都能满足,入口文件都在。
- `partial` — 能加载,但有组件注册的槽位本底座没有挂载点(例如指向 `panel.tab.*` 之外的槽),那部分界面不会出现。
- `incompatible` — 缺少运行包(常见于为其它 harness 构建的插件,其 `peerDependencies` 指向本仓不提供的包),或声明的入口文件不在盘上。缺失项逐个列出。

判定只读插件自己的 `package.json` 依赖与入口源码,**不加载插件代码** —— 「能不能加载」正是要避免先加载再观察的东西。缺失的运行包与缺席的槽位分别影响 `incompatible` 与 `partial`,因为前者加载不了、后者只是那部分不显示。

报告随 `plugins.install.state` 的终态返回,渲染端据此提示,不必等到加载失败才发现装了个跑不起来的插件。

### 已打开会话的即时生效

安装、卸载、市场升级与 `plugins.setEnabled` 都写同一份插件清单,因此它们不再只对下一个会话生效:daemon 解析该包贡献的入口路径,逐条交给每个活跃会话(`daemon/live-plugin-apply.ts`)。会话未装载的入口走 load,已装载的走 reload,卸载/停用走 unload;unload 只移除没有其它扩展再注册的工具名,并重建 prompt。单条扩展模块的 `extensions.setEnabled` 也走同一通道,但只对 `plugin-module` / `extension-module` 条目生效——技能、工具、MCP 等行不是会话可装载的扩展入口。

会话拥有时机:空闲会话立即换入,流式会话把操作挂到自己的待处理表,在该回合结束后的空闲边界执行并报 `deferred: true`。同一入口的连续请求折叠为最后一次,不同入口全部执行。单条入口失败只进错误列表,不影响其它入口或其它会话。

结果经 `plugins.apply.state` 广播:`application` 为 `applied`(全部立即生效)或 `pending`(至少一个会话推迟);`applied` / `deferred` 是入口操作计数,`errors` 逐条带会话与路径。没有任何会话需要改动且无错误时不广播 —— 「应用到 0 个会话」不是值得提示的事实。

### 插件库存的两个平面

`extensions.list` 的 `presets[]` 带 `isDefault` 与 `rows`:`rows` 是该预设**继承折叠后的完整组合**(`extensions` 显式白名单 + `plugins` 组合行展开到扩展入口名),被父预设用 `enabled: false` 关掉的行仍保留并标记为停用。GUI 的会话插件面直接渲染选中预设的 rows,全局面是组合之外的其余内置条目;`enabledInPresets`(每个条目的「启用于」)由同一份 rows 反推,只作为事实行,不再充当分类依据。预设面读取失败时 `presets` 为空,清单主数据照常返回。

### 安装源与回退链

三个设置键(`pluginRegistryMode` / `pluginRegistryUrl` / `pluginRegistryFallbacks`,均不带点号——点号键会被 Settings 当嵌套路径解析)决定安装问哪个源。默认模式先问官方源,遇到「换源可能有救」的失败再试公开镜像。

换源与否由 `attributeFailure`(`extensibility/plugins/registry-fallback.ts`)判定,而非「失败就重试」:包管理器报的是哪一类失败、该失败是否点名了 spec 自己的主机(host 失败换 registry 无意义)、纯 registry spec 的失败永远可换。链在每次重试前先还原本轮开始时捕获的文件,否则失败尝试留下的半写状态会成为下一次尝试的起点。

**不测延迟、不做粘性回退**,理由与 DSH 的差异见 `docs/handoff-plugin-install.md` §4。

## 15. 用户自定义扩展(现状核实,2026-10-06)

对照 DSH 的用户 patch 层核实过两次(2026-10-06 修正)。**先纠正本文档早前的一处错误记录**:早前称「DSH 可以在 patch 里写 `insert: [{ id, name, config }]` 而不必有包」——**这是错的**。`insert` 的 `name` 必须是一个真实的、已安装的包名,Loader 靠它 import;`insert` 做的是**在 Loader 树里增加一行指向该包**,并可同时携带 `config` 与 `disabled` 条件(`vendor/include/src/index.ts:77-101`、`packages/bundle/web-app/cordis.patch.yml:44-63`)。它不是凭空造插件,配置里永远配着实现。

两侧的真实对照:

| 能力 | DSH | musepi | 依据 |
|---|---|---|---|
| 本地未发布插件 | `plugin add .`,相对路径锚定到调用目录;装完按 manifest 的 `dsh.bundle.patch` 自动 reconcile 进 `profile.bundles` | `PluginManager.link(path)` 建符号链接;`PluginManager.install` 支持 path/tarball 形态 | `deepseek-harness/apps/cli/reference/README.md:81`、`extensibility/plugins/manager.ts:917` |
| 装完即生效 | 否——须进 Loader 树 | 是——`getAllPluginExtensionPaths` 运行时发现 | `extensibility/extensions/loader.ts:1012-1015` |
| 按行开关 | `setPluginEnabled` 写 patch 的 `disabled` 覆写 | `extensions.setComponentEnabled`,粒度 `<plugin>/<component>` | `daemon/services/extension-service.ts:601` |
| 整包启停 | 同上(行级) | `plugins.setEnabled` → `settings.disabledExtensions` | `daemon/server.ts:1928` |
| **关掉整个发现层** | **无此概念** | `disableExtensionDiscovery`,已用于 compress/session、security/coordinator、commit/agentic | `extensibility/extensions/loader.ts:950-955`、`compress/session.ts:61`、`security/coordinator.ts:265` |
| **整包条件启停** | `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"` | **无** | DSH `packages/bundle/web-app/cordis.patch.yml:47` |
| profile 隔离 | `$DSH_HOME/profiles/<name>/`,含完整 Loader 树 | `~/.musepi/profiles/<name>/agent/`,含 sessions/MCP 凭据/兼容性豁免/扩展加载 | `discovery/builtin.ts:72-73`、`mcp/oauth-flow.ts:26-30` |

**粒度上我们不比 DSH 细**:DSH 的「行」不可再分,而 `Extension` 接口为每个注册面各持一个独立通道(`extensibility/extensions/types.ts` 的 `Extension`),每条各自加载与卸载。但我们**多一个控制维度**——`disableExtensionDiscovery` 能整层关闭环境发现,DSH 的 Loader 树没有对应概念。通道数会随注册 API 增加而变,故不复述具体数字,以该接口为准。

### 真实差异只有一处:整包级条件启停

`disabledExtensions` 是静态 id 列表,没有表达式求值。DSH 能在 patch 里写 `disabled: !!js <表达式>`,Loader 在每次挂载决策时针对 loader ctx 求值——所以「这个包只在 desktop profile 下启用」是可表达的。

这条差异**在 DSH 插件兼容层落地时会直接咬人**:bundle 的 `disabled: !!js` 翻译不了。对应的做法是兼容层求值常见形态(比较 profile 名、判断环境变量存在性)并写入 `disabledExtensions`,求值不了的表达式显式报「无法翻译」而非静默忽略——静默忽略会让一个本该禁用的插件被装载。

不必为此把 musepi 改成声明式 Loader 树:那会把「插件是运行时发现的」这个前提改掉,代价大于收益。

## 16. Claude Code 兼容面(现状核实,2026-10-06)

对照 DSH 的 `hooks-claude-code` 核实过一次。DSH 的 Claude Code 兼容**只有一件事**:把 Claude Code `hooks.json` 的 command 型钩子桥到自己的扩展点,认 7 个事件(`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `SubagentStart` / `SubagentStop`),`configPath` 必填、无自动发现,且不读 `.claude-plugin/plugin.json`、marketplace、commands、agents、skills、`.mcp.json`。

musepi 的覆盖面**更广**,不必为了"对齐 DSH"补 P3 —— 补了反而是改窄:

| 兼容面 | 实现 | 依据 |
|---|---|---|
| 插件目录(`~/.claude/plugins`) | `claude-plugins` provider:读 `installed_plugins.json` 清单、认 `.claude-plugin/plugin.json`,含 skills / MCP / commands,带路径逃逸防护 | `discovery/claude-plugins.ts:4-5,75,119,188` |
| `.claude/` 配置目录 | `claude` provider 共 9 个能力面 | `discovery/claude.ts:523-587` |
| CLAUDE.md / AGENTS.md | 指令文件 + `@import` 展开 | `discovery/claude.ts:128-149`、`discovery/at-imports.ts` |
| skills | `~/.claude/skills/*/SKILL.md` | `discovery/claude.ts:539` |
| slash commands | `~/.claude/commands/*.md` | `discovery/claude.ts:555` |
| hooks | `.claude/hooks/pre/` 与 `post/` | `discovery/claude.ts:563` |
| 自定义工具 | `~/.claude/tools/` | `discovery/claude.ts:571` |
| MCP | `.claude.json`、`.claude/mcp.json` | `discovery/claude.ts:523` |
| marketplace | `.claude-plugin/marketplace.json` 目录清单 | `extensibility/plugins/marketplace/fetcher.ts:199` |
| LSP | `.claude/lsp.*` | `lsp/config.ts:410-411` |
| settings | `.claude/settings.json` 项目层 | `config/settings.ts:295,362` |

优先级是刻意排的:claude-plugins(70) < claude(80),所以用户自己在 `.claude/` 里的覆盖优先于 marketplace 装来的插件(`discovery/agent-plugins.ts:39-40`)。

**与 DSH 的实质差异只有钩子的执行模型**:DSH 桥的是 Claude Code 的 shell 命令钩子(带 `hookSpecificOutput.hookEventName` 事件门控、`${CLAUDE_PLUGIN_ROOT}` 替换、exit 2 阻断),而 musepi 的 hooks 是 JS/TS 模块(`HookFactory`),命令钩子另走 `.claude/hooks/{pre,post}/` 的目录约定。若要补 command 型钩子,应作为 hooks 引擎的一种新来源接进现有 `HookEvent` 联合,而不是新建一套与 DSH 对齐的独立桥。

## 17a. 第三方 Cordis 插件适配

生产插件管理器默认合并 `superpowers-dev`（`obra/superpowers`）与 `googlechrome`（`GoogleChrome/modern-web-guidance`）目录，让 Superpowers 和 Modern Web Guidance 无需先添加 marketplace 即可见。内置目录只提供元数据，不自动下载、安装或启用插件；用户显式安装后才获取包。同名用户目录优先，其余自定义目录保留。两个条目使用与目录版本一致的远程品牌图标，未安装时也可显示。

`MarketplaceManager` 在安装缓存复制完成后调用 `compat/third-party-cordis.ts`：只修改安装器拥有的缓存 `package.json` 和适配入口，不编辑上游源目录。版本刷新、按 scope 升级、runtime link、启停状态与 Cordis mount/dispose 继续由原管理器负责。适配器还读取 `.codex-plugin/plugin.json` 的 `interface.logo`，仅将缓存内已存在的资源写为 `musepi.icon` 的 `file://` URI；路径逃逸与缺失资源继续使用默认回退。

- `superpowers` 的 `musepi` 声明指向其现有 `.pi/extensions/superpowers.ts`，保留 `pi` 声明与 bootstrap/context 行为；不会生成替代实现。
- `modern-web-guidance` 在缓存的 `cordis/index.ts` 注册同名虚拟技能和 `modern_web_guidance` 工具。工具接受 `operation: "search" | "retrieve" | "list"`、可选 `query` 与 `skillVersion`；search/retrieve 必须有 query。包内存在 `modern-web.mjs` 时直接调用，否则使用 `npx -y modern-web-guidance@<缓存 package.json 的版本>`（Windows 为 `npx.cmd`），不使用 `@latest`。60 秒超时，输出上限 256 KiB，非零退出显式失败；调用方取消、超时或输出超限都会终止子进程。适配入口无外部运行时依赖，可从任意缓存路径加载。

`marketplace.detail` 与安装共用源码准备和持久化克隆。首次读取详情时按需获取源码，后续读取复用磁盘缓存，不安装或启用插件；返回显示名、完整介绍、图标、能力与按名称排序的技能 frontmatter。`marketplace.list` 额外返回活动安装的 `enabled`，详情页据此通过 `plugins.setEnabled` 启停。

适配按插件名显式选择，目前仅覆盖上述两个已审查包；其他 Agent 插件格式不会自动推断或转换成 Cordis 插件。

## 17. 模块身份契约：共享实例 vs 重新求值(2026-10-18)

插件的**模块实例**有两个互相排斥的诉求，而 Bun 只提供两种行为、没有第三种：

| 写法 | 行为 |
|---|---|
| `import(path)` | 命中 ESM 缓存，返回**已存在的实例** |
| `import(path?tag)` | 重新求值，返回**新实例** |

实测确认(`?t=1` 与 `?t=2` 是两个不同对象)，也印证了本文件对 HMR 的既有结论：裸
`file://` 加查询串**不能**击穿缓存，必须用 raw path。

### 两个语义各自的用途

- **首次装载必须共享实例。** 会话装载、`ext.call` 的 artifact compiler、cordis
  宿主级装载是三条独立入口；若各自 import 一份，模块级状态就有三份。真实缺陷：
  插件在一个实例上捕获了会话的 `ExtensionContext`，而它的 RPC 在另一个实例上
  读同一个模块变量，读到 `null`。
- **重载必须重新求值。** 磁盘上新字节不重新求值就永远不生效——那是 HMR 的前提。

### 落地方式

`loadLegacyPiModule(path, { fresh })`：

- `fresh` 缺省 → 不带查询串，取进程内同一实例
- `fresh: true` → 附加单调 `?mtime=` 标签，重新求值

调用方约定：**只有显式重载传 `fresh: true`**，其余一律缺省。已接线的重载点：

- `ExtensionRunner.reloadExtension()`(会话内 HMR)
- `CordisDynamicExtensionRuntime.reloadPlugin()` 与句柄 `reload()`(宿主级)

### 顺带去掉的 bundled 特判

原先 `isBundledPluginPath()` 给 `src/bundled-plugins/` 下的插件开第二条装载语义
(裸 `import`、不做源码图快照)。`discovery/builtin.ts` 的注释自陈「a bundled unit
is a package the distribution ships, **not a separate kind of thing**」——措辞与
实现矛盾：随发行版交付不是「另一种插件」。该分支已删除，内置与用户插件走同一条
`loadLegacyPiModule`；代价是首次装载多一次源码图快照，换来的是**单一插件身份类别**。

**回归锚点**：`packages/coding-agent/test/extension-module-identity.test.ts`
四条——两次独立装载只求值一次、`fresh` 重新求值、编辑后 `fresh` 拿到新字节而普通
装载仍取旧字节、形似 bundled 目录的路径不再有第二类语义。

## 18. `ctx.effect` 属于所有插件，`ctx.state` 仍只属于 cordis 插件

`effect` 与 `state` 的差别不在“进不进 cordis”，而在**有没有可挂的生命周期对象**：

| 原语 | 依赖 | 现状 |
|---|---|---|
| `ctx.effect(cleanup)` | 归属调用点的 Cordis fiber | `apply` 里注册归扩展 fiber（卸载/重载执行）；会话处理器里注册归会话 fiber（会话结束执行）；无 fiber 的旧式装载回退到实例账本 |
| `ctx.state` | 一个随卸载清空的 fiber 作用域存储 | 仍只发给 cordis 插件 |

账本按 `Extension` 实例存放，所以“谁来回收”不再是 cordis 独占的问题：bundled 宿主插件（如 `musepi-hmr` 的 watcher）在宿主装载器 reset 时被回收，会话扩展在 runner 收尾时被回收。`effect` 返回 disposer，可单独撤销一条登记而不卸载整个插件。

插件卸载只走一个入口：effects、事件监听 disposer 与 state 一起清空，任何一条卸载路径都不会漏掉监听；会话停止只执行 effects，因为 runner 可能复用，监听要留到真正卸载。

`ctx.effect` 的归属跟随调用点（与 dsh 一致）：在 `apply` 里注册的清理归扩展 fiber，卸载/重载时执行；在 `session_start` 等会话处理器里注册的归会话 fiber，会话结束即执行。没有 fiber 的旧式装载仍用实例账本，卸载与会话停止都会执行。

会话级监听用 `ctx.session.on(event, handler)`（dsh 的 `agent.ctx`）：作用域是一个真实的 Cordis fiber（`eventBus.inject`），监听登记进 fiber 的 effect 账本，由 fiber 销毁回收，没有旁路账本。作用域在 `session_start` 派发前打开、会话收尾时销毁，监听不会带到下一个会话；`session_start` 重放（插件重载后的 `refreshSessionStart`）会先销毁旧 fiber 再建新的，所以只重注册、不叠加。`ctx.on` 仍是实例级（活到插件卸载），两者分工与 dsh 的 `ctx.on` / `agent.ctx` 一致；会话外 `ctx.session` 为 `undefined`，插件必须按可选处理。

与 dsh 的隔离手段对比：dsh 的插件实例挂在宿主 loader 的 fiber 上（`app-boot` 的 `ctx.plugin(Loader)`），一个宿主总线服务多个 agent，所以派发要带 scope 载体（`scopeTarget` + Cordis `Context.filter`）把监听过滤到对应 agent；只有确实需要 per-agent 实例时才在 `agentCtx.plugin(...)` 里装子插件（如 ACP 的 MCP client）。MusePi 现在采用同一机制：会话作用域归 runner，派发携带 carrier，`Context.filter` 只放行「无标签（实例/宿主级）」与「本会话」的监听，所以一个事件总线可以同时服务多个会话而不串台；同一 runtime 同时服务多个活跃会话时，实例级监听按设计接收全部会话事件。插件实例若要跨会话共享，还需把 prompt 贡献与 effect 等会话级注册迁到会话作用域——那是下一步的契约迁移。

实例级监听同样归 fiber：每个扩展装载时在自己的 Cordis fiber 里执行 `apply`（`eventBus.inject`），`pi.on` 登记的监听进该 fiber 的 effect 账本，重载、卸载、回滚只需 `fiber.dispose()`；`eventListenerDisposers` 列表只用于精确计数和没有 fiber 的装载路径，不再承担所有权。

Prompt 贡献与会话绑定：`ctx.promptHost` 只在 `session_start` 之后的会话处理器里可用，`apply` 里读到 `undefined`；核心提示词插件（browser / computer / delegation / file-tools / host-integrations / lsp）都改为在 `session_start` 注册，因此共享实例不会把一个会话的段落带给另一个。服务与内存后端 provider 属于插件实例：`start` 在装载时执行一次，`stop` 只在卸载/重载时执行，某个会话结束不会停掉它们。`pi.state` 与 `pi.events` 同样是实例级，需要会话状态的插件自行按会话 key。

装载复用：同一 `(cwd, 插件入口集)` 的多个会话共享一套插件实例与 runtime（`loadSessionPluginsCached`）。cwd 进 key 是因为插件在 `apply` 时捕获它；会话各自的监听、提示词贡献与 effect 由会话 fiber 承担，派发按会话过滤。`fresh: true`（HMR 重载）与 CLI 预加载路径不经过缓存。

会话内重载或移除某个扩展时，当前 generation 标记为 retired：新会话装载新 generation，仍在使用旧实例的会话保有一份，最后一个会话释放时才销毁（与 dsh 的 preset generation 引用计数一致）。

Preset 组合同一套规则：同一 runtime 上同一 preset 只挂载一次，会话通过租约加入，定义变化时当前 generation 退役、最后一个会话释放后销毁。Preset 插件的实例级监听带 preset scope 标签，派发只投给加入该 preset 的会话；会话级注册（`ctx.promptHost`、`ctx.session.on`、会话处理器里的 `ctx.effect`）仍按会话作用域工作。切换 preset 只退出租约，不会销毁其他会话仍在使用的实例。

选择的 dsh 形状 API：`agentPresets.list` 合并三处声明——文件 preset、profile preset、扩展贡献的 mode（宿主级注册表：任何一次装载都会登记；daemon 启动时按 cwd 与工作区注册表中的所有根目录预加载，并复用会话插件缓存，所以无需活跃会话即可列出；同 id 时文件优先），每项带 `source: file | profile | extension`；`agentPresets.read` 对文件 preset 返回磁盘 YAML 原文，对 profile/extension 返回序列化文档（动态 prompt 文本显示为 `<dynamic>`）；`agentPresets.select` 切换并把选择写入会话头，历史会话直接持久化。选择成功后在会话的 Cordis 总线派发 `agent-preset/selected`（`{ sessionId, agentPreset }`，清除时为 `null`），preset scope 与会话级监听都能收到。会话头字段沿用 `modeId`（resume 已经读它）；`AgentSession.getAgentPreset()` / `selectAgentPreset()` 是 dsh 命名的访问器。解析同样走宿主注册表兜底：即使当前会话的发现没有装载声明该 preset 的扩展，创建会话或 `setMode` 也能解析到它——与 dsh 的全局注册表一致，列表里出现的 preset 不会因为换了工作区就选不了。

`state` 没有同步放宽：它要求一个卸载即清空的作用域，而 legacy 扩展按模块级变量写，拿到一个“看起来能用”的 state 只会让两份实例各自持有一半状态。`ExtensionAPI` 上 `state` 仍是可选的（`state?`），代码里必须按可选处理。

### 写插件时怎么选

- 打开定时器、监听器、子进程、watcher → 用 `ctx.effect(() => cleanup())`，所有形态都可以。
- 需要随插件卸载清空的可变状态 → 写成 cordis 插件用 `ctx.state`，或把状态收敛到闭包里。

## 18. `apply(ctx)` lifecycle for plugin UI modules (2026-10-24)

A plugin's **compiled UI artifact** (`ui/*.tsx`, compiled by the daemon via
`bun.build` and then blob-imported) may export `apply(ctx)` alongside its
`export default` component:

```ts
export default function Panel(props) { ... }   // required: the mounted component

export function apply(ctx: PluginClientContext): void {   // optional: module-level setup
  const style = document.createElement("style");
  style.textContent = MY_CSS;
  document.head.appendChild(style);
  ctx.effect(() => style.remove());          // runs on unmount / reload

  const events = new EventSource("/api/my-plugin/events");
  ctx.effect(() => events.close());
}
```

### `PluginClientContext`

| Member | Meaning |
|---|---|
| `effect(dispose, label?)` | Register a teardown. Runs in **reverse** order (a later contribution may depend on an earlier one). |
| `signal: AbortSignal` | Aborted when this module load is superseded or unmounted. Pass it to `fetch`/`EventSource` instead of tracking lifetime by hand. |
| `slot: string` | The seat this component mounted into (`composer.model`, `settings.tab.x`, …). |
| `extensionId: string` | The extension entry path that produced the component. |

### Why this seam has to exist

**A component that only exports `default` has no leak problem**: its styles and
subscriptions live in `useEffect` and React runs the cleanups on unmount. What
leaks is **module-level** contribution:

- one global stylesheet (one per plugin, not one per render);
- one EventSource shared across the plugin's panels;
- window-level listeners.

A reload swaps the whole compiled artifact, and the old module is **never
evaluated again** — whatever it installed stays in the document until the window
closes. The symptoms are "every UI edit leaves another stylesheet behind" and
"sockets still open against a module that no longer exists".

### Host guarantees

- `apply` is called once, **before** the component mounts;
- teardown runs **before the next load** (reload and unmount alike), so the old
  `<style>`/connections are gone first;
- every load gets a **fresh** `ctx` (and a fresh signal) — reusing an aborted
  signal would make every request in the new module fail instantly;
- a module with no `apply` export behaves **exactly as before** (a pure component
  is the common case).

### Acceptance

`desktop-app/test/plugin-client-lifecycle.test.tsx` drives the **real**
`SlotComponentMount` (blob-imports real code → mounts → unmounts) and asserts the
`<style>` count in the document, the abort the module observed, and the disposer
order. Do **not** write a test that replays the host's steps — it would pass
while the host is broken.

## 18.2 Host memory service (`ctx.memory`)

A session extension receives the live memory backend through `ctx.memory`:

| Member | Meaning |
|---|---|
| `backend()` | Active backend id (`off`, `local`, `mnemopi`, `hindsight`, `sharpshooter`). |
| `status()` | The same structured status the settings page and `/memory` read. |
| `search()`, `save()` | Structured recall and explicit writes, when the backend supports them. |
| `clear()`, `enqueue()` | The `/memory clear` and `/memory enqueue` operations. |
| `view()`, `stats()`, `diagnose()` | The prompt payload and backend reports behind `/memory view/stats/diagnose`. |

Both the core memory system and extension code resolve the same backend for the session. A host-half memory plugin (tools, commands, lifecycle) should call `ctx.memory` instead of importing `memory-backend` internals; the desktop settings page is a renderer component and reads the daemon's `memory.*` RPC. `"memory"` is also a host service name for a Cordis plugin's `inject`; `pi.service("memory")` intentionally returns `undefined` because host capabilities are exposed as `ctx.memory`, not as plugin-provided objects.

A Cordis plugin can replace one backend implementation with `pi.registerMemoryBackendProvider({ id, create(settings) })`. The provider is consulted before the built-in backend, a second provider for the same id is refused, and the returned disposer restores the built-in implementation. The runner also runs that disposer on extension unload/reload, so a replaced backend cannot outlive its plugin.

A provider may also contribute a **new** backend id, not only replace one: `registerMemoryBackendProvider({ id: "mybank", label, description, create })` makes `memory.backend` accept that id (`getEnumValues` merges the provider registry) and adds it to the settings picker with the provider's own label and description. Unloading the plugin removes the option, and a config still pointing at the id falls back to `off` instead of resolving to a foreign implementation.

`ctx.hmr` reports host-level hot reload, provided by the host-scope `musepi-hmr` package (`provide: ["hmr"]`) through the host service registry. It publishes the dsh event names through a real Cordis event service: `on("hmr/change", …)` per file batch and `on("hmr/reload", …)` when a reload pass starts for that batch, with Cordis `prepend` ordering and per-listener isolation (`onChange` stays as an alias). The plugin's own `musepi.config` reaches `apply(ctx, config)`: `debounce` (ms), `base`, `root` (a `list` field of roots resolved against base; empty keeps the native extension/plugin roots), and `ignored` (a `list` of globs on top of `.git` and the module cache). `list` is a first-class config field type: manifests declare `type: "list"` with a `string[]` default, the GUI edits it as a comma-separated field, and the wire shape is always `string[]`. `enabled` is false when no watcher runs (no host plugin, tests); `onChange(listener)` receives one batched `{ trigger: "watch" | "manual", paths }` per settle window and returns a disposer; `reload()` runs the current listeners as if the files had changed. `runExclusive(tx)` serializes installs and config writes against reload batches, so neither observes a half-applied state. `getLinked(file)` names the entries that own a file and `getOuterStack(file)` walks the importer chain up to its entry — both answer from the loader's module graph, and return empty when no graph is attached. The watcher is process-wide — the daemon, TUI, ACP, and SDK share one — but reactions are per host: the daemon drops extension caches and broadcasts `extensions.changed`, the terminal drops discovery caches, and a plugin decides for itself what its own reload means. A listener that must not outlive its owner should be registered through `ctx.effect(dispose)`. Host-plugin config batches compare newly coerced values with each mounted record and reload only records whose effective config changed; an unrelated save does not select HMR, while a selected non-reloadable provider still requests restart. Host ensure, reload, and reset share one lifecycle queue, duplicate service names are rejected without replacing the incumbent or leaking rejected effects, and asynchronous service stops are awaited. Replacement plus rollback failure requests restart. Restart requests are deduplicated in `restartRequirements`; `restartRequired` remains the oldest for compatibility, `acknowledgeRestart` removes a handled request, and disposal clears all pending requests.

`memory.*` stays a core contract: every route calls a member of the active backend instead of letting a plugin register method names of its own. Replacing the backend therefore moves `memory.status/view/stats/diagnose/clear/enqueue` with it. `memory.workspace*` follows the optional `workspaceDir(agentDir, cwd)` capability: a backend that returns a directory gets the settings file browser, and one that omits it answers `supported: false` and refuses reads or reveals instead of listing local files that belong to a different implementation.

This is the seam for moving the memory management surface (settings page, `/memory`, tools, RPC) into a first-party Cordis package. The provider seam now exists; no first-party memory plugin registers one yet, so the built-in backends remain the default.

## 19. Frozen host module table for compiled plugins (2026-11-03)

A compiled component is a standalone ESM bundle. Every app import it does not externalize is copied into that bundle — including modules that hold **React context or module-level state**. The copies then diverge: a bundled `prompt-dialog` reads its own default context, so `confirm` resolves `false` without showing a dialog; a bundled toast store never reaches the host's toaster; a bundled floating-menu module owns a second mutex, so two menus can be open at once. Copying a pure helper is harmless; copying an identity-bearing module is a silent behavioral bug.

### Single authority

`packages/collab-proto/src/extension-host-modules.ts` owns the table:

```ts
export const EXTENSION_HOST_MODULES = [
  { key: "prompt-dialog", path: "lib/prompt-dialog" },
  { key: "action-toast", path: "lib/action-toast" },
  { key: "client-core", specifier: "@musepi/client-core" },
  { key: "i18n", specifier: "@musepi/client-core/src/i18n" },
  …
] as const satisfies readonly ExtensionHostModuleDeclaration[];
```

`path` matches a relative app import by normalized suffix at any depth (`../lib/x`, `../../lib/x`, with or without extension, either slash); `specifier` matches an exact bare package import. Every entry declares exactly one rule. `ExtensionHostModuleKey` is the union of keys, and `matchExtensionHostModule(request)` resolves one import to one key; `undefined` means "keep it in the plugin bundle".

### Compiler

The daemon artifact compiler (`packages/coding-agent/src/daemon/extension-artifact-compiler.ts`) consults this table for every resolved import. A match becomes a shim that reads `window.MusePiHostModules[key]`; **no source of the host module enters the bundle**. The shim throws when the table or the key is missing, so a host that does not publish the contract fails at import instead of running against a stale copy. Non-matching imports, including pure helpers such as `lib/leaf-walk`, are still bundled normally. React and React DOM keep their separate mapping to `window.MusePiReact*`.

### Renderer

`packages/desktop-app/src/lib/host-modules.ts` is the one place that binds keys to instances:

```ts
const hostModules = {
  "prompt-dialog": promptDialog,
  "action-toast": actionToast,
  …
} satisfies Record<ExtensionHostModuleKey, unknown>;
```

`satisfies` makes a contract entry without a bound instance a type error, and a key without a contract entry a compile error. `exposeHostModules()` publishes the table as `window.MusePiHostModules` before any compiled component mounts. The older `window.MusePiPromptDialog` and `window.MusePiManagedBrowserHost` globals remain aliases of the same namespace objects, so already-compiled bundles keep reading host state.

`slot-host` is the one entry that registers itself rather than being imported by `host-modules.ts`: `slot-host.tsx` already imports `exposeHostModules` to install the browser bridge, so importing it back from the table would create a cycle. It registers its namespace when the module loads, and the app imports it before any compiled component mounts.

### Current entries

| Key | App module | Identity that must be shared |
|---|---|---|
| `prompt-dialog` | `lib/prompt-dialog.tsx` | Prompt/confirm React context |
| `managed-browser-host` | `lib/managed-browser-host.ts` | Managed-browser host store |
| `action-toast` | `lib/action-toast.ts` (re-exports the `client-core` store) | Toast list and subscribers, shared by the desktop and guest/mobile shells |
| `file-workspace` | `lib/file-workspace.ts` | File preview buffers |
| `floating-menu` | `lib/use-floating-menu.tsx` | Module-level menu mutex |
| `update-ux` | `lib/update-ux.ts` | Update-toast/dialog shared flags and subscriber set |
| `tooltips` | `lib/tooltips.ts` | Tooltip element, timers, and hover/focus state |
| `slot-host` | `lib/slot-host.tsx` | Slot registry store, mount helpers, and slot contract constants |
| `monaco-runtime` | `lib/monaco-runtime.ts` | `monacoPromise`, the global `MonacoEnvironment`, and the worker factory: one Monaco instance and one worker set for every editor surface |
| `monaco-lsp` | `lib/monaco-lsp.ts` | LSP `documents`, provider registrations, peek models, and the editor opener: one LSP runtime and one provider set across the shell and every plugin |
| `voice` | `lib/voice.ts` | Active TTS/dictation sessions, playback context, and stop/resume handles: audio state and cancellation must not diverge across bundles |
| `panel-maximize` | `lib/panel-maximize.ts` | Maximized flag, subscribers, and animation registry: the host and every plugin observe one panel-maximize state |
| `suggestions` | `lib/suggestions.ts` | Suggestion contributors, storage, and subscriptions: user-curated suggestions stay the same across the host and plugins |
| `scrollbar-skins` | `plugins/ui-theme/skins.ts` | Contributed/imported/built-in skin catalog: the `ui-theme` settings card writes it and a compiled `app.overlay` rail reads the same list |
| `client-core` | `@musepi/client-core` (bare) | The whole client-core namespace: its React contexts and module-level state |
| `i18n` | `@musepi/client-core/src/i18n` (bare) | Locale registry behind `t` / `setLocale` |

A copied `monaco-runtime` assigns its own `MonacoEnvironment` and worker factory, so editors from different bundles load separate Monaco instances. A copied `monaco-lsp` keeps its own document map, provider registrations, and peek models, so diagnostics, navigation, and peek windows target different document state. Both must resolve through the table for a plugin editor to share the host's runtime.

### Identity versus helpers

`client-core` and `i18n` are bare-specifier entries, not paths. Module identity — React context, module-level state, and the `client-core` namespace itself — is shared through `MusePiHostModules`; translations ride the host's locale service because `@musepi/client-core/src/i18n` and `@musepi/client-core` resolve to the same module instance, so a plugin's `setLocale("zh-CN")` changes what the host's `t` returns.

Do not add entries for deep helpers: a subpath such as `@musepi/client-core/src/lib/<helper>` carries no identity and stays bundled. Bare matching is exact, so import the specifier exactly as listed — `@musepi/client-core/src/i18n/index.js` is a different request, matches nothing, and bundles a second locale registry.

Relative references to i18n from inside the client-core package (`../i18n/index.js` and the like) also resolve to the same host `i18n` service, because identity there is decided by the importer's location; a `../i18n` import from any non-client-core importer is unaffected and keeps its own copy.

### Adding a shared module

Add an entry only when **identity must be shared**. A helper without cross-module state stays bundled.

1. Add `{ key, path }` or `{ key, specifier }` to `EXTENSION_HOST_MODULES`.
2. Import the module in `packages/desktop-app/src/lib/host-modules.ts` and map it under the same key; the `satisfies` constraint fails until both sides agree.
3. Extend the compiler test to prove the import resolves to `window.MusePiHostModules[key]` and the bundled marker is absent, and the runtime test to prove the key is published with a bound instance.
4. Update this document and the changelog.

Every entry is host ABI: removing or renaming a key breaks already-compiled bundles, which throw at import rather than falling back to a copy.

`packages/desktop-app/test/host-module-state-guard.test.ts` enforces completeness: every `src/lib` module with a `createContext(...)` call must have a contract path, and each known state-bearing module must have a path and a published instance. A new React context module fails the suite until it is registered.

**Anchors**: `packages/collab-proto/test/extension-host-modules.test.ts`, `packages/coding-agent/src/daemon/extension-artifact-compiler.test.ts`, `packages/desktop-app/test/host-modules.test.ts`, `packages/desktop-app/test/host-module-state-guard.test.ts`.

## 20. Prompt sections: registry, composer, source lifecycle (2026-11-03)

`PromptComposer` now delegates to a named registry. Existing callers keep using `add`, `removeBySource`, `clear`, `size`, and `compose`; new code can use the registry directly:

```ts
import { PromptComposer, PROMPT_ORDERS } from "@musepi/pi-coding-agent/prompts/composer";
import { PromptRegistry, PromptRegistryError } from "@musepi/pi-coding-agent/prompts/registry";
import { resolvePromptOrder } from "@musepi/pi-coding-agent/prompts/orders";
```

Extensions keep using `pi.registerPrompt({ name, order, text })`. The composer assigns each contribution a source: `ext:<extension id>` for `registerPrompt`, `mode:<mode id>` for a preset's `prompt`, `user` for settings `prompt.sections`, and the host-owned `design-system`, `asset-policy`, and `ext:inventory` for sections the session resolves on every rebuild.

### Function text

`text` accepts `string | ((context) => string | null | undefined)` in both `registry.registerSection` and the compatibility entries `composer.add` / `pi.registerPrompt`. A function runs at assembly time, not when it is registered, so every rebuild sees current closure state. Returning `null` or `undefined` omits the section for that build; an empty string is still emitted as a real section. The function receives the assembly context plus `variable(name)`. The session currently calls `compose(base)` and `composeComplete()` without extra keys, so extension function text should read closure state or registered variables rather than assume host fields.

### Strict variables are opt-in

Register a variable with `registry.registerVariable(name, resolver)`, then reference it as `{{name}}`. Names match `[A-Za-z0-9_.-]`; each variable resolves at most once per assembly and its value is stringified. A later registration shadows an earlier resolver, and the earlier one returns when the later registration is disposed. On an interpolating section, an unknown placeholder or a resolver returning `null`/`undefined` throws `PromptRegistryError` (`unknown prompt variable` / `unresolved prompt variable`); it never renders as empty text. Section text can call `context.variable(name)` for the same strict lookup. Assembly context keys are not implicit variables: `{{settingsKey}}` is unknown unless something registered that name. Variables are not source-scoped — `removeBySource` only removes sections; use the variable's disposer or `clear()`.

### Legacy string sections

Existing string sections are not Handlebars templates and are not rendered against session context; they remain literal prose. Legacy entries (`composer.add` and `pi.registerPrompt`) never interpolate: `{{name}}` stays byte-for-byte literal even when a registry variable has that name. Strict `{{name}}` interpolation applies only to sections registered explicitly through `registry.registerSection` or used from registry function text; there, prose containing `{{...}}` must register the name or assembly throws. `composer.add` returns no disposer and follows the old Map semantics: a same-name later `add` replaces the earlier layer outright, so removing the replacement's source never restores the old section. New code that needs stacking, shadow restoration, or explicit disposal should call `registry.registerSection`.

### Order, shadowing, and complete

The central anchors are `core: 0`, `injection: 25`, `safety: 100`, `project: 200`, `repoContext: 300`; numeric orders remain valid, and `resolvePromptOrder` rejects unknown names and non-finite numbers. Sections sort by resolved order, then name. Registering an existing name through the registry shadows the earlier registration; disposing the later registration restores the earlier one. At most one visible section may set `complete: true`; it replaces the whole prompt (`compose` and `composeComplete` return only it). A second visible complete section is rejected at registration. A conflict introduced later, for example by disposing a shadow, is rejected atomically: the disposer or `removeBySource` call throws, leaves every layer unchanged, and does not bump `revision`. The rejected disposer stays unspent and can be retried after the conflicting section is removed.

### Source unload and lifecycle

`registerSection` and `registerVariable` return idempotent disposers. `removeBySource(source)` drops every section layer whose source matches and increments `revision` only when it removed something; layers from other sources stay in place. `clear()` drops all sections and variables. `revision` is a monotonic count of structural mutations and never changes during `assemble`, so a caller can compare it before and after an explicit refresh. `size` counts section names, not shadow layers. An empty registry assembles `{ revision: 0, sections: [], complete: null }`, and `compose(base)` returns `base` unchanged — the compatibility anchor.

Extension load and reload re-sync the extension's source: the old generation is removed before the replacement's sections are added, so a prompt never mixes generations. A busy session defers reload to the next idle `agent_end`. Mode switches use the same source-scoped path, and the `design-system` / `asset-policy` sections are re-resolved on every rebuild.

### Prompt-only refresh

Every prompt rebuild re-evaluates function text, re-resolves variables, and re-runs the host-owned section resolvers before `compose(base)` (or `composeComplete` for a `promptComplete` preset). `AgentSession.setDesignSystemId` is the live prompt-only path: it writes the metadata key and calls `refreshBaseSystemPrompt()`, leaving the active tool set unchanged, so the new brief is used on the next model call. Extension load and reload re-sync the composer source and then call `refreshBaseSystemPrompt()` immediately, so a prompt-only extension (no tools) reaches a live session without waiting for another rebuild. A busy session performs the same refresh when its deferred load/reload drains. The composer revision is part of the rebuild signature, so a section-only change is not skipped when the tool set is unchanged. Tool changes from the same load/reload still follow the normal tool-registry path, and neither path requires a session restart.

The composer registry still does not own cache policy or diff-style runtime messages.

### Session prompt host (PromptHost)

Every session — main agent and subagents alike — creates one `PromptHost` (`packages/coding-agent/src/prompts/host.ts`); extension factories reach it through the optional `pi.promptHost` and register four kinds of contributions: `registerSection`, `registerContext`, `registerVariable`, and `registerTool`. Placement has three axes: a `scope` (child scopes inherit every ancestor contribution), a `lane` (source priority inside one scope; the default order is `core` < `extension` < `preset` < `session`, and a later lane shadows an earlier one), and an `owner` (bulk release through `removeByOwner`; preset enable/disable switches, hot reload, and session teardown release or replay per owner). Sections, contexts, and tool sections also declare a `cacheScope` (`prefix` / `snapshot` / `turn` / `request`; sections and tool sections default to `prefix`, contexts to `turn`) that says how long their rendered text may be reused. Variables have no cache scope. An empty host keeps the prompt byte-identical.

`interpolate: false` on a section only skips the final `{{name}}` replacement after the text renders — function text still runs, and sections without the flag keep the strict default under which an unknown or unresolved variable throws. Sections that carry discovered or user/server-controlled text (project context, runtime appendices) register with `interpolate: false`, so a `{{...}}` sequence inside that data passes through literally instead of failing strict resolution.

`registerContext` is wired into per-turn delivery. Each turn the SDK calls `promptHost.collectContext` with the same active tool set and assembly context it passed to `assemble`, and `AgentSession` converts every delivered context into a hidden `role: "custom"` message typed `prompt-context:<name>` with `display: false`. The message rides the normal provider and persistence pipeline: model-visible, persisted with the session, never shown in the transcript. A `required: true` context is delivered every turn; any other context is skipped when the latest delivered copy of the same custom type in history already carries identical content, and that history is the live, resumed, or branched one — so resumed and branched sessions dedupe against their own latest copy instead of stacking repeats. Contexts accept `interpolate: false` like sections; the `xd://` device-catalog section uses it to keep braces inside mounted device text literal. Session collection does not advance the host's separate delivery ledger: live history is the sole dedupe authority, so compaction or an aborted prompt assembly cannot suppress a later delivery when its earlier copy is no longer in history. Plan, goal, and vibe runtime context do not ride this channel — they keep their own pre-existing custom types (see below).

Six readonly first-party core prompt packages — `delegation`, `file-tools`, `browser`, `computer`, `lsp`, and `host-integrations` — mount in every session load path: preloaded sessions remount them onto the session host, subagent and tool-restricted sessions load them even when discovery is off, and full discovery merges them ahead of caller-provided paths. Their entries only set a label and register prompt-host contributions (their tools ship as separately mounted component entries), mounting is per session and never global, and paths are deduped by resolved path so a core package mounts exactly once.

The session's volatile context is split by owner. AGENTS context files and the workspace tree render as the `project:context` snapshot section and the nested active repo as `project:active-repo`, both owned by `session:project-context` and refreshed by function text on every rebuild; the custom-prompt layout keeps rendering context files in its own template, so that layout also has a single owner per piece. Memory instructions, auto-learn guidance, mounted MCP route guidance, MCP server instructions, and the default user append render solely through the host-integrations plugin's `host:runtime-context` section at order 250, between the project sections (200) and the repo context (300); the host sorts MCP server instructions by name and applies the 4000-character truncation before the section renders, and with a custom system prompt the append renders inside that template while the host omits its copy.

Plan, goal, and vibe runtime context deliberately stay host-owned custom messages: `AgentSession` persists them as `role: "custom"` entries because streaming-steer delivery, mode-exit markers, and resume/branch dedup depend on that message transport. They are not system sections; the unchanged-content dedup — a latest delivered copy is not re-sent, so a streaming mode-entry steer does not produce a second copy — lives in that path.

Date, cwd, skills/rules, the tool inventory, and persona/preset data remain in `buildSystemPrompt`; do not describe the prompt surface as fully pluginized.

**Anchors**: `packages/coding-agent/test/prompts-registry.test.ts`, `packages/coding-agent/test/prompts-composer.test.ts`, `packages/coding-agent/test/prompts-host.test.ts`, `packages/coding-agent/test/prompt-host-session.test.ts`, `packages/coding-agent/test/prompt-project-context.test.ts`, `packages/coding-agent/src/prompts/{orders,registry,composer,host,store,types,project-context}.ts`, `packages/coding-agent/src/bundled-plugins/loader.ts`.
