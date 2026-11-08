---
layout: default
title: 扩展开发契约
status: living
summary: OMP 与 MusePi 插件边界、开发流程、生命周期和产品级验收标准。
scope:
  - packages/coding-agent/src
  - packages/client-core/src
  - docs/capability-seams.md
lang: zh-CN
---

# MusePi 扩展开发规范（Agent 版）

[English](extensions-dev.md) | 中文

> 给 LLM agent（以及人类开发者）的 musepi-omp 扩展开发指南。本文件回答三个问题：
> 1. OMP Plugin 与 MusePi Plugin 的划分与兼容边界；
> 2. 一个扩展从零到落地要走哪些步骤、遵循什么结构；
> 3. 验收标准（怎么做才算“产品级扩展”）。

## 1. OMP Plugin vs MusePi Plugin

musepi-omp 是 oh-my-pi 的 fork，扩展运行时同源，但 musepi 在**加载、管理、GUI 集成**三层做了增强。写扩展前先分清你落在哪一侧：

| 维度 | OMP Plugin（上游兼容） | MusePi Plugin（musepi 增强） |
|---|---|---|
| **运行时 API** | `@musepi/pi-coding-agent` 的 `ExtensionAPI`（与上游 `pi` 同名，`pi.on/registerTool/registerCommand/...`） | 同左，`ExtensionAPI` 完全兼容 —— OMP 扩展无需改动即可在 musepi 运行 |
| **入口形态** | 一个 TS/JS 模块，默认导出 factory `(pi: ExtensionAPI) => void` | 同左；可选携带 `package.json`（名称/描述/触发词）供 GUI 展示 |
| **加载路径** | `src/extensibility/extensions/loader.ts`（Bun import） | 同左；另加 `discoverAndLoadExtensions` 合并 discovery provider 结果（native 优先） |
| 发现/安装 | 无插件管理器（手动放 node_modules） | `musepi plugin install|link|uninstall|list|enable|disable`（`PluginManager` + `MarketplaceManager`），`musepi-plugins.lock.json` 记录 |
| **GUI 集成** | 无 | 设置「扩展」tab + 侧栏入口（`ExtensionsCenter.tsx`），daemon `extensions.list` RPC，TTL 10s 缓存。Cordis 包启停写 `settings.disabledExtensions` 的裸包名，组件状态写 `disabledExtensionComponents` 的 `<package>/<component>`；其他发现项保留自身 ID，`mcp:` 前缀走 mcp.json |
| **运行时管理** | 无 | daemon 统一扫描（`extensions.list` → 树：provider → kind → item）、`extensions.setEnabled` |

**结论**：能力上 **OMP Plugin ⊂ MusePi Plugin**。新扩展一律按 MusePi Plugin 写（免费获得 GUI 管理）；只在纯 OMP 环境跑才按上游最小形态写。

普通插件包由 `package.json` 的 `musepi` 块声明入口、配置与资源（见 §13），启停归 runtime lock。应用 profile 通过 `musepi.profile.bundles` 选择 bundle，行级覆盖写入该 profile 的 `cordis.patch.yml`；仅支持 `musepi.profile.bundles`，DSH profile 字段直接忽略。Agent preset 也作为插件行声明在同一组合中，按文件 > profile > 扩展的顺序解析。新会话默认值保存在 profile 的 `agent-preset-registry.config.selectedDefault`；会话开始首轮后 preset 锁定，已有会话保留原组合。组件开关与父插件开关相互独立：父插件停用时保留组件选择，但只有父插件与组件两道门都允许时组件才实际生效。

「插件」视图按同一种卡片管理普通包与 profile bundle。普通包开关写 runtime lock，bundle 开关写 `musepi.profile.bundles`；已选但无法读取的 bundle 仍保留显示。层与行的详细组合继续通过 `bundles.composition` 提供，不再设置独立「组合」页。preset 行在每个会话中挂载为真实 Cordis fiber：`isolate` 创建按服务隔离的子 realm，切换模式先销毁旧 preset fiber，再挂载新组合。插件自有 skill 与其他资源一起通过 `registerSkill` 声明，并随插件启停；Android 模拟器即采用这一生命周期。

Creator 快捷创建只发送用户的自然语言需求。预设 prompt 持有操作流程：用 `modes.save` 提交完整的新定义，再按已落盘 id 调用 `modes.validate`。`modes.save` 在写盘前检查结构、继承和扩展存在性，`modes.validate` 执行挂载自检。任何检查失败都必须修正并重试，不能提前报告完成。宿主界面操作说明不得拼到用户消息后。

桌面发布包必须随 daemon 一起暂存可独立加载的第一方插件产物。编译 daemon 后运行 `bun packages/coding-agent/scripts/stage-desktop-daemon.ts --binary <daemon-binary>`。脚本将 `bundled-plugins` 与 `desktop-plugins` 编译到 `packages/desktop-app/vendor/daemon`，校验每个 `musepi.extensions` 与 `musepi.components` 声明的入口，并将组件样式保留在编译产物旁。普通及传递 JavaScript 依赖会打入组件产物，终端 PTY 桥接文件与原生运行时包则复制到暂存目录。Electron 解包该目录，再通过按平台分隔的 `MUSEPI_BUNDLED_PLUGIN_ROOTS` 变量把两个绝对根目录传给 daemon。开发环境仍保留源码树回退；发布包不得依赖源码树或开发依赖。

发现的 JavaScript／TypeScript hooks 使用生产扩展链：`discoverExtensionPaths()` → `hookCapability` → `loadExtensions()` → `ExtensionRunner`。旧 `HookRunner` 导出仅为公开 API 兼容及其直接消费者保留，不是第二条生产执行链。TUI 的设置与插件入口读取和桌面客户端相同的 schema、发现结果及 Cordis 启停状态，不引入独立安装器或插件状态存储。

## 2. 扩展能做什么（能力面）

一个扩展模块可以组合：

- 事件处理：`ctx.on("session_start" | "tool_call" | "tool_result" | "message" | ...)`。每个 session-bound agent（主 agent 与每个子 agent）各拿一份独立 runner，`session_start` 携带 `{ agentId, source }`（`source` 为 `main` 或 `subagent`）；生命周期事件 `session_start`、`session_shutdown`、`session_before_*`、`tool_call`、`tool_result`、`context` 与 `input` 已迁到 runtime 的 Cordis 事件上下文：除 shutdown 用 `parallel`（并发、互不阻塞）外，其余都用 `serial`（顺序）。`tool_result` / `context` / `input` 的改写由派发侧累积：监听器只返回自己的 patch，后者能看到前者的修改。流式/通知事件（`message_*`、`tool_execution_*`、`turn_*`）用 `parallel` 并发派发，零监听时直接跳过；其余单次通知（`session_switch/branch/tree`、`agent_start/end`、`auto_compaction_*`、`auto_retry_*`、`todo_reminder` 等）用 `serial` 保持注册顺序。`user_bash` / `user_python`（首个非空结果即中断）与 `resources_discover`（按扩展路径累积）同样走 `serial`；`before_agent_start`（消息 + systemPrompt 累积）、`before_provider_request`（payload 逐次改写）、`after_provider_response`、`cache_warming_decision`（最后一个 action 生效）也已迁移，`credential_disabled` / `mcp_notification` 走单次通知通道。至此所有插件事件都由 Cordis 派发，旧的 `Extension.handlers` 表、`hasHandlers` 的 map 分支和 runner 里的手写兜底循环已删除——事件注册与派发只剩一份实现。`session.compacting` / `session_stop` 也走 `serial`：前者保留最后一个有效结果；后者在“要继续且带上下文”时立即中断并返回该结果，`event.signal` 由执行器合成到 handler 预算里。`ctx.on(event, handler, { prepend })` 对所有事件可用：已迁事件里它是 Cordis 的全局顺序，legacy 事件里它只在同一扩展内提前。`tool_result` 的改写由派发侧累积：监听器只返回自己的 patch，后者看到前者的修改（last-write-wins）。`tool_call` 保持 fail-closed：超时或抛错都返回 `block: true`，首个 block 立即中断；非 block 结果仍按“最后一个有效值”保留。`session_before_*` 保持旧契约——只有 `cancel: true` 中断链，其余结果记为“最后一个有效值”并继续；超时包装在监听器内部，错误仍走 runner 的 error 通道，`handler timed out after Nms` 文本不变。`on()` 返回的 disposer 只注销该监听（Cordis `ctx.on` 语义），插件卸载仍清空它注册的全部监听；`session_shutdown` 与该 runner 的定时器、服务、文件回退一起清理，所以 `apply` 就是该 agent 作用域内的 setup
- LLM 工具：`ctx.tools.register({ name, description, parameters, execute })`（进入工具注册表，权限链照常生效）
- 子智能体：`ctx.subagents.register({ name, description, systemPrompt, external })`；本地 Agent 必须提供非空 `systemPrompt`，外部 Agent 改为提供一次性 `external(context)` 执行器，并复用现有 task 进度、取消、超时、结果卡片和完整 Markdown 产物。子智能体类型本身已是 Cordis 插件能力；本地子智能体的多轮接续属于运行时生命周期（`hub send` / `agents.chat` / 冷恢复），不需要第二个 Agent 定义。共享任务板等团队协作应是独立 Cordis 插件，可参考 DSH 将团队服务、模型工具与 UI 拆包的做法，不要把任务所有权塞进子智能体注册。
- 斜杠命令：`ctx.commands.register(...)`（TUI `/cmd` + GUI 命令面板）
- 快捷键/flags、自定义消息渲染、会话/消息注入（`sendMessage` / `sendUserMessage` / `appendEntry`）
- **工具执行拦截**：每个工具执行都被扩展拦截层包裹（`tool_call` / `tool_result` 事件可介入）

内置命令名（如 `/memory`）默认保留给核心实现：第三方扩展注册同名命令会被跳过并记录冲突告警。随宿主分发的第一方插件（`bundled-plugins/`、`desktop-plugins/`）注册同名命令即接管该名字，内建实现作为插件缺席或编译失败时的回退，命令补全与分发都优先走插件。

## 3. Agent 开发规范（步骤）

### 3.1 结构

```
packages/<your-ext>/
  package.json        # name（必填，kind:name 的 name）、description、触发词
  index.ts            # 默认导出 factory
  src/…               # 实现拆分（可选）
```

**package.json 约定**（供 GUI ExtensionsCenter 展示与启停 id）：

```jsonc
{
  "name": "@musepi/awesome-tool",       // id = `extension:<name>`（与 kind 前缀）
  "description": "一句话描述",
  "main": "index.ts"
}
```

### 3.2 factory 骨架

```ts
import type { ExtensionAPI } from "@musepi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // 注册阶段：只能调注册类方法（on/registerTool/registerCommand）
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

1. **注册与运行时分离**：factory 执行 = 注册阶段，`sendMessage` 等运行时动作要等 `ExtensionRunner.initialize` 后（事件回调里用，不在 factory 顶层用）。
2. **不阻塞加载**：loader 逐模块 import，单个扩展抛错只记 `per-path load errors`，不 abort 整个加载。你的扩展要自行 try/catch 边界。
3. **权限链照常**：registerTool 的工具仍走 permission 链（approval 等），不要绕过。
4. **可发现性**：描述写清触发词/能力，供 TUI/GUI 的扩展列表与 agent 路由。
5. **GUI 启停兼容**：新扩展默认启用；要可关，确保 `disabledExtensions` 里 `extension:<name>` 能完全禁用它（加载层检查该 id）。

### 3.4 验收标准（产品级）

- [ ] `musepi plugin link <path>` 后 `musepi plugin list` 可见，`extensions.list` RPC 返回（provider/kind/描述/状态正确）
- [ ] GUI 设置「扩展」tab 能开关它，开关状态重启后保持（`settings.disabledExtensions` 写入）
- [ ] 工具/命令在 TUI 与 GUI 两条路都可触发（TUI 直接，GUI 经 daemon 会话）
- [ ] 错误路径不炸进程：加载失败/运行时异常有日志且可恢复
- [ ] 文档：`README` 写清安装（link 或 marketplace）、能力、配置

## 4. 内置扩展 vs 第三方

- **native/内置配置**（`discovery/builtin.ts`）：`~/.musepi/agent` 与 `.musepi/` 配置文件扫描项，`extensions.list` 里 provider = native。native provider 自 0.5.0（M2.1）起在 TUI/GUI 的 provider tab 可见（不再 skip-native），无 provider 级开关（daemon 拒绝禁用 native）。
- **第一方 Cordis 包**（`src/bundled-plugins/*/package.json` + `extensibility/extensions-center/builtin-registry.ts`）：语音、终端、浏览器、文件、computer、LSP、桌面壳、任务卡片、主题与工具卡片均由真实插件包发现。第一方包与外部 MusePi 包使用相同身份和生命周期。包名是管理 ID，`disabledExtensions` 中的裸包名是包启停的唯一事实源；`voice:stt` 等 MusePi 早期独立 ID、`settingsMirror` 和旧 deny-list 不再参与解析或兼容读取。
  - `musepi.components[].entry` 定义独立子 fiber。`disabledExtensionComponents` 中的 `<package>/<component>` 是组件启停的唯一事实源；关闭组件只反注册该组件的服务或效果，同包其他 entry 不受影响。`tools.disabled` 只负责独立的工具过滤，不充当组件状态存储。
  - `configStorage: "settings"` 的字段与设置页共用存储。`stt.enabled`、`speech.enabled`、`browser.enabled`、`computer.enabled` 和 `lsp.enabled` 等领域配置继续控制各自功能，但不决定包状态。`terminal`、`browser`、`computer` 等 provider/service 由包或 entry 组件注册，宿主通过服务名消费；卸载 effect 负责反注册。
  - `readonly: true` 的主题和工具卡片是只读集合/组合包。它们没有独立 entry 组件，不宣称包内每个主题或渲染器都能分别启停；daemon 与 UI 都拒绝无效包开关。
  - `desktop-shell` 是宿主组合入口。包开关还维护 `shell.enabled` 与 `web.port` 连接副作用；`task-card-style` 已接入真实会话注册。
  - `annotate: true` 仍只给 bundled skills 的既有扫描行打内置标记，不生成重复条目。内置 hooks 仍全部由文件或插件扫描发现。
  - `musepi-subagent-codex`、`musepi-subagent-claude-code`、`musepi-subagent-kimi-code`、`musepi-subagent-codebuddy` 与 `musepi-subagent-opencode` 是实验性一次性子智能体包。Codex 使用官方 app-server JSON-RPC，其余产品使用各自流式 JSONL CLI；包只持有可执行文件、原生模型、产品权限与环境配置，不在加载时启动进程。外部 Agent 拒绝显式 model/effort override、plan mode、结构化输出 schema 和隔离 worktree；进程终止、输出上限、错误和产物仍由共享 task 执行器处理。
  - 五个包共用 `task/external-executable-probe.ts` 注册 `probeExecutable` RPC。配置页打开、路径失焦或手动重检时按当前工作目录解析 PATH 或显式路径，并以 5 秒超时执行一次 `--version`，显示解析路径和版本；找不到、非零退出与超时均显示失败。检测只证明 CLI 可执行，不验证原生模型、凭据或后续任务可用性。`env` 在失焦时校验 JSON 对象与字符串值，输入修正时清除旧错误。
- **第三方生态发现**：Pi、OMP、Codex 与 Claude 的扩展、技能、Commands 和 MCP 继续由各自独立 provider 适配，不使用 MusePi 已退休的第一方 ID。`kimi-code` provider 读取 `$KIMI_CODE_HOME`（默认 `~/.kimi-code`）与项目 `.kimi-code/`，支持用户和项目 Skills、MCP，以及 `plugins/installed.json` 中启用插件的 Skills、Commands 和 MCP；插件 MCP 使用官方 `plugin-<pluginId>:<serverName>` 命名。当前不接入 Kimi 的 hooks、agents、systemPrompt 或 sessionStart。
- **插件安装**（`~/.musepi/plugins/`）：provider = user，可启停。
- 测试/示例扩展（如 `harmony-leak` 夹具）是测试资产，不算产品扩展。

## 5. 相关文档

- `docs/extensions.md` —— 扩展运行时 API 全量（事件、注册方法、生命周期图）
- `docs/extension-loading.md` —— 发现与加载规则（module 路径、discovery provider）
- `docs/plugin-lifecycle.md` —— Cordis 注册与消费、fiber 状态、依赖、销毁及迁移验收
- `docs/plugin-manager-installer-plumbing.md` —— 插件管理/市场安装管线
- `docs/user-facing-packages.md` —— 用户面包（CLI/特性）
- `docs/gui-implementation.md` §2 —— GUI 扩展控制中心契约（daemon RPC、TTL、启停语义）

## 6. UI 组件贡献（renderer-side slots，2026-08-16）

扩展可以向桌面 GUI 贡献 React 组件——daemon 编译、GUI 动态挂载、HMR 即时生效：

```ts
import type { ExtensionAPI } from "@musepi/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.registerComponent({
		slot: "panel.tab.greeting", // 右面板动态 tab（panel.tab.<任意 id>）
		moduleUrl: "./ui/greeting.tsx", // 扩展目录内相对路径
		label: "Greeting card",
	});
}
```

**组件契约**（编译时强制）：
- 默认导出 React 组件；
- JSX 使用 `window.MusePiReact.createElement`。`react`、`react-dom`、`react-dom/client` 和 `react/jsx-runtime` 的普通或 type-only import 都由 daemon 映射到宿主 React，不会打包第二份 React；不得绕过这条映射，自行打包或从其他地址加载 React；
- **注入 props（全部可选，宿主传哪项哪项有值）**：`{ rpc, sessionId, cwd, slot, extensionId, panelTab, fileWorkspace, page, chatView, panelShell, browser, formatTokens }` —— `rpc` 是 daemon RPC 桥；`sessionId`/`cwd` 标识当前会话；`slot`/`extensionId` 标识贡献身份。`panelTab` 仅 `panel.tab.*` 注入，携带当前实例的 `id/surface/target/label/readOnly/dedupeKey`，分栏时也对应本列。保留的 `panel.tab.files` 挂载还会收到 `fileWorkspace`，即宿主拥有的文件标签、草稿、定位请求和编辑历史契约。single `app.chat` 挂载接收 `chatView`，即宿主拥有的会话、工作区、右栏和终端契约；插件不得复制这些状态。`panel.shell` 通过 `panelShell` 接收完整右栏契约；`panel.tab.browser` 通过 `browser` 接收 `{ open, openRequest, onTakeover }`。整页槽位通过 `page` 注入导航；`app.capability` 具体接收 `page: { tab, onTabChange, onBack }`，不是顶层导航 props。`formatTokens` 让插件读数与宿主 transcript 格式一致。组件不依赖任何一项仍可工作；
- **样式**：组件内 `import "./x.css"` 会被 daemon 提取并在挂载时注入 `<style data-slot-css>`（组件卸载即移除）——不要依赖全局样式文件；
- **失败可见**：编译失败/加载失败在宿主处以红色错误块显示（不再静默消失）；运行时错误有 `gui-slot-error` 样式。

**槽位清单**（daemon `assertKnownComponentSlot` 校验，未知槽名注册会抛错；单一权威见 `packages/collab-proto/src/extension-slots.ts`）：
- `panel.tab.<id>` — 右面板动态 tab。默认提供 rail 启动入口；声明 `availability: "on-demand"` 时不进入 rail、空状态或新建菜单，只由会话内容或工具结果中的 `details.panelTab` 描述符打开。描述符使用 `surface: "ext:panel.tab.<id>"`，可携带 `target`、`dedupeKey` 和 `label`；失败工具结果不会打开标签。`panel.tab.files` 是保留特例：它映射到持久化 surface `files`，不进入通用扩展 launcher，也不接受 `ext:panel.tab.files` 作为第二个 surface。
- `panel.shell` — 完整右栏壳（single）。`panel` 插件拥有标签、分栏和最大化呈现，`app.chat` 不再打包右栏。
- `browser.host` — 常驻受管浏览器 guest 宿主（single），在应用根部挂载，独立于 `panel.tab.browser`。两个产物共享 `window.MusePiManagedBrowserHost`，不分别打包 store。
- `settings.tab.<id>` — 设置页左侧导航项：扩展声明一个设置页即出现在设置导航，内容区挂载组件。
- `sidebar.panel.<destination id>` — 二级左栏面板（2026-11-08）：宿主按 rail 目的地 id 取唯一贡献，挂进 `.gui-side-keeper`，由 `data-panel` 决定显隐；几何读 keeper 上的 `--gui-side-w`，不接宿主专用 props。编译插件通过宿主模块表共享 `lib/scheduled-task-nav`（`task-nav`），否则会拿到另一份快照 store。插件停用或编译失败时宿主回退内置面板，目的地仍可用。
- `rail.<id>` — 右缘图标轨（前缀命名空间；`rail.right` 是保留的精确槽）
- `composer.dock` / `composer.left` / `composer.right` — 输入卡上方行 / 工具栏两端（list 语义，多扩展可同槽）
- `panel.right` / `settings.extensions` — 旧保留槽（仍可用）。**`settings.extensions` 是插件自带设置面板的推荐槽位**（2026-10-10 起由 `ExtensionsCenter` 承载，见下）：注册到该槽的组件与 `settings.item.<extId>` 卡片一并按扩展分组渲染，并注入 `settingsScope` 读写代理。
- `settings.item.<extId>` — 扩展设置卡片（2026-08-17；2026-08-20 起展示于**扩展中心底部**，随插件 inventory）：按扩展 id 派发一张卡片，组件经 `settingsScope` prop 读写设置键（见下）。
- `settings.action.<id>` — 单行偏好槽（2026-08-20）：组件挂到设置页“通用”分区末尾，功能插件贡献单行偏好（语言/外观/Enter 行为），无需整 tab 或整卡。

**设置面板宿主**（2026-10-10）：注册到 `settings.extensions` 的组件由**扩展控制中心**底部
的「扩展设置」分区承载 —— 与 `settings.item.<extId>` 卡片同框，按 `extensionId`（扩展入口路径）
分组，每组一张 `gui-ext-settings-card`。两者挂载时都拿到 `settingsScope`
（`{ get(keys), set(key, value) }`，经 daemon `settings.get`/`settings.set`），组件必须把它当
**可选**处理（只挂在 RPC 桥上的宿主不传）。插件包详情弹层（`PluginPackageDialog`）同样挂载
slot 以 `settings.` 开头且 `extensionId` 位于包目录下的组件 —— 这就是第三方插件（如
musepi-auth-hub）设置界面的落点。

**数据流**：daemon `bun.build` 把模块编译为自包含 ESM（react 绑定宿主实例）→ `extensions.list` 返回 code → GUI `SlotComponentHost` blob：动态 import 挂载。**信任模型**：扩展本就在 daemon 进程执行任意代码，渲染其组件不构成新提权。

**宿主模块**：编译组件通过 `window.MusePiHostModules` 共享承载 React context 或模块级状态的应用模块（`prompt-dialog`、`action-toast`、`floating-menu` 等），不打包第二份副本；契约、当前条目与新增步骤见 §19。

**面板实例示例**：bundled `compaction-summary` Cordis 插件注册 `panel.tab.compaction`，UI 读取 `panelTab.target` 并调用 `session.compaction { sessionId, entryId }`。会话绑定内容必须走这种受校验的 daemon RPC，不能使用不提供会话 actions 的 `registerRpc` 裸 runtime。恢复的标签只保存 entry id；target 改变或组件卸载后，必须丢弃未完成的旧响应。

**文件工作区示例**：内置 `file-workspace` Cordis 插件注册保留的 `panel.tab.files` 槽位。它读取 `panelTab.dedupeKey` 区分树根与文件页，并通过宿主注入的 `fileWorkspace` 契约操作草稿、dirty 状态、定位请求和历史。停用插件会移除文件渲染与启动入口，但标签和草稿所有权不会转移到插件。

**Android 模拟器示例**：内置 `android-emulator` 插件贡献 `panel.tab.android-emulator`、扩展隔离的 RPC 方法和 `android_emulator` Agent 工具。当可执行文件不在 `PATH` 中时，在插件配置里设置 `adbPath` 与 `emulatorPath` 绝对路径。面板可启动 AVD、显示并操作设备、安装当前工作区内的 APK、启动 Activity、查看 UI 树和日志。内置 `android-emulator` skill 定义 build → install → launch → wait → screenshot/UI-tree/logcat 验证流程。PNG 轮询不是视频流，文本注入只支持单行可打印 ASCII。禁用插件会移除注册并销毁共享服务，但不会终止已有设备。

**设置卡片（settings.item + settingsScope）**：注册 `slot: "settings.item.<extId>"`（extId = 扩展目录名）的组件，会在**扩展中心**（设置 → 扩展）底部按扩展获得一张卡片（扩展未启用则不显示）。组件收到额外 prop `settingsScope = { get(keys: string[]): Promise<Record<string, unknown>>, set(key: string, value: unknown): Promise<void> }` —— 经 daemon `settings.get`/`settings.set` RPC 读写设置。**键名自由命名，建议用 `扩展名.xxx` 前缀**（与 registerSetting 的 `display.taskCardStyle` 同约定）避免与其他扩展冲突；写入只放行 registerSetting 注册过的键，未注册键写会抛 read-only。**写时校验（registerSetting 的 `validate` 字段）**：扩展可为注册的设置键提供 `validate(value)` 回调——返回错误字符串即拒写（daemon `settings.set` RPC 抛错，GUI 显示原因），返回 `void` 放行。schema 无法表达的约束（端点可达性、跨键一致性、枚举外值）由此在**写入时**拒绝，而非用到时才炸。无任何扩展注册该槽位时分区显示空态文案。

**热插拔（v2，HMR 全量）**：扩展源码/配置变更 → daemon watcher（500ms debounce）① 清缓存并广播 `extensions.changed`（需先 `events.subscribe`）→ GUI 插槽即时重载（~1s），`ExtensionsCenter`/`PluginsSection` 监听同事件即时刷新；② 对每个活跃会话比对**运行时源码图的 mtime 快照**后执行 `reloadExtension`（不依赖 fs.watch 的 filename —— Windows 递归 watch 的 filename 不可靠），完成后发会话内事件 `extensions.reloaded`。会话内工具/命令/handlers 下次调用生效。

**Cordis 宿主级组合 HMR**：`ProfileModuleGraph` 合并所有在役组合行的源码图，accepted 变更沿 importer 反向传播，未接受模块记为 declined。生产装载链保留每行的 `rowId`、`config` 和附加 `inject`，同一 entry 的多行独立重载。受影响行作为一个事务先预导入全部替代模块，再逆序销毁旧 fiber 并逐行 apply；导入或 apply 失败会恢复旧实例，成功后才刷新图快照。externals 只记录 pending 并要求重启宿主。Track B 的会话级重载继续使用下述语义，不把 Cordis 的组合事务误套到 legacy runner。

**v2 契约（子模块边界、忙门控、MCP）**：
- **子模块改动同样热生效，无需 touch 入口**：装载时对入口的**运行时源码图**做一次走查（`collectExtensionModules`，含静态 `import`、CJS `require` 与动态 `import()`；type-only import/export 被编译擦除，不进入该图），快照逐文件 mtime；daemon 的变更判定按这个快照逐文件比对（`extensionEntriesNeedingReload`），任一图内文件变了就重载它的入口。重载本身一直是好的 —— cache-bust tag 单调递增（`nextLegacyPiLoadTag`），`onLoad` 钩子把它盖到每个相对 import 上，整图重新读盘 —— 坏的是**没人通知有东西该重载**。
  图内 specifier 一律发**裸路径 + `?mtime=`**，不是 `file://`：Bun 对 `file://` 忽略 query（会命中缓存），对裸路径才按键。这条原先只在 POSIX 生效，Windows 上整图退回 `file://` 而静默不刷新 —— 入口能重载、它的子模块不能，正是这个不对称。
extLegacyPiLoadTag），onLoad 钩子把它盖到每个相对 import 上，整图重新读盘 —— 坏的是**没人通知有东西该重载**。
  图内 specifier 一律发**裸路径 + ?mtime=**，不是 ile://：Bun 对 ile:// 忽略 query（会命中缓存），对裸路径才按键。这条原先只在 POSIX 生效，Windows 上整图退回 ile:// 而静默不刷新 —— 入口能重载、它的子模块不能，正是这个不对称。
- **重载语义（无事务）**：失败的重载（语法错误等）保留旧实例并上报错误，不破坏现状；成功的重载 = 旧实例 handlers 先清空、新模块工厂运行（重注册的 handler 无双跑）、`toolRegistrationListeners` 带到新实例（新工具按名覆盖推入会话注册表）、`extensions[]` 原地替换。返回 `removedTools` = 旧工具名，会话侧删除**未被新模块重注册**的旧名。
- **内存态不迁移**：重载重建模块实例，扩展自行持久化状态（settings/磁盘）；在途异步副作用（已发出的 fetch/定时器）不回收，尽力而为。
- **忙会话门控**：会话 streaming（`isStreaming`）时重载挂起到单槽 pending，`agent_end`（含延迟 agent_end flush）空闲时补做；不引入队列/锁。
- **MCP 不随扩展关闭**：MCP 连接由配置层启动、`MCPManager` 按 cwd 多会话共享，`SourceMeta` 是配置来源非扩展来源 —— 扩展重载不触碰 MCP server 生命周期；扩展自行管理自有连接。

**参考实现**：`examples/extension-component/`（示例）、`packages/coding-agent/src/daemon/extension-components.ts`（编译/聚合）、`packages/desktop-app/src/lib/slot-components.tsx`（渲染）、`ExtensionRunner.reloadExtension` + `AgentSession.reloadExtension`（v2 会话级重载）。

## 7. 扩展 daemon RPC（registerRpc，2026-08-20）

扩展向 daemon 注册 JSON-RPC 方法，GUI 槽位组件经 `extensionCall` prop 回调自己的 daemon 侧逻辑 —— 组件从“展示”变成“可交互”：

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

**调用链**：组件 prop `extensionCall(method, params)` → daemon RPC `ext.call { extensionId, method, params, sessionId }` → daemon 校验扩展为 active extension-module → 调 handler。`extensionCall` 自动绑定当前组件的 `extensionId`，组件无需知道自己是谁：

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

**约束（裸 runtime）**：handler 在 daemon 的扩展加载上下文运行（与槽位组件编译同一次 factory 调用）——`pi.exec`/`pi.logger`/纯计算可用；**会话绑定 actions（sendMessage/setModel/…）不可用**（抛 stub 错误）。需要会话能力时在 handler 里只做计算/IO，把结果返回给组件。

**错误面**：未知扩展（非 active / 不存在）/ 未知方法 / handler 抛错 → JSON-RPC 错误，组件 `extensionCall` promise reject；方法名按扩展隔离，不同扩展可注册同名方法。

## 8. 扩展注册技能（registerSkill，2026-08-20）

扩展声明**虚拟技能**（无 backing SKILL.md 文件），与文件扫描技能同框展示：

```ts
pi.registerSkill({
	name: "my-skill",
	description: "技能说明",
	content: "# My Skill\n\n正文（SKILL.md 风格 markdown）",
	hide: false,
});
```

**展示面**：
- daemon `skills.list` 合并返回（`_source.provider === "extension"`，`filePath: ""`，content 随行）；
- `skills.read` 直接返回 `content`（无文件读）；
- `skills.delete` 拒绝（仅 user 级文件技能可删）；
- GUI 扩展中心 / TUI /extensions 技能类目下出现，归入“扩展声明” provider 节点；
- 扩展禁用/卸载 → 技能自动消失（HMR watcher 同时失效 skills 缓存）。

**边界**：虚拟技能**不进 agent 的 loadSkills 自动装载**（那是文件扫描路径）——技能中心可见 + 可读，但不会作为上下文注入 agent；需要注入的扩展请写真实 SKILL.md 文件。

## 9. 扩展注册魔术关键词（registerMagicKeyword，2026-10-11）

扩展贡献一个**魔术关键词**：输入框里单独出现的词，提交时向模型追加一条隐藏提示。

```ts
import deepdiveNotice from "./prompts/deepdive-notice.md" with { type: "text" };

pi.registerMagicKeyword({
	name: "deepdive",
	description: "在输入框里单独输入 deepdive，即请求一次带证据链的深度分析",
	notice: deepdiveNotice.trim(),
	noticeType: "deepdive-notice", // 可选，默认 `<name>-notice`
});
```

**契约**：
- 匹配与内置关键词同规则：小写、散文边界（`keywordInProse`），因此 `deepdiving` / `Deepdive` / `deepdive.ts` / 行内代码里的 `deepdive` 都不触发；
- 提示以 `role: "custom"`、`display: false`、`attribution: "user"` 追加 —— 模型可见，transcript 不显示；
- 开关走 `magicKeywords.<name>` 设置键，并受总开关 `magicKeywords.enabled` 门控；**该键从未写入时按停用处理**（扩展不能因为没人配置就开始改模型行为）；
- 提示词正文放在 `.md` 文件里用 `with { type: "text" }` 导入（不内联拼字符串）。

**生命周期**：注册进 loader 的 pending 队列，会话初始化时 replay 进 `modes/magic-keyword-registry`；扩展卸载/禁用时按 sourceId 移除 —— 关键词不会活过声明它的扩展。

**可运行样板**：`examples/plugin-magic-keyword`（关键词 + 自带设置面板 + RPC 完整一套）。

## 10. 扩展 per-tool 渲染器（registerToolView，2026-08-20）

扩展为**指定工具名**贡献 transcript 渲染器，替换内置渲染器：

```ts
pi.registerToolView("my_tool", { moduleUrl: "./views/my-tool.tsx", label: "My Tool View" });
```

**模块契约**（与 registerComponent 同编译管线，blob import + `window.MusePiReact`）：
- 默认导出两种合法形状之一：
  - **React 组件**：作为全卡 Card 渲染，收到 `ToolRenderProps` `{ name, args, result, running, host, kind, intent }`；
  - **ToolRenderer 对象** `{ Summary, Body?, Card? }`（guest-client 内置注册表同构）。
- 工具名 = wire 工具名（扩展自己 registerTool 的工具名，或覆盖内置如 `bash`）；扩展渲染器**优先于内置**（`resolveToolRenderer` 先查外部表）。

**分派**：daemon 编译 → `extensions.list.toolViews` → GUI `useExtensionToolViews`（ChatView 挂载）blob-import 并注册进 guest-client tool-render 外部表 → `ToolView` 按名分派。编译失败的 view 携带 `error`，回退内置/generic 渲染器，不破坏 transcript。

**参考实现**：`packages/client-core/src/tool-render/registry.ts`（`registerExternalToolRenderers`）、`packages/desktop-app/src/lib/slot-host.tsx`（`useExtensionToolViews`）、`packages/coding-agent/src/daemon/extension-artifact-compiler.ts`（`collectToolViews`）。

## 10.1 扩展 widget 类型（registerWidget）

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

## 11. 扩展 transcript 节点渲染（transcript.node seat，DSH 粒度，2026-08-27）

扩展为**指定节点 kind** 贡献 transcript 渲染器。对应 DSH `conversation.chat.node` 的单一“聊天节点 seat”槽：按节点 kind（entryKey）分发，命中即“拥有”该条目的渲染，未命中回退到内建渲染（fallback）。

**注册**：

```ts
pi.registerComponent({
	slot: "transcript.node",
	moduleUrl: "./ui/my-node.tsx",
	label: "My Chat Node",
	entryKinds: ["message:user"], // 派发键（transcriptNodeKind）
});
```

**模块契约**（与 registerComponent 同编译管线，blob import + `window.MusePiReact`）：
- default export React component，收到 `SlotComponentProps.node`：`{ entry, kind, turnIndex?, children? }`。
  - `entry` = 原始 `SessionEntry` wire 值；`kind` = `transcriptNodeKind(entry)` 派发键；
  - `children` = 内建 MusePi 对该条目的渲染——组件可包含它做“增强”（保留官方骨架），或完全自绘（**拥有**该 kind）。
- 未命中的 kind → 内建渲染（children 直接返回），等价 DSH fallback。

**分派**：daemon 编译（透传 `entryKinds`）→ `extensions.list.components` → GUI `useSlotComponents(rpc, "transcript.node")` → `renderTranscriptNode`（ChatView）按 kind 过滤（`selectTranscriptNodeComponents`）→ 命中组件收到 `node` 上下文拥有渲染，未命中回退内建。组件集只在 `extensions.changed` 变化，不随 stream 帧变（memo 安全）。

**防置换**：扩展声明的 kind 只影响该 kind 条目的渲染；内建类型（message/compaction/branch_summary/model_change 等）仍由宿主持有，扩展只能经 `children` 基座增强声明的 kind。与 DSH 一致——官方 sidebar/conversation 的 owner 始终是宿主，插件贡献到 seat，不覆写核心。

**参考实现**：`packages/client-core/src/components/transcript/Transcript.tsx`（`transcriptNodeKind`/`renderTranscriptNode`）、`packages/desktop-app/src/lib/slot-host.tsx`（`selectTranscriptNodeComponents`/`SlotComponentMount`）、`packages/coding-agent/src/daemon/extension-artifact-compiler.ts`（`collectSlotComponents` 透传 `entryKinds`）。

## 12. 桌面壳与 Shell 模式（desktop-shell, dsh-desktop parity, 2026-08-28）

Electron 壳由第一方 Cordis 包 `desktop-shell` 提供，与其他 MusePi 包使用同一生命周期：
- `extensions.list` 顶层返回 `shell: { enabled, mode, webUrl }` —— 壳连接状态（`shell.enabled` 设置键）、DSH 三模式、daemon serve 的渲染器 origin。
- `extensions.setEnabled("desktop-shell", { enabled, mode? })` 切换包状态与模式（写包名到 `disabledExtensions`，并维护 `shell.enabled`/`shell.mode` 与 `web.port` 发现文件 —— 壳进程据此决定 loadURL 运行时渲染器 or 本地 bundle）。
- daemon `--web-port` serve 渲染器（`guest-client/dist`）+ `/__daemon.json`（wsUrl/token）；壳 `probeWeb()` 读 `web.port` 自动发现。

**Shell 三模式**（DSH compatibility/extended/enhanced）：
- `compatibility`（默认）：注入脚本只注册 `transcript.node` —— 扩展贡献聊天节点。
- `extended`：注入脚本额外注册 `composer.dock` / `panel.tab.workbench` / `statusbar`；guest-client 的 `CompatSlotHost` 按 slot 渲染注册组件（composer 上方 dock、底部状态条、workbench 面板）。
- `enhanced`：渲染器侧同 extended，壳保留原生 titlebar（原生 UI 面板预留）。

**注册表契约**：daemon 注入脚本（`static-web.ts` `compatSlotHostScript`, 仅 `?shell=1`）blob-import 已编译组件 → `window.MusePiCompatHost.register(slot, entryKinds, Component, extensionId)`；guest-client 初始化注册表（`main.tsx`），`Transcript`/`CompatSlotHost` 只读消费。纯浏览器 guest 无注入脚本 → 注册表为空 → 内建渲染。

## 13. 设计体系贡献（registerDesignSystem，M3 §3，2026-09-27）

扩展可注册命名设计体系（风格资产包），供 design 模式页的预览 rail 选择与引用：

```ts
pi.registerDesignSystem({
  id: "my-brand",                  // kebab-case；撞内置/撞已注册即抛
  label: "My Brand",
  description: "一句话描述（hover 浮卡）",
  swatches: ["#0f172a", "#e2e8f0"], // 色卡，≤6 色
  tokens: { "--accent": "#38bdf8" }, // gui token 覆盖片段，只允许既有阶梯键，禁止新造 token
  promptSection: {
    name: "design-system",
    order: 40,                     // 固定 40：位于 mode 预设区块之后
    text: "给 agent 的设计简报（色彩/材质/排版基调）",
  },
});
pi.unregisterDesignSystem("my-brand");
```

- 消费面：daemon `design.systems.list` RPC 合并返回内置五套（`minimal`/`glass`/`editorial`/`neubrutalism`/`darkneon`，id 稳定保留）与扩展注册项（带 `source: "builtin" | "extension"` 徽章）；GUI 选中后把 id 写入 `projectMetadata.designSystemId` 建会话，会话引导时 `promptSection.text` 经 PromptComposer 注入 system prompt（source `design-system`）。
- 防撞契约：扩展 id 撞内置抛 `registerDesignSystem: id "x" collides with a built-in design system`，重复注册抛 `... is already registered`（与 registerMediaProvider 同形态）。
- 生命周期：随扩展加载注册、reload/unload 按来源整源清除，下一次 prompt 重建即生效。
- 类型：`DesignSystemConfig` 见 `packages/coding-agent/src/extensibility/extensions/types.ts`。

## 14. 插件清单配置（manifest config/resources + pi.config，dsh 插件管理页 parity，2026-09-30）

扩展的 package.json 可在 `musepi` 块下声明**配置字段表**与**资源占用卡**（`musepi` 为权威清单字段；旧上游的 `omp`/`pi` 块继续可读，新扩展一律写 `musepi`）：扩展中心详情页据此渲染 dsh 式管理视图（配置表单 + 资源卡），扩展运行时经 `pi.config` 读取同一份值。

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
- `icon` 是插件自己的标记：emoji、文字字形或 `http(s)://`/`file://` URI。插件列表与详情优先使用它，图片按 `contain` 缩放，解码失败回退名字字形。
- `presetOnly` 只接受字面值 `true`：`true` 的 persona 包只在 Agent 预设里按会话提供，不出现于能力中心的插件列表；完整库存仍在 设置 → 扩展与插件。
- 字段类型：`boolean | number | string | select | path`；number 可带 `min/max/step`，select 必须给 `options`。
- `restart` 生效域：`none`（默认，立即） / `session`（新会话） / `daemon`（重启 daemon）。
- fail-soft：manifest 是用户可写 JSON，坏字段逐个被丢弃进结构化 errors（详情页有可见警告），好字段照常生效，绝不拖垮扩展登记。

### 运行时读取

```ts
export default async function (pi: ExtensionAPI) {
  const threshold = await pi.config.get<number>("threshold"); // 钳制后的值，未写过 = 声明默认
  const all = await pi.config.getAll(); // 完整值表（只含声明键）
}
```

- 取值与扩展中心表单、`extensions.setConfig` 写入共用同一条 `coerceConfigValues` 钳制链路（daemon/GUI 单一权威在 `@musepi/pi-wire`）：存储坏值回退声明默认，未声明键 `get` 返回 `undefined`、`getAll` 被过滤。
- 生效语义：`restart: "none"` 字段每次调用现读——GUI 表单改完立即可见；`session` 字段在扩展加载时快照，新会话/重载后生效；`daemon` 字段约定需重启 daemon。
- 存储落点：`<agentDir>/extensions/plugin-config.json`，键空间与 `disabledExtensions` 一致（`extension-module:<name>`）。

契约与类型：`ConfigFieldDesc`/`PluginResources`/`coerceConfigValues` 见 `packages/wire/src/plugin-config.ts`；存储见 `packages/coding-agent/src/extensibility/extensions-center/plugin-config-store.ts`；运行时读取见 `ConcreteExtensionAPI.config`（loader.ts）。

## 15. 插件安装（spec 安装与能力报告，2026-10-06）

市场（`marketplace.*`）只覆盖已收录的包。自己做的、还没发布的插件走本节的 spec 安装面：插件页工具栏「安装插件」直接填包名、git 地址、压缩包或本机绝对路径。

### RPC

| 方法 | 入参 | 出参 |
|---|---|---|
| `plugins.install` | `{ spec, force? }` | `{ installId }`（立即返回，不阻塞到安装结束） |
| `plugins.install.status` | — | `{ installs: PluginInstallView[] }` |
| `plugins.install.cancel` | `{ installId }` | `{ status: "cancelled" \| "not-running" }` |
| `plugins.install.output` | `{ installId }` | `{ lines: PluginInstallOutputLine[] }` |
| `plugins.uninstall` | `{ name }` | `{ name }` |

事件（daemon 广播，渲染端按 `installId` 对账）：
- `plugins.install.state` — 状态迁移，载荷同 `PluginInstallView`；
- `plugins.install.output` — 包管理器输出的每一块，带 `stream`。

### spec 分类

`parseInstallSpec`（单一权威，`extensibility/plugins/spec-classifier.ts`）把 spec 分四类，安装按类走不同分支：

| 类别 | 例子 | 包名来源 |
|---|---|---|
| `registry` | `acme-plugin`、`@scope/plugin@1.2.3` | spec 自身 |
| `git` | `github:owner/repo#v1`、`https://github.com/owner/repo` | 装后 diff `plugins/package.json` |
| `tarball` | `/path/pkg.tgz`、`https://host/pkg-1.0.0.tgz` | 装后 diff |
| `path` | `C:\dir\pkg`、`/home/me/pkg` | 装后 diff |

- 本地路径必须绝对：GUI 输入框没有工作目录可依，相对路径会被解析到插件目录内。
- 三段式 http(s) URL 仅在 host 属已知 forge（github/gitlab/bitbucket/codeberg/sr.ht/gitee/gitcode）时读作仓库；其它 host 需带 `.git` 后缀自证。否则一个网页链接会启动必然失败的克隆。
- 取消与失败是两回事：取消后插件目录已还原、不带失败分类，GUI 文案与动作都不同。

### 入口校验、打包与分享

安装校验使用生产 `mountPlugin` 链解析每个 `extensions` 入口，因此纯 Cordis 的 `name` / `inject` / `Config` / `apply` 与 legacy 默认导出 factory 都按各自真实语义检查。校验在独立 runtime 和 event bus 上执行，成功后立即调用 `disposePluginPrimitives` 释放资源；入口缺失或挂载失败会拒绝安装并触发既有回滚，不会留下半安装状态。

`musepi plugin pack [path] [-o dir] [--json]` 在本地生成可分发的 `.tgz`。它要求包具有 `name`、`version` 和 `musepi` / `omp` / `pi` 清单，检查声明的入口存在后调用 `bun pm pack`，不访问 registry，也不执行 publish。将生成的文件发给接收方后，可在插件页拖入，或执行 `musepi plugin install <tarball 绝对路径>`。绝对 `.tgz` 路径按归档安装，不会误入目录 link 分支。需要公开发布时，仍使用包 registry 的发布流程；`plugin pack` 本身不发布。

### 拖入安装

安装框本身是拖放目标：把 `.tgz` / `.tar.gz` / `.zip` 压缩包或一个插件文件夹拖进去，绝对路径直接落到 spec 字段，随后与手输路径走同一条安装路径。未发布、自建、只在同事机器上存在的插件因此不需要先发布。

取路径走 preload 暴露的 `webUtils.getPathForFile`（`electron/preload.cjs` 的 `getDroppedFilePath`）。Electron 32 起渲染端的 `File.path` 已移除，渲染器没有别的办法知道拖进来的是什么位置；取不到路径时该 API 返回空串，调用方必须区别对待而不是当作路径去装。

拖放只接受 bun 能读的归档或目录。文件夹没有扩展名可判，一律接受；文件按扩展名判 —— 拖进一个 `.docx` 或 `.png` 会在落进输入框之前就拒绝，而不是让包管理器报一个“无法解析的 spec”。

**拖入不会执行被拖包的安装脚本。** `PluginManager.install` 跑 `bun install <spec>`，不传 `--trust`，而 bun 默认不执行依赖的 lifecycle 脚本（除非该包进了项目的 `trustedDependencies`）。因此拖入一个带 `postinstall` 的包，它自己的脚本不会运行。这与技能市场的 `awaiting-approval` 阶段不同 —— 那里拦的是“下载后的文件会被 loader 求值”，插件安装没有这一步可拦；真要加批准闸门，先要决定的是“插件安装允许执行什么”，不是界面怎么摆。

### 能力报告（装上 ≠ 能跑）

`describePluginCapability`（`extensibility/plugins/capability-report.ts`）在安装完成后静态判定该插件能否在本底座加载，三档：

- `runnable` — 声明的依赖都能满足，入口文件都在。
- `partial` — 能加载，但有组件注册的槽位本底座没有挂载点（例如指向 `panel.tab.*` 之外的槽），那部分界面不会出现。
- `incompatible` — 缺少运行包（常见于为其它 harness 构建的插件，其 `peerDependencies` 指向本仓不提供的包），或声明的入口文件不在盘上。缺失项逐个列出。

判定只读插件自己的 `package.json` 依赖与入口源码，**不加载插件代码** —— 「能不能加载」正是要避免先加载再观察的东西。缺失的运行包与缺席的槽位分别影响 `incompatible` 与 `partial`，因为前者加载不了、后者只是那部分不显示。

报告随 `plugins.install.state` 的终态返回，渲染端据此提示，不必等到加载失败才发现装了个跑不起来的插件。

### 安装源与回退链

三个设置键（`pluginRegistryMode` / `pluginRegistryUrl` / `pluginRegistryFallbacks`，均不带点号——点号键会被 Settings 当嵌套路径解析）决定安装问哪个源。默认模式先问官方源，遇到「换源可能有救」的失败再试公开镜像。

换源与否由 `attributeFailure`（`extensibility/plugins/registry-fallback.ts`）判定，而非「失败就重试」：包管理器报的是哪一类失败、该失败是否点名了 spec 自己的主机（host 失败换 registry 无意义）、纯 registry spec 的失败永远可换。链在每次重试前先还原本轮开始时捕获的文件，否则失败尝试留下的半写状态会成为下一次尝试的起点。

**不测延迟、不做粘性回退**，理由与 DSH 的差异见 `docs/handoff-plugin-install.md` §4。

## 16. 用户自定义扩展（现状核实，2026-10-06）

对照 DSH 的用户 patch 层核实过两次（2026-10-06 修正）。**先纠正本文档早前的一处错误记录**：早前称「DSH 可以在 patch 里写 `insert: [{ id, name, config }]` 而不必有包」——**这是错的**。`insert` 的 `name` 必须是一个真实的、已安装的包名，Loader 靠它 import；`insert` 做的是**在 Loader 树里增加一行指向该包**，并可同时携带 `config` 与 `disabled` 条件（`vendor/include/src/index.ts:77-101`、`packages/bundle/web-app/cordis.patch.yml:44-63`）。它不是凭空造插件，配置里永远配着实现。

两侧的真实对照：

| 能力 | DSH | musepi | 依据 |
|---|---|---|---|
| 本地未发布插件 | `plugin add .`，相对路径锚定到调用目录；装完按 manifest 的 `dsh.bundle.patch` 自动 reconcile 进 `profile.bundles` | `PluginManager.link(path)` 建符号链接；`PluginManager.install` 支持 path/tarball 形态 | `deepseek-harness/apps/cli/reference/README.md:81`、`extensibility/plugins/manager.ts:917` |
| 装完即生效 | 否——须进 Loader 树 | 是——`getAllPluginExtensionPaths` 运行时发现 | `extensibility/extensions/loader.ts:1012-1015` |
| 按行开关 | `setPluginEnabled` 写 patch 的 `disabled` 覆写 | `extensions.setComponentEnabled`，粒度 `<plugin>/<component>` | `daemon/services/extension-service.ts:601` |
| 整包启停 | 同上（行级） | `plugins.setEnabled` → `settings.disabledExtensions` | `daemon/server.ts:1928` |
| **关掉整个发现层** | **无此概念** | `disableExtensionDiscovery`，已用于 compress/session、security/coordinator、commit/agentic | `extensibility/extensions/loader.ts:950-955`、`compress/session.ts:61`、`security/coordinator.ts:265` |
| **整包条件启停** | `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"` | **无** | DSH `packages/bundle/web-app/cordis.patch.yml:47` |
| profile 隔离 | `$DSH_HOME/profiles/<name>/`，含完整 Loader 树 | `~/.musepi/profiles/<name>/agent/`，含 sessions/MCP 凭据/兼容性豁免/扩展加载 | `discovery/builtin.ts:72-73`、`mcp/oauth-flow.ts:26-30` |

**粒度上我们不比 DSH 细**：DSH 的「行」不可再分，而 `Extension` 接口为每个注册面各持一个独立通道（`extensibility/extensions/types.ts` 的 `Extension`），每条各自加载与卸载。但我们**多一个控制维度**——`disableExtensionDiscovery` 能整层关闭环境发现，DSH 的 Loader 树没有对应概念。通道数会随注册 API 增加而变，故不复述具体数字，以该接口为准。

### 真实差异只有一处：整包级条件启停

`disabledExtensions` 是静态 id 列表，没有表达式求值。DSH 能在 patch 里写 `disabled: !!js <表达式>`，Loader 在每次挂载决策时针对 loader ctx 求值——所以「这个包只在 desktop profile 下启用」是可表达的。

这条差异**在 DSH 插件兼容层落地时会直接咬人**：bundle 的 `disabled: !!js` 翻译不了。对应的做法是兼容层求值常见形态（比较 profile 名、判断环境变量存在性）并写入 `disabledExtensions`，求值不了的表达式显式报「无法翻译」而非静默忽略——静默忽略会让一个本该禁用的插件被装载。

不必为此把 musepi 改成声明式 Loader 树：那会把「插件是运行时发现的」这个前提改掉，代价大于收益。

## 17. Claude Code 兼容面（现状核实，2026-10-06）

对照 DSH 的 `hooks-claude-code` 核实过一次。DSH 的 Claude Code 兼容**只有一件事**：把 Claude Code `hooks.json` 的 command 型钩子桥到自己的扩展点，认 7 个事件（`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `SubagentStart` / `SubagentStop`），`configPath` 必填、无自动发现，且不读 `.claude-plugin/plugin.json`、marketplace、commands、agents、skills、`.mcp.json`。

musepi 的覆盖面**更广**，不必为了“对齐 DSH”补 P3 —— 补了反而是改窄：

| 兼容面 | 实现 | 依据 |
|---|---|---|
| 插件目录（`~/.claude/plugins`） | `claude-plugins` provider：读 `installed_plugins.json` 清单、认 `.claude-plugin/plugin.json`，含 skills / MCP / commands，带路径逃逸防护 | `discovery/claude-plugins.ts:4-5,75,119,188` |
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

优先级是刻意排的：claude-plugins(70) < claude(80)，所以用户自己在 `.claude/` 里的覆盖优先于 marketplace 装来的插件（`discovery/agent-plugins.ts:39-40`）。

**与 DSH 的实质差异只有钩子的执行模型**：DSH 桥的是 Claude Code 的 shell 命令钩子（带 `hookSpecificOutput.hookEventName` 事件门控、`${CLAUDE_PLUGIN_ROOT}` 替换、exit 2 阻断），而 musepi 的 hooks 是 JS/TS 模块（`HookFactory`），命令钩子另走 `.claude/hooks/{pre,post}/` 的目录约定。若要补 command 型钩子，应作为 hooks 引擎的一种新来源接进现有 `HookEvent` 联合，而不是新建一套与 DSH 对齐的独立桥。

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

实测确认(`?t=1` 与 `?t=2` 是两个不同对象)，也印证了本文件的既有结论：裸
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
| `ctx.effect(cleanup)` | 一条按 Extension 实例记账的清理账本 | 所有已装载插件都有；cordis fiber、bundled 宿主装载器 reset、会话 runner 收尾三条路径都会反向执行 |
| `ctx.state` | 一个随卸载清空的 fiber 作用域存储 | 仍只发给 cordis 插件 |

账本按 `Extension` 实例存放，所以“谁来回收”不再是 cordis 独占的问题：bundled 宿主插件（如 `musepi-hmr` 的 watcher）在宿主装载器 reset 时被回收，会话扩展在 runner 收尾时被回收。`effect` 返回 disposer，可单独撤销一条登记而不卸载整个插件。

插件卸载只走一个入口：effects、事件监听 disposer 与 state 一起清空，任何一条卸载路径都不会漏掉监听；会话停止只执行 effects，因为 runner 可能复用，监听要留到真正卸载。

`state` 没有同步放宽：它要求一个卸载即清空的作用域，而 legacy 扩展按模块级变量写，拿到一个“看起来能用”的 state 只会让两份实例各自持有一半状态。`ExtensionAPI` 上 `state` 仍是可选的（`state?`），代码里必须按可选处理。

### 写插件时怎么选

- 打开定时器、监听器、子进程、watcher → 用 `ctx.effect(() => cleanup())`，所有形态都可以。
- 需要随插件卸载清空的可变状态 → 写成 cordis 插件用 `ctx.state`，或把状态收敛到闭包里。

## 18. 插件 UI 模块的 `apply(ctx)` 生命周期(2026-10-24)

插件的**编译产物**(`ui/*.tsx`,daemon 用 `bun.build` 编译后经 blob 导入)除
`export default` 组件外,**可以**再导出一个 `apply(ctx)`:

```ts
export default function Panel(props) { ... }   // 必选:挂到座位里的组件

export function apply(ctx: PluginClientContext): void {   // 可选:模块级装配
  const style = document.createElement("style");
  style.textContent = MY_CSS;
  document.head.appendChild(style);
  ctx.effect(() => style.remove());          // 卸载/重载时跑

  const events = new EventSource("/api/my-plugin/events");
  ctx.effect(() => events.close());
}
```

### `PluginClientContext`

| 成员 | 含义 |
|---|---|
| `effect(dispose, label?)` | 登记一次拆卸。**逆序执行**(后装的贡献可能依赖先装的) |
| `signal: AbortSignal` | 本模块被取代/卸载时中止;交给 `fetch`/`EventSource`,不要手工跟踪生命周期 |
| `slot: string` | 挂载到的座位(`composer.model`、`settings.tab.x` …) |
| `extensionId: string` | 产出该组件的扩展入口路径 |

### 为什么必须存在这条缝

**只写 `export default` 的组件没有泄漏问题**:它的样式/订阅都在 `useEffect` 里,
React 卸载时会跑清理。漏的是**模块级**贡献:

- 一份全局样式表(每插件一份,不是每渲染一份);
- 跨面板共享的一条 EventSource;
- window 级监听。

重载会换掉整份编译产物、旧模块**永远不会再被求值**——它装下的东西就留在
document 里直到窗口关闭。症状是「改一次 UI 就多一份样式」「旧连接一直开着打
一个已不存在的模块」。

### 宿主保证

- `apply` 在组件挂载**之前**被调用一次;
- 拆卸在**下一次加载之前**跑(重载/卸载都算),因此旧 `<style>`/连接先清掉;
- 每次加载都是**全新** `ctx`(全新 signal)——复用一个已中止的 signal 会让新模块
  的每个请求立刻失败;
- 没导出 `apply` 的模块**行为完全不变**(纯组件是常态)。

### 验收

`desktop-app/test/plugin-client-lifecycle.test.tsx` 驱动**真实**的
`SlotComponentMount`(blob 导入真实代码 → 挂载 → 卸载),断言 document 里的
`<style>` 数量、模块收到的 abort、以及 disposer 顺序。**不要**写「复现宿主步骤」
的测试——那会在宿主坏掉时照样通过。

## 19. 编译插件的冻结宿主模块表(2026-11-03)

编译后的组件是独立 ESM bundle：没有被 external 的应用 import 都会复制进 bundle，其中也包括承载 **React context 或模块级状态** 的模块。副本一旦分叉，行为就静默走偏：打包的 `prompt-dialog` 读自己那份默认 context，`confirm` 不弹窗直接返回 `false`；打包的 toast store 到不了宿主的提示层；打包的 floating-menu 自带第二个 mutex，两个菜单可以同时打开。纯 helper 被复制无害，承载身份的模块被复制就是行为缺陷。

### 单一权威

`packages/collab-proto/src/extension-host-modules.ts` 拥有这张表：

```ts
export const EXTENSION_HOST_MODULES = [
  { key: "prompt-dialog", path: "lib/prompt-dialog" },
  { key: "action-toast", path: "lib/action-toast" },
  { key: "client-core", specifier: "@musepi/client-core" },
  { key: "i18n", specifier: "@musepi/client-core/src/i18n" },
  …
] as const satisfies readonly ExtensionHostModuleDeclaration[];
```

`path` 按归一化后缀匹配任意深度的相对 import（`../lib/x`、`../../lib/x`，带不带扩展名、正反斜杠均可）；`specifier` 精确匹配裸包 import。每个条目只声明一条规则。`ExtensionHostModuleKey` 是全部 key 的联合，`matchExtensionHostModule(request)` 把一条 import 解析成一个 key；返回 `undefined` 表示「留在插件 bundle 里」。

### 编译器

daemon 侧 artifact compiler（`packages/coding-agent/src/daemon/extension-artifact-compiler.ts`）对每条解析后的 import 查这张表。命中即替换为读取 `window.MusePiHostModules[key]` 的 shim，**宿主模块源码不进入 bundle**。表或 key 缺失时 shim 在导入阶段抛错，宿主没有发布契约就立即失败，而不是拿着旧副本继续跑。未命中的 import 照常打包，包括 `lib/leaf-walk` 这类纯 helper。React 与 React DOM 仍走各自到 `window.MusePiReact*` 的映射。

### 渲染端

`packages/desktop-app/src/lib/host-modules.ts` 是 key 到实例的唯一绑定处：

```ts
const hostModules = {
  "prompt-dialog": promptDialog,
  "action-toast": actionToast,
  …
} satisfies Record<ExtensionHostModuleKey, unknown>;
```

`satisfies` 让「契约有条目但渲染端没绑定实例」和「渲染端多出契约没有的 key」都变成类型错误。`exposeHostModules()` 在编译组件挂载前把表发布为 `window.MusePiHostModules`。旧的 `window.MusePiPromptDialog` 与 `window.MusePiManagedBrowserHost` 保留为同一批命名空间对象的别名，已编译的 bundle 继续读到宿主状态。

`slot-host` 是唯一自注册的条目，而不是由 `host-modules.ts` 反向 import：`slot-host.tsx` 已经 import `exposeHostModules` 来安装浏览器桥，若表再 import 它就会形成循环。它在模块加载时登记自己的命名空间，应用在任何编译组件挂载前 import 它。

### 当前条目

| Key | 应用模块 | 必须共享的身份 |
|---|---|---|
| `prompt-dialog` | `lib/prompt-dialog.tsx` | prompt/confirm 的 React context |
| `managed-browser-host` | `lib/managed-browser-host.ts` | 受管浏览器宿主 store |
| `action-toast` | `lib/action-toast.ts`（re-export `client-core` 的 store） | toast 列表与订阅者，桌面与 guest/mobile 共用 |
| `file-workspace` | `lib/file-workspace.ts` | 文件预览缓冲区 |
| `floating-menu` | `lib/use-floating-menu.tsx` | 模块级菜单 mutex |
| `update-ux` | `lib/update-ux.ts` | 更新提示/对话框共享的标志位与订阅者集合 |
| `tooltips` | `lib/tooltips.ts` | 提示气泡元素、计时器与 hover/focus 状态 |
| `slot-host` | `lib/slot-host.tsx` | slot 注册表 store、挂载函数与 slot 契约常量 |
| `monaco-runtime` | `lib/monaco-runtime.ts` | `monacoPromise`、全局 `MonacoEnvironment` 与 worker 工厂：所有编辑面共用一份 Monaco 实例与一套 worker |
| `monaco-lsp` | `lib/monaco-lsp.ts` | LSP `documents`、provider 注册、peek model 与编辑器 opener：宿主与所有插件共用一套 LSP 运行时与 provider 集合 |
| `voice` | `lib/voice.ts` | 活跃 TTS/听写会话、播放上下文与停止/恢复句柄：音频状态与取消操作不能跨 bundle 分叉 |
| `panel-maximize` | `lib/panel-maximize.ts` | 最大化标志、订阅者与动画注册表：宿主和每个插件观察同一个面板最大化状态 |
| `suggestions` | `lib/suggestions.ts` | 建议贡献者、存储与订阅：用户维护的建议在宿主和插件之间保持同一份 |
| `client-core` | `@musepi/client-core`（裸包） | 整个 client-core 命名空间：其中的 React context 与模块级状态 |
| `i18n` | `@musepi/client-core/src/i18n`（裸包） | `t` / `setLocale` 共用的 locale 注册表 |

复制一份 `monaco-runtime` 会各自设置 `MonacoEnvironment` 与 worker 工厂，不同 bundle 的编辑器因此加载出多份 Monaco。复制一份 `monaco-lsp` 会各自持有 document 表、provider 注册与 peek model，诊断、跳转和 peek 窗口会落在不同的文档状态上。两者都必须经表解析，插件编辑器才能与宿主共用同一套运行时。

### 身份与纯 helper 的界限

`client-core` 与 `i18n` 是裸包条目而非路径条目。模块身份——React context、模块级状态、`client-core` 命名空间本身——经 `MusePiHostModules` 共享；翻译则走宿主 locale 服务：`@musepi/client-core/src/i18n` 与 `@musepi/client-core` 指向同一个模块实例，因此插件里 `setLocale("zh-CN")` 会改变宿主 `t` 的返回值。

不要给深层 helper 加条目：`@musepi/client-core/src/lib/<helper>` 这类子路径不承载身份，继续打包。裸包按精确匹配，import 必须与表中写的一致——`@musepi/client-core/src/i18n/index.js` 是另一条请求，不会命中，并会打包出第二份 locale 注册表。

client-core 包内以 `../i18n/index.js` 等相对形式引用 i18n 时，同样归到同一个宿主 `i18n` 服务，因为这里的身份由 importer 的位置决定；非 client-core 的 importer 不受影响，其 `../i18n` 仍是自己的副本。

### 新增共享模块

只有 **身份必须共享** 时才加条目；没有跨模块状态的 helper 继续打包。

1. 在 `EXTENSION_HOST_MODULES` 加 `{ key, path }` 或 `{ key, specifier }`。
2. 在 `packages/desktop-app/src/lib/host-modules.ts` 引入该模块，并按同一 key 映射；两边不一致时 `satisfies` 约束会报类型错误。
3. 扩充编译器测试，证明该 import 解析到 `window.MusePiHostModules[key]` 且 bundle 内没有本地标记；扩充运行时测试，证明该 key 已发布且绑定了实例。
4. 更新本文档与 changelog。

每个条目都是宿主 ABI：删除或改名会让已编译的 bundle 在导入时抛错，而不是退回副本。

`packages/desktop-app/test/host-module-state-guard.test.ts` 负责完整性：`src/lib` 下任何包含 `createContext(...)` 调用的模块都必须有契约路径，已知状态模块还必须同时有路径与已发布实例。新增 React context 模块在登记前会让该测试失败。

**回归锚点**：`packages/collab-proto/test/extension-host-modules.test.ts`、`packages/coding-agent/src/daemon/extension-artifact-compiler.test.ts`、`packages/desktop-app/test/host-modules.test.ts`、`packages/desktop-app/test/host-module-state-guard.test.ts`。

## 20. 提示词区块：注册表、composer 与来源生命周期（2026-11-03）

`PromptComposer` 现在委托给具名注册表。既有调用方继续使用 `add`、`removeBySource`、`clear`、`size` 与 `compose`；新代码可直接使用注册表：

```ts
import { PromptComposer, PROMPT_ORDERS } from "@musepi/pi-coding-agent/prompts/composer";
import { PromptRegistry, PromptRegistryError } from "@musepi/pi-coding-agent/prompts/registry";
import { resolvePromptOrder } from "@musepi/pi-coding-agent/prompts/orders";
```

扩展继续使用 `pi.registerPrompt({ name, order, text })`。composer 为每份贡献记录来源：`registerPrompt` 为 `ext:<扩展 id>`，预设的 `prompt` 为 `mode:<预设 id>`，设置 `prompt.sections` 为 `user`，会话每次重建时解析的宿主区块为 `design-system`、`asset-policy` 与 `ext:inventory`。

### 函数文本

`text` 在 `registry.registerSection` 与兼容入口 `composer.add` / `pi.registerPrompt` 中接受 `string | ((context) => string | null | undefined)`。函数在组装时求值，而不是注册时求值，因此每次重建都能读到当前闭包状态。返回 `null` 或 `undefined` 会在本次组装中省略该区块；空字符串仍作为真实区块输出。函数收到组装上下文与 `variable(name)`。会话当前以不带额外键的 `compose(base)` 与 `composeComplete()` 调用，扩展函数文本应读取闭包状态或已注册变量，不要假定宿主字段可用。

### 严格变量需显式 opt-in

先用 `registry.registerVariable(name, resolver)` 注册变量，再在区块文本里写 `{{name}}`。名称匹配 `[A-Za-z0-9_.-]`；每个变量在单次组装中最多解析一次，值会转成字符串。后注册的 resolver 遮蔽先注册者，dispose 后者后恢复前者。在参与插值的区块上，未知占位符或 resolver 返回 `null`/`undefined` 都会抛 `PromptRegistryError`（`unknown prompt variable` / `unresolved prompt variable`），绝不会渲染成空文本。区块文本可调用 `context.variable(name)` 走同一套严格查找。组装上下文的键不会隐式成为变量：未注册的 `{{settingsKey}}` 仍是未知变量。变量不按 source 归属——`removeBySource` 只移除区块；请使用变量自己的 disposer 或 `clear()`。

### 旧有字符串区块

既有字符串区块不是 Handlebars 模板，也不会用会话 context 渲染，仍是字面量文本。旧入口（`composer.add` 与 `pi.registerPrompt`）不做任何插值：即使注册了同名变量，`{{name}}` 也逐字保留。严格 `{{name}}` 插值只适用于通过 `registry.registerSection` 显式注册的区块，或注册表函数文本中的显式查找；在那些路径里，正文若含 `{{...}}` 就必须注册对应名称，否则组装抛错。`composer.add` 不返回 disposer，并沿用旧 Map 语义：同名后一次 `add` 直接替换较早的层，因此移除替换者的 source 不会恢复旧区块。需要遮蔽堆叠、恢复旧层或显式释放的新代码应调用 `registry.registerSection`。

### 顺序、遮蔽与 complete

中央锚点为 `core: 0`、`injection: 25`、`safety: 100`、`project: 200`、`repoContext: 300`；数字 order 继续有效，`resolvePromptOrder` 拒绝未知名称和非有限数字。区块按解析后的 order、再按 name 排序。通过注册表同名后注册者遮蔽先注册者；dispose 后注册者会恢复前一份。最多一个可见区块可设 `complete: true`，它替换整个提示词（`compose` 与 `composeComplete` 都只返回它）。第二个可见 complete 在注册时被拒绝；之后才出现的冲突（例如 dispose 遮蔽层）会被原子拒绝：disposer 或 `removeBySource` 抛错，所有层保持不变，`revision` 不递增。被拒绝的 disposer 不会被消耗，冲突解除后可重试。

### 来源卸载与生命周期

`registerSection` 与 `registerVariable` 返回幂等 disposer。`removeBySource(source)` 删除所有 source 匹配的区块层，只有确实删除时才递增 `revision`；其他 source 的层保持原位。`clear()` 清空全部区块与变量。`revision` 是结构变更的单调计数，`assemble` 期间不变，调用方可在显式刷新前后比较。`size` 统计区块名称而非遮蔽层。空注册表组装为 `{ revision: 0, sections: [], complete: null }`，`compose(base)` 原样返回 `base`——这是兼容性锚点。

扩展 load/reload 按来源重新同步：先移除旧一代，再加入替换实例的区块，提示词不会混合两代内容。忙会话把 reload 推迟到下一个空闲 `agent_end`。mode 热切换使用同一条按来源卸载路径，`design-system` / `asset-policy` 区块每次重建都会重新解析。

### 仅提示词刷新

每次提示词重建都会重新求值函数文本、重新解析变量，并重新运行宿主区块 resolver，再调用 `compose(base)`（`promptComplete` 预设走 `composeComplete`）。`AgentSession.setDesignSystemId` 是仅提示词的实时路径：写入 metadata 键并调用 `refreshBaseSystemPrompt()`，不改变活动工具集，新简报在下一次模型调用生效。扩展 load/reload 会立即重挂 composer 来源，然后调用 `refreshBaseSystemPrompt()`，因此仅提示词扩展（没有工具）无需等待下一次重建即可进入活动会话；忙会话在延迟的 load/reload 排空时执行同样的刷新。composer revision 已计入重建签名，工具集不变时仅区块变化也不会被跳过。同一次 load/reload 产生的工具变更仍走常规工具注册表路径，两条路径都不需要重启会话。

composer 注册表同样不拥有缓存策略或 diff 式运行时消息。

### 会话提示词宿主（PromptHost）

每个会话——主代理与子代理一样——创建一个 `PromptHost`（`packages/coding-agent/src/prompts/host.ts`）；扩展工厂经可选的 `pi.promptHost` 注册四类贡献：`registerSection`、`registerContext`、`registerVariable` 与 `registerTool`。放置有三个维度：`scope`（子 scope 继承全部祖先贡献）、`lane`（同一 scope 内的来源优先级；默认顺序为 `core` < `extension` < `preset` < `session`，靠后的 lane 遮蔽靠前的）与 `owner`（经 `removeByOwner` 整组释放；预设启停、热重载与会话销毁按 owner 释放或重放）。区块、context 与工具区块还声明 `cacheScope`（`prefix` / `snapshot` / `turn` / `request`；区块与工具区块默认 `prefix`，context 默认 `turn`），说明渲染文本可复用多久。变量没有 cache scope。空宿主保持提示词逐字节不变。

区块声明 `interpolate: false` 只跳过文本渲染之后的最终 `{{name}}` 替换——函数文本照常求值，未带该标记的区块维持严格默认（未知或未解析变量即抛错）。承载发现内容或用户/服务器可控文本的区块（项目上下文、运行时附录）以 `interpolate: false` 注册，数据中的 `{{...}}` 序列按字面通过，不会触发严格解析失败。

`registerContext` 已接入每轮投递。SDK 每轮用与 `assemble` 相同的活动工具集和装配上下文调用 `promptHost.collectContext`，`AgentSession` 把每条投递转为隐藏的 `role: "custom"` 消息——`customType` 为 `prompt-context:<name>`、`display: false`——走常规 provider 与持久化管线：模型可见、随会话持久化、时间线不显示。`required: true` 的 context 每轮投递；其余 context 在历史中最近一条同类型消息内容相同时跳过，而这里比较的是活动、resume 或 branch 之后的最新历史副本——续接与分支会话按自己的最新副本去重，不会叠加重复。context 与区块一样支持 `interpolate: false`；`xd://` 设备目录区块用它让挂载设备文本中的花括号按字面保留。会话收集不会推进宿主独立的投递台账：实际历史是唯一去重依据，因此压缩或提示词装配中止后，只要旧副本已不在历史中，后续投递就不会被提前记作“已投递”而抑制。plan/goal/vibe 运行时上下文不走这条通道——它们保留各自的既有 customType（见下）。

六个只读第一方核心提示词包——`delegation`、`file-tools`、`browser`、`computer`、`lsp`、`host-integrations`——在所有会话加载路径自动挂载：预加载会话在会话宿主上重挂它们，子代理与工具受限会话在发现被关闭时也加载它们，完整发现则把它们合并到调用方路径之前。它们的入口只设置标签并注册提示词宿主贡献（工具由单独挂载的组件 entry 提供），按会话挂载、从不全局，路径按解析结果去重，核心包恰好挂载一次。

会话易变上下文按 owner 分割。AGENTS context 文件与工作区树渲染为 `project:context` snapshot 区块，嵌套活动仓库渲染为 `project:active-repo`，两者都归 `session:project-context` 所有，函数文本在每次重建时刷新；custom prompt 布局仍在自己的模板中渲染 context 文件，因此该布局同样每块只有一个 owner。记忆指令、auto-learn 指南、已挂载 MCP 路由指引、MCP 服务器说明与默认用户 append 只经 host-integrations 插件的 `host:runtime-context` 区块渲染（order 250，位于 project 区块 200 与 repo context 300 之间）；宿主在该区块渲染前按名称排序 MCP 服务器说明并施加 4000 字符截断，custom system prompt 下 append 在该模板内渲染、宿主省略自己的副本。

plan/goal/vibe 运行时上下文刻意保持宿主持有的 custom 消息：`AgentSession` 以 `role: "custom"` 持久化它们，因为流式 steer 投递、模式退出 marker 与 resume/branch 去重依赖该消息传输。它们不是 system 区块；"最近已投递副本不再重发、流式进入模式经 steer 持久化的上下文不会产生第二份"的去重也在这条路径上。

日期、cwd、skills/rules、工具清单与 persona/预设数据仍在 `buildSystemPrompt`；不要把提示词面描述成已全部插件化。

**回归锚点**：`packages/coding-agent/test/prompts-registry.test.ts`、`packages/coding-agent/test/prompts-composer.test.ts`、`packages/coding-agent/test/prompts-host.test.ts`、`packages/coding-agent/test/prompt-host-session.test.ts`、`packages/coding-agent/test/prompt-project-context.test.ts`、`packages/coding-agent/src/prompts/{orders,registry,composer,host,store,types,project-context}.ts`、`packages/coding-agent/src/bundled-plugins/loader.ts`。

## 20. 宿主记忆服务（`ctx.memory`）

会话扩展通过 `ctx.memory` 读取当前记忆后端：

| 成员 | 含义 |
|---|---|
| `backend()` | 活动后端 id（`off`、`local`、`mnemopi`、`hindsight`、`sharpshooter`）。 |
| `status()` | 设置页与 `/memory` 读取的同一份结构化状态。 |
| `search()`、`save()` | 后端支持时提供结构化召回与显式写入。 |
| `clear()`、`enqueue()` | 对应 `/memory clear` 与 `/memory enqueue`。 |
| `view()`、`stats()`、`diagnose()` | 对应 `/memory view/stats/diagnose` 的提示词载荷与后端报告。 |

核心记忆系统与扩展代码为同一会话解析同一个后端。宿主半体的记忆插件（工具、命令、生命周期）应调用 `ctx.memory`，而不是导入 `memory-backend` 内部模块；桌面设置页是渲染侧组件，读取 daemon 的 `memory.*` RPC。`"memory"` 同时是 Cordis 插件 `inject` 可声明的宿主服务名；`pi.service("memory")` 有意返回 `undefined`，因为宿主能力通过 `ctx.memory` 暴露，而不是插件 `provide` 的对象。

Cordis 插件可以用 `pi.registerMemoryBackendProvider({ id, create(settings) })` 替换一个后端实现。provider 在内置后端之前解析；同一 id 的第二个 provider 会被拒绝；返回的 disposer 恢复内置实现。扩展卸载或重载时 runner 也会执行该 disposer，被替换的后端不会比插件活得更久。

provider 也可以贡献**新**后端 id，而不仅是替换：`registerMemoryBackendProvider({ id: "mybank", label, description, create })` 注册后 `memory.backend` 接受该 id（`getEnumValues` 合并 provider 注册表），设置选择器以 provider 自己的 label / description 追加该项。插件卸载后选项消失；仍指向该 id 的配置回退到 `off`，不会解析到别人的实现。

`ctx.hmr` 报告宿主级热重载，由 host 作用域的 `musepi-hmr` 包（`provide: ["hmr"]`）经宿主服务注册表提供。它通过真实的 Cordis 事件服务发布 dsh 的事件名：`on("hmr/change", …)` 每批文件变更、`on("hmr/reload", …)` 表示该批的重新装载开始，支持 Cordis 的 `prepend` 顺序与逐监听隔离（`onChange` 保留为别名）。该包自己的 `musepi.config` 经 `apply(ctx, config)` 传入：`debounce`（毫秒）、`base`、`root`（`list` 字段，相对 base 解析；留空则使用原生扩展/插件根）、`ignored`（`list` 字段，叠加在 `.git` 与模块缓存之上）。`list` 是正式配置字段类型：清单声明 `type: "list"` 与 `string[]` 默认值，GUI 以逗号分隔输入编辑，wire 形状始终是 `string[]`。没有 watcher 时（未装载 host 插件、测试）`enabled` 为 false；`onChange(listener)` 每个稳定窗口收到一批 `{ trigger: "watch" | "manual", paths }`，返回 disposer；`reload()` 让当前监听按“文件刚变过”跑一次。`runExclusive(tx)` 让安装/配置写入与重载批次串行，谁都不会看到半应用状态；`getLinked(file)` 返回拥有该文件的入口，`getOuterStack(file)` 给出到入口的 importer 链——两者都来自 loader 的模块图，未挂图时返回空。watcher 是进程级单例——daemon、TUI、ACP、SDK 共用一份——但反应归各宿主：daemon 失效扩展缓存并广播 `extensions.changed`，终端只失效发现缓存，插件自行决定重载对自身意味着什么。监听若不应长于其所有者，用 `ctx.effect(dispose)` 登记。

`memory.*` 仍是核心契约：每条路由都调用活动后端的成员，插件不能另立方法名。因此替换后端时，`memory.status/view/stats/diagnose/clear/enqueue` 会一起切换。`memory.workspace*` 由可选的 `workspaceDir(agentDir, cwd)` 能力决定：返回目录的后端才拥有设置页文件浏览，未实现的返回 `supported: false` 并拒绝读取或定位，而不是列出属于另一种实现的本地文件。

这是把记忆管理面（设置页、`/memory`、工具、RPC）迁入第一方 Cordis 包的最小 seam。provider seam 已经存在；目前还没有第一方记忆插件注册 provider，因此内置后端仍是默认实现。
