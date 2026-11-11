/**
 * Loader for the bundled plugin packages.
 *
 * The first-party units that ship in plugin form live in
 * `src/bundled-plugins/<name>/`, and the bundled CLI copies the
 * tree to `./bundled-plugins`. Discovery finds them like any plugin; this
 * module additionally offers a one-shot idempotent load, so a host that wants
 * the first-party contributions guaranteed — regardless of whether extension
 * discovery ran — can call it before reading the registry.
 *
 * Idempotence matters because two callers (session bootstrap and an extension
 * scan) may both reach for it: loading twice would register twice and
 * double-fire notices. The flag is process-level, matching the registry's own
 * lifetime.
 *
 * Host-scope packages (`musepi.scope: "host"`) are not mounted here: their
 * `apply` registers process-wide facts, so they run on the cordis host runtime
 * (`extensibility/plugins/runtime/host-runtime.ts`) once per process.
 *
 * @module bundled-plugins/loader
 */

import * as path from "node:path";
import { logger } from "@musepi/pi-utils";
import { discoverBundledPluginPaths } from "../discovery/builtin";
import { ExtensionRuntime, loadExtensionFromFactory } from "../extensibility/extensions/loader";
import type { Extension } from "../extensibility/extensions/types";
import { resolvePluginEntry, toFactory } from "../extensibility/plugins/runtime/cordis-entry";
import { disposePluginPrimitives } from "../extensibility/plugins/runtime/cordis-primitives";
import { ensureHostPlugins, resetHostPlugins } from "../extensibility/plugins/runtime/host-runtime";
import { registerMagicKeyword } from "../modes/magic-keyword-registry";
import { EventBus } from "../utils/event-bus";

/**
 * Bundled packages whose prompt-host contributions are part of the core
 * session contract. They are readonly first-party prompt units (manifest
 * `host.readonly`, distribution-shipped, nothing user-removable) that only
 * `setLabel` + register on the session prompt host, and their sections —
 * delegation gates, file-tool guidance, browser/computer/LSP/host-integration
 * notes — must hold in every real session regardless of discovery options.
 * The factory is mounted once per `(cwd, entry set)`; each session re-registers
 * these contributions in `session_start` against its own `ctx.promptHost`.
 */
const SESSION_PROMPT_PACKAGE_DIRS: ReadonlySet<string> = new Set([
	"delegation",
	"file-tools",
	"browser",
	"computer",
	"lsp",
	"host-integrations",
]);

/**
 * Entry paths of the six readonly core prompt packages, so a session can bind
 * them to its own prompt host even when discovery is disabled or the caller
 * preloaded without one.
 *
 * Filtered from {@link discoverBundledPluginPaths} by package directory name:
 * bundled copies keep the `<root>/<package>/` layout in every distribution
 * shape (source tree, staged `./bundled-plugins`, packaged roots).
 */
export async function discoverBundledSessionPromptPluginPaths(): Promise<string[]> {
	const paths = await discoverBundledPluginPaths();
	return paths.filter(entryPath => SESSION_PROMPT_PACKAGE_DIRS.has(path.basename(path.dirname(entryPath))));
}

/**
 * Coerce the values of one bundled package's declared `musepi.config` fields,
 * the same read `ctx.config` performs (one store, one id scheme).
 */
async function readDeclaredConfig(entry: string): Promise<Record<string, unknown>> {
	const [
		{ readExtensionPluginMeta },
		{ readPluginConfigStore },
		{ coerceConfigValues },
		{ getExtensionNameFromPath },
	] = await Promise.all([
		import("../extensibility/extensions/plugin-manifest"),
		import("../extensibility/extensions-center/plugin-config-store"),
		import("@musepi/pi-wire"),
		import("../discovery/helpers"),
	]);
	const meta = await readExtensionPluginMeta(entry);
	if (!meta || meta.fields.length === 0) return {};
	const store = await readPluginConfigStore();
	const id = `extension-module:${getExtensionNameFromPath(entry)}`;
	return coerceConfigValues(meta.fields, store[id]);
}

export interface BundledPluginLoader {
	ensure(cwd: string): Promise<boolean>;
	/** Forget the attempt and dispose what it mounted (`memoryBackendProviders`
	 *  and other registration disposers). */
	reset(): void;
}

/** Create an independently stateful loader. Concurrent callers share the same attempt. */
export function createBundledPluginLoader(
	discover: () => Promise<string[]> = discoverBundledPluginPaths,
): BundledPluginLoader {
	let loaded = false;
	let inFlight: Promise<void> | undefined;
	const mounted: Extension[] = [];
	return {
		ensure: async cwd => {
			if (loaded) return false;
			if (inFlight) {
				await inFlight;
				return false;
			}
			const pending = (async () => {
				const paths = await discover();
				const eventBus = new EventBus();
				for (const entry of paths) {
					try {
						// A file URL so the dynamic import works with Windows drive paths.
						const mod = (await import(`file:///${entry.replaceAll("\\", "/")}`)) as { default: unknown };
						const resolved = resolvePluginEntry(mod as never);
						if (resolved === null) {
							throw new Error(`bundled plugin exports nothing loadable: ${entry}`);
						}
						const runtime = new ExtensionRuntime();
						const extension = await loadExtensionFromFactory(
							toFactory(resolved) as never,
							cwd,
							eventBus,
							runtime,
							entry,
							undefined,
							await readDeclaredConfig(entry),
						);
						mounted.push(extension);
						for (const keyword of runtime.pendingMagicKeywordRegistrations) {
							registerMagicKeyword(keyword);
						}
					} catch (error) {
						logger.warn("bundled plugin package failed to load", { entry, error: String(error) });
					}
				}
			})();
			inFlight = pending;
			try {
				await pending;
				loaded = true;
				return true;
			} catch (error) {
				if (inFlight === pending) inFlight = undefined;
				throw error;
			}
		},
		reset: () => {
			for (const extension of mounted.splice(0)) {
				for (const dispose of extension.memoryBackendProviders.splice(0)) dispose();
				// The same ledger the cordis mount uses: a bundled plugin's
				// watcher/socket is reclaimed here instead of leaking until exit.
				void disposePluginPrimitives(extension);
			}
			loaded = false;
			inFlight = undefined;
		},
	};
}

const bundledPluginLoader = createBundledPluginLoader();

/** Load bundled packages once. Returns false after the shared attempt has already completed. */
export function ensureBundledPluginsLoaded(cwd: string): Promise<boolean> {
	return bundledPluginLoader.ensure(cwd);
}

/** Test helper: forget the process-wide loader state so a test can load again. */
export function resetBundledPluginsLoaded(): void {
	bundledPluginLoader.reset();
}

/**
 * Host-scope packages (`musepi.scope: "host"`) mount once per host process,
 * before the first session. Their `apply` registers process-wide facts — a
 * memory backend provider, a service — that a session-less RPC must also see.
 * They run on the cordis host runtime rather than this session loader: one
 * `apply` per process is the registry's requirement, and a fiber per package
 * is what reclaims those registrations when the host tears them down.
 */
export function ensureHostHalfPluginsLoaded(cwd: string): Promise<boolean> {
	return ensureHostPlugins(cwd);
}

/** Test helper: tear down the process-wide host runtime so a test can mount again. */
export function resetHostHalfPluginsLoaded(): Promise<void> {
	return resetHostPlugins();
}
