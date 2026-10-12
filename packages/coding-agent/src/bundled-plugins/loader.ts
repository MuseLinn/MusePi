/**
 * Loader for the bundled plugin packages.
 *
 * The first-party units that ship in plugin form (currently the magic-keywords
 * trio) live in `src/bundled-plugins/<name>/`, and the bundled CLI copies the
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

import { logger } from "@musepi/pi-utils";
import { discoverBundledPluginPaths } from "../discovery/builtin";
import { ExtensionRuntime, loadExtensionFromFactory } from "../extensibility/extensions/loader";
import { registerMagicKeyword } from "../modes/magic-keyword-registry";
import { EventBus } from "../utils/event-bus";

let loaded = false;

/**
 * Load every bundled plugin package once, registering what they contribute.
 *
 * Fail-soft per package: a bundled package that fails to load is logged, not
 * thrown — a first-party packaging mistake must not take the session down with
 * it. Returns whether any load ran (false when already loaded).
 */
export async function ensureBundledPluginsLoaded(cwd: string): Promise<boolean> {
	if (loaded) return false;
	loaded = true;
	const paths = await discoverBundledPluginPaths();
	const eventBus = new EventBus();
	for (const entry of paths) {
		try {
			// A file URL so the dynamic import works with Windows drive paths.
			const mod = (await import(`file:///${entry.replaceAll("\\", "/")}`)) as { default: unknown };
			const runtime = new ExtensionRuntime();
			await loadExtensionFromFactory(mod.default as never, cwd, eventBus, runtime, entry);
			for (const keyword of runtime.pendingMagicKeywordRegistrations) {
				registerMagicKeyword(keyword);
			}
		} catch (error) {
			logger.warn("bundled plugin package failed to load", { entry, error: String(error) });
		}
	}
	return true;
}

/** Test helper: forget the one-shot flag so a test can load again. */
export function resetBundledPluginsLoaded(): void {
	loaded = false;
}
