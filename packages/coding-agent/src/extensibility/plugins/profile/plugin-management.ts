import * as path from "node:path";
import { getActiveProfile, getPluginsDir } from "@musepi/pi-utils";
import { parsePluginExperimental } from "@musepi/pi-wire";
import { readInstalledPluginsRegistry } from "../marketplace/registry";
import { parsePluginId } from "../marketplace/types";
import { getAllPlugins } from "../runtime/loader";
import { listInstalledBundles, profileDirFor, readProfileComposition } from "./profile-composition";

export interface PluginManagementPackage {
	name: string;
	version: string;
	path: string;
	scope: "user" | "project";
	enabled: boolean;
	description: string | null;
	experimental?: boolean;
	icon: string | null;
	tools: number;
	commands: number;
	handlers: number;
	management: "package" | "bundle";
	/** Which track mounts this row, and therefore which store owns the
	 *  enablement the row reports: `cordis` rows carry the profile's bundle
	 *  selection (`bundles.setBundleEnabled`), `extension` rows carry the
	 *  runtime lockfile flag (`plugins.setEnabled`). Derived from `management`
	 *  rather than stored twice — `management` already means "which store said
	 *  yes". A package that is also a bundle lists as a bundle, so its row
	 *  reports bundle selection while its extension entries still follow the
	 *  lockfile. */
	track: "cordis" | "extension";
	readable?: boolean;
	/** Host fact (`removable`): whether this row may be uninstalled. A
	 *  project-scope plain package has no uninstall path here; a bundle can
	 *  always at least be deselected from the profile composition. */
	removable: boolean;
	/** Why the row has no removal affordance (`removable === false`). */
	removeBlockedReason?: "project-scope" | "missing";
	/** Marketplace id when the package came from one; removal must clear that
	 *  registry too, not only the npm tree. */
	marketplace?: string;
}

/** Package name → marketplace identity, read from the installed registries. */
async function marketplacePackagesByName(
	home: string,
	cwd: string,
): Promise<Map<string, { marketplace: string; scope: "user" | "project" }>> {
	const out = new Map<string, { marketplace: string; scope: "user" | "project" }>();
	const { resolveOrDefaultProjectRegistryPath } = await import("../../../discovery/helpers");
	const registryPath = path.join(getPluginsDir(home), "installed_plugins.json");
	const projectPath = await resolveOrDefaultProjectRegistryPath(cwd);
	const read = async (file: string | undefined, scope: "user" | "project"): Promise<void> => {
		if (!file) return;
		const registry = await readInstalledPluginsRegistry(file);
		for (const [id, entries] of Object.entries(registry.plugins)) {
			const parsed = parsePluginId(id);
			if (!parsed) continue;
			for (const entry of entries) {
				try {
					const pkg = (await Bun.file(path.join(entry.installPath, "package.json")).json()) as {
						name?: unknown;
					};
					if (typeof pkg.name === "string" && pkg.name.length > 0) {
						out.set(pkg.name, { marketplace: parsed.marketplace, scope });
					}
				} catch {
					// A registry entry whose cache was pruned names nothing we can map;
					// the row still lists from its installed package name.
				}
			}
		}
	};
	await read(registryPath, "user");
	await read(projectPath, "project");
	return out;
}

/** One row of another track's listing, as the merge below receives it. */
export interface ComposedRowLike {
	id: string;
	name: string;
	state: "enabled" | "disabled" | "conditional";
	group: boolean;
	layers: readonly string[];
	pluginPath: string | null;
	mountable: boolean;
}

/** One row of the merged, two-track plugin list. */
export interface PluginTrackRow {
	/** Stable id used by set_plugin. For `cordis` rows this is the composition
	 *  id; for `extension` rows the package name, which is also the lockfile
	 *  key that owns its enablement. */
	id: string;
	/** The npm package the row names. */
	name: string;
	state: "enabled" | "disabled" | "conditional";
	group: boolean;
	/** Bundles/layers that contributed the row. Empty for `extension` rows,
	 *  which no profile layer composes. */
	layers: string[];
	pluginPath: string | null;
	mountable: boolean;
	/**
	 * Which track owns this row's enablement, and therefore where set_plugin
	 * writes: `cordis` rows carry the profile's bundle selection and its patch
	 * overrides, `extension` rows carry `musepi-plugins.lock.json`. Only a
	 * `cordis` row can report `conditional`.
	 */
	track: "cordis" | "extension";
}

/**
 * One list covering both tracks.
 *
 * The two tracks keep enablement in different stores — a cordis row in the
 * profile's bundle selection and patch, an extension package in
 * `musepi-plugins.lock.json` — so a list built from one store hides the other
 * track's packages entirely. They install, they run, and nothing lists them.
 *
 * Rows are keyed by package name, the only identity both stores share. A name
 * that appears in both keeps the composed row: bundle selection is the narrower
 * fact, and its `conditional` state is information an extension row cannot
 * express. Extension packages no composed row covers are appended in inventory
 * order, toggled by package name (their lockfile key is the identity).
 */
export function mergePluginTrackRows(
	composed: readonly ComposedRowLike[],
	packages: readonly PluginManagementPackage[],
): PluginTrackRow[] {
	const rows: PluginTrackRow[] = composed.map(row => ({
		...row,
		layers: [...row.layers],
		track: "cordis" as const,
	}));
	const covered = new Set(rows.map(row => row.name));
	for (const pkg of packages) {
		if (pkg.track !== "extension" || covered.has(pkg.name)) continue;
		rows.push({
			id: pkg.name,
			name: pkg.name,
			state: pkg.enabled ? "enabled" : "disabled",
			group: false,
			layers: [],
			pluginPath: pkg.path,
			mountable: pkg.enabled,
			track: "extension",
		});
	}
	return rows;
}

/**
 * The identity `plugins.uninstall` needs for one package, read from its row.
 *
 * A marketplace install has to clear its own registry, not just the npm tree:
 * without the marketplace id the `installed_plugins.json` entry survives and
 * points at a cache directory that no longer exists. The listing row carries
 * the origin and scope, so removal re-reads them instead of guessing.
 *
 * Returns no marketplace field for a package that did not come from one, which
 * is the correct instruction: `uninstall` then removes the npm entry alone.
 */
export function uninstallIdentityOf(
	row: Pick<PluginManagementPackage, "name" | "scope" | "management" | "marketplace"> | undefined,
	name: string,
): {
	name: string;
	marketplace?: string;
	scope?: "user" | "project";
	management?: "package" | "bundle";
} {
	if (row === undefined) return { name };
	return {
		name,
		...(row.marketplace !== undefined ? { marketplace: row.marketplace, scope: row.scope } : {}),
		management: row.management,
	};
}

/** Package/bundle cards share one management feed; missing selected bundles stay visible. */
export async function listPluginManagementPackages(
	cwd: string,
	home: string,
	profileName?: string,
): Promise<PluginManagementPackage[]> {
	const profile = profileName ?? getActiveProfile() ?? "";
	const [installed, composition, marketplaceByName] = await Promise.all([
		getAllPlugins(cwd, { home }),
		readProfileComposition(profile, home),
		marketplacePackagesByName(home, cwd),
	]);
	const bundles = await listInstalledBundles(profileDirFor(profile, home), home);
	const rows = new Map<string, PluginManagementPackage>();
	for (const plugin of installed) {
		const marketplace = marketplaceByName.get(plugin.name);
		rows.set(plugin.name, {
			name: plugin.name,
			version: plugin.version,
			path: plugin.path,
			scope: plugin.scope,
			enabled: plugin.enabled,
			description: plugin.manifest.description ?? null,
			...(parsePluginExperimental(plugin.manifest.experimental) ? { experimental: true } : {}),
			icon: plugin.manifest.icon ?? null,
			tools: plugin.manifest.tools ? 1 : 0,
			commands: Array.isArray(plugin.manifest.commands)
				? plugin.manifest.commands.length
				: plugin.manifest.commands
					? 1
					: 0,
			handlers:
				typeof plugin.manifest.hooks === "string"
					? 1
					: plugin.manifest.hooks
						? Object.keys(plugin.manifest.hooks).length
						: 0,
			management: "package",
			track: "extension",
			...(marketplace ? { marketplace: marketplace.marketplace } : {}),
			...(plugin.scope === "user" || marketplace !== undefined
				? { removable: true }
				: { removable: false, removeBlockedReason: "project-scope" as const }),
		});
	}
	const selectedOrder = composition.kind === "ok" ? composition.composition.bundles : [];
	const orderedBundles = [...bundles].sort((a, b) => {
		const aIndex = a.selected ? selectedOrder.indexOf(a.name) : Number.MAX_SAFE_INTEGER;
		const bIndex = b.selected ? selectedOrder.indexOf(b.name) : Number.MAX_SAFE_INTEGER;
		return aIndex - bIndex || a.name.localeCompare(b.name);
	});
	for (const bundle of orderedBundles) {
		const existing = rows.get(bundle.name);
		const marketplace = marketplaceByName.get(bundle.name);
		rows.set(bundle.name, {
			name: bundle.name,
			version: bundle.version || existing?.version || "",
			path: bundle.path ?? existing?.path ?? "",
			scope: marketplace?.scope ?? existing?.scope ?? "user",
			enabled: bundle.selected,
			description: bundle.description ?? existing?.description ?? null,
			...(bundle.experimental || existing?.experimental ? { experimental: true } : {}),
			icon: existing?.icon ?? null,
			tools: existing?.tools ?? 0,
			commands: existing?.commands ?? 0,
			handlers: existing?.handlers ?? 0,
			management: "bundle",
			track: "cordis",
			readable: bundle.readable,
			// A selected bundle is removable by deselecting it; an installed but
			// unselected one by uninstalling the package. A selected name with
			// neither files nor a package still has a removal (deselect).
			removable: bundle.path !== null || bundle.selected,
			...(bundle.path === null && !bundle.selected ? { removeBlockedReason: "missing" as const } : {}),
			...(marketplace ? { marketplace: marketplace.marketplace } : {}),
		});
	}
	if (composition.kind === "unreadable") {
		for (const row of rows.values()) {
			if (row.management === "bundle") row.readable = false;
		}
	}
	return [...rows.values()];
}
