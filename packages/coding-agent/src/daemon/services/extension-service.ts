import * as fs from "node:fs";
import { EXTENSION_SLOT_DECLARATION } from "@musepi/collab-proto/extension-slots";
import type { Settings } from "../../config/settings";
import type { Extension } from "../../extensibility/extensions-center/types";
import type { DaemonService } from "./types";

/**
 * ExtensionService — 扩展/插件控制面（L2 宿主服务，P1 第十一刀抽取）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `extensions.list` / `extensions.raw` / `extensions.setEnabled` /
 *   `extensions.setForceEnabled` / `extensions.setProviderEnabled`（统一扩展
 *   扫描、inspector 原文、条目/桌面外壳/供应商启停，写 settings 与 mcp.json
 *   denylist）、`ext.call`（扩展 registerRpc 的 daemon 侧回调，仅限 active
 *   extension-module）、`plugins.list` / `plugins.packages` /
 *   `plugins.setEnabled`（插件扫描/已装清单/启停）。
 * - 输出：各 RPC 返回值原样；extensions.raw 超 16KB 截断；extensions.list
 *   聚合 tabs/providers/槽位组件/toolViews/状态栏段与 shell 配置；三个 10s
 *   TTL 缓存（#extensionsCache/#pluginsCache/#pluginPackagesCache）随变更
 *   RPC 与宿主 watcher 失效；extensions.changed 广播经注入的 onChanged 扇出
 *   （宿主侧接 EventService，lazy 调用无循环）。
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
	/** web.port 发现文件的绝对路径（宿主计算：socket 目录下）。 */
	webPortFile(): string;
	/** extensions.changed 广播（宿主接 EventService，lazy 调用无循环）。 */
	onChanged(): void;
}

export class ExtensionService implements DaemonService {
	readonly key = "extensions";
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
		plugins: {
			name: string;
			version: string;
			path: string;
			scope: "user" | "project";
			enabled: boolean;
			description: string | null;
			tools: number;
			commands: number;
			handlers: number;
		}[];
	} | null = null;

	/** TTL cache of the unified extension scan (extensions.list — the
	 *  Extension Control Center's 10 capability kinds, TUI parity).
	 *  Invalidated by the mutation RPCs below. */
	#extensionsCache: { at: number; extensions: Extension[] } | null = null;

	constructor(deps: ExtensionServiceDeps) {
		this.#deps = deps;
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
		}
		return this.#extensionsCache.extensions;
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
		// Desktop-shell config (dsh-desktop parity): the compat page /
		// GUI shell read enabled + mode + served origin from the
		// registry response (raw is stripped by the response mapping).
		const shellEnabled = s?.getRaw("shell.enabled");
		const shellMode = s?.getRaw("shell.mode");
		const shellCfg = {
			enabled: shellEnabled !== false,
			mode: shellMode === "extended" || shellMode === "enhanced" ? shellMode : "compatibility",
			webUrl: this.#deps.webUrl(),
		};
		// Builtin registry entries mirrored on a settings key
		// (style/shell/magic keywords): the setting IS the source of
		// truth for state — raw === off means disabled, anything else
		// (unset defaults to enabled) means active.
		const { BUILTIN_EXTENSIONS, builtinMirrorDisabled } = await import(
			"../../extensibility/extensions-center/builtin-registry"
		);
		for (const def of BUILTIN_EXTENSIONS) {
			if (!def.settingsMirror) continue;
			const ext = extensions.find(e => e.id === `${def.kind}:${def.name}`);
			if (!ext) continue;
			const disabled = s ? builtinMirrorDisabled(def, key => s.getRaw(key)) : false;
			ext.state = disabled ? "disabled" : "active";
			ext.disabledReason = disabled ? "item-disabled" : undefined;
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
		const { collectSlotComponents, collectToolViews, collectStatusBarSegments } = await import(
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
			statusBarSegments,
			// Desktop-shell config (dsh-desktop parity): enabled/mode/
			// webUrl read by the compat page + GUI shell.
			shell: shellCfg,
			// 槽位契约单一权威(collab-proto):GUI 据此诊断未挂载槽位。
			slots: {
				exact: [...EXTENSION_SLOT_DECLARATION.exact],
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

	/** RPC extensions.setEnabled：条目启停（settings.disabledExtensions / 外壳
	 *  镜像键 / mcp.json denylist 同一裁决，issue #3827）。 */
	async setEnabled(params: unknown) {
		// Item toggle (TUI /extensions parity): writes
		// settings.disabledExtensions with the same `kind:name` ids
		// the dashboard uses. MCP toggles route through the canonical
		// mcp.json denylist so /mcp list, the MCP runtime and this
		// center agree (issue #3827). Settings-mirrored builtins
		// (task-card style, magic keywords) write their mirrored
		// setting key instead — the setting IS the source of truth.
		const p = (params ?? {}) as { id: string; enabled: boolean; mode?: string };
		let settings = this.#deps.settings();
		if (!settings) {
			await this.#deps.ensureRegistry();
			settings = this.#deps.settings();
		}
		if (!settings) throw new Error("settings unavailable");
		if (p.id === "desktop-shell:shell") {
			// Desktop shell toggle: enabled -> the GUI shell loads the
			// runtime-served renderer; disabled -> local bundle. The
			// setting drives the extension's mirrored state, and the
			// web.port discovery file is written/deleted so the shell
			// sees the change without an RPC round-trip. An optional
			// `mode` param (compatibility/extended/enhanced) switches
			// the shell mode atomically.
			if (typeof p.mode === "string") {
				const mode: string = p.mode;
				if (mode !== "compatibility" && mode !== "extended" && mode !== "enhanced") {
					throw new Error(`invalid shell mode: ${mode}`);
				}
				settings.set("shell.mode" as Parameters<Settings["set"]>[0], mode as never);
			}
			settings.set("shell.enabled" as Parameters<Settings["set"]>[0], p.enabled as never);
			await settings.flush();
			const webPortFile = this.#deps.webPortFile();
			const webUrl = this.#deps.webUrl();
			if (p.enabled && webUrl) {
				const port = new URL(webUrl).port;
				if (port) {
					try {
						await fs.promises.writeFile(webPortFile, port, "utf8");
					} catch {
						// non-fatal
					}
				}
			} else {
				try {
					await fs.promises.unlink(webPortFile);
				} catch {
					// already gone
				}
			}
			this.#extensionsCache = null;
			this.#deps.onChanged();
			return { ok: true };
		}
		// Generic settings-mirror builtins (task-card style, magic
		// keywords): the mirrored setting IS the source of truth —
		// write it instead of the disabledExtensions list.
		const mirrorDef = (await import("../../extensibility/extensions-center/builtin-registry")).findBuiltinDef(
			p.id,
		)?.settingsMirror;
		if (mirrorDef) {
			settings.set(
				mirrorDef.key as Parameters<Settings["set"]>[0],
				(p.enabled ? mirrorDef.on : mirrorDef.off) as never,
			);
			await settings.flush();
			this.#extensionsCache = null;
			this.#deps.onChanged();
			return { ok: true };
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
			// Reconcile legacy `mcp:<name>` flags in disabledExtensions
			// (TUI parity) so a stale entry doesn't keep the server
			// marked disabled after re-enabling via the UI.
			const stored = [...((settings.get("disabledExtensions") ?? []) as string[])];
			const had = stored.indexOf(p.id);
			if (p.enabled && had !== -1) {
				stored.splice(had, 1);
				settings.set("disabledExtensions", stored);
				await settings.flush();
			}
		} else {
			const disabled = [...((settings.get("disabledExtensions") ?? []) as string[])];
			const i = disabled.indexOf(p.id);
			if (p.enabled && i >= 0) disabled.splice(i, 1);
			if (!p.enabled && i < 0) disabled.push(p.id);
			settings.set("disabledExtensions", disabled);
			await settings.flush();
		}
		this.#extensionsCache = null;
		this.#deps.onChanged();
		return { ok: true };
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
		this.#deps.onChanged();
		return { ok: true };
	}

	/** RPC ext.call：扩展贡献的 daemon 侧 JSON-RPC（registerRpc）回调入口。 */
	async call(params: unknown) {
		// 扩展贡献的 daemon 侧 JSON-RPC(registerRpc):GUI 槽位组件
		// 经此回调自己的 daemon 侧逻辑。仅限 active extension-module
		// 条目 —— 与
		// collectSlotComponents 同源过滤,未知扩展/方法抛 JSON-RPC
		// 错误给调用方。
		const p = (params ?? {}) as { extensionId?: string; method?: string; params?: unknown; sessionId?: string };
		if (typeof p.extensionId !== "string" || p.extensionId.length === 0) {
			throw new Error("ext.call: extensionId required");
		}
		if (typeof p.method !== "string" || p.method.length === 0) {
			throw new Error("ext.call: method required");
		}
		const extensions = await this.getExtensions();
		const entry = extensions.find(
			e => e.kind === "extension-module" && e.state === "active" && e.path === p.extensionId,
		);
		if (!entry) throw new Error(`extension not active: ${p.extensionId}`);
		const { invokeExtensionRpc } = await import("../extension-artifact-compiler");
		return await invokeExtensionRpc(entry.path, this.#deps.cwd(), p.method, p.params ?? {}, {
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
					handlers: ext.handlers.size,
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
			const { getAllPlugins } = await import("../../extensibility/plugins/loader");
			const installed = await getAllPlugins(this.#deps.cwd());
			this.#pluginPackagesCache = {
				at: Date.now(),
				plugins: installed.map(p => ({
					name: p.name,
					version: p.version,
					path: p.path,
					scope: p.scope,
					enabled: p.enabled,
					description: p.manifest.description ?? null,
					tools: p.manifest.tools ? 1 : 0,
					commands: Array.isArray(p.manifest.commands) ? p.manifest.commands.length : p.manifest.commands ? 1 : 0,
					handlers:
						typeof p.manifest.hooks === "string"
							? 1
							: p.manifest.hooks
								? Object.keys(p.manifest.hooks).length
								: 0,
				})),
			};
		}
		return this.#pluginPackagesCache;
	}

	/** RPC plugins.setEnabled：已装插件启停（TUI /plugins enable|disable parity）。 */
	async setPluginEnabled(params: unknown) {
		// Enable/disable an installed plugin (settings → plugins tab
		// toggle). Mirrors the TUI /plugins enable|disable command;
		// busts the TTL cache so the next list reflects the change.
		const { PluginManager } = await import("../../extensibility/plugins/manager");
		const p = (params ?? {}) as { name: string; enabled: boolean };
		if (!p.name) throw new Error("plugins.setEnabled: name required");
		const manager = new PluginManager(this.#deps.cwd());
		await manager.setPluginEnabled(p.name, Boolean(p.enabled));
		this.#pluginPackagesCache = null;
		this.#pluginsCache = null;
		return { ok: true, enabled: Boolean(p.enabled) };
	}

	/** 宿主 watcher（#scheduleExtensionReload）统一失效入口。 */
	invalidateCaches(): void {
		this.#extensionsCache = null;
		this.#pluginsCache = null;
	}

	/** 宿主侧 marketplace.install/remove 的插件缓存失效入口（这两个 case 属
	 *  第十二刀，但其体内引用的插件缓存字段已随本刀搬入服务——保持原失效
	 *  粒度：仅清两个插件 TTL 缓存，不动 #extensionsCache）。 */
	invalidatePluginCaches(): void {
		this.#pluginsCache = null;
		this.#pluginPackagesCache = null;
	}

	/** 宿主侧 skills.delete/skills.install 的扩展缓存失效入口（保持原粒度：
	 *  仅清 #extensionsCache，不动插件缓存）。 */
	invalidateExtensionsCache(): void {
		this.#extensionsCache = null;
	}
}
