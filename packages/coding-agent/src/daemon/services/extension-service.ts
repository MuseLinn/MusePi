import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXTENSION_SLOT_DECLARATION, EXTENSION_SLOT_NAMES } from "@musepi/collab-proto/extension-slots";
import { logger } from "@musepi/pi-utils";
import type { ConfigFieldDesc, PluginCompatibility, PluginComponentDecl, PluginComponentDesc } from "@musepi/pi-wire";
import { coerceConfigFieldValue, coerceConfigValues } from "@musepi/pi-wire";
import { invalidateCapabilityCache } from "../../capability";
import { isModuleEntryKind, LEGACY_EXTENSION_MODULE_KIND, PLUGIN_MODULE_KIND } from "../../capability/extension-module";
import { pluginNameOfEntryId, setPluginEnabledIn } from "../../capability/plugin-identity";
import type { Settings } from "../../config/settings";
import type { LoadExtensionsResult, Extension as RuntimeExtension } from "../../extensibility/extensions/types";
import type { Extension } from "../../extensibility/extensions-center/types";
import {
	readCompatibilityExemptions,
	resolveCompatibilityPath,
	setVersionExemption,
} from "../../extensibility/plugins/compat/compatibility-store";
import type { PluginManagementPackage } from "../../extensibility/plugins/profile/plugin-management";
import type { PluginRuntimeTarget } from "../../extensibility/plugins/runtime/mount";
import type { ResolvedMode } from "../../presets/resolve";
import type { CordisDynamicPluginRuntime } from "../cordis-dynamic-plugins";
import type { LiveApplyTarget } from "../live-plugin-apply";
import type { WebRouteRegistry } from "../web-routes";
import type { DaemonService } from "./types";

/**
 * ExtensionService — 扩展/插件控制面（L2 宿主服务，P1 第十一刀抽取）。
 *
 * 轨道归属:**两轨共用**。这是两条轨道的管理面与 RPC 入口,不偏属其一:
 * `getExtensionRuntimeLoad` 走 cordis 宿主级装载(Track A),`listPlugins` /
 * `collectExtensionModes` 等读的是会话装配那份清单(Track B),`ext.call` 分发
 * 到实际持有该 RPC 的实例。**文件名的 `extension-` 是历史命名**(服务抽取时
 * cordis 插件系统尚未落地),不代表只服务 legacy 一侧。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `extensions.list` / `extensions.raw` / `extensions.setEnabled` /
 *   `extensions.setForceEnabled` / `extensions.setProviderEnabled`（统一扩展
 *   扫描、inspector 原文、条目/桌面外壳/供应商启停，写 settings 与 mcp.json
 *   denylist）、`extensions.setConfig`（插件清单声明式配置写入：按字段声明
 *   钳制后落盘 plugin-config-store 并扇出 extensions.changed）、`ext.call`
 *   （扩展 registerRpc 的 daemon 侧回调，仅限 active
 *   extension-module）、`plugins.list` / `plugins.packages` /
 *   `plugins.setEnabled`（插件扫描/已装清单/启停）。
 * - 输出：各 RPC 返回值原样；extensions.raw 超 16KB 截断；extensions.list
 *   聚合 tabs/providers/槽位组件/toolViews/状态栏段、shell 配置与「会话
 *   插件」面（显式扩展白名单的预设清单 + 每个 extension-module 的
 *   enabledInPresets）+ builtin 单元的 cordis 运行状态（runtime：fiberState/
 *   effects/operational,宿主注入 builtinRuntime）与声明式启用条件（activation）；
 *   三个 10s TTL 缓存（#extensionsCache/#pluginsCache/#pluginPackagesCache）随变更
 *   RPC 与宿主 watcher 失效；extensions.changed 广播经注入的 onChanged 扇出
 *   （宿主侧接 EventService，lazy 调用无循环）。另有宿主级扩展运行时加载
 *   缓存（#runtimeLoadCache，10s TTL，随运行时组合变更独立失效）——
 *   getExtensionRuntimeLoad 按会话同源 discovery 分支执行扩展入口代码，
 *   供 session-less RPC（design.systems.list 的宿主重放，M3 §3.7d）消费
 *   pending 注册，不经会话引导。
 * - 生命周期：无 start/stop——缓存惰性构建；宿主扩展 watcher 经
 *   invalidateCaches（及两个粒度更细的失效入口）统一失效，加载/卸载可逆。
 *
 * 范围边界（有意不包，P1 纪律）：
 * - 扩展 watcher（#startExtensionWatcher/#scheduleExtensionReload）、会话内
 *   HMR（#reloadChangedSessionExtensions）、marketplace 与 skills 两组 RPC
 *   原地留宿主（第十二刀）；`createExtensionManagerTools` 会话接线不属本
 *   服务（最后一刀）。
 * - 槽位契约单一权威仍是 collab-proto 的 EXTENSION_SLOT_DECLARATION（本服务
 *   只读透传，不再自行声明）。
 *
 * 从 server.ts 巨型 switch 的九个 case 与 #getExtensions 原样搬移（P1 纪律：
 * 纯搬移不改行为，docs/review/0.5.0-m2-daemon-host-layering.md §5）。
 */

export interface ExtensionServiceDeps {
	settings(): Settings | null;
	ensureRegistry(): Promise<unknown>;
	cwd(): string;
	webUrl(): string | null;
	/**
	 * The daemon's loopback web route table, when the web server is up.
	 * Extension-contributed HTTP routes are (re)mounted here.
	 */
	webRoutes?(): WebRouteRegistry | undefined;
	/** web.port 发现文件的绝对路径（宿主计算：socket 目录下）。 */
	webPortFile(): string;
	/** 预设目录（宿主注入 #modesDir；缺省回退 $env/用户目录——测试可隔离）。 */
	modesDir?(): string;
	/** 宿主级 user 插件 cordis 运行时（收编第二刀：DaemonServer 惰性装配
	 *  CordisDynamicPluginRuntime；缺省走直接 loadExtensions——会话装载
	 *  语义不变的 fail-soft 回退）。 */
	dynamicRuntime?(): Promise<CordisDynamicPluginRuntime | undefined>;
	/** Active profile rows to mount alongside ordinary discovered extensions. */
	runtimeTargets?(): Promise<readonly PluginRuntimeTarget[]>;
	/** extensions.changed 广播（宿主接 EventService，lazy 调用无循环）。 */
	onChanged(): void;
	/**
	 * Apply an entry-level plugin change to sessions that are already open
	 * (package enable/disable). Absent → the change lands with the next session.
	 */
	applyLive?(target: LiveApplyTarget): Promise<{ errors: string[] }>;
	/**
	 * A namespace's declared config fields, when the caller can supply them
	 * without a full extension scan (tests, or a host that already has the
	 * manifest). Absent → the fields come from the scanned extension list.
	 */
	configFields?(namespace: string): Promise<ConfigFieldDesc[]> | ConfigFieldDesc[];
	/**
	 * Overrides the plugin-config store path (tests inject a temp file).
	 * Absent → the host's own `<agentDir>/extensions/plugin-config.json`,
	 * which is where a form's values belong.
	 */
	pluginConfigStorePath?(): string;
}

export class ExtensionService implements DaemonService {
	/** Disposers for the web routes we mounted; a reconcile drops them first. */
	#mountedWebRoutes: Array<() => void> = [];
	readonly key = "extensions";
	readonly routes = {
		"extensions.list": "list",
		"extensions.raw": "raw",
		"extensions.setEnabled": "setEnabled",
		"extensions.setForceEnabled": "setForceEnabled",
		"extensions.setProviderEnabled": "setProviderEnabled",
		"extensions.setConfig": "setConfig",
		"extensions.setComponentEnabled": "setComponentEnabled",
		"extensions.setVersionExemption": "setVersionExemption",
		"ext.call": "call",
		"plugins.list": "listPlugins",
		"plugins.packages": "pluginPackages",
		"plugins.setEnabled": "setPluginEnabled",
		"pluginConfig.form": "configForm",
		"pluginConfig.mutate": "configFormMutate",
	} as const;

	readonly #deps: ExtensionServiceDeps;

	/** TTL cache of the extension/plugin scan (settings → plugins tab). */
	#pluginsCache: {
		at: number;
		plugins: { path: string; label: string | null; tools: number; commands: number; handlers: number }[];
		errors: { path: string; error: string }[];
	} | null = null;

	/** TTL cache of the full installed-plugin inventory (settings → plugins
	 *  tab, enabled + disabled). */
	#pluginPackagesCache: {
		at: number;
		plugins: PluginManagementPackage[];
	} | null = null;

	/** TTL cache of the unified extension scan (extensions.list — the
	 *  Extension Control Center's 10 capability kinds, TUI parity).
	 *  Invalidated by the mutation RPCs below. */
	#extensionsCache: { at: number; extensions: Extension[] } | null = null;

	/** TTL cache of the host-level extension runtime load (session-less
	 *  RPCs like design.systems.list consume queued registrations —
	 *  pendingDesignSystemRegistrations — without a session boot; M3 §3.7d).
	 *  Cleared everywhere #extensionsCache is. */
	#runtimeLoadCache: { at: number; result: LoadExtensionsResult } | null = null;

	constructor(deps: ExtensionServiceDeps) {
		this.#deps = deps;
	}

	/** Resolve a bundled package by its canonical package name. */
	async #hostDeclaration(id: string): Promise<
		| {
				name: string;
				host?: Extension["host"];
				config: ConfigFieldDesc[];
				components: PluginComponentDecl[];
		  }
		| undefined
	> {
		const [{ discoverBundledPluginPaths }, { readExtensionPluginMeta }, { getExtensionNameFromPath }] =
			await Promise.all([
				import("../../discovery/builtin"),
				import("../../extensibility/extensions/plugin-manifest"),
				import("../../discovery/helpers"),
			]);
		for (const entryPath of await discoverBundledPluginPaths({ scope: "all" })) {
			const name = getExtensionNameFromPath(entryPath);
			if (name !== id) continue;
			const meta = await readExtensionPluginMeta(entryPath);
			if (!meta) return undefined;
			return { name, host: meta.host, config: meta.fields, components: meta.components ?? [] };
		}
		return undefined;
	}

	async getExtensions(): Promise<Extension[]> {
		if (!this.#extensionsCache || Date.now() - this.#extensionsCache.at > 10_000) {
			const { loadAllExtensions } = await import("../../extensibility/extensions-center/state-manager");
			let settings = this.#deps.settings();
			if (!settings) {
				await this.#deps.ensureRegistry();
				settings = this.#deps.settings();
			}
			const disabledIds = (settings?.get("disabledExtensions") ?? []) as string[];
			// omp 生态智能兼容:显式启用集(默认空的隐藏设置键)优先于优先级去重。
			// getRaw:forceEnabledExtensions 不在 schema(隐藏设置键),走原始读取。
			const forceIds = (settings?.getRaw("forceEnabledExtensions") ?? []) as string[];
			this.#extensionsCache = {
				at: Date.now(),
				extensions: await loadAllExtensions(this.#deps.cwd(), disabledIds, forceIds),
			};
			// Routes follow the list: a reload/install/uninstall moves them with it.
		}
		return this.#extensionsCache.extensions;
	}

	/**
	 * Mount every loaded extension's HTTP routes on the daemon's web server.
	 *
	 * Runs after the extension list is (re)built, so an install/uninstall/reload
	 * moves the routes with it. The routes are the extension's OWN namespace
	 * (`/api/<ns>/…` — the loader scoped them at registration), which is why
	 * this cannot collide with the renderer's static paths.
	 *
	 * ⚠️ **A path already claimed by another extension is reported, not
	 * overridden.** The route table would happily let the last registration win,
	 * and then the earlier plugin's panel would be served by a stranger's
	 * handler with nothing in any log. Skipping + warning keeps both the truth
	 * and the earlier plugin's data plane intact.
	 */
	#reconcileWebRoutes(extensions: readonly RuntimeExtension[]): void {
		const table = this.#deps.webRoutes?.();
		if (!table) return;
		const mounted = this.#mountedWebRoutes;
		this.#mountedWebRoutes = [];
		for (const dispose of mounted) dispose();
		// Ownership by absolute path: the namespace is already baked in, so two
		// extensions claiming one path is the collision to catch.
		const ownerOf = new Map<string, string>();
		for (const extension of extensions) {
			for (const route of extension.webRoutes) {
				const existing = ownerOf.get(route.path);
				if (existing !== undefined) {
					logger.warn(
						`extension web route "${route.path}" already served by ${existing}; skipping ${extension.path}`,
					);
					continue;
				}
				ownerOf.set(route.path, extension.path);
				try {
					this.#mountedWebRoutes.push(table.register(route));
				} catch (error) {
					logger.warn(`failed to mount web route "${route.path}": ${String(error)}`);
				}
			}
		}
	}

	/**
	 * 宿主级扩展运行时加载：按会话同源的 discovery 分支（configured 路径 +
	 * disabledExtensions 过滤 + ambient）执行扩展入口代码，返回
	 * LoadExtensionsResult（含 runtime.pendingDesignSystemRegistrations 等
	 * 排队注册）。供 session-less RPC（design.systems.list 的宿主重放，
	 * M3 §3.7d）消费——装包/卸包后经 invalidateExtensionsCache 失效重载。
	 * 10s TTL，并在清单或运行时组合变化时失效。
	 * 收编第二刀：宿主注入 dynamicRuntime 时经 cordis fiber 装载（每插件一
	 * fiber，登记 = 效果账本，卸载反向回收）；未注入（测试）回退 loadExtensions。
	 */
	async getExtensionRuntimeLoad(): Promise<LoadExtensionsResult> {
		if (!this.#runtimeLoadCache || Date.now() - this.#runtimeLoadCache.at > 10_000) {
			const { discoverExtensionPaths } = await import("../../extensibility/extensions");
			let settings = this.#deps.settings();
			if (!settings) {
				await this.#deps.ensureRegistry();
				settings = this.#deps.settings();
			}
			const configured = (settings?.get("extensions") ?? []) as string[];
			const disabledIds = (settings?.get("disabledExtensions") ?? []) as string[];
			const cwd = this.#deps.cwd();
			const paths = await discoverExtensionPaths(configured, cwd, disabledIds, { ambient: true });
			// 收编第二刀：宿主级装载切 cordis fiber（生命周期/效果账本/检视），
			// 与 loadExtensions 同结果形状；宿主未注入运行时（测试）回退直接装载。
			const dynamic = await this.#deps.dynamicRuntime?.();
			const runtimeTargets = dynamic ? ((await this.#deps.runtimeTargets?.()) ?? []) : [];
			// A composed row replaces the same entry's package-level discovery mount.
			// Otherwise every row would coexist with an extra unconfigured instance.
			const composedEntries = new Set(runtimeTargets.map(target => path.resolve(target.path)));
			const discoveredPaths = paths.filter(entry => !composedEntries.has(path.resolve(entry)));
			// 清单组件禁用面：disabledExtensionComponents 复合键
			// `<plugin>/<component>` 黑名单,reconcile 装载时跳过命中组件。
			const disabledComponents = new Set((settings?.get("disabledExtensionComponents") ?? []) as string[]);
			this.#runtimeLoadCache = {
				at: Date.now(),
				result: dynamic
					? await dynamic.loadAll([...discoveredPaths, ...runtimeTargets], cwd, disabledComponents)
					: await (await import("../../extensibility/extensions/loader")).loadExtensions(paths, cwd),
			};
			// Routes belong to the RUNTIME load, not to the list rows: `webRoutes`
			// lives on the Extension the loader executed (the same object that
			// holds `rpcs`), while `getExtensions()` returns the center's
			// inventory rows — a different shape with no routes on it.
			this.#reconcileWebRoutes(this.#runtimeLoadCache.result.extensions);
		}
		return this.#runtimeLoadCache.result;
	}

	/** RPC extensions.list：扩展控制中心统一数据源（TUI /extensions parity）。 */
	async list() {
		// 扩展控制中心统一数据源 (TUI /extensions parity): all 10
		// capability kinds normalized to one Extension shape with
		// three states (active/disabled/shadowed). raw is heavy and
		// served lazily via extensions.raw for the inspector.
		const extensions = await this.getExtensions();
		let s = this.#deps.settings();
		if (!s) {
			// Shell mode/enabled live in settings; bootstrap the shared
			// instance so the desktop-shell entry reports them even
			// before any session exists (fresh daemon + compat page).
			await this.#deps.ensureRegistry();
			s = this.#deps.settings();
		}
		// Desktop-shell config: the compat page /
		// GUI shell read enabled + mode + served origin from the
		// registry response (raw is stripped by the response mapping).
		const shellEnabled = s?.getRaw("shell.enabled");
		const shellMode = s?.getRaw("shell.mode");
		const shellCfg = {
			enabled: shellEnabled !== false,
			mode: shellMode === "extended" || shellMode === "enhanced" ? shellMode : "compatibility",
			webUrl: this.#deps.webUrl(),
		};
		// Settings-backed fields are configuration only. Package state comes from
		// disabledExtensions and component state from disabledExtensionComponents.
		for (const ext of extensions) {
			if (ext.host?.configStorage === "settings" && ext.config?.length && s) {
				const stored: Record<string, unknown> = {};
				for (const field of ext.config) stored[field.key] = s.getRaw(field.key);
				ext.configValues = coerceConfigValues([...ext.config], stored);
			}
		}
		// user 插件清单组件面（清单声明的组件）：manifest
		// `musepi.components` 声明的组件下发——entry 组件带宿主 fiber 运行时
		// 的真实数据（fiber 状态机/效果账本）,启用态读隐藏键
		// extensions.disabledComponents → disabledExtensionComponents 复合键
		// `<plugin>/<component>` 黑名单（无点号键,见 settings-schema 注释）;
		// fail-soft：运行时不可用（回退直接装载路径）时按启用渲染、无 runtime 行。
		const componentDenylist = new Set((s?.get("disabledExtensionComponents") ?? []) as string[]);
		// 宿主 fiber 检视面：组件运行态之外,本轮起同时带出版本与兼容性判定
		// （回退保护②）——豁免键 `name@version` 的输入与 GUI 归因渲染的数据源。
		let inspectedByName:
			| Map<
					string,
					{
						version?: string;
						compatibility?: PluginCompatibility;
						fiberState?: string;
						effectLabels: string[];
						components: Map<string, { fiberState?: string; effectLabels: string[] }>;
					}
			  >
			| undefined;
		try {
			const dynamic = await this.#deps.dynamicRuntime?.();
			inspectedByName = new Map(
				(dynamic?.inspect() ?? []).map(i => [
					i.name,
					{
						...(i.version ? { version: i.version } : {}),
						...(i.compatibility ? { compatibility: i.compatibility } : {}),
						fiberState: i.fiberState,
						effectLabels: i.effectLabels,
						components: new Map(
							i.components.map(c => [c.id, { fiberState: c.fiberState, effectLabels: c.effectLabels }]),
						),
					},
				]),
			);
		} catch {
			inspectedByName = undefined;
		}
		const { readExtensionPluginMeta } = await import("../../extensibility/extensions/plugin-manifest");
		for (const ext of extensions) {
			if (ext.kind !== LEGACY_EXTENSION_MODULE_KIND && ext.kind !== PLUGIN_MODULE_KIND) continue;
			let meta: Awaited<ReturnType<typeof readExtensionPluginMeta>>;
			try {
				meta = await readExtensionPluginMeta(ext.path);
			} catch {
				continue;
			}
			if (!meta?.components || meta.components.length === 0) continue;
			const runtimeComponents = inspectedByName?.get(ext.name)?.components;
			ext.components = meta.components.map(decl => {
				const denied = Boolean(decl.entry) && componentDenylist.has(`${ext.name}/${decl.id}`);
				const rt = runtimeComponents?.get(decl.id);
				return {
					id: decl.id,
					name: decl.id,
					description: decl.description,
					enabled: !denied,
					canToggle: Boolean(decl.entry),
					...(denied ? { disabledReason: "component-disabled" as const } : {}),
					...(rt?.fiberState ? { runtime: { fiberState: rt.fiberState, effects: rt.effectLabels.length } } : {}),
				} satisfies PluginComponentDesc;
			});
		}
		// 兼容面 + 版本透出（回退保护②）：宿主 fiber 检视面有的 extension-module
		// 条目如实带出版本与判定——incompatible 是结构化拒绝的证据面（GUI 归因
		// 段 + 豁免入口）,exempted 如实标注;无检视（运行时不可用）则不挂。
		// 在役记录的 exempted 标注须对照**当前**豁免清单复核：撤销只影响下次
		// 装配（不热卸载在役 fiber），但管理面必须讲当下真话——
		// 豁免已撤而记录仍标 exempted,GUI 会永远显示过期标注。缺票降级为
		// incompatible（unmetPeers 原样保留,作证据面）。fail-safe：坏文件 =
		// 零豁免,exempted 全部降级,不阻塞清单。
		const liveExemptions = readCompatibilityExemptions(resolveCompatibilityPath()).exemptions;
		for (const ext of extensions) {
			if (ext.kind !== LEGACY_EXTENSION_MODULE_KIND && ext.kind !== PLUGIN_MODULE_KIND) continue;
			const inspected = inspectedByName?.get(ext.name);
			if (!inspected) continue;
			if (inspected.version) ext.version = inspected.version;
			if (inspected.fiberState) {
				ext.runtime = {
					fiberState: inspected.fiberState,
					effects: inspected.effectLabels.length,
					operational: ext.state === "active" ? "running" : "stopped",
				};
			}
			if (!inspected.compatibility) continue;
			const gate = inspected.compatibility;
			if (
				gate.status === "exempted" &&
				liveExemptions[`${gate.plugin.name}@${gate.plugin.version}`]?.includes(gate.runtimeVersion) !== true
			) {
				ext.compatibility = { ...gate, status: "incompatible", code: "incompatible-peer" };
				continue;
			}
			ext.compatibility = gate;
		}
		// 「会话插件」面（预设启用轴）：Agent 预设声明的东西 → 每个扩展的
		// 「启用于」预设列表 + 顶部预设清单（GUI 切换器/分组）。
		//
		// A preset declares plugins two ways and BOTH feed this: the legacy
		// `extensions` whitelist and the `plugins` composition. Only the whitelist
		// used to be read, so a preset that composed a plugin showed nothing under
		// "enabled in" — the tag existed in the UI and had no data behind the half
		// of the feature that was newer. 三态白名单里 undefined = 全部启用，不构成
		// 「按预设提供」语义（只有显式声明的预设才算提供者）。fail-soft：预设面是
		// 增益信息，任何一步失败都不阻塞清单主数据。
		const presets: { id: string; label: string }[] = [];
		const enabledInByName = new Map<string, string[]>();
		try {
			const { listModeIds, loadModeFile, resolveMode, ensureModeTemplates } = await import("../../presets/resolve");
			const { t } = await import("../../i18n/index.js");
			const { $env } = await import("@musepi/pi-utils");
			const { getExtensionNameFromPath } = await import("../../discovery/helpers");
			// A composition row names a PACKAGE, while the "enabled in" map is keyed
			// by the extension name derived from an entry path. Resolving the package
			// to its extension entries is what lets the two spellings meet.
			const { getEnabledPlugins, resolvePluginExtensionPaths } = await import(
				"../../extensibility/plugins/runtime/loader"
			);
			const installedPlugins = await getEnabledPlugins(this.#deps.cwd()).catch(() => []);
			const extensionNamesOfPackage = (packageName: string): string[] => {
				const plugin = installedPlugins.find(p => p.name === packageName);
				if (!plugin) return [];
				return resolvePluginExtensionPaths(plugin).map(entry => getExtensionNameFromPath(entry));
			};
			const dir = this.#deps.modesDir?.() ?? $env.MUSEPI_MODES_DIR ?? path.join(os.homedir(), ".musepi", "modes");
			ensureModeTemplates(dir);
			const definitions = new Map(listModeIds(dir).map(id => [id, loadModeFile(dir, id)]));
			const { collectProfilePresetDefinitions } = await import(
				"../../extensibility/plugins/profile/profile-presets"
			);
			for (const def of await collectProfilePresetDefinitions(this.#deps.cwd(), os.homedir())) {
				if (!definitions.has(def.id)) definitions.set(def.id, def);
			}
			for (const id of definitions.keys()) {
				let resolved: ResolvedMode | undefined;
				try {
					resolved = resolveMode(id, mid => definitions.get(mid) ?? loadModeFile(dir, mid));
				} catch {
					continue; // 环/悬空预设不参与启用面，与 modes.list 容错同口径
				}
				// A preset that declares neither an extension whitelist nor a plugin
				// composition contributes nothing to this axis.
				if (!resolved.extensionsExplicit && resolved.plugins.length === 0) continue;
				const builtinName = t(`preset ${id} name` as never);
				const label = !builtinName.startsWith("preset ") ? builtinName : (resolved.label ?? id);
				presets.push({ id, label });
				const contributed = [
					...(resolved.extensions ?? []),
					// Only enabled rows compose; a disabled row is how a child preset
					// switches one of its parent's plugins off.
					...resolved.plugins
						.filter(row => row.enabled !== false)
						.flatMap(row => extensionNamesOfPackage(row.name)),
				];
				for (const extName of contributed) {
					const list = enabledInByName.get(extName);
					if (list) {
						if (!list.includes(label)) list.push(label);
					} else enabledInByName.set(extName, [label]);
				}
			}
			for (const ext of extensions) {
				if (ext.kind !== LEGACY_EXTENSION_MODULE_KIND && ext.kind !== PLUGIN_MODULE_KIND) continue;
				const labels = enabledInByName.get(getExtensionNameFromPath(ext.path));
				if (labels && labels.length > 0) ext.enabledInPresets = labels;
			}
		} catch {
			// 预设面不可用 → 清单照常，只是没有「启用于」行。
		}
		const { buildProviderTabs } = await import("../../extensibility/extensions-center/state-manager");
		const tabs = buildProviderTabs(extensions);
		const { getAllProvidersInfo } = await import("../../capability");
		const providers = getAllProvidersInfo().map(p => ({
			id: p.id,
			displayName: p.displayName,
			enabled: p.enabled,
		}));
		// Renderer-side slot components (ui-slots analogue): compiled
		// from active extension-module entries, cached 10s with the
		// extension scan. The GUI mounts them by slot id.
		const { collectSlotComponents, collectToolViews, collectStatusBarSegments, collectWidgetViews } = await import(
			"../extension-artifact-compiler"
		);
		const components = await collectSlotComponents(
			extensions.map(e => ({ kind: e.kind, state: e.state, path: e.path })),
			this.#deps.cwd(),
		);
		// Renderer-side per-tool views (registerToolView): the
		// transcript dispatches by tool name, replacing the built-in renderer.
		const toolViews = await collectToolViews(
			extensions.map(e => ({ kind: e.kind, state: e.state, path: e.path })),
			this.#deps.cwd(),
		);
		// Widget types (registerWidget): daemon metadata + compiled renderer
		// module. The GUI registers them into the widget registry; the board
		// picker and inline renderer read the same entries.
		const widgets = await collectWidgetViews(
			extensions.map(e => ({ kind: e.kind, state: e.state, path: e.path })),
			this.#deps.cwd(),
		);
		// Status-bar segments (registerStatusBarSegment): the GUI status bar
		// merges these after its built-ins, ordered by `order`.
		const statusBarSegments = await collectStatusBarSegments(
			extensions.map(e => ({ kind: e.kind, state: e.state, path: e.path })),
			this.#deps.cwd(),
		);
		return {
			extensions: extensions.map(({ raw: _raw, ...rest }) => rest),
			tabs,
			providers,
			components,
			toolViews,
			widgets,
			statusBarSegments,
			// Desktop-shell config: enabled/mode/
			// webUrl read by the compat page + GUI shell.
			shell: shellCfg,
			// 「会话插件」面：显式扩展白名单的预设清单（GUI 切换器）。
			presets,
			// 槽位契约单一权威(collab-proto):GUI 据此诊断未挂载槽位。
			slots: {
				exact: [...EXTENSION_SLOT_NAMES],
				prefixes: [...EXTENSION_SLOT_DECLARATION.prefixes],
			},
		};
	}

	/** RPC extensions.raw：inspector 面板的条目原文（JSON，超 16KB 截断）。 */
	async raw(params: unknown) {
		// Raw capability item for the inspector panel (JSON, capped).
		const p = (params ?? {}) as { id: string };
		const extensions = await this.getExtensions();
		const ext = extensions.find(e => e.id === p.id);
		if (!ext) throw new Error(`unknown extension: ${p.id}`);
		const text = JSON.stringify(ext.raw, null, 2);
		return { raw: text.length > 16 * 1024 ? `${text.slice(0, 16 * 1024)}\n… (truncated)` : text };
	}

	/** Enable or disable an extension using its canonical inventory identity. */
	async setEnabled(params: unknown) {
		const p = (params ?? {}) as { id: string; enabled: boolean; mode?: string };
		let settings = this.#deps.settings();
		if (!settings) {
			await this.#deps.ensureRegistry();
			settings = this.#deps.settings();
		}
		if (!settings) throw new Error("settings unavailable");
		const hostExtension = await this.#hostDeclaration(p.id);
		if (hostExtension?.host?.readonly) {
			throw new Error(`extensions.setEnabled: ${p.id} is read-only and has no enablement control`);
		}
		if (hostExtension?.name === "desktop-shell") {
			if (typeof p.mode === "string") {
				const mode: string = p.mode;
				if (mode !== "compatibility" && mode !== "extended" && mode !== "enhanced") {
					throw new Error(`invalid shell mode: ${mode}`);
				}
				settings.set("shell.mode" as Parameters<Settings["set"]>[0], mode as never);
			}
			settings.set("shell.enabled" as Parameters<Settings["set"]>[0], p.enabled as never);
			const webPortFile = this.#deps.webPortFile();
			const webUrl = this.#deps.webUrl();
			if (p.enabled && webUrl) {
				const port = new URL(webUrl).port;
				if (port) {
					try {
						await fs.promises.writeFile(webPortFile, port, "utf8");
					} catch {
						// The RPC state remains authoritative if discovery-file writing fails.
					}
				}
			} else {
				try {
					await fs.promises.unlink(webPortFile);
				} catch {
					// The discovery file is already absent.
				}
			}
		}
		if (p.id.startsWith("mcp:")) {
			const { setMcpServerEnabled } = await import("../../mcp/config-writer");
			const { getMCPConfigPath } = await import("@musepi/pi-utils");
			await setMcpServerEnabled({
				userPath: getMCPConfigPath("user", this.#deps.cwd()),
				projectPath: getMCPConfigPath("project", this.#deps.cwd()),
				sourcePath: undefined,
				name: p.id.slice("mcp:".length),
				enabled: p.enabled,
			});
			const stored = [...((settings.get("disabledExtensions") ?? []) as string[])];
			const had = stored.indexOf(p.id);
			if (p.enabled && had !== -1) {
				stored.splice(had, 1);
				settings.set("disabledExtensions", stored);
				await settings.flush();
			}
		} else {
			const entry = hostExtension
				? undefined
				: (await this.getExtensions()).find(extension => extension.id === p.id);
			if (!hostExtension && !entry) throw new Error(`unknown extension: ${p.id}`);
			const pluginName = hostExtension?.name ?? pluginNameOfEntryId(p.id);
			if (pluginName !== undefined) {
				const stored = (settings.get("disabledExtensions") ?? []) as string[];
				settings.set("disabledExtensions", setPluginEnabledIn(stored, pluginName, p.enabled));
				await settings.flush();
				if (hostExtension || entry?.kind === PLUGIN_MODULE_KIND) {
					const runtime = await this.#deps.dynamicRuntime?.();
					if (runtime) {
						if (p.enabled) await runtime.reloadPlugin(pluginName);
						else await runtime.unloadPlugin(pluginName);
					}
				}
			} else {
				const disabled = [...((settings.get("disabledExtensions") ?? []) as string[])];
				const i = disabled.indexOf(p.id);
				if (p.enabled && i >= 0) disabled.splice(i, 1);
				if (!p.enabled && i < 0) disabled.push(p.id);
				settings.set("disabledExtensions", disabled);
				await settings.flush();
			}
			// One extension-module entry toggled: hand exactly that entry to open
			// sessions. Non-module rows (skill/tool/mcp/theme) are not extension
			// entries a session can mount, so they keep their next-session
			// semantics rather than failing a load that was never valid.
			if (entry && isModuleEntryKind(entry.kind)) {
				await this.#deps.applyLive?.(p.enabled ? { add: [entry.path] } : { remove: [entry.path] });
			}
		}
		this.#extensionsCache = null;
		this.#runtimeLoadCache = null;
		this.#deps.onChanged();
		return { ok: true };
	}

	/** Enable or disable one declared Cordis entry component. */
	async setComponentEnabled(params: unknown) {
		const p = (params ?? {}) as { id?: unknown; component?: unknown; enabled?: unknown };
		if (typeof p.id !== "string" || typeof p.component !== "string" || typeof p.enabled !== "boolean") {
			throw new Error("extensions.setComponentEnabled: id, component and enabled are required");
		}
		let settings = this.#deps.settings();
		if (!settings) {
			await this.#deps.ensureRegistry();
			settings = this.#deps.settings();
		}
		if (!settings) throw new Error("extensions.setComponentEnabled: settings unavailable");
		const hostExtension = await this.#hostDeclaration(p.id);
		const entry = hostExtension ? undefined : (await this.getExtensions()).find(extension => extension.id === p.id);
		const pluginName = hostExtension?.name ?? pluginNameOfEntryId(p.id);
		const declared = hostExtension
			? hostExtension.components.some(component => component.id === p.component && Boolean(component.entry))
			: entry !== undefined &&
				isModuleEntryKind(entry.kind) &&
				entry.components?.some(component => component.id === p.component && component.canToggle) === true;
		if (pluginName === undefined || !declared) {
			throw new Error(`extensions.setComponentEnabled: "${p.component}" is not a declared component of ${p.id}`);
		}
		const runtime = await this.#deps.dynamicRuntime?.();
		if (!runtime) throw new Error("extensions.setComponentEnabled: cordis dynamic runtime unavailable");
		await this.getExtensionRuntimeLoad();
		await runtime.setComponentEnabled(pluginName, p.component, p.enabled);
		const denylist = [...((settings.get("disabledExtensionComponents") ?? []) as string[])];
		const key = `${pluginName}/${p.component}`;
		const i = denylist.indexOf(key);
		if (p.enabled && i >= 0) denylist.splice(i, 1);
		if (!p.enabled && i < 0) denylist.push(key);
		settings.set("disabledExtensionComponents", denylist);
		await settings.flush();
		// Component state is applied from settings on every list call. The package
		// inventory is unchanged; only the runtime composition needs rebuilding.
		this.#runtimeLoadCache = null;
		this.#deps.onChanged();
		return { ok: true, denied: denylist };
	}

	/** RPC extensions.setVersionExemption：授予/撤销兼容性精确版本豁免
	 *  （回退保护②的「知情接受」入口）。
	 *  只能批当前运行时版本;落盘 agentDir/compatibility.json（原子写）后失效清单缓存并扇出
	 *  extensions.changed——GUI 重拉即见 exempted 标注,下次装配即放行。 */
	async setVersionExemption(params: unknown) {
		const p = (params ?? {}) as {
			package?: unknown;
			runtimeVersion?: unknown;
			enabled?: unknown;
			acceptRisk?: unknown;
		};
		if (
			typeof p.package !== "string" ||
			typeof p.runtimeVersion !== "string" ||
			typeof p.enabled !== "boolean" ||
			typeof p.acceptRisk !== "boolean"
		) {
			throw new Error(
				"extensions.setVersionExemption: package, runtimeVersion, enabled and acceptRisk are required",
			);
		}
		await setVersionExemption(resolveCompatibilityPath(), p.package, p.runtimeVersion, p.enabled, p.acceptRisk);
		this.#extensionsCache = null;
		this.#runtimeLoadCache = null;
		this.#deps.onChanged();
		return { ok: true as const };
	}

	/** RPC extensions.setForceEnabled：显式启用同名冲突项（forceEnabledExtensions）。 */
	async setForceEnabled(params: unknown) {
		// omp 生态智能兼容:显式启用同名冲突项(默认被高优先级 shadow)。
		// 与 disabledExtensions 正交 —— 写入 forceEnabledExtensions;
		// 感知层(agent/用户)分析 shadowedBy 详情后决定启用。
		const p = (params ?? {}) as { id: string; enabled: boolean };
		let settings = this.#deps.settings();
		if (!settings) {
			await this.#deps.ensureRegistry();
			settings = this.#deps.settings();
		}
		if (!settings) throw new Error("settings unavailable");
		const force = [...((settings.getRaw("forceEnabledExtensions") ?? []) as string[])];
		const i = force.indexOf(p.id);
		if (p.enabled && i < 0) force.push(p.id);
		if (!p.enabled && i >= 0) force.splice(i, 1);
		settings.set("forceEnabledExtensions" as Parameters<Settings["set"]>[0], force as never);
		await settings.flush();
		this.#extensionsCache = null;
		this.#runtimeLoadCache = null;
		this.#pluginsCache = null;
		this.#deps.onChanged();
		return { ok: true };
	}

	/** RPC extensions.setProviderEnabled：供应商级启停（disabledProviders）。 */
	async setProviderEnabled(params: unknown) {
		// Provider-level toggle (TUI parity): enableProvider /
		// disableProvider persist to settings.disabledProviders;
		// flush here so the change survives a daemon restart (the
		// capability layer only settings.set's).
		const p = (params ?? {}) as { providerId: string; enabled: boolean };
		if (p.providerId === "native") throw new Error("native provider cannot be toggled");
		const { enableProvider, disableProvider, getAllProvidersInfo } = await import("../../capability");
		if (!getAllProvidersInfo().some(pr => pr.id === p.providerId)) {
			throw new Error(`unknown provider: ${p.providerId}`);
		}
		if (p.enabled) enableProvider(p.providerId);
		else disableProvider(p.providerId);
		const settings = this.#deps.settings();
		if (settings) await settings.flush();
		this.#extensionsCache = null;
		this.#runtimeLoadCache = null;
		this.#deps.onChanged();
		return { ok: true };
	}

	/** RPC ext.call：扩展贡献的 daemon 侧 JSON-RPC（registerRpc）回调入口。 */
	async call(params: unknown) {
		// 扩展贡献的 daemon 侧 JSON-RPC(registerRpc):GUI 槽位组件
		// 经此回调自己的 daemon 侧逻辑。
		//
		// Fast path: load the entry DIRECTLY instead of validating it against a
		// full extension inventory scan. `getExtensions()` runs
		// `loadAllExtensions` — it evaluates every extension factory — and one
		// entry alone costs seconds to load (Bun transpiles the module graph
		// each time). A panel that fires four RPCs on mount paid that scan four
		// times and timed out at the caller's 15s budget, which read as "the
		// plugin never loads its own data".
		//
		// The guard that actually matters survives: `invokeExtensionRpc` throws
		// for a path it cannot load and for a method the entry never
		// registered. A path that merely exists but is disabled in settings is
		// rejected here from the settings list without a scan.
		const p = (params ?? {}) as { extensionId?: string; method?: string; params?: unknown; sessionId?: string };
		if (typeof p.extensionId !== "string" || p.extensionId.length === 0) {
			throw new Error("ext.call: extensionId required");
		}
		if (typeof p.method !== "string" || p.method.length === 0) {
			throw new Error("ext.call: method required");
		}
		const entryPath = p.extensionId;
		const disabled = new Set((this.#deps.settings()?.get("disabledExtensions") ?? []) as string[]);
		if (disabled.has(entryPath) || disabled.has(`path:${entryPath}`)) {
			throw new Error(`extension disabled: ${entryPath}`);
		}
		if (!fs.existsSync(entryPath)) {
			throw new Error(`extension not active: ${entryPath}`);
		}
		const { invokeExtensionRpc } = await import("../extension-artifact-compiler");
		return await invokeExtensionRpc(entryPath, this.#deps.cwd(), p.method, p.params ?? {}, {
			cwd: this.#deps.cwd(),
			sessionId: p.sessionId,
		});
	}

	/** RPC plugins.list：插件扫描（settings → plugins tab，10s TTL 缓存）。 */
	async listPlugins() {
		// Session-independent extension scan (settings → plugins tab).
		// Mirrors the CLI extension discovery; TTL-cached like the
		// session-dir scan so list refreshes don't re-walk the FS.
		if (!this.#pluginsCache || Date.now() - this.#pluginsCache.at > 10_000) {
			const { discoverExtensionPaths } = await import("../../extensibility/extensions");
			const { loadExtensions } = await import("../../extensibility/extensions/loader");
			const cwd = this.#deps.cwd();
			const paths = await discoverExtensionPaths([], cwd);
			const result = await loadExtensions(paths, cwd);
			this.#pluginsCache = {
				at: Date.now(),
				plugins: result.extensions.map(ext => ({
					path: ext.path,
					label: ext.label ?? null,
					tools: ext.tools.size,
					commands: ext.commands.size,
					handlers: ext.eventListenerDisposers?.length ?? 0,
				})),
				errors: result.errors,
			};
		}
		return this.#pluginsCache;
	}

	/** RPC plugins.packages：已装插件全量清单（enabled + disabled，10s TTL 缓存）。 */
	async pluginPackages() {
		// Full installed-plugin inventory (enabled + disabled) for the
		// settings → plugins tab. Session-independent; TTL-cached so
		// the list doesn't re-walk node_modules on each tab switch.
		if (!this.#pluginPackagesCache || Date.now() - this.#pluginPackagesCache.at > 10_000) {
			const { listPluginManagementPackages } = await import("../../extensibility/plugins/profile/plugin-management");
			this.#pluginPackagesCache = {
				at: Date.now(),
				plugins: await listPluginManagementPackages(this.#deps.cwd(), os.homedir()),
			};
		}
		return this.#pluginPackagesCache;
	}

	/**
	 * 插件级启停的组件联动：`disabledExtensions` 中的裸包名是包状态事实源。
	 * 停用时卸载整个 Cordis fiber，并按清单声明更新
	 * `disabledExtensionComponents`；启用时执行相反的恢复。未声明 components
	 * 的包只维护包键和 fiber 生命周期。
	 *
	 * best-effort：runtime 缺席或单步失败只记日志，不阻塞包自身的启停。
	 */
	async #cascadePluginComponents(pluginName: string, enabled: boolean): Promise<void> {
		const extensionsKey = "disabledExtensions" as Parameters<Settings["set"]>[0];
		const componentsKey = "disabledExtensionComponents" as Parameters<Settings["set"]>[0];
		// Read the declaration BEFORE writing the row id: discovery filters
		// entries whose id is already in `disabledExtensions`, so a package we
		// are about to disable would otherwise read back as "declares
		// nothing" — exactly the components we must cascade to.
		const declared = await this.#declaredComponentIds(pluginName);
		let settings = this.#deps.settings();
		if (!settings) {
			await this.#deps.ensureRegistry();
			settings = this.#deps.settings();
		}
		if (settings) {
			// 1) Persist the exact bare package name as the package enablement state.
			const disabled = setPluginEnabledIn((settings.get(extensionsKey) ?? []) as string[], pluginName, enabled);
			const before = (settings.get(extensionsKey) ?? []) as string[];
			if (disabled.length !== before.length || disabled.some((id, i) => id !== before[i])) {
				settings.set(extensionsKey, disabled as never);
				await settings.flush();
			}
			// 2) Declared components (manifest `components`): a plugin that
			//    declares none has no component keys to write.
			if (declared.length > 0) {
				const denylist = [...((settings.get(componentsKey) ?? []) as string[])];
				let denylistChanged = false;
				for (const componentId of declared) {
					const key = `${pluginName}/${componentId}`;
					const j = denylist.indexOf(key);
					if (enabled && j >= 0) {
						denylist.splice(j, 1);
						denylistChanged = true;
					} else if (!enabled && j < 0) {
						denylist.push(key);
						denylistChanged = true;
					}
				}
				if (denylistChanged) {
					settings.set(componentsKey, denylist as never);
					await settings.flush();
				}
			}
		}
		// 3) Runtime: unload the plugin fiber on disable (every registration
		//    it holds — slot components, commands, providers, RPC — is
		//    reclaimed with its lifetime), re-mount it on enable.
		try {
			const runtime = await this.#deps.dynamicRuntime?.();
			if (!runtime) return;
			if (enabled) {
				await runtime.reloadPlugin?.(pluginName);
				return;
			}
			await runtime.unloadPlugin?.(pluginName);
		} catch (err) {
			logger.warn("plugins.setEnabled component cascade failed (package toggle stands)", {
				plugin: pluginName,
				enabled,
				error: String(err),
			});
		}
	}

	/**
	 * 一个插件包声明的组件 id 清单（manifest `components`）。
	 *
	 * 走 `discoverExtensionPaths` 拿入口路径——它与装载链路同源，同时覆盖
	 * 两种安装态（npm 装的 `node_modules/<pkg>` 与链接/手写的
	 * `<agentDir>/extensions/<pkg>`），且**不经过任何 TTL 缓存**：级联不能
	 * 为了读一份声明去清 `#extensionsCache`（那会把别的调用方正要用的扫描
	 * 结果一起作废），也不能依赖 `getExtensions` 的行——那些行不带
	 * components（该字段只在 `list()` 的后处理里为 GUI 填充）。
	 *
	 * 发现用的禁用集**排除目标插件自己的条目 id**：调用点（包开关）要回答的
	 * 是「这个包声明过什么」，与它此刻是否已被标记禁用无关——一个刚被停用、
	 * 条目 id 还在 `disabledExtensions` 里的包，其组件声明必须照样读得到，
	 * 否则停用写入的键在启用时无人摘除。
	 *
	 * 读不到（未装/无声明）返回空数组 = 无级联对象。
	 */
	async #declaredComponentIds(pluginName: string): Promise<string[]> {
		try {
			const { discoverExtensionPaths } = await import("../../extensibility/extensions");
			const { readExtensionPluginMeta } = await import("../../extensibility/extensions/plugin-manifest");
			const { getExtensionNameFromPath } = await import("../../discovery/helpers");
			const settings = this.#deps.settings();
			const disabledIds = ((settings?.get("disabledExtensions") ?? []) as string[]).filter(id => id !== pluginName);
			const paths = await discoverExtensionPaths(
				(settings?.get("extensions") ?? []) as string[],
				this.#deps.cwd(),
				disabledIds,
				{ ambient: true },
			);
			const ids = new Set<string>();
			for (const entry of paths) {
				// 入口文件名 = 插件名（`<root>/<name>/index.ts` 的目录名）。
				if (getExtensionNameFromPath(entry) !== pluginName) continue;
				const meta = await readExtensionPluginMeta(entry);
				for (const decl of meta?.components ?? []) ids.add(decl.id);
			}
			return [...ids];
		} catch (err) {
			logger.warn("declared component ids unreadable (cascade skipped)", { plugin: pluginName, error: String(err) });
			return [];
		}
	}

	/** RPC plugins.setEnabled：已装插件启停（TUI /plugins enable|disable parity）。
	 *
	 *  插件级开关是总闸：停用一个插件包同时停用它注册的全部组件——否则
	 *  「插件已停用」与「它的 settings.tab / 面板组件还在役」并存，界面留下
	 *  一个点进去就报错的死入口。 */
	async setPluginEnabled(params: unknown) {
		// Enable/disable an installed plugin (settings → plugins tab
		// toggle). Mirrors the TUI /plugins enable|disable command;
		// busts the TTL cache so the next list reflects the change.
		//
		// The write is the INTENT, not the outcome: persisting `enabled` in
		// the lockfile says nothing about whether the plugin's extension
		// modules then load. Reporting `ok: true` unconditionally turned the
		// GUI toggle into a lie — a plugin whose factory throws (or whose
		// manifest points at a missing entry) flips to "enabled" in the UI
		// while nothing is registered. So after the write, this re-loads the
		// plugin's extension entries and reports what ACTUALLY happened.
		const { PluginManager } = await import("../../extensibility/plugins/management/manager");
		const p = (params ?? {}) as { name: string; enabled: boolean };
		if (!p.name) throw new Error("plugins.setEnabled: name required");
		const manager = new PluginManager(this.#deps.cwd());
		await manager.setPluginEnabled(p.name, Boolean(p.enabled));
		this.#pluginPackagesCache = null;
		this.#pluginsCache = null;

		// Component cascade: the package toggle is the master switch, so a
		// disable takes every component the plugin declares down with it —
		// otherwise "the plugin is off" coexists with "its settings.tab /
		// panel component is still in service", leaving a dead entry that
		// errors when opened. Best-effort: a component whose fiber is
		// already gone must not block the package toggle.
		await this.#cascadePluginComponents(p.name, Boolean(p.enabled));

		// Resolve the package's entry paths once: the disable branch needs them
		// to detach from live sessions, and the enable probe below loads the same
		// list. A package the inventory cannot see has nothing to apply.
		const { getAllPlugins, resolvePluginExtensionPaths } = await import("../../extensibility/plugins/runtime/loader");
		const installed = await getAllPlugins(this.#deps.cwd());
		const plugin = installed.find(x => x.name === p.name);
		const entryPaths = plugin ? resolvePluginExtensionPaths(plugin) : [];

		// Probe the real load outcome. Only an enable can newly fail (a
		// disable cannot break a load that already succeeded), so the probe
		// runs for enables; a disable reports without one.
		if (!p.enabled) {
			if (entryPaths.length > 0) await this.#deps.applyLive?.({ remove: entryPaths });
			return { ok: true, enabled: false };
		}
		const { loadExtensions } = await import("../../extensibility/extensions/loader");
		const probe = { loaded: 0, errors: [] as Array<{ path: string; error: string }> };
		if (plugin) {
			const paths = resolvePluginExtensionPaths(plugin);
			if (paths.length > 0) {
				const result = await loadExtensions(paths, this.#deps.cwd());
				probe.loaded = result.extensions.length;
				probe.errors = result.errors;
			}
		} else {
			probe.errors.push({ path: p.name, error: "plugin not found in installed inventory after enabling" });
		}
		// An enable is a real change for open sessions: entries the session
		// never mounted are loaded, entries it already had are refreshed.
		const apply = entryPaths.length > 0 ? await this.#deps.applyLive?.({ add: entryPaths }) : undefined;
		const ok = probe.errors.length === 0 && probe.loaded > 0;
		return {
			ok,
			enabled: Boolean(p.enabled),
			...(apply && apply.errors.length > 0 ? { applyErrors: apply.errors } : {}),
			...(ok
				? {}
				: { error: probe.errors.map(e => `${e.path}: ${e.error}`).join("; ") || "no loadable extension entries" }),
		};
	}

	/** 宿主 watcher（#scheduleExtensionReload）统一失效入口。 */
	invalidateCaches(): void {
		this.#extensionsCache = null;
		this.#runtimeLoadCache = null;
		this.#pluginsCache = null;
	}

	/** 宿主侧 marketplace.install/remove 的插件缓存失效入口（这两个 case 属
	 *  第十二刀，但其体内引用的插件缓存字段已随本刀搬入服务——保持原失效
	 *  粒度：仅清两个插件 TTL 缓存，不动 #extensionsCache）。 */
	invalidatePluginCaches(): void {
		this.#pluginsCache = null;
		this.#pluginPackagesCache = null;
	}

	/** 宿主侧 skills.delete/skills.install 与 marketplace.install/remove 的
	 *  扩展缓存失效入口：清 #extensionsCache + 宿主运行时加载缓存
	 *  （设计体系重放依赖后者重载，M3 §3.7d），不动插件缓存。
	 *
	 *  同时清扩展加载缓存（extension-artifact-compiler 的 load-once 缓存）：
	 *  装包/卸包/启停之后，session-less RPC 的 `ext.call` 必须拿到新实例，
	 *  否则一个被卸载的插件还能继续应答自己的 daemon 侧 RPC。 */
	invalidateExtensionsCache(): void {
		this.#extensionsCache = null;
		this.#runtimeLoadCache = null;
		// Discovery sits on the capability TTL cache — clear it too or a
		// removed extension keeps being discovered for the TTL window and
		// design.systems.list replays a stale system (M3 §3.7d unload path).
		invalidateCapabilityCache();
		void import("../extension-artifact-compiler").then(m => m.invalidateExtensionLoadCache());
	}

	/** 插件清单声明式配置写入:params = { id, key, value }。
	 *  字段必须以该扩展 manifest 声明的 config 为准——未声明的键直接拒绝
	 *  (防写垃圾键);值经 coerceConfigFieldValue 钳制后落盘存储,失效扩展
	 *  缓存并扇出 extensions.changed 让 GUI 重拉 configValues。返回
	 *  { restart, values }——restart 声明生效时机(运行时消费随 cordis 试点)。
	 *  内置插件单元(语音 STT/TTS)的字段键即设置键:按注册表声明钳制后经
	 *  settings 落盘,与设置页同一条存储。 */
	async setConfig(params: unknown) {
		const p = (params ?? {}) as { id?: unknown; key?: unknown; value?: unknown };
		if (typeof p.id !== "string" || typeof p.key !== "string") {
			throw new Error("extensions.setConfig: id and key are required strings");
		}
		const host = await this.#hostDeclaration(p.id);
		const wantedName = pluginNameOfEntryId(p.id) ?? p.id;
		const ext =
			host ?? (await this.getExtensions()).find(extension => extension.id === p.id || extension.id === wantedName);
		const desc = ext?.config?.find(field => field.key === p.key);
		if (!ext || !desc) {
			throw new Error(`extensions.setConfig: "${p.key}" is not a declared config field of ${p.id}`);
		}
		const coerced = coerceConfigFieldValue(desc, p.value);
		if (ext.host?.configStorage === "settings") {
			let settings = this.#deps.settings();
			if (!settings) {
				await this.#deps.ensureRegistry();
				settings = this.#deps.settings();
			}
			if (!settings) throw new Error("extensions.setConfig: settings unavailable");
			settings.set(desc.key as Parameters<Settings["set"]>[0], coerced as never);
			await settings.flush();
			// Settings-backed values do not change package discovery or runtime
			// composition. Update the cached row instead of rescanning every provider.
			const cached = this.#extensionsCache?.extensions.find(extension => extension.name === ext.name);
			if (cached?.config) {
				const stored: Record<string, unknown> = {};
				for (const field of cached.config) stored[field.key] = settings.getRaw(field.key);
				cached.configValues = coerceConfigValues([...cached.config], stored);
			}
			this.#deps.onChanged();
			return { ok: true as const, restart: desc.restart ?? ("none" as const), values: undefined };
		}
		const { writePluginConfigValue } = await import("../../extensibility/extensions-center/plugin-config-store");
		const values = await writePluginConfigValue(ext.name, p.key, coerced);
		this.invalidateExtensionsCache();
		this.#deps.onChanged();
		return { ok: true as const, restart: desc.restart ?? ("none" as const), values };
	}

	/**
	 * RPC pluginConfig.form — one namespace's config form snapshot.
	 *
	 * `settingsScope` (bare get/set) cannot answer "did my write lose a race"
	 * or "is this value mine or inherited", and a real settings form needs
	 * both. The form carries a revision fence and a base/user split; see
	 * `plugin-config-form.ts` for the contract.
	 *
	 * The base is the namespace's declared field defaults, so a form can show
	 * what a cleared field returns to instead of guessing.
	 */
	async configForm(params: unknown): Promise<{
		namespace: string;
		snapshot: {
			status: "ready" | "readonly" | "unavailable";
			value: Record<string, unknown> | undefined;
			base: Record<string, unknown> | undefined;
			user: Record<string, unknown> | undefined;
			revision: number | undefined;
			writable: boolean;
			mode: "host" | "memory";
		};
	}> {
		const p = (params ?? {}) as { namespace?: unknown };
		if (typeof p.namespace !== "string" || p.namespace === "") {
			throw new Error("pluginConfig.form: namespace required");
		}
		const fields = await this.#configFieldsFor(p.namespace);
		const { createPluginConfigForm } = await import("../../extensibility/extensions-center/plugin-config-form");
		const form = await createPluginConfigForm(p.namespace, fields, this.#pluginConfigStorePath());
		const snap = form.getSnapshot();
		return {
			namespace: p.namespace,
			snapshot: {
				status: snap.status,
				value: snap.value,
				base: snap.base,
				user: snap.user,
				revision: snap.revision,
				writable: snap.writable,
				mode: snap.mode,
			},
		};
	}

	/**
	 * RPC pluginConfig.mutate — apply field edits under the revision fence.
	 *
	 * Returns `applied: false` when the caller's revision is stale, so a form
	 * can tell "your edit lost" from "your edit failed" — the difference
	 * decides whether to re-read or to show an error.
	 */
	async configFormMutate(params: unknown): Promise<{
		applied: boolean;
		revision: number | undefined;
	}> {
		const p = (params ?? {}) as {
			namespace?: unknown;
			ops?: unknown;
			expectedRevision?: unknown;
		};
		if (typeof p.namespace !== "string" || p.namespace === "") {
			throw new Error("pluginConfig.mutate: namespace required");
		}
		const ops = Array.isArray(p.ops) ? (p.ops as { kind?: unknown; field?: unknown; value?: unknown }[]) : [];
		const parsed: Array<{ kind: "set"; field: string; value: unknown } | { kind: "unset"; field: string }> = [];
		for (const op of ops) {
			if (!op || typeof op !== "object") continue;
			if (typeof op.field !== "string" || op.field === "") continue;
			if (op.kind === "unset") parsed.push({ kind: "unset", field: op.field });
			else parsed.push({ kind: "set", field: op.field, value: op.value });
		}
		const fields = await this.#configFieldsFor(p.namespace);
		const { createPluginConfigForm } = await import("../../extensibility/extensions-center/plugin-config-form");
		const form = await createPluginConfigForm(p.namespace, fields, this.#pluginConfigStorePath());
		const applied = await form.mutate(
			parsed,
			typeof p.expectedRevision === "number" ? p.expectedRevision : undefined,
		);
		if (applied) {
			this.invalidateExtensionsCache();
			this.#deps.onChanged();
		}
		return { applied, revision: form.getSnapshot().revision };
	}

	/** The namespace's declared config fields, used as the form's base. */
	async #configFieldsFor(namespace: string): Promise<ConfigFieldDesc[]> {
		const injected = this.#deps.configFields?.(namespace);
		if (injected) return await injected;
		const extensions = await this.getExtensions();
		return extensions.find(e => e.id === namespace)?.config ?? [];
	}

	/** Where a form's values are stored: the host's own config directory
	 *  unless the caller injected one (tests isolate to a temp file). */
	#pluginConfigStorePath(): string | undefined {
		return this.#deps.pluginConfigStorePath?.();
	}
}
