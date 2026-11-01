import { getActiveProfile } from "@musepi/pi-utils";
import { getAllPlugins } from "../runtime/loader";
import { listInstalledBundles, profileDirFor, readProfileComposition } from "./profile-composition";

export interface PluginManagementPackage {
	name: string;
	version: string;
	path: string;
	scope: "user" | "project";
	enabled: boolean;
	description: string | null;
	icon: string | null;
	tools: number;
	commands: number;
	handlers: number;
	management: "package" | "bundle";
	readable?: boolean;
}

/** Package/bundle cards share one management feed; missing selected bundles stay visible. */
export async function listPluginManagementPackages(
	cwd: string,
	home: string,
	profileName?: string,
): Promise<PluginManagementPackage[]> {
	const profile = profileName ?? getActiveProfile() ?? "";
	const [installed, composition] = await Promise.all([
		getAllPlugins(cwd, { home }),
		readProfileComposition(profile, home),
	]);
	const bundles = await listInstalledBundles(profileDirFor(profile, home), home);
	const rows = new Map<string, PluginManagementPackage>();
	for (const plugin of installed) {
		rows.set(plugin.name, {
			name: plugin.name,
			version: plugin.version,
			path: plugin.path,
			scope: plugin.scope,
			enabled: plugin.enabled,
			description: plugin.manifest.description ?? null,
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
		rows.set(bundle.name, {
			name: bundle.name,
			version: bundle.version || existing?.version || "",
			path: bundle.path ?? existing?.path ?? "",
			scope: existing?.scope ?? "user",
			enabled: bundle.selected,
			description: bundle.description ?? existing?.description ?? null,
			icon: existing?.icon ?? null,
			tools: existing?.tools ?? 0,
			commands: existing?.commands ?? 0,
			handlers: existing?.handlers ?? 0,
			management: "bundle",
			readable: bundle.readable,
		});
	}
	if (composition.kind === "unreadable") {
		for (const row of rows.values()) {
			if (row.management === "bundle") row.readable = false;
		}
	}
	return [...rows.values()];
}
