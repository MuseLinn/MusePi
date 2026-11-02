/** File resources contributed by active MusePi Cordis plugin packages. */
import * as path from "node:path";
import { loadCapability, registerProvider } from "../capability";
import { type ExtensionModule, extensionModuleCapability, PLUGIN_MODULE_KIND } from "../capability/extension-module";
import { type Skill, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { readExtensionPluginPackage } from "../extensibility/extensions/plugin-manifest";
import { scanSkillsFromDir } from "./helpers";

const PROVIDER_ID = "musepi-plugins";

/**
 * Discover package-local skills without copying them into the user's skill directory.
 * The capability's extension ID is the package name, so disabling the Cordis package
 * also removes every file skill it owns from agent discovery and management lists.
 */
async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const modules = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
		cwd: ctx.cwd,
		includeDisabled: true,
	});
	const packages = new Map<string, { name: string; root: string; level: ExtensionModule["level"] }>();
	for (const module of modules.all) {
		if (module.track !== PLUGIN_MODULE_KIND) continue;
		const pkg = await readExtensionPluginPackage(module.path);
		if (!pkg || packages.has(pkg.root)) continue;
		packages.set(pkg.root, { ...pkg, level: module.level });
	}

	const scans = await Promise.all(
		[...packages.values()].map(async pkg => ({
			pkg,
			result: await scanSkillsFromDir(ctx, {
				dir: path.join(pkg.root, "skills"),
				providerId: PROVIDER_ID,
				level: pkg.level === "project" ? "project" : "user",
				requireDescription: true,
			}),
		})),
	);
	return {
		items: scans.flatMap(({ pkg, result }) =>
			result.items.map(skill => ({
				...skill,
				pluginId: pkg.name,
				containRoot: pkg.root,
				_source: { ...skill._source, level: pkg.level },
			})),
		),
		warnings: scans.flatMap(({ result }) => result.warnings ?? []),
	};
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: "MusePi Plugin Packages",
	description: "File skills and resources inside Cordis plugin packages",
	priority: 85,
	load: loadSkills,
});
