/**
 * Session-level plugin loading, on the same pipeline as the host-level runtime.
 *
 * A session used to load its plugins through the legacy extension loader. That is
 * a second implementation of the same job, and it drifted: the two paths
 * disagreed about which module shapes count as a plugin, so a plugin written as a
 * class loaded at the host level and threw "cannot be invoked without 'new'" at
 * the session level — the same file, two answers, and the failure surfaced as a
 * log line from the loader its author was not using.
 *
 * This walks the SAME {@link mountPlugin} the cordis runtime uses, so a plugin's
 * shape, its declared dependencies, its config and its registration ledger mean
 * one thing wherever it loads. What differs is only the CONTEXT: a session binds
 * its own `ExtensionAPI` (cwd, event bus, runtime), because an extension instance
 * closes over those and sharing one across sessions would route a tool back
 * through the wrong session.
 *
 * Session policy stays in this module rather than in the mount pipeline:
 *
 * - the compatibility gate (a plugin whose declared condition does not hold is
 *   skipped, not errored — the condition is how it says "not in this
 *   configuration"), and
 * - the `ExtensionRuntime` the rest of the host reads, which is where a plugin's
 *   queued provider / media-provider / design-system registrations land.
 */

import * as path from "node:path";
import { logger } from "@musepi/pi-utils";
import type { PromptHostSurface } from "../../../prompts/host";
import type { EventBus } from "../../../utils/event-bus";
import { enablementAllowsPath } from "../../enablement-manifest";
import { ExtensionRuntime } from "../../extensions/loader";
import type { Extension, LoadExtensionsResult } from "../../extensions/types";
import { readCompatibilityExemptions, resolveCompatibilityPath } from "../compat/compatibility-store";
import { compatibilityGateForExtensionPath, pluginCompatibilityWarning } from "../compat/plugin-compatibility";
import { disposePluginPrimitives } from "./cordis-primitives";
import type { MountContext } from "./mount";
import { mountPlugin } from "./mount";

/** What a session load may vary. */
export interface SessionPluginLoadOptions {
	/** Re-evaluate the module instead of reusing the process-wide instance (HMR). */
	fresh?: boolean;
	/** Disabled component ids, spelled `<plugin>/<component>`. */
	disabledComponents?: ReadonlySet<string>;
	/**
	 * Reads a plugin's declared config. Defaults to the plugin config store; a
	 * caller with its own settings source can substitute it.
	 */
	readConfig?: MountContext["readConfig"];
	/**
	 * The owning session's prompt host, carried on the runtime so factories
	 * reach it through `pi.promptHost`. Absent when no session is wiring one.
	 */
	promptHost?: PromptHostSurface;
	/**
	 * Mount into an existing runtime instead of a fresh one. The preload path
	 * (CLI `preloadedExtensions`) reuses the caller's runtime so the core
	 * prompt packages' registrations land in the same pending queues and
	 * prompt-host ledgers the session will drain; the default stays a new
	 * runtime so unrelated loads never share lifecycle state.
	 */
	runtime?: LoadExtensionsResult["runtime"];
}

/**
 * Process-wide cache of session plugin loads, keyed by cwd + entry list.
 *
 * dsh mounts a preset once and lets every session of that preset join its
 * scope. The equivalent here is the `(cwd, entry set)` pair, because a plugin
 * instance captures `cwd` at apply time; session-bound work (listeners, prompt
 * contributions, effects) is owned by the session scope, so one instance set
 * can serve several sessions without cross-talk.
 *
 * Inline factory extensions never reach this cache: they are per-session by
 * construction and are loaded by the caller.
 */
interface CachedSessionLoad {
	readonly result: LoadExtensionsResult;
	/** Live sessions joined to this generation. A retired generation is kept
	 *  alive for them and disposed when the last one releases (dsh preset GC). */
	users: number;
	retired: boolean;
	/** Registrations queued during the first load, replayed to every session
	 *  that acquires the cache entry. A session may carry its own ModelRegistry,
	 *  so draining once would leave the second session without them. */
	readonly pending: {
		providers: LoadExtensionsResult["runtime"]["pendingProviderRegistrations"];
		media: LoadExtensionsResult["runtime"]["pendingMediaProviderRegistrations"];
		design: LoadExtensionsResult["runtime"]["pendingDesignSystemRegistrations"];
	};
}

const sessionLoadCache = new Map<string, Promise<CachedSessionLoad>>();

/** Extensions owned by a cached generation. A per-session reload must not
 *  dispose one another live session is still using. */
const sharedExtensions = new WeakSet<Extension>();

/** Whether this instance belongs to a cached (cross-session) generation. */
export function isSharedSessionExtension(extension: Extension): boolean {
	return sharedExtensions.has(extension);
}

async function disposeCachedGeneration(entry: CachedSessionLoad): Promise<void> {
	for (const extension of entry.result.extensions) await disposePluginPrimitives(extension);
}

/**
 * Retire the generation that owns `extension` (a per-session reload or
 * removal). New sessions load a fresh generation; sessions already joined keep
 * the old one until they release, then it is disposed.
 */
export function retireSessionPluginGeneration(extension: Extension): void {
	for (const [key, pending] of sessionLoadCache) {
		void pending
			.then(entry => {
				if (!entry.result.extensions.includes(extension)) return;
				sessionLoadCache.delete(key);
				entry.retired = true;
				if (entry.users === 0) void disposeCachedGeneration(entry);
			})
			.catch(() => {});
	}
}

/** Cache identity for one session load. The cwd is load-bearing: plugins
 *  capture it in `apply`. */
export function sessionPluginCacheKey(paths: readonly string[], cwd: string): string {
	return `${path.resolve(cwd)}\u0000${[...paths]
		.map(entry => path.resolve(entry))
		.sort()
		.join("\u0000")}`;
}

/** Drop every cached load (tests, and a full plugin-set change). */
export function clearSessionPluginCache(): void {
	sessionLoadCache.clear();
}

/**
 * Load the session's plugins, reusing a previous load for the same
 * `(cwd, entry set)`.
 *
 * `fresh` and a caller-supplied runtime bypass the cache: both mean "this load
 * must be its own instance" (HMR re-evaluation, the CLI preload).
 */
export interface CachedSessionPluginLoad {
	result: LoadExtensionsResult;
	/** Leave this generation. The last user of a retired generation disposes it. */
	release(): void;
}

export async function loadSessionPluginsCached(
	paths: readonly string[],
	cwd: string,
	eventBus: EventBus,
	options: SessionPluginLoadOptions = {},
): Promise<CachedSessionPluginLoad> {
	if (options.fresh === true || options.runtime !== undefined) {
		return { result: await loadSessionPlugins(paths, cwd, eventBus, options), release: () => {} };
	}
	const key = sessionPluginCacheKey(paths, cwd);
	let pending = sessionLoadCache.get(key);
	if (!pending) {
		pending = (async () => {
			const result = await loadSessionPlugins(paths, cwd, eventBus, options);
			for (const extension of result.extensions) sharedExtensions.add(extension);
			return {
				result,
				users: 0,
				retired: false,
				pending: {
					providers: [...result.runtime.pendingProviderRegistrations],
					media: [...result.runtime.pendingMediaProviderRegistrations],
					design: [...result.runtime.pendingDesignSystemRegistrations],
				},
			};
		})();
		sessionLoadCache.set(key, pending);
		// A load that throws is not cached; the next session retries.
		pending.catch(() => sessionLoadCache.delete(key));
	}
	const entry = await pending;
	entry.users += 1;
	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		entry.users = Math.max(0, entry.users - 1);
		if (entry.users === 0 && entry.retired) void disposeCachedGeneration(entry);
	};
	// Refill the queues: a session with its own ModelRegistry must still see
	// the registrations, and `sdk` drains them per session.
	entry.result.runtime.pendingProviderRegistrations = [...entry.pending.providers];
	entry.result.runtime.pendingMediaProviderRegistrations = [...entry.pending.media];
	entry.result.runtime.pendingDesignSystemRegistrations = [...entry.pending.design];
	return { result: entry.result, release };
}

/**
 * Load plugin entries for one session.
 *
 * Failures are collected rather than thrown: one malformed plugin must not cost
 * the session every other plugin it had.
 */
export async function loadSessionPlugins(
	paths: readonly string[],
	cwd: string,
	eventBus: EventBus,
	options: SessionPluginLoadOptions = {},
): Promise<LoadExtensionsResult> {
	// The runtime is constructed up front because every mount registers into
	// it; a caller-injected runtime (preload path) replaces the fresh one so
	// its pending queues and ledgers stay the session's single source.
	const runtime = options.runtime ?? new ExtensionRuntime();
	runtime.promptHost = options.promptHost;
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];

	const admissible = await sessionAdmissiblePaths(paths, errors);
	if (admissible.length === 0) return { extensions, errors, runtime };

	const readConfig = options.readConfig ?? (await defaultSessionConfigReader());
	for (const entryPath of admissible) {
		// No `wrapApi`: `mountPlugin` builds the API itself from `ctx.runtime`,
		// `cwd` and `eventBus` — the three things that make this the SESSION's
		// plugin rather than a shared one. Overriding it here would hand the
		// plugin a second API that bypasses the cordis primitives.
		const mounted = await mountPlugin({
			entryPath,
			cwd,
			eventBus,
			runtime: runtime as unknown as MountContext["runtime"],
			readConfig,
			fresh: options.fresh === true,
		});
		if (!mounted.ok) {
			errors.push({ path: entryPath, error: `${mounted.code}: ${mounted.message}` });
			continue;
		}
		extensions.push(mounted.extension);
	}

	return { extensions, errors, runtime };
}

/** Apply the session's pre-flight policy: enablement condition + compatibility. */
async function sessionAdmissiblePaths(
	paths: readonly string[],
	errors: Array<{ path: string; error: string }>,
): Promise<string[]> {
	if (paths.length === 0) return [];
	const { exemptions, warnings } = readCompatibilityExemptions(resolveCompatibilityPath());
	for (const warning of warnings) logger.warn(warning);
	const admissible: string[] = [];
	for (const entryPath of paths) {
		// Checked before any import, so a gated-out plugin never runs code.
		if (!(await enablementAllowsPath(entryPath))) continue;
		const gate = await compatibilityGateForExtensionPath(entryPath, exemptions);
		if (gate && gate.status !== "exempted") {
			errors.push({ path: entryPath, error: pluginCompatibilityWarning(gate) });
			continue;
		}
		if (gate) logger.warn("compatibility exemption active, loading anyway", { path: entryPath });
		admissible.push(entryPath);
	}
	return admissible;
}

/** The default config reader: the plugin's declared fields, filled from the store. */
export async function defaultSessionConfigReader(): Promise<MountContext["readConfig"]> {
	const [
		{ readPluginConfigStore },
		{ coerceConfigValues },
		{ readExtensionPluginMeta },
		{ getExtensionNameFromPath },
	] = await Promise.all([
		import("../../extensions-center/plugin-config-store"),
		import("@musepi/pi-wire"),
		import("../../extensions/plugin-manifest"),
		import("../../../discovery/helpers"),
	]);
	return async entryPath => {
		const meta = await readExtensionPluginMeta(entryPath);
		const store = await readPluginConfigStore();
		const id = `extension-module:${getExtensionNameFromPath(entryPath)}`;
		const fields = meta?.fields ?? [];
		return { fields, values: coerceConfigValues(fields, store[id]) };
	};
}
