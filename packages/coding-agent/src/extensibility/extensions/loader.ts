/**
 * Extension loader - loads TypeScript extension modules using native Bun import.
 */
import type * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode, isEacces, isEnoent, logger } from "@musepi/pi-utils";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import { type Hook, hookCapability } from "../../capability/hook";
import { isPluginDisabled } from "../../capability/plugin-identity";
import { loadCapability } from "../../discovery";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import type { PromptHostSurface } from "../../prompts/host";
import { EventBus } from "../../utils/event-bus";
import { enablementAllowsPath } from "../enablement-manifest";
import { readCompatibilityExemptions, resolveCompatibilityPath } from "../plugins/compat/compatibility-store";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/compat/legacy-pi-compat";
import { compatibilityGateForExtensionPath, pluginCompatibilityWarning } from "../plugins/compat/plugin-compatibility";
import { type PluginEntryModule, resolvePluginEntry, toFactory } from "../plugins/runtime/cordis-entry";
import { getAllPluginExtensionPaths } from "../plugins/runtime/loader";
import { resolvePath, withHostGuard } from "../utils";
import { DynamicExtensionLoadError, type DynamicExtensionLoadErrorCode } from "./dynamic-extension-error";
import { readExtensionPluginLabel } from "./plugin-manifest";
import type {
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime as IExtensionRuntime,
	LoadExtensionsResult,
} from "./types";

installLegacyPiSpecifierShim();

import { createPluginAPI, createPluginRecord, PluginRuntime, runPluginInFiber } from "../plugin-runtime/plugin-api";

export {
	assertKnownComponentSlot,
	createPluginAPI,
	createPluginAPI as createConcreteExtensionAPI,
	createPluginRecord,
	createPluginRecord as createExtension,
	loadPluginFromFactory,
	loadPluginFromFactory as loadExtensionFromFactory,
	PluginRuntime,
	PluginRuntime as ExtensionRuntime,
	PluginRuntimeNotInitializedError,
	PluginRuntimeNotInitializedError as ExtensionRuntimeNotInitializedError,
	pluginHostOwner,
	pluginHostOwner as extensionHostOwner,
	runPluginInFiber,
	runPluginInFiber as runFactoryInFiber,
} from "../plugin-runtime/plugin-api";

type LoadedExtensionModule = PluginEntryModule;

function getExtensionFactory(module: LoadedExtensionModule): ExtensionFactory | null {
	const entry = resolvePluginEntry(module);
	if (entry === null) return null;
	return toFactory(entry) as ExtensionFactory;
}

interface ImportedExtensionModule {
	factory: ExtensionFactory | null;
	resolvedPath: string;
	error: string | null;
}

/**
 * Import one extension entry.
 *
 * `fresh` decides module identity. A first load must take the process-wide
 * instance so the session, the `ext.call` compiler and any other consumer all
 * see ONE module object (each holding its own copy splits module-level state —
 * a plugin that captured the session context in one saw `null` through its
 * RPC). A reload must re-evaluate: Bun caches ESM by specifier and will not
 * re-read a cached module, so new bytes only take effect through a query-tagged
 * import. There is no third behaviour available, hence one option.
 */
async function importExtensionModule(
	extensionPath: string,
	cwd: string,
	options?: { fresh?: boolean },
): Promise<ImportedExtensionModule> {
	const resolvedPath = resolvePath(extensionPath, cwd);
	try {
		// Bundled plugin packages load through a plain dynamic import. They ship
		// with the host — same repo, same version, replaced as a whole on
		// upgrade — so they never need the legacy source-graph snapshot (a
		// file-by-file walk of the package's ENTIRE import graph, which for a
		// package importing host modules means thousands of files read and
		// parsed per load) nor its per-session cache-bust. Their module identity
		// is the distribution itself.
		if (isBundledPluginPath(resolvedPath)) {
			const module = (await import(resolvedPath)) as LoadedExtensionModule;
			const factory = getExtensionFactory(module);
			if (typeof factory !== "function") {
				return {
					factory: null,
					resolvedPath,
					error: `Extension does not export a valid factory function: ${extensionPath}`,
				};
			}
			return { factory, resolvedPath, error: null };
		}
		const module = (await withHostGuard(() =>
			loadLegacyPiModule(resolvedPath, { fresh: options?.fresh === true }),
		)) as LoadedExtensionModule;
		const factory = getExtensionFactory(module);

		if (typeof factory !== "function") {
			return {
				factory: null,
				resolvedPath,
				error: `Extension does not export a valid factory function: ${extensionPath}`,
			};
		}

		return { factory, resolvedPath, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { factory: null, resolvedPath, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Run one extension factory inside its own Cordis fiber.
 *
 * dsh's plugin instance is a fiber; the extension record stays our bookkeeping
 * object, but every listener registered through `pi.on` belongs to this fiber,
 * so reload, unload and rollback dispose one scope instead of replaying a
 * second ownership ledger. The listener list stays for exact counts and for
 * loaders that run a factory without a fiber.
 */
/** Whether an extension entry lives under the host's bundled plugin tree. */
function isBundledPluginPath(resolvedPath: string): boolean {
	const normalized = resolvedPath.replaceAll("\\", "/");
	return normalized.includes("/src/plugins/") || normalized.includes("/plugins/");
}

async function bindExtension(
	extensionPath: string,
	imported: ImportedExtensionModule,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	/** 收编第二刀：cordis 宿主级动态装载给 API 套效果账本壳的挂点——
	 *  默认恒等，会话装载路径不传，语义不变。 */
	wrapApi: (api: ExtensionAPI, extension: Extension) => ExtensionAPI = (api): ExtensionAPI => api,
): Promise<{ extension: Extension | null; error: string | null; code?: DynamicExtensionLoadErrorCode }> {
	const factory = imported.factory;
	if (imported.error !== null || factory === null) {
		return { extension: null, error: imported.error };
	}
	try {
		const extension = createPluginRecord(extensionPath, imported.resolvedPath);
		// The name the agent-facing `extensions-inventory` prompt section and the
		// `plugins.list` readout show. The manifest owns it, so a package cannot
		// name itself twice and drift; `ctx.setLabel` remains the runtime override
		// for a plugin that decides its name while loading.
		extension.label = await readExtensionPluginLabel(imported.resolvedPath);
		await withHostGuard(() =>
			runPluginInFiber(extension, runtime, cwd, eventBus, factory, ownContext =>
				wrapApi(createPluginAPI(extension, runtime, cwd, eventBus, ownContext), extension),
			),
		);

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			extension: null,
			error: `Failed to load extension: ${message}`,
			// 结构化归因（宿主级 cordis 装载的碰撞守卫等）穿透字符串包装不丢失。
			...(err instanceof DynamicExtensionLoadError ? { code: err.code } : {}),
		};
	}
}

/**
 * 同源装配（收编第二刀）：import + bind 一条路径，供 cordis 宿主级动态
 * 装载复用——与会话装载同一 import 管线（loadLegacyPiModule 兼容层）、
 * 同一 API 工厂，仅 wrapApi 挂点不同。
 */
export async function importAndBindExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	wrapApi?: (api: ExtensionAPI, extension: Extension) => ExtensionAPI,
	options?: { fresh?: boolean },
): Promise<{ extension: Extension | null; error: string | null; code?: DynamicExtensionLoadErrorCode }> {
	const imported = await importExtensionModule(extensionPath, cwd, options);
	return bindExtension(extensionPath, imported, cwd, eventBus, runtime, wrapApi);
}

/**
 * Create an Extension from an inline factory function.
 */
/**
 * Load extensions from paths.
 *
 * Module import (the dominant cold-start cost — file I/O plus module
 * evaluation) runs concurrently across extensions; factory binding then runs
 * sequentially in the original path order, so registration semantics
 * (last-wins collisions, shared runtime flag defaults) stay deterministic.
 */
export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	options?: { fresh?: boolean; promptHost?: PromptHostSurface; runtime?: IExtensionRuntime },
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();
	const runtime = options?.runtime ?? new PluginRuntime();
	runtime.sessionEventBus ??= resolvedEventBus;
	// The session prompt host travels on the runtime so every factory binding
	// (including cordis mounts reusing this runtime) sees the same host.
	runtime.promptHost = options?.promptHost;

	// 回退保护②：兼容性预检先于任何 import（dsh「只有兼容性冲突拒绝一行」
	// parity——清单缺失/不可读不是兼容性意见,交给下方 import 诊断）。
	// 拒绝的路径不进 imported 清单,errors 带结构化诊断;豁免命中放行但
	// 打警告日志（如实标注）。豁免清单读 agentDir/compatibility.json,
	// fail-safe：坏文件 = 零豁免 + 日志,永不阻塞会话装配。
	let admissible = paths;
	if (paths.length > 0) {
		const { exemptions, warnings } = readCompatibilityExemptions(resolveCompatibilityPath());
		for (const warning of warnings) logger.warn(warning);
		admissible = [];
		for (const extPath of paths) {
			// A plugin whose manifest condition does not hold is skipped, not
			// errored: the condition is how it says "not in this configuration",
			// which is an expected state rather than a failure to report. Both
			// gates are checked before any import, so a gated-out plugin never
			// runs code.
			if (!(await enablementAllowsPath(extPath))) continue;
			const gate = await compatibilityGateForExtensionPath(extPath, exemptions);
			if (gate && gate.status !== "exempted") {
				errors.push({ path: extPath, error: pluginCompatibilityWarning(gate) });
				continue;
			}
			if (gate) logger.warn("compatibility exemption active, loading anyway", { path: extPath });
			admissible.push(extPath);
		}
	}

	const imported = await Promise.all(admissible.map(extPath => importExtensionModule(extPath, cwd, options)));

	for (let i = 0; i < admissible.length; i++) {
		const extPath = admissible[i]!;
		const { extension, error } = await bindExtension(extPath, imported[i]!, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
	};
}

interface ExtensionManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
}

async function readExtensionManifest(packageJsonPath: string): Promise<ExtensionManifest | null> {
	try {
		const pkg = (await Bun.file(packageJsonPath).json()) as {
			musepi?: ExtensionManifest;
			omp?: ExtensionManifest;
			pi?: ExtensionManifest;
		};
		// musepi 为权威清单字段；omp/pi 是旧上游兼容遗留（继续可读）。
		const manifest = pkg.musepi ?? pkg.omp ?? pkg.pi;
		if (manifest && typeof manifest === "object") {
			return manifest;
		}
		return null;
	} catch (error) {
		if (isEnoent(error) || isEacces(error) || hasFsCode(error, "EPERM")) {
			return null;
		}
		logger.warn("Failed to read extension manifest", { path: packageJsonPath, error: String(error) });
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 */
async function resolveExtensionEntries(dir: string): Promise<string[] | null> {
	const packageJsonPath = path.join(dir, "package.json");
	const manifest = await readExtensionManifest(packageJsonPath);
	if (manifest?.extensions?.length) {
		const entries: string[] = [];
		for (const extPath of manifest.extensions) {
			const resolvedExtPath = path.resolve(dir, extPath);
			try {
				await fs.stat(resolvedExtPath);
				entries.push(resolvedExtPath);
			} catch (err) {
				if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) continue;
				throw err;
			}
		}
		if (entries.length > 0) {
			return entries;
		}
	}

	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	try {
		await fs.stat(indexTs);
		return [indexTs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}
	try {
		await fs.stat(indexJs);
		return [indexJs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/<ext>/index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/<ext>/package.json` with "omp"/"pi" field → load declared paths
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
async function discoverExtensionsInDir(dir: string): Promise<string[]> {
	const discovered: string[] = [];

	// First check if this directory itself has explicit extension entries (package.json or index)
	const rootEntries = await resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	// Otherwise, discover extensions from directory contents
	let entries: fs1.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Failed to discover extensions in directory", { path: dir, error: String(err) });
		return [];
	}

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);

		if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
			discovered.push(entryPath);
			continue;
		}

		if (entry.isDirectory() || entry.isSymbolicLink()) {
			const resolved = await resolveExtensionEntries(entryPath);
			if (resolved) {
				discovered.push(...resolved);
			}
		}
	}

	return discovered;
}
async function discoverHooksInPackageRoot(root: string): Promise<string[]> {
	const hooks: string[] = [];
	for (const hookType of ["pre", "post"]) {
		const hookDir = path.join(root, "hooks", hookType);
		let entries: fs1.Dirent[];
		try {
			entries = await fs.readdir(hookDir, { withFileTypes: true });
		} catch (err) {
			if (isEnoent(err) || isEacces(err) || hasFsCode(err, "ENOTDIR") || hasFsCode(err, "EPERM")) continue;
			throw err;
		}
		for (const entry of entries) {
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				hooks.push(path.join(hookDir, entry.name));
			}
		}
	}
	return hooks;
}

/**
 * Discover absolute paths of extensions to load, without importing or
 * binding factories. Hot path on session startup — the scan walks native
 * `.omp`/`.pi` extension capabilities, JS/TS hook factories, the
 * installed-plugin tree, and any configured paths.
 *
 * Subagents reuse the parent's collected paths via the SDK's
 * `preloadedExtensionPaths` option, then call {@link loadExtensions} themselves
 * so each session rebuilds Extension instances bound to its OWN
 * `ExtensionAPI` (cwd, eventBus, runtime). Forwarding the parent's
 * `LoadExtensionsResult` directly would reuse handlers/tools/commands that
 * closed over the parent's `cwd` and event bus.
 */
export interface DiscoverExtensionPathOptions {
	/** Include ambient native extensions, hooks, and installed plugins. */
	ambient?: boolean;
	/** Include ambient hook factories. Disable for read-only catalog commands. */
	includeAmbientHooks?: boolean;
}

export async function discoverExtensionPaths(
	configuredPaths: string[],
	cwd: string,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<string[]> {
	const allPaths: string[] = [];
	const seen = new Set<string>();
	const disabled = new Set(disabledExtensionIds ?? []);
	const loadOptions = disabledExtensionIds ? { cwd, disabledExtensions: disabledExtensionIds } : { cwd };

	// MusePi package enablement uses only the exact bare package name.
	const isDisabledName = (name: string): boolean => isPluginDisabled(disabled, name);

	const addPath = (extPath: string): void => {
		const resolved = path.resolve(extPath);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			allPaths.push(extPath);
		}
	};

	const addPaths = (paths: string[]) => {
		for (const extPath of paths) {
			if (isDisabledName(getExtensionNameFromPath(extPath))) continue;
			addPath(extPath);
		}
	};

	const ambient = options.ambient !== false;
	if (ambient) {
		// 1. Discover extension modules via capability API (native .omp/.pi
		// + musepi 自有扩展). Scope the load to the two providers whose
		// entries sessions actually consume: the native provider
		// (.omp/.pi extension-module items) and the musepi-extensions
		// provider (~/.musepi/agent/extensions — MusePi 自有扩展,modes v2
		// 白名单/扩展中心的同一数据源)。claude/codex/gemini/opencode 的
		// 外部扩展目录仍被跳过(见 #4198)。
		const discovered = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
			...loadOptions,
			providers: ["native", "musepi-extensions"],
		});
		for (const ext of discovered.items) {
			// Through `addPaths`, not `addPath`: the capability does not filter by
			// the user's disable list, so adding directly here started a disabled
			// extension anyway (the row showed disabled while it kept loading).
			addPaths([ext.path]);
		}
	}

	// 2. Discover JS/TS hook factories and bind them through the extension
	// runner, which owns the current runtime event bus. Non-ambient discovery
	// scans only this invocation's configured package roots; it must not consult
	// settings, installed packages, or process-global CLI injection state.
	if (ambient) {
		if (options.includeAmbientHooks !== false) {
			const hooks = await loadCapability<Hook>(hookCapability.id, loadOptions);
			for (const hookPath of hooks.items
				.map(hook => hook.path)
				.filter(hookPath => isExtensionFile(path.basename(hookPath)))) {
				addPath(hookPath);
			}
		}
	} else {
		for (const configuredPath of configuredPaths) {
			addPaths(await discoverHooksInPackageRoot(resolvePath(configuredPath, cwd)));
		}
	}

	// 3. Discover extension entry points from installed plugins.
	if (ambient) {
		addPaths(await getAllPluginExtensionPaths(cwd));
	}

	// 4. Explicitly configured paths
	for (const configuredPath of configuredPaths) {
		const resolved = resolvePath(configuredPath, cwd);

		let stat: fs1.Stats | null = null;
		try {
			stat = await fs.stat(resolved);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		if (stat?.isDirectory()) {
			const entries = await resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}

			const discovered = await discoverExtensionsInDir(resolved);
			if (discovered.length > 0) {
				addPaths(discovered);
			}
			continue;
		}

		addPath(resolved);
	}

	return allPaths;
}

/**
 * Discover and load extensions from standard locations. Composed of
 * {@link discoverExtensionPaths} (FS scan) + {@link loadExtensions}
 * (per-session binding).
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	eventBus?: EventBus,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<LoadExtensionsResult> {
	const paths = await discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, options);
	return loadExtensions(paths, cwd, eventBus);
}
