# P1 第十一刀：ExtensionService 抽取（extensions.* + plugins.* + ext.call，9 路由）

你在 `musepi-omp` 仓库（Bun monorepo）执行一次**纯搬移式**服务抽取。纪律：不改行为、不改消息文本、不改时序语义；只搬代码、改委托接线。先例（必须先读）：

- `packages/coding-agent/src/daemon/services/schedule-service.ts`（上一个有状态服务，最近完成）
- `packages/coding-agent/src/daemon/services/approval-service.ts`（结构切面注入先例）
- `packages/coding-agent/src/daemon/server.ts` 构造注册区（ScheduleService 注册处）

设计约束：`docs/review/0.5.0-m2-daemon-host-layering.md`。头注释简体中文"能力缝声明 + 范围边界"两段式。

## ⚠️ 本刀最大坑（上一刀真实发生过的错误）

被搬 case 体内的**动态 import 相对路径要随文件位置修正**：这些 case 现在在 `src/daemon/server.ts`，搬进 `src/daemon/services/` 后，凡 `await import("../X")` 一律改 `await import("../../X")`；凡 `await import("./X")`（同 daemon 目录）一律改 `await import("../X")`；裸包名（`@musepi/pi-utils`）不变。逐条核对，一条都不许漏：

| 原路径（server.ts 内） | 服务文件内 |
|---|---|
| `../extensibility/extensions-center/builtin-registry` | `../../extensibility/extensions-center/builtin-registry` |
| `../extensibility/extensions-center/state-manager` | `../../extensibility/extensions-center/state-manager` |
| `../capability` | `../../capability` |
| `./extension-artifact-compiler` | `../extension-artifact-compiler` |
| `../mcp/config-writer` | `../../mcp/config-writer` |
| `../extensibility/extensions` | `../../extensibility/extensions` |
| `../extensibility/extensions/loader` | `../../extensibility/extensions/loader` |
| `../extensibility/plugins/loader` | `../../extensibility/plugins/loader` |
| `../extensibility/plugins/manager` | `../../extensibility/plugins/manager` |

## 一、新建 `packages/coding-agent/src/daemon/services/extension-service.ts`

`key = "extensions"`，routes：

```ts
readonly routes = {
	"extensions.list": "list",
	"extensions.raw": "raw",
	"extensions.setEnabled": "setEnabled",
	"extensions.setForceEnabled": "setForceEnabled",
	"extensions.setProviderEnabled": "setProviderEnabled",
	"ext.call": "call",
	"plugins.list": "listPlugins",
	"plugins.packages": "pluginPackages",
	"plugins.setEnabled": "setPluginEnabled",
} as const;
```

### 依赖注入（全 lazy）

```ts
export interface ExtensionServiceDeps {
	settings(): Settings | undefined;
	ensureRegistry(): Promise<unknown>;
	cwd(): string;
	webUrl(): string | null;
	/** web.port 发现文件的绝对路径（宿主计算：socket 目录下）。 */
	webPortFile(): string;
	/** extensions.changed 广播（宿主接 EventService，lazy 调用无循环）。 */
	onChanged(): void;
}
```

`Settings` 类型从 `../../config/settings` import type（server.ts:76 同款来源）。

### 拥有的状态（从 DaemonServer 原样搬入，含各自 doc 注释）

- `#pluginsCache`（server.ts 3339-3344，TTL 10s，shape 原样）
- `#pluginPackagesCache`（3346-3361，shape 原样）
- `#extensionsCache`（3417-3420）
- `#getExtensions(): Promise<Extension[]>`（3565-3583）→ 改为**公开方法 `getExtensions()`**，逻辑逐字（10s TTL、ensureRegistry 引导、disabledExtensions、getRaw forceEnabledExtensions、loadAllExtensions(cwd, disabledIds, forceIds)）。`Extension` 类型：`import type { Extension } from "../../extensibility/extensions-center/types"`（server.ts:524 的 import() 别名改直接 import type）。

### 方法（全部从 server.ts 原样搬移）

- `list()` ← case "extensions.list"（4562-4647）：整段逐字——#getExtensions、settings 引导、shellCfg（webUrl 走 deps）、builtin mirror 循环、buildProviderTabs、getAllProvidersInfo、collectSlotComponents/collectToolViews/collectStatusBarSegments（cwd 走 deps）、返回体（extensions 剥 raw、tabs、providers、components、toolViews、statusBarSegments、shell、slots: EXTENSION_SLOT_DECLARATION）。静态 import `EXTENSION_SLOT_DECLARATION` from `"@musepi/collab-proto/extension-slots"`。
- `raw(params)` ← case "extensions.raw"（4648-4656）：`unknown extension: ${p.id}` 抛错、16KB 截断逻辑原样。
- `setEnabled(params)` ← case "extensions.setEnabled"（4657-4757）**整段逐字**，四分支全搬：① `desktop-shell:shell`（mode 校验抛 `invalid shell mode: ${mode}`、shell.enabled 写、web.port 文件写/删【路径走 `this.#deps.webPortFile()`】、缓存失效、`onChanged`）；② settingsMirror 内置项（findBuiltinDef 动态 import 已按上表修正）；③ `mcp:` 前缀（setMcpServerEnabled + getMCPConfigPath + disabledExtensions 残留清理）；④ 通用 disabledExtensions 读写。所有 `settings unavailable` 抛错、`settings.flush()`、`this.#extensionsCache = null`（改服务内私有字段）、`this.#services.get<EventService>("events").broadcastExtensionsChanged()`（改 `this.#deps.onChanged()`）逐字保留。
- `setForceEnabled(params)` ← case "extensions.setForceEnabled"（4758-4779）：forceEnabledExtensions 读写 + flush + **同时失效 #extensionsCache 与 #pluginsCache（服务内私有字段直接置 null）** + onChanged。
- `setProviderEnabled(params)` ← case "extensions.setProviderEnabled"（4787-4805）：`native provider cannot be toggled`、`unknown provider: ${p.providerId}` 抛错、enableProvider/disableProvider、settings flush、缓存失效、onChanged。
- `call(params)` ← case "ext.call"（4806-4829）：`ext.call: extensionId required` / `ext.call: method required` / `extension not active: ${p.extensionId}` 抛错、active extension-module 过滤、invokeExtensionRpc（动态 import 按上表修正）。
- `listPlugins()` ← case "plugins.list"（4276-4299）：TTL 缓存 + discoverExtensionPaths + loadExtensions + 返回 shape 原样。
- `pluginPackages()` ← case "plugins.packages"（4300-4332）：TTL 缓存 + getAllPlugins + 返回 shape 原样。
- `setPluginEnabled(params)` ← case "plugins.setEnabled"（4333-4345）：`plugins.setEnabled: name required` 抛错、PluginManager(cwd).setPluginEnabled、**#pluginPackagesCache 与 #pluginsCache 双失效**（服务内私有字段）。

### 公开 `invalidateCaches(): void`

```ts
/** 宿主 watcher（#scheduleExtensionReload）统一失效入口。 */
invalidateCaches(): void {
	this.#extensionsCache = null;
	this.#pluginsCache = null;
}
```

## 二、server.ts 改动（行号基于 HEAD 135a345d9，以标识符为准）

1. **删字段**：`#pluginsCache`（3339-3344）、`#pluginPackagesCache`（3346-3361）、`#extensionsCache`（3417-3420）三段（含各自 doc 注释）。**⚠️ 中间夹的 `#marketplaceCache`（3363-3385）、`#buildMarketplaceManager`（3387-3407）、`#skillsCache`（3409-3415）一个字符都不许动——它们属于第十二刀。**
2. **删方法**：`#getExtensions()`（3565-3583）。
3. **watcher 微调**（#scheduleExtensionReload，3445-3462）：体内 `this.#extensionsCache = null;` 与 `this.#pluginsCache = null;` 两行替换为
   `this.#services.get<ExtensionService>("extensions").invalidateCaches();`
   （`#skillsCache = null`、invalidateExtensionCaches 动态 import、broadcast、#reloadChangedSessionExtensions 调用全部原地保留。）`#startExtensionWatcher`（3425-3443）不动。
4. **宿主侧 `#getExtensions()` 既有调用点 6 处**全部改 `await this.#services.get<ExtensionService>("extensions").getExtensions()`：3598（#validateModeMounting）、3636（#reloadChangedSessionExtensions 内）、4857（setup.status）、4912（collectExtensionModes）、4961 与 5014（mode 解析 knownExtensions）。**这些方法的实现本体不动。**
5. **删 9 个 case**：plugins.list（4276-4299）、plugins.packages（4300-4332）、plugins.setEnabled（4333-4345）、extensions.list（4562-4647）、extensions.raw（4648-4656）、extensions.setEnabled（4657-4757）、extensions.setForceEnabled（4758-4779）、extensions.setProviderEnabled（4787-4805）、ext.call（4806-4829）。各替换为一行委托（组首 case 带 `// 实现归 ExtensionService（扩展/插件控制面语义不变）。` 注释，形状照抄 cron 组）。
6. **构造注册**（ScheduleService 注册块之后）：

```ts
this.#services.register(
	new ExtensionService({
		settings: () => this.#host.settings(),
		ensureRegistry: () => this.#host.ensureRegistry(),
		cwd: () => this.#host.cwd(),
		webUrl: () => this.#webUrl,
		webPortFile: () => path.join(path.dirname(this.#socketPath || DEFAULT_SOCKET), "web.port"),
		onChanged: () => this.#services.get<EventService>("events").broadcastExtensionsChanged(),
	}),
);
```

   （`DEFAULT_SOCKET`、`path` 在 server.ts 已有 import；`#webUrl`/`#socketPath` 字段保留——setup.status 等宿主代码仍用 `#webUrl`。）
7. **import**：新增 `import { ExtensionService } from "./services/extension-service";`（服务 import 区字母序）；server.ts:524 的 `type Extension = import(...)` 别名若删除后 server 内已无 `Extension` 引用（grep 确认）则一并删除，否则保留。顶部其余 import 不动。

## 三、legacy-routes.ts 与 route-coverage.test.ts

- `legacy-routes.ts`：删 9 条——`extensions.list/raw/setEnabled/setForceEnabled/setProviderEnabled`、`ext.call`、`plugins.list/packages/setEnabled`（保持字母序、无空行残留）。
- `route-coverage.test.ts`：import ExtensionService + 注册 stub：
  `services.register(new ExtensionService({ settings: () => undefined, ensureRegistry: async () => {}, cwd: () => "", webUrl: () => null, webPortFile: () => "", onChanged: () => {} }));`
  （注释：`// ExtensionService：stub 化宿主访问，仅参与路由表。`）

## 四、严禁触碰

- `#marketplaceCache`、`#buildMarketplaceManager`、`#skillsCache`、`#getSkills`（第十二刀）。
- `#startExtensionWatcher`、`#scheduleExtensionReload` 除指定两行外的全部；`#reloadChangedSessionExtensions`（P5 HMR v2，会话纠缠）。
- `#validateModeMounting`、`setup.status`、mode 解析段的方法本体（只改 `#getExtensions()` 调用点）。
- `createExtensionManagerTools`（server.ts:1431 附近 provider，会话接线，属最后一刀）。
- channels/collab/crons 各区。任何行为/消息文本改动；不得"顺手优化"。注释块内不得出现 `*/` 提前闭合序列。

## 五、验证（必须亲自跑过并在回复贴结果）

```bash
cd packages/coding-agent
bunx biome check --write src/daemon
bun test src/daemon test/daemon    # 期望 195 pass / 0 fail
bun run check:ts 2>&1 | grep -c "error TS"   # 仓库根目录跑；期望 0
```

回复格式：改动文件清单、`git diff --stat`、验证输出原文、偏差及理由。若 Bun 工具被权限系统拒绝执行，如实说明并停止，不要谎报。
