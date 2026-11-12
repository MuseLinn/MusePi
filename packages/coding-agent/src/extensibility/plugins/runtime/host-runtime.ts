/**
 * Process-level host plugin runtime — Track A for distribution-shipped
 * packages whose manifest declares `musepi.scope: "host"`.
 *
 * A host package registers process-wide facts: a memory backend provider, a
 * service another plugin reads by name. Those registrations belong to the host
 * process, not to a session, and a second execution of the same `apply` without
 * unloading the first is a failure rather than a refresh — the memory backend
 * registry refuses a duplicate id outright.
 *
 * So this runtime mounts them through {@link mountPlugin}, the same cordis
 * pipeline a session uses, and owns the lifecycle at process scope: one mount,
 * one fiber per plugin, `provide` payloads published to the host service
 * registry, and every registration reclaimed on unload. Idempotence is keyed by
 * the mount attempt, not by any per-item flag: `ensureHostPlugins` is a
 * process-wide one-shot, so a second caller (another host, a second session,
 * a retry after a successful mount) cannot re-run an entry.
 *
 * ## Reload
 *
 * A plugin's fibers are replaced when the plugin's own modules change, and the
 * process restarts only when a change lands in the host's static graph. The
 * package directory is the ownership boundary here:
 * {@link reloadHostPlugins} disposes an affected record (services unpublish →
 * fiber teardown → provider unregistration) and mounts a freshly imported
 * entry, restoring the previous module if the replacement fails. A change
 * outside every host package is host code, and re-importing it would split the
 * module-level state the running host already holds — that needs a restart.
 * The `hmr` package itself is the one exception inside the boundary: it owns
 * the watcher delivering the batch and its subscribers are external to the
 * plugin, so replacing it would silently detach them — it, and any future
 * provider of `hmr`, keeps running until the host restarts.
 *
 * The host half is deliberately separate from `CordisDynamicPluginRuntime`
 * (daemon-scoped, user plugins): a TUI or SDK process has no daemon host
 * context, and host packages must mount before any session in every host.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@musepi/pi-utils";
import { discoverBundledPluginPaths } from "../../../discovery/builtin";
import { getExtensionNameFromPath } from "../../../discovery/helpers";
import { EventBus } from "../../../utils/event-bus";
import { ExtensionRuntime } from "../../extensions/loader";
import { getPluginConfigPath } from "../../extensions-center/plugin-config-store";
import type { HmrRestartRequirement, HmrService } from "../hmr/service";
import { HOST_SERVICES, providedServices, type ServiceRegistry } from "./cordis-entry";
import { disposePluginPrimitives } from "./cordis-primitives";
import { FIBER_STATE_FAILED, fiberStateName } from "./fiber-state";
import { getHostService, hasHostService, provideHostService } from "./host-services";
import { importPluginEntry, type MountContext, type MountedPlugin, mountPlugin } from "./mount";
import { defaultSessionConfigReader } from "./session-loader";

/** One mounted host package, with what a reload needs to replace it. */
interface HostPluginRecord {
	readonly name: string;
	readonly entryPath: string;
	readonly manifestPath: string;
	/** The package root: every file below it is plugin-owned and reloadable. */
	readonly packageDir: string;
	/** The host cwd the instance was applied with; a reload reuses it. */
	readonly cwd: string;
	/** The module namespace currently being applied. Retained for rollback. */
	module: unknown;
	mounted: MountedPlugin;
	/** Services this instance published; unpublishing is the first reload step. */
	serviceDisposers: Array<() => void>;
	/** Whether the package can be replaced without restarting the host. */
	reloadable: boolean;
	/** True between the teardown and the replacement's success, so a rollback
	 *  does not dispose the same fiber a second time. */
	disposed?: boolean;
	error?: string;
}

interface HostPluginRuntime {
	loaded: boolean;
	readonly records: Map<string, HostPluginRecord>;
	readonly runtime: ExtensionRuntime;
	readonly eventBus: EventBus;
}

/** Diagnostics for one host package, keyed the way the extension center lists it. */
export interface HostPluginInspection {
	readonly name: string;
	readonly entryPath: string;
	readonly fiberState?: string;
	readonly effectLabels: string[];
	readonly error?: string;
}

/**
 * One runtime per process. The loader's module instance is the process-scope
 * key: every host entry point imports this module statically, so they share
 * the attempt instead of each mounting the same package again.
 */
let state: HostPluginRuntime | undefined;
let lifecycleQueue: Promise<unknown> = Promise.resolve();

function withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
	const run = lifecycleQueue.then(operation, operation);
	lifecycleQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function runtimeState(): HostPluginRuntime {
	state ??= {
		loaded: false,
		records: new Map(),
		runtime: new ExtensionRuntime(),
		eventBus: new EventBus(),
	};
	return state;
}

/**
 * The `inject` resolution surface for host mounts.
 *
 * Host services (`credentials`, `memory`, …) are capabilities the plugin
 * already holds; the objects a previous host plugin published are what
 * `pi.service(name)` hands over. Both live in the process-wide host service
 * registry, so a package mounted after its provider sees it, and one mounted
 * before is refused with the dependency named.
 */
function hostServiceRegistry(): ServiceRegistry {
	return {
		host: HOST_SERVICES,
		hasProvided: name => hasHostService(name),
		providerOf: name => (hasHostService(name) ? "a host plugin" : undefined),
		resolve: <T>(name: string): T | undefined => getHostService<T>(name),
	};
}

/** The package manifest nearest an entry, within the manifest reader's depth. */
function manifestPathFor(entryPath: string): string {
	let dir = path.dirname(entryPath);
	for (let depth = 0; depth < 4; depth++) {
		const candidate = path.join(dir, "package.json");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.join(path.dirname(entryPath), "package.json");
}

/** Whether `file` is the directory or one of its descendants. */
function isWithin(file: string, dir: string): boolean {
	return file === dir || file.startsWith(`${dir}${path.sep}`);
}

/**
 * Hand a restart request to the host.
 *
 * The process lifecycle belongs to the host: the daemon's supervisor, the
 * desktop shell, or a TUI that asks the user to relaunch. The HMR service is
 * the process-level surface every host already reads; when it is absent the
 * request is still logged rather than swallowed.
 */
function requestHostRestart(requirement: HmrRestartRequirement): void {
	const service = getHostService<HmrService>("hmr");
	if (service) {
		service.requestRestart(requirement);
		return;
	}
	logger.warn("host restart required", {
		reason: requirement.reason,
		file: requirement.file,
		entry: requirement.entry,
	});
}

function serviceNames(mounted: MountedPlugin): readonly string[] {
	return providedServices(mounted.entry);
}

/** Publish the objects one mount's `provide` names refer to. */
function publishServices(record: HostPluginRecord): void {
	for (const name of serviceNames(record.mounted)) {
		const service = record.mounted.published?.[name];
		if (service === undefined) continue;
		record.serviceDisposers.push(provideHostService(name, service));
	}
}

/** Build the record for one successful mount. */
function recordFor(entryPath: string, cwd: string, module: unknown, mounted: MountedPlugin): HostPluginRecord {
	const manifestPath = manifestPathFor(entryPath);
	const record: HostPluginRecord = {
		name: getExtensionNameFromPath(entryPath),
		entryPath,
		manifestPath,
		packageDir: path.dirname(manifestPath),
		cwd,
		module,
		mounted,
		serviceDisposers: [],
		// The watcher's own provider cannot replace itself: the batch is being
		// delivered through its listeners, and those listeners are not owned by
		// the fiber (a host subscribes to the service object directly).
		reloadable: !serviceNames(mounted).includes("hmr"),
	};
	try {
		publishServices(record);
		return record;
	} catch (error) {
		for (const dispose of record.serviceDisposers.splice(0)) {
			try {
				dispose();
			} catch (disposeError) {
				logger.warn("host plugin service unpublish failed", {
					entry: record.entryPath,
					error: String(disposeError),
				});
			}
		}
		throw error;
	}
}

/** Mount one entry (shared by the first load and a reload). */
async function mountHostEntry(
	current: HostPluginRuntime,
	entryPath: string,
	cwd: string,
	readConfig: MountContext["readConfig"],
	module?: unknown,
): Promise<HostPluginRecord> {
	const mounted = await mountPlugin({
		entryPath,
		cwd,
		eventBus: current.eventBus,
		runtime: current.runtime as unknown as MountContext["runtime"],
		readConfig,
		serviceRegistry: hostServiceRegistry(),
		...(module === undefined ? {} : { module }),
	});
	if (!mounted.ok) throw new Error(`${mounted.code}: ${mounted.message}`);
	try {
		return recordFor(entryPath, cwd, mounted.module, mounted);
	} catch (error) {
		await disposePluginPrimitives(mounted.extension);
		throw error;
	}
}

/**
 * Mount the host-scope bundled packages once per process.
 *
 * Returns true for the attempt that mounted them, false for every later caller
 * — including concurrent ones, which await the same attempt. One plugin's
 * mount failure is logged and does not block the rest; a failure of discovery
 * itself rejects the attempt and is retried by the next caller rather than
 * cached forever.
 */
export function ensureHostPlugins(cwd: string): Promise<boolean> {
	return withLifecycle(async () => {
		const current = runtimeState();
		if (current.loaded) return false;
		const [paths, readConfig] = await Promise.all([
			discoverBundledPluginPaths({ scope: "host" }),
			defaultSessionConfigReader(),
		]);
		for (const entryPath of paths) {
			try {
				const record = await mountHostEntry(current, entryPath, cwd, readConfig);
				current.records.set(record.entryPath, record);
			} catch (error) {
				logger.warn("host plugin failed to mount", { entry: entryPath, error: String(error) });
			}
		}
		current.loaded = true;
		return true;
	});
}

/**
 * Reload the host packages affected by a change batch.
 *
 * `changedFiles` undefined = an explicit reload (every package); an empty array
 * = nothing changed. A package is affected when the changed path is inside its
 * package directory, its entry, or its manifest. A path outside every host
 * package is host code and is not replaced; it requires a restart.
 *
 * Returns the names that were replaced. A failed replacement keeps the
 * previous module and re-applies it, so a syntax error never leaves the host
 * without its process-wide registrations.
 */
export function reloadHostPlugins(changedFiles?: readonly string[]): Promise<readonly string[]> {
	// Mount, replacement, and reset share one queue so old and new effects
	// cannot overlap even when a reset races an ensure or another reload.
	return withLifecycle(() => reloadHostPluginsNow(changedFiles));
}

async function reloadHostPluginsNow(changedFiles?: readonly string[]): Promise<readonly string[]> {
	const current = state;
	if (!current?.loaded) return [];
	const records = [...current.records.values()];
	if (changedFiles !== undefined && changedFiles.length > 0) {
		requestRestartForHostFiles(records, changedFiles);
	}
	const readConfig = await defaultSessionConfigReader();
	const affected = new Map(selectAffected(records, changedFiles).map(record => [record.entryPath, record]));
	if (changedFiles?.some(file => path.resolve(file) === path.resolve(getPluginConfigPath()))) {
		for (const record of await selectConfigAffected(records, readConfig)) affected.set(record.entryPath, record);
	}
	if (affected.size === 0) return [];

	const reloaded: string[] = [];
	for (const record of affected.values()) {
		if (!record.reloadable) {
			requestHostRestart({
				entry: record.entryPath,
				reason: "it provides the HMR service that delivers this batch",
			});
			continue;
		}
		let module: unknown;
		try {
			module = await importPluginEntry(record.entryPath, true);
		} catch (error) {
			logger.warn("host plugin reload could not import the new entry; keeping the old instance", {
				entry: record.entryPath,
				error: String(error),
			});
			record.error = String(error);
			continue;
		}
		const previousModule = record.module;
		try {
			await replaceRecord(current, record, module, readConfig);
			record.error = undefined;
			reloaded.push(record.name);
			logger.info("host plugin reloaded", { entry: record.entryPath });
		} catch (error) {
			record.error = String(error);
			logger.warn("host plugin reload failed; restoring the previous instance", {
				entry: record.entryPath,
				error: String(error),
			});
			try {
				await replaceRecord(current, record, previousModule, readConfig);
			} catch (rollbackError) {
				record.disposed = true;
				record.error = `${record.error}; rollback failed: ${String(rollbackError)}`;
				logger.error("host plugin rollback failed", {
					entry: record.entryPath,
					error: String(rollbackError),
				});
				requestHostRestart({
					entry: record.entryPath,
					reason: "replacement and rollback both failed; the previous instance could not be restored",
				});
			}
		}
	}
	return reloaded;
}

/** Unmount a record's current instance, then apply `module` in its place. */
async function replaceRecord(
	current: HostPluginRuntime,
	record: HostPluginRecord,
	module: unknown,
	readConfig: MountContext["readConfig"],
): Promise<void> {
	if (!record.disposed) {
		for (const dispose of record.serviceDisposers.splice(0)) {
			try {
				dispose();
			} catch (error) {
				logger.warn("host plugin service unpublish failed", { entry: record.entryPath, error: String(error) });
			}
		}
		await disposePluginPrimitives(record.mounted.extension);
		record.disposed = true;
	}
	const replacement = await mountHostEntry(current, record.entryPath, record.cwd, readConfig, module);
	record.module = replacement.module;
	record.mounted = replacement.mounted;
	record.serviceDisposers.push(...replacement.serviceDisposers);
	record.reloadable = replacement.reloadable;
	record.disposed = false;
}

/**
 * Report a batch's host-owned files as restart-required.
 *
 * A host plugin's package directory is the only code this runtime owns. A
 * changed file outside every package (and outside the config store, which is
 * re-read on re-apply) is host code: replacing it in place would split the
 * module-level state the running host holds, so the host receives a restart
 * request instead.
 */
function requestRestartForHostFiles(records: readonly HostPluginRecord[], changedFiles: readonly string[]): void {
	const configStore = path.resolve(getPluginConfigPath());
	for (const file of new Set(changedFiles.map(changed => path.resolve(changed)))) {
		if (file === configStore) continue;
		// Only the coding-agent package's own tree is host code. The watcher is
		// shared with user plugins, whose files are reloadable session state —
		// requesting a host restart for those would be wrong.
		if (!isWithin(file, HOST_PACKAGE_ROOT)) continue;
		if (records.some(record => isWithin(file, record.packageDir))) continue;
		requestHostRestart({
			file,
			reason: "the change is outside every host plugin package (host module)",
		});
	}
}

/** The package that contains this runtime: its code is the host's static graph. */
const HOST_PACKAGE_ROOT = packageRootFor(import.meta.dir);

/** The nearest ancestor directory with a manifest, starting at `dir`. */
function packageRootFor(dir: string): string {
	let current = dir;
	for (let depth = 0; depth < 8; depth++) {
		if (fs.existsSync(path.join(current, "package.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dir;
}

/**
 * The packages one batch affects: any file inside the package directory, the
 * entry, or the manifest. Config-store changes are filtered separately by
 * effective value so an unrelated save cannot select a non-reloadable service.
 */
function selectAffected(
	records: readonly HostPluginRecord[],
	changedFiles: readonly string[] | undefined,
): HostPluginRecord[] {
	if (changedFiles === undefined) return [...records];
	if (changedFiles.length === 0) return [];
	const changed = new Set(changedFiles.map(file => path.resolve(file)));
	return records.filter(record => {
		if (changed.has(path.resolve(record.entryPath)) || changed.has(path.resolve(record.manifestPath))) {
			return true;
		}
		for (const file of changed) {
			if (isWithin(file, record.packageDir)) return true;
		}
		return false;
	});
}

async function selectConfigAffected(
	records: readonly HostPluginRecord[],
	readConfig: MountContext["readConfig"],
): Promise<HostPluginRecord[]> {
	const affected: HostPluginRecord[] = [];
	for (const record of records) {
		try {
			const { values } = await readConfig(record.entryPath);
			if (!Bun.deepEquals(values, record.mounted.config)) affected.push(record);
		} catch {
			affected.push(record);
		}
	}
	return affected;
}

/** Live fiber diagnostics for the extension center, keyed like its rows. */
export function inspectHostPlugins(): readonly HostPluginInspection[] {
	const current = state;
	if (!current) return [];
	return [...current.records.values()].map(record => {
		const fiber = record.mounted.extension.fiber;
		const state = fiber?.state;
		return {
			name: record.name,
			entryPath: record.entryPath,
			...(state === undefined ? {} : { fiberState: fiberStateName(state) }),
			effectLabels: state === FIBER_STATE_FAILED ? [] : (fiber?.getEffects?.() ?? []).map(effect => effect.label),
			...(record.error === undefined ? {} : { error: record.error }),
		};
	});
}

/**
 * Tear the host runtime down (tests, and a host that reloads its own
 * process-level plugins).
 *
 * Published services go first: nothing may resolve a name whose provider is
 * being unmounted. Process-wide registrations (memory backend providers) are
 * reclaimed synchronously before the fiber teardown is awaited, so a caller
 * that resets and immediately re-ensures observes a clean registry.
 */
export function resetHostPlugins(): Promise<void> {
	return withLifecycle(async () => {
		const current = state;
		state = undefined;
		if (!current) return;
		for (const record of current.records.values()) {
			for (const dispose of record.serviceDisposers.splice(0)) {
				try {
					dispose();
				} catch (error) {
					logger.warn("host plugin service unpublish failed", { error: String(error) });
				}
			}
			if (record.disposed) continue;
			for (const dispose of record.mounted.extension.memoryBackendProviders.splice(0)) {
				try {
					dispose();
				} catch (error) {
					logger.warn("host plugin memory backend cleanup failed", { error: String(error) });
				}
			}
			await disposePluginPrimitives(record.mounted.extension);
		}
		current.records.clear();
	});
}
