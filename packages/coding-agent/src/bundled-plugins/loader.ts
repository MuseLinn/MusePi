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
 * @module bundled-plugins/loader
 */

import * as path from "node:path";
import { logger } from "@musepi/pi-utils";
import { discoverBundledPluginPaths } from "../discovery/builtin";
import { ExtensionRuntime, loadExtensionFromFactory } from "../extensibility/extensions/loader";
import type { Extension } from "../extensibility/extensions/types";
import {
	isCordisPluginEntry,
	resolvePluginEntry,
	toFactory,
} from "../extensibility/plugins/runtime/cordis-entry";
import { provideHostService } from "../extensibility/plugins/runtime/host-services";
import { registerMagicKeyword } from "../modes/magic-keyword-registry";
import { EventBus } from "../utils/event-bus";

/**
 * Bundled packages whose prompt-host contributions are part of the core
 * session contract. They are readonly first-party prompt units (manifest
 * `host.readonly`, distribution-shipped, nothing user-removable) that only
 * `setLabel` + register on the session prompt host, and their sections —
 * delegation gates, file-tool guidance, browser/computer/LSP/host-integration
 * notes — must hold in every real session regardless of discovery options.
 * They are still mounted PER SESSION (each factory binds that session's
 * `ctx.promptHost`), never globally.
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

export interface BundledPluginLoader {
	ensure(cwd: string): Promise<boolean>;
	/** Forget the attempt and dispose what it mounted (`memoryBackendProviders`
	 *  and other registration disposers). */
	reset(): void;
}

/** Create an independently stateful loader. Concurrent callers share the same attempt. */
export function createBundledPluginLoader(
	discover: () => Promise<string[]> = discoverBundledPluginPaths,
	options: { publishProvidedServices?: boolean } = {},
): BundledPluginLoader {
	let loaded = false;
	let inFlight: Promise<void> | undefined;
	const mounted: Extension[] = [];
	const serviceDisposers: Array<() => void> = [];
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
						const capture: { published?: unknown } = {};
						const extension = await loadExtensionFromFactory(
							toFactory(resolved) as never,
							cwd,
							eventBus,
							runtime,
							entry,
							capture,
						);
						mounted.push(extension);
						// Host-scope packages publish their `provide` objects into the
						// process-wide registry (Cordis `apply` return contract).
						if (options.publishProvidedServices && isCordisPluginEntry(resolved)) {
							const payload = capture.published as Record<string, unknown> | undefined;
							for (const name of resolved.provide ?? []) {
								const service = payload?.[name];
								if (service === undefined) continue;
								serviceDisposers.push(provideHostService(name, service));
							}
						}
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
			for (const dispose of serviceDisposers.splice(0)) dispose();
			for (const extension of mounted.splice(0)) {
				for (const dispose of extension.memoryBackendProviders.splice(0)) dispose();
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
 * memory backend provider, a service — that a session-less RPC must also see,
 * so mounting them per session would register the same thing once per session.
 */
const hostPluginLoader = createBundledPluginLoader(() => discoverBundledPluginPaths({ scope: "host" }), {
	publishProvidedServices: true,
});

/** Mount the host-scope bundled packages once. Returns false after the shared attempt completed. */
export function ensureHostHalfPluginsLoaded(cwd: string): Promise<boolean> {
	return hostPluginLoader.ensure(cwd);
}

/** Test helper: forget the process-wide host loader state so a test can load again. */
export function resetHostHalfPluginsLoaded(): void {
	hostPluginLoader.reset();
}
