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
| **GUI 集成** | 无 | 设置「扩展」tab + 侧栏入口(`ExtensionsCenter.tsx`),daemon `extensions.list` RPC,TTL 10s 缓存,启停写 `settings.disabledExtensions`(`kind:name` id;`mcp:` 前缀走 mcp.json denylist) |
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

在 **musepi 自己的插件体系内部没有第二层**:一个插件包就是一个插件,`package.json` 的 `musepi` 块声明它提供哪些入口/配置/资源(见 §13),装上即可用。DSH 另有一层 `cordis.patch.yml` Loader 配置(把包的几行插进插件树),我们不需要 —— 插件由 `pi.extensions` 运行时发现。对照核实见 §15。

## 2. 扩展能做什么(能力面)

一个扩展模块可以组合:

- 事件处理:`pi.on("session:start" | "tool:call" | "tool:result" | "message" | ...)`
- LLM 工具:`pi.registerTool({ name, description, parameters, execute })`(进入工具注册表,权限链照常生效)
- 斜杠命令:`pi.registerCommand(...)`(TUI `/cmd` + GUI 命令面板)
- 快捷键/flags、自定义消息渲染、会话/消息注入(`sendMessage` / `sendUserMessage` / `appendEntry`)
- **工具执行拦截**:每个工具执行都被扩展拦截层包裹(`tool_call` / `tool_result` 事件可介入)

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
- **内置注册表**(`extensibility/extensions-center/builtin-registry.ts` 的 `BUILTIN_EXTENSIONS`):随代码分发的部署物,以 `musepi-extensions` provider 的 builtin 项呈现(provider=native 语义不扩大),path 恒为空(只读,不可改删/rollback),带"内置"徽章。三类语义:
  - `settingsMirror`(样式/桌面壳/magic keywords):设置键即事实源,`extensions.setEnabled` 写镜像键,daemon 与 TUI 仪表盘按 `builtinMirrorDisabled` 读回;
  - 通用项:走 `settings.disabledExtensions`,可禁用;
  - `readonly: true`(主题包/渲染器包):只读展示,无禁用语义,UI 不渲染开关——登记仅为可见性,不发明语义。
  - `annotate: true`(bundled skills):不产生独立条目,只给扫描出的同 id 行打 `builtin` 标记(bundled skill 的安装行已由 native 扫描呈现,重复登记会出现两行)。
  - 0.5.0 M2.1 登记清单:bundled skills ×6(清单源 `src/bundled-skills/index.ts`)、magic keywords ×3(镜像 `magicKeywords.<kw>`)、modes 主题包 ×1(raw.themes = `getBuiltinThemes()`)、tool-render 卡片工具包 ×1(raw.tools = client-core `tool-render/card-tools.ts` 权威清单的快照,契约测试守交集)。**内置 hooks 不存在**:hook 全部是文件/插件态,经 native 扫描自然可见,登记数为 0。
- **插件安装**(`~/.musepi/plugins/`):provider = user,可启停。
- 测试/示例扩展(如 `harmony-leak` 夹具)是测试资产,不算产品扩展。

## 5. 相关文档

- `docs/extensions.md` —— 扩展运行时 API 全量(事件、注册方法、生命周期图)
- `docs/extension-loading.md` —— 发现与加载规则(module 路径、discovery provider)
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
- 通过 `React` 标识符引用 React(daemon 编译时改写为 `window.MusePiReact`)——**禁止 `import ... from "react"`**,否则绑定第二份 react 副本,hooks dispatcher 变 null(实测坑);
- type-only import 可(编译擦除);
- **注入 props(全部可选,宿主传哪项哪项有值)**:`{ rpc, sessionId, cwd, slot, extensionId }` —— `rpc` 是 daemon RPC 桥(models.list/session.setModel 等),`sessionId`/`cwd` 是宿主当前会话上下文,`slot`/`extensionId` 是身份。组件不依赖任何一项仍可工作;
- **样式**:组件内 `import "./x.css"` 会被 daemon 提取并在挂载时注入 `<style data-slot-css>`(组件卸载即移除)——不要依赖全局样式文件;
- **失败可见**:编译失败/加载失败在宿主处以红色错误块显示(不再静默消失);运行时错误有 `gui-slot-error` 样式。

**槽位清单**(daemon `assertKnownComponentSlot` 校验,未知槽名注册会抛错;单一权威见 `packages/collab-proto/src/extension-slots.ts`):
- `panel.tab.<id>` — 右面板动态 tab(图标 + 内容区)
- `settings.tab.<id>` — 设置页左侧导航项:扩展声明一个设置页即出现在设置导航,内容区挂载组件。
- `rail.<id>` — 右缘图标轨(前缀命名空间;`rail.right` 是保留的精确槽)
- `composer.dock` / `composer.left` / `composer.right` — 输入卡上方行 / 工具栏两端(list 语义,多扩展可同槽)
- `panel.right` / `settings.extensions` — 旧保留槽(仍可用)
- `settings.item.<extId>` — 扩展设置卡片(2026-08-17;2026-08-20 起展示于**扩展中心底部**,随插件 inventory):按扩展 id 派发一张卡片,组件经 `settingsScope` prop 读写设置键(见下)。
- `settings.action.<id>` — 单行偏好槽(2026-08-20):组件挂到设置页"通用"分区末尾,功能插件贡献单行偏好(语言/外观/Enter 行为),无需整 tab 或整卡。

**数据流**:daemon `bun.build` 把模块编译为自包含 ESM(react 绑定宿主实例)→ `extensions.list` 返回 code → GUI `SlotComponentHost` blob: 动态 import 挂载。**信任模型**:扩展本就在 daemon 进程执行任意代码,渲染其组件不构成新提权。

**设置卡片(settings.item + settingsScope)**:注册 `slot: "settings.item.<extId>"`(extId = 扩展目录名)的组件,会在**扩展中心**(设置 → 扩展)底部按扩展获得一张卡片(扩展未启用则不显示)。组件收到额外 prop `settingsScope = { get(keys: string[]): Promise<Record<string, unknown>>, set(key: string, value: unknown): Promise<void> }` —— 经 daemon `settings.get`/`settings.set` RPC 读写设置。**键名自由命名,建议用 `扩展名.xxx` 前缀**(与 registerSetting 的 `display.taskCardStyle` 同约定)避免与其他扩展冲突;写入只放行 registerSetting 注册过的键,未注册键写会抛 read-only。**写时校验(registerSetting 的 `validate` 字段)**:扩展可为注册的设置键提供 `validate(value)` 回调——返回错误字符串即拒写(daemon `settings.set` RPC 抛错,GUI 显示原因),返回 `void` 放行。schema 无法表达的约束(端点可达性、跨键一致性、枚举外值)由此在**写入时**拒绝,而非用到时才炸。无任何扩展注册该槽位时分区显示空态文案。

**热插拔(v2,HMR 全量)**:扩展源码/配置变更 → daemon watcher(500ms debounce)① 清缓存并广播 `extensions.changed`(需先 `events.subscribe`)→ GUI 插槽即时重载(~1s),`ExtensionsCenter`/`PluginsSection` 监听同事件即时刷新;② 对每个活跃会话比对**整张源码图的 mtime 快照**后执行 `reloadExtension`(不依赖 fs.watch 的 filename —— Windows 递归 watch 的 filename 不可靠),完成后发会话内事件 `extensions.reloaded`。会话内工具/命令/handlers 下次调用生效。

**v2 契约(子模块边界、忙门控、MCP)**:
- **子模块改动同样热生效,无需 touch 入口**:装载时对入口的**整个源码图**做一次走查(`collectExtensionModules`,含静态 `import`、CJS `require` 与动态 `import()`),快照逐文件 mtime;daemon 的变更判定按这个快照逐文件比对(`extensionEntriesNeedingReload`),任一图内文件变了就重载它的入口。重载本身一直是好的 —— cache-bust tag 单调递增(`nextLegacyPiLoadTag`),`onLoad` 钩子把它盖到每个相对 import 上,整图重新读盘 —— 坏的是**没人通知有东西该重载**。
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

## 9. 扩展 per-tool 渲染器(registerToolView,2026-08-20)

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

Electron 壳本身是**一等扩展**(`kind: "desktop-shell"`, id `desktop-shell:shell`, 内置注册表 `builtin-registry.ts`):
- `extensions.list` 顶层返回 `shell: { enabled, mode, webUrl }` —— 壳启用状态(`shell.enabled` 设置键)、DSH 三模式、daemon serve 的渲染器 origin。
- `extensions.setEnabled("desktop-shell:shell", { enabled, mode? })` 切换壳开关与模式(写 `shell.enabled`/`shell.mode`, 管理 `web.port` 发现文件 —— 壳进程据此决定 loadURL 运行时渲染器 or 本地 bundle)。
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
| `plugins.uninstall` | `{ name }` | `{ name }` |

事件(daemon 广播,渲染端按 `installId` 对账):
- `plugins.install.state` — 状态迁移,载荷同 `PluginInstallView`;
- `plugins.install.output` — 包管理器输出的每一块,带 `stream`。

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

## 15. 用户自定义扩展(现状核实,2026-10-06)

对照 DSH 的用户 patch 层核实过一次,结论是**不构成能力缺口**,这里记录实测依据以免重复讨论。

DSH 的插件装载分两步:装包,再把包的 `cordis.patch.yml` 合进 profile 的 Loader 配置树,树里才出现这个插件的「行」;用户可以自己往这棵树插行,也可以按行单独开关(`setPluginEnabled` 写用户层的 `disabled` 覆写)。

musepi 的对应能力:

| DSH | musepi | 依据 |
|---|---|---|
| 用户 patch 层插自定义行 | `discoverExtensionPaths` 第 4 类来源 `configuredPaths`,可直接喂目录或单文件;`~/.musepi/agent/extensions` 亦可放 | `extensibility/extensions/loader.ts:1017-1043` |
| 按行单独开关 | `extensions.setComponentEnabled`,粒度 `<plugin>/<component>`,写隐藏设置键,GUI 在插件详情页有开关 | `daemon/services/extension-service.ts:601`、`daemon/cordis-dynamic-extensions.ts:791` |
| 整包启停 | `plugins.setEnabled` → `settings.disabledExtensions`(`extension-module:<name>`) | `daemon/server.ts:1928` |

粒度上我们比 DSH **更细**:DSH 的「行」是 Loader 树的一个节点,行内不可再分;`ExtensionItem` 有 17 条独立贡献通道(components / skills / toolViews / services / themeTokens / promptSections / modes / designSystems / notificationChannels …),每条各自加载与卸载(`extensibility/extensions/types.ts:2085-2142`)。

真实差异只有一处:**没有「用一段配置声明一个插件」的能力** —— DSH 可以在 patch 里写 `insert: [{ id, name, config }]` 而不必有包。适用场景是临时代理、实验开关,代价是要手写一个模块文件。若这个场景被提出,应扩展 `configuredPaths` 侧的声明式配置,而不是引入 Loader 配置树 —— 那会把「插件是运行时发现的」这个前提改掉。

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
