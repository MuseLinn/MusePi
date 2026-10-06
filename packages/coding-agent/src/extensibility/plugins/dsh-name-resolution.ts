/**
 * Resolve the package names a DSH bundle declares to installed plugins here.
 *
 * A DSH `cordis.patch.yml` row names its plugin by npm package name —
 * `@deepseek-ai/dsh-plugin-manager/tools` — because the Loader imports that
 * package. This host locates a plugin by the directory it was installed into,
 * so a name has to become a path before anything else in the file can be read.
 *
 * The installed set is not read from the filesystem here. `getEnabledPlugins`
 * already enumerates both plugin roots with the project's entries shadowing the
 * user's, caches the result, and applies each plugin's own enable state; a second
 * walk would have to reproduce all of that and would drift the moment any of it
 * changed. A name that resolves to a disabled plugin is deliberately not
 * resolved — the compatibility layer reports it instead, because "installed but
 * switched off" is a decision the person made and not a missing dependency.
 *
 * @module extensibility/plugins/dsh-name-resolution
 */

import { getAllPlugins, getEnabledPlugins } from "./loader";

/** What a name resolved to, and why when it did not. */
export type PluginNameResolution =
	| { readonly status: "resolved"; readonly pluginPath: string; readonly scope: "user" | "project" }
	| { readonly status: "not-installed" }
	| { readonly status: "disabled" };

/**
 * Resolve one package name against the installed plugins.
 *
 * Matching is exact. DSH names are npm package names and this host installs by
 * them, so a prefix or substring match would resolve a name to a plugin that is
 * merely similar — and a bundle row applied to the wrong plugin is worse than
 * one that went unapplied.
 *
 * @param name - the package name the bundle declares.
 * @param cwd - the project directory whose plugin root applies.
 * @param home - pins the user plugins root; tests pass a temp dir.
 * @returns where the plugin is, or why it could not be used.
 */
export async function resolvePluginName(name: string, cwd: string, home?: string): Promise<PluginNameResolution> {
	const enabled = await getEnabledPlugins(cwd, home ? { home } : {});
	const match = enabled.find(plugin => plugin.name === name);
	if (match) {
		return { status: "resolved", pluginPath: match.path, scope: match.scope };
	}

	// It may be installed but switched off. Enumerating everything to say so
	// costs a second scan of both roots, so this asks the question the cheapest
	// way that can answer it rather than reporting "not installed" for a plugin
	// that is sitting in the directory.
	const all = await getAllPlugins(cwd, home ? { home } : {});
	const disabled = all.find(plugin => plugin.name === name);
	return disabled ? { status: "disabled" } : { status: "not-installed" };
}

/**
 * Resolve every name a bundle declares, keeping the order they were declared in.
 *
 * @param names - the package names, possibly repeated across patch layers.
 * @param cwd - the project directory whose plugin root applies.
 * @param home - pins the user plugins root.
 * @returns one resolution per distinct name, first occurrence order.
 */
export async function resolvePluginNames(
	names: readonly string[],
	cwd: string,
	home?: string,
): Promise<{ name: string; resolution: PluginNameResolution }[]> {
	const seen = new Set<string>();
	const distinct: string[] = [];
	for (const name of names) {
		if (seen.has(name)) continue;
		seen.add(name);
		distinct.push(name);
	}
	const resolutions = await Promise.all(distinct.map(name => resolvePluginName(name, cwd, home)));
	return distinct.map((name, index) => ({ name, resolution: resolutions[index] as PluginNameResolution }));
}
