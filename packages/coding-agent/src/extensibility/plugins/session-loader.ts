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

import { logger } from "@musepi/pi-utils";
import type { EventBus } from "../../utils/event-bus";
import { enablementAllowsPath } from "../enablement-manifest";
import { ExtensionRuntime } from "../extensions/loader";
import type { Extension, LoadExtensionsResult } from "../extensions/types";
import { readCompatibilityExemptions, resolveCompatibilityPath } from "./compatibility-store";
import type { MountContext } from "./mount";
import { mountPlugin } from "./mount";
import { compatibilityGateForExtensionPath, pluginCompatibilityWarning } from "./plugin-compatibility";

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
	// The runtime is constructed up front because every mount registers into it.
	const runtime = new ExtensionRuntime();
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];

	const admissible = await sessionAdmissiblePaths(paths, errors);
	if (admissible.length === 0) return { extensions, errors, runtime };

	const readConfig = options.readConfig ?? (await defaultConfigReader());
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
async function defaultConfigReader(): Promise<MountContext["readConfig"]> {
	const [
		{ readPluginConfigStore },
		{ coerceConfigValues },
		{ readExtensionPluginMeta },
		{ getExtensionNameFromPath },
	] = await Promise.all([
		import("../extensions-center/plugin-config-store"),
		import("@musepi/pi-wire"),
		import("../extensions/plugin-manifest"),
		import("../../discovery/helpers"),
	]);
	return async entryPath => {
		const meta = await readExtensionPluginMeta(entryPath);
		const store = await readPluginConfigStore();
		const id = `extension-module:${getExtensionNameFromPath(entryPath)}`;
		const fields = meta?.fields ?? [];
		return { fields, values: coerceConfigValues(fields, store[id]) };
	};
}
