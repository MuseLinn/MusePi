# P1 第十二刀：MarketplaceService 抽取（marketplace.* ×3 + skills.* ×8，11 路由）

你在 `musepi-omp` 仓库（Bun monorepo）执行一次**纯搬移式**服务抽取。纪律：不改行为、不改消息文本、不改时序语义。先例（必须先读）：

- `packages/coding-agent/src/daemon/services/extension-service.ts`（刚完成的第十一刀，本刀与其有缓存失效/事件广播的 lazy 依赖）
- `packages/coding-agent/src/daemon/services/schedule-service.ts`
- `packages/coding-agent/src/daemon/server.ts` 构造注册区（ExtensionService 注册处）

## ⚠️ 动态 import 路径坑（上一刀真实发生过）

被搬 case 从 `src/daemon/server.ts` 进 `src/daemon/services/` 后：`await import("../X")` → `await import("../../X")`；`await import("./X")` → `await import("../X")`；裸包名不变。本刀涉及的修正表：

| 原路径 | 服务文件内 |
|---|---|
| `../extensibility/plugins/marketplace` | `../../extensibility/plugins/marketplace` |
| `../skills/install` | `../../skills/install` |
| `../skills/marketplace-client` | `../../skills/marketplace-client` |
| `../sdk` | `../../sdk` |
| `./extension-artifact-compiler` | `../extension-artifact-compiler` |

`node:fs/promises` 不变。

## 一、新建 `packages/coding-agent/src/daemon/services/marketplace-service.ts`

`key = "marketplace"`，routes：

```ts
readonly routes = {
	"marketplace.list": "list",
	"marketplace.install": "install",
	"marketplace.remove": "remove",
	"skills.list": "listSkills",
	"skills.delete": "deleteSkill",
	"skills.install": "installSkill",
	"skills.read": "readSkill",
	"skills.marketplace.query": "querySkillMarket",
	"skills.marketplace.categories": "skillCategories",
	"skills.marketplace.featured": "featuredSkills",
	"skills.marketplace.detail": "skillDetail",
} as const;
```

### 类型与 import

- `SkillListItem` 接口（server.ts:511-521，含 `_source` 字段）**整体搬入并 export**（grep 确认 server.ts 其余位置无对该接口名的显式标注——6703 行调用点是推断类型，不 import）。
- `import { getAgentDir } from "@musepi/pi-utils"`（服务自用，skills.install 的 destRoot）。
- `import { MANAGED_SKILLS_PROVIDER_ID } from "../../autolearn/managed-skills"`（skills.delete 守卫）。
- `import { clearPluginRootsAndCaches, resolveOrDefaultProjectRegistryPath }`——来源照抄 server.ts:86-88 的 import 语句（看它是从哪个模块导出的，整组搬；若该语句还导出 server 其他在用的名字，服务只引自己这两个，server 侧删减由第二节处理）。
- `import type { Settings } from "../../config/settings";`、`import type { Extension } from "../../extensibility/extensions-center/types";`、`import * as path from "node:path";`、`import type { DaemonService } from "./types";`

### 依赖注入（全 lazy）

```ts
export interface MarketplaceServiceDeps {
	cwd(): string;
	settings(): Settings | null;
	/** #getSkills 合并扩展虚拟技能用（宿主接 ExtensionService.getExtensions）。 */
	extensionEntries(): Promise<Extension[]>;
	/** skills.delete/install 的扩展缓存失效（宿主接 ExtensionService.invalidateExtensionsCache）。 */
	invalidateExtensionsCache(): void;
	/** extensions.changed 广播（宿主接 EventService）。 */
	onChanged(): void;
}
```

### 拥有的状态（从 DaemonServer 原样搬入，含 doc 注释）

- `#marketplaceCache`（server.ts 约 3349-3370，含上方 4 行 doc 注释，shape 原样）
- `#buildMarketplaceManager()`（约 3372-3392，含 doc 注释；体内 `resolveOrDefaultProjectRegistryPath(this.#host.cwd())` → `this.#deps.cwd()`）
- `#skillsCache`（约 3392-3398，shape 原样，`skills: SkillListItem[]; warnings: string[]`）
- `#getSkills(): Promise<SkillListItem[]>`（3575-3621）→ 公开方法 `getSkills()`：discoverSkills(cwd) 扫描、scanned 映射（5 字段）、collectExtensionSkills 虚拟技能合并（**第一参数改 `this.#deps.extensionEntries()` 的 `.map(e => ({ kind: e.kind, state: e.state, path: e.path }))`**，第二参数 cwd 走 deps）、virtual 映射（`_source` 结构原样）、cache 写入与 TTL 判定逐字。上方 4 行中文注释随迁。
- 公开 `invalidateSkillsCache(): void { this.#skillsCache = null; }`（宿主 watcher 用，照 ExtensionService.invalidateCaches 先例写 doc 注释）。

### 方法（全部从 server.ts 原样搬移）

- `list()` ← case "marketplace.list"（4247-4277）：动态 import `../extensibility/plugins/marketplace`（按坑表修正）、#buildMarketplaceManager、registry/catalogs/installed 合并、TTL、返回 `{ entries }`。注释随迁。
- `install(params)` ← case "marketplace.install"（4278-4291）：`marketplace.install: name required` / `marketplace.install: marketplace required` 抛错、installPlugin、`this.#marketplaceCache = null`、**插件缓存失效改 `this.#deps.invalidateExtensionsCache()` 的姊妹调用**——原语义是清插件双缓存：`this.#deps` 上需要新增一个 `invalidatePluginCaches(): void` dep（宿主接 `ExtensionService.invalidatePluginCaches`），委托单第二节给宿主接线。
- `remove(params)` ← case "marketplace.remove"（4292-4304）：`marketplace.remove: name required` / `marketplace.remove: marketplace required`、buildPluginId 动态 import、uninstallPlugin、双缓存失效同上。
- `listSkills()` ← case "skills.list"（4305-4318）：`this.#getSkills()` → `this.getSkills()`；settings 的 `skills.ignoredSkills` + Bun.Glob match（`ignored` 逐字）；**`warnings: this.#skillsCache!.warnings` 非空断言保留**（pi biome noNonNullAssertion 关闭，合法）。
- `deleteSkill(params)` ← case "skills.delete"（4319-4345）：`unknown skill: ${p.name}`、四重来源守卫抛 `only user-level file skills can be deleted`（MANAGED_SKILLS_PROVIDER_ID 用服务内 import）、node:fs/promises rm、`this.#skillsCache = null`、`this.#deps.invalidateExtensionsCache()`、**广播改 `this.#deps.onChanged()`**。中文注释随迁。
- `installSkill(params)` ← case "skills.install"（4346-4365）：`url is required (https git URL or owner/repo)` 抛错、installSkillFromGit（destRoot `path.join(getAgentDir(), "skills")`）、双缓存失效 + onChanged。注释随迁。
- `readSkill(params)` ← case "skills.read"（4366-4388）：`unknown skill: ${p.name}`、虚拟技能 content 64KB 截断、文件读取 64KB 截断，逐字。
- `querySkillMarket(params)` ← case "skills.marketplace.query"（4389-4412）：querySkillMarket 透传。
- `skillCategories()` ← case "skills.marketplace.categories"（4413-4426）：try/catch 软失败 shape 逐字（`failures: []` / catch 返回空数组+message）。
- `featuredSkills(params)` ← case "skills.marketplace.featured"（4427-4436）：topSkillHub、软失败 shape 逐字。
- `skillDetail(params)` ← case "skills.marketplace.detail"（4437-4443）：`skills.marketplace.detail: slug required`、skillHubDetail 透传。

**deps 接口补一个成员**（接上文 install/remove）：

```ts
	/** marketplace.install/remove 的插件双缓存失效（宿主接 ExtensionService.invalidatePluginCaches）。 */
	invalidatePluginCaches(): void;
```

## 二、server.ts 改动（以标识符为准）

1. **删字段/方法**：`#marketplaceCache`（含 doc 注释）、`#buildMarketplaceManager`（含 doc 注释）、`#skillsCache`（含 doc 注释）、`#getSkills`（含中文注释）。
2. **watcher 微调**（#scheduleExtensionReload，约 3428-3432）：体内 `this.#skillsCache = null;`（带上方两行中文注释）整段替换为
   `this.#services.get<MarketplaceService>("marketplace").invalidateSkillsCache();`（注释随迁或改写为指向服务的简短注释）。
3. **宿主调用点**（commands.list 内，约 6703）：`await this.#getSkills()` 改 `await this.#services.get<MarketplaceService>("marketplace").getSkills()`，循环体不动。
4. **删 11 个 case**（4247-4443 连续区块 + 4366-4388 内的 skills.read）：各替换为一行委托（组首 case 带 `// 实现归 MarketplaceService（marketplace/skills 面语义不变）。`）。注意区块内夹着 `context.list`（4444-4460）**不属于本刀，原地保留**。
5. **构造注册**（ExtensionService 注册块之后）：

```ts
this.#services.register(
	new MarketplaceService({
		cwd: () => this.#host.cwd(),
		settings: () => this.#host.settings(),
		extensionEntries: () => this.#services.get<ExtensionService>("extensions").getExtensions(),
		invalidateExtensionsCache: () => this.#services.get<ExtensionService>("extensions").invalidateExtensionsCache(),
		invalidatePluginCaches: () => this.#services.get<ExtensionService>("extensions").invalidatePluginCaches(),
		onChanged: () => this.#services.get<EventService>("events").broadcastExtensionsChanged(),
	}),
);
```

6. **import 清理**：51 行 `MANAGED_SKILLS_PROVIDER_ID` 删除（确认无其他使用点）；86-88 行的 `clearPluginRootsAndCaches` / `resolveOrDefaultProjectRegistryPath` 从该 import 语句中移除（若语句内其他名字 server 仍在用则只删这两个，否则删整语句）；新增 `import { MarketplaceService } from "./services/marketplace-service";`。`getAgentDir` 保留（server 多处仍在用）。

## 三、legacy-routes.ts 与 route-coverage.test.ts

- `legacy-routes.ts`：删 11 条——`marketplace.list/install/remove`、`skills.delete/install/list/read`、`skills.marketplace.categories/detail/featured/query`（保持字母序、无空行残留）。
- `route-coverage.test.ts`：import MarketplaceService + 注册 stub：
  `services.register(new MarketplaceService({ cwd: () => "", settings: () => null, extensionEntries: async () => [], invalidateExtensionsCache: () => {}, invalidatePluginCaches: () => {}, onChanged: () => {} }));`
  （注释：`// MarketplaceService：stub 化宿主访问，仅参与路由表。`）

## 四、严禁触碰

- `context.list`（4444-4460）；ExtensionService 全部（第十一刀成果）；watcher/HMR 除指定行外全部；cron、channels、collab 各区。
- `SkillListItem` 在 server.ts 的删除以"无其他显式标注使用点"为前提——grep 确认后再删。
- 任何行为/消息文本/时序改动；不得"顺手优化"；注释块内不得出现 `*/` 提前闭合序列。

## 五、验证（必须亲自跑过并在回复贴结果）

```bash
cd packages/coding-agent
bunx biome check --write src/daemon
bun test src/daemon test/daemon    # 期望 195 pass / 0 fail
bun run check:ts 2>&1 | grep -c "error TS"   # 仓库根目录跑；期望 0
```

回复格式：改动文件清单、`git diff --stat`、验证输出原文、偏差及理由。若 Bun 工具被权限系统拒绝执行，如实说明并停止，不要谎报。
