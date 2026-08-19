# MusePi 扩展开发规范(Agent 版)

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
| **发现/安装** | 无插件管理器(手动放 node_modules) | `musepi plugin install|link|uninstall|list|enable|disable`(`PluginManager` + `MarketplaceManager`),`omp-plugins.lock.json` 记录 |
| **GUI 集成** | 无 | 设置「扩展」tab + 侧栏入口(`ExtensionsCenter.tsx`),daemon `extensions.list` RPC,TTL 10s 缓存,启停写 `settings.disabledExtensions`(`kind:name` id;`mcp:` 前缀走 mcp.json denylist) |
| **运行时管理** | 无 | daemon 统一扫描(`extensions.list` → 树:provider → kind → item)、`extensions.setEnabled` |

**结论**:能力上 **OMP Plugin ⊂ MusePi Plugin**。新扩展一律按 MusePi Plugin 写(免费获得 GUI 管理);只在纯 OMP 环境跑才按上游最小形态写。

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

- **native/内置**(`discovery/builtin.ts`):随代码分发,`extensions.list` 里 provider = native,节点只读(不能禁用)。
- **插件安装**(`~/.musepi/plugins/`):provider = user,可启停。
- 测试/示例扩展(如 `harmony-leak` 夹具)是测试资产,不算产品扩展。

## 5. 相关文档

- `docs/extensions.md` —— 扩展运行时 API 全量(事件、注册方法、生命周期图)
- `docs/extension-loading.md` —— 发现与加载规则(module 路径、discovery provider)
- `docs/plugin-manager-installer-plumbing.md` —— 插件管理/市场安装管线
- `docs/user-facing-packages.md` —— 用户面包(CLI/特性)
- `docs/gui-implementation.md` §2 —— GUI 扩展控制中心契约(daemon RPC、TTL、启停语义)

## 6. UI 组件贡献(renderer-side slots,2026-08-16)

扩展可以向桌面 GUI 贡献 React 组件(DSH ui-slots 对应物)——daemon 编译、GUI 动态挂载、HMR 即时生效:

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
- `settings.tab.<id>` — 设置页动态分区(2026-08-20 起并入"扩展设置"分区内渲染,不再独立导航)
- `rail.<id>` — 右缘图标轨(前缀命名空间;`rail.right` 是保留的精确槽)
- `composer.dock` / `composer.left` / `composer.right` — 输入卡上方行 / 工具栏两端(list 语义,多扩展可同槽)
- `panel.right` / `settings.extensions` — 旧保留槽(仍可用)
- `settings.item.<extId>` — 扩展设置卡片(2026-08-17):设置页"扩展设置"分区按扩展 id 派发一张卡片,组件经 `settingsScope` prop 读写设置键(见下)。
- `settings.action.<id>` — 单行偏好槽(2026-08-20,DSH `settings.action` 类比):组件挂到设置页"通用"分区末尾,功能插件贡献单行偏好(语言/外观/Enter 行为),无需整 tab 或整卡。

**数据流**:daemon `bun.build` 把模块编译为自包含 ESM(react 绑定宿主实例)→ `extensions.list` 返回 code → GUI `SlotComponentHost` blob: 动态 import 挂载。**信任模型**:扩展本就在 daemon 进程执行任意代码,渲染其组件不构成新提权。

**设置卡片(settings.item + settingsScope)**:注册 `slot: "settings.item.<extId>"`(extId = 扩展目录名)的组件,会在设置页"扩展设置"分区获得一张卡片(DSH `settings.plugin.item` 派发对齐;扩展未启用则不显示)。组件收到额外 prop `settingsScope = { get(keys: string[]): Promise<Record<string, unknown>>, set(key: string, value: unknown): Promise<void> }` —— 经 daemon `settings.get`/`settings.set` RPC 读写设置。**键名自由命名,建议用 `扩展名.xxx` 前缀**(与 registerSetting 的 `display.taskCardStyle` 同约定)避免与其他扩展冲突;写入只放行 registerSetting 注册过的键,未注册键写会抛 read-only。**写时校验(registerSetting 的 `validate` 字段,DSH `installSettingsSection` validate 对齐)**:扩展可为注册的设置键提供 `validate(value)` 回调——返回错误字符串即拒写(daemon `settings.set` RPC 抛错,GUI 显示原因),返回 `void` 放行。schema 无法表达的约束(端点可达性、跨键一致性、枚举外值)由此在**写入时**拒绝,而非用到时才炸。无任何扩展注册该槽位时分区显示空态文案。

**热插拔(v2,HMR 全量)**:扩展源码/配置变更 → daemon watcher(500ms debounce)① 清缓存并广播 `extensions.changed`(需先 `events.subscribe`)→ GUI 插槽即时重载(~1s),`ExtensionsCenter`/`PluginsSection` 监听同事件即时刷新;② 对每个活跃会话按**入口 mtime 对比**执行 `reloadExtension`(不依赖 fs.watch 的 filename —— Windows 递归 watch 的 filename 不可靠),完成后发会话内事件 `extensions.reloaded`。会话内工具/命令/handlers 下次调用生效。

**v2 契约(子模块边界、忙门控、MCP)**:
- **入口 vs 子模块**:重载只对**入口文件**生效(`loadLegacyPiModule` 的 `?mtime=` cache-bust 只重键入口 specifier);入口 `import` 的子模块按裸路径命中 Bun 进程模块缓存,改动不热生效 —— 多文件扩展改子模块需 **touch 入口** 或重启会话。这是 Bun 模块图语义,非缺陷(DSH 的 vm 沙箱每次重载是全新模块图,子模块天然重执行,代价是沙箱复杂度)。
- **重载语义(无事务)**:失败的重载(语法错误等)保留旧实例并上报错误,不破坏现状;成功的重载 = 旧实例 handlers 先清空、新模块工厂运行(重注册的 handler 无双跑)、`toolRegistrationListeners` 带到新实例(新工具按名覆盖推入会话注册表)、`extensions[]` 原地替换。返回 `removedTools` = 旧工具名,会话侧删除**未被新模块重注册**的旧名。
- **内存态不迁移**:重载重建模块实例,扩展自行持久化状态(settings/磁盘);在途异步副作用(已发出的 fetch/定时器)不回收,尽力而为。
- **忙会话门控**:会话 streaming(`isStreaming`)时重载挂起到单槽 pending,`agent_end`(含延迟 agent_end flush)空闲时补做;不引入队列/锁。
- **MCP 不随扩展关闭**:MCP 连接由配置层启动、`MCPManager` 按 cwd 多会话共享,`SourceMeta` 是配置来源非扩展来源 —— 扩展重载不触碰 MCP server 生命周期;扩展自行管理自有连接。

**参考实现**:`examples/extension-component/`(示例)、`packages/coding-agent/src/daemon/extension-components.ts`(编译/聚合)、`packages/gui/src/lib/slot-components.tsx`(渲染)、`ExtensionRunner.reloadExtension` + `AgentSession.reloadExtension`(v2 会话级重载)、`docs/extension-hmr-v2-plan.md`(设计记录)。

## 7. 扩展 daemon RPC(registerRpc,2026-08-20)

DSH `harness.handle` 类比:扩展向 daemon 注册 JSON-RPC 方法,GUI 槽位组件经 `extensionCall` prop 回调自己的 daemon 侧逻辑 —— 组件从"展示"变成"可交互":

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

DSH `ctx.skills.register` 类比:扩展声明**虚拟技能**(无 backing SKILL.md 文件),与文件扫描技能同框展示:

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

DSH `tool.call.toolview` 类比:扩展为**指定工具名**贡献 transcript 渲染器,替换内置渲染器:

```ts
pi.registerToolView("my_tool", { moduleUrl: "./views/my-tool.tsx", label: "My Tool View" });
```

**模块契约**(与 registerComponent 同编译管线,blob import + `window.MusePiReact`):
- 默认导出两种合法形状之一:
  - **React 组件**(DSH tool.call.toolview 形状):作为全卡 Card 渲染,收到 `ToolRenderProps` `{ name, args, result, running, host, kind, intent }`;
  - **ToolRenderer 对象** `{ Summary, Body?, Card? }`(desktop-web 内置注册表同构)。
- 工具名 = wire 工具名(扩展自己 registerTool 的工具名,或覆盖内置如 `bash`);扩展渲染器**优先于内置**(`resolveToolRenderer` 先查外部表)。

**分派**:daemon 编译 → `extensions.list.toolViews` → GUI `useExtensionToolViews`(ChatView 挂载)blob-import 并注册进 desktop-web tool-render 外部表 → `ToolView` 按名分派。编译失败的 view 携带 `error`,回退内置/generic 渲染器,不破坏 transcript。

**参考实现**:`packages/desktop-web/src/tool-render/registry.ts`(`registerExternalToolRenderers`)、`packages/gui/src/lib/slot-host.tsx`(`useExtensionToolViews`)、`packages/coding-agent/src/daemon/extension-artifact-compiler.ts`(`collectToolViews`)。
