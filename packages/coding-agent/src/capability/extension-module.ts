/**
 * Extension Modules Capability
 *
 * TypeScript/JavaScript module entries loaded by EITHER plugin track — the
 * cordis plugin loader (`plugin-module`) or the legacy Pi/omp loader
 * (`extension-module`). The `level` below records where the entry came from;
 * the loader that loaded it is recorded on the list row's `kind`, via
 * `PLUGIN_MODULE_KIND` / `LEGACY_EXTENSION_MODULE_KIND` (module-entry.ts).
 */
import { defineCapability } from ".";
import {
	isModuleEntryKind,
	LEGACY_EXTENSION_MODULE_KIND,
	moduleEntryId,
	PLUGIN_MODULE_KIND,
} from "./module-entry";
import type { SourceMeta } from "./types";

/**
 * A loaded module entry (either track).
 */
export interface ExtensionModule {
	/** Module name (derived from path) */
	name: string;
	/** Absolute path to the entrypoint */
	path: string;
	/**
	 * Which loader loaded this entry: the cordis plugin track or the legacy
	 * extension track. Same vocabulary as the list row's `kind` — carried here
	 * so a consumer that only sees the capability (not the assembled list row)
	 * can still tell the tracks apart.
	 */
	track: typeof PLUGIN_MODULE_KIND | typeof LEGACY_EXTENSION_MODULE_KIND;
	/**
	 * Where the module came from: the user's own config, the current project, or
	 * the distribution itself.
	 *
	 * `native` is the third case and it is not a synonym for `user`: a package the
	 * distribution ships is neither installed by the user nor scoped to a project,
	 * and listing it as either is what makes a user unable to tell what they can
	 * remove. The UI already carries this third value (`_source.level` is
	 * `"user" | "project" | "native"` in the capability center and the slash
	 * command source); this is the same vocabulary on the daemon side.
	 */
	level: "user" | "project" | "native";
	/** Source metadata */
	_source: SourceMeta;
}

export const extensionModuleCapability = defineCapability<ExtensionModule>({
	id: "extension-modules",
	displayName: "Plugin Modules",
	description: "Module entries loaded by the plugin (cordis) or legacy extension loader",
	key: ext => ext.name,
	toExtensionId: ext => moduleEntryId(ext.name),
	validate: ext => {
		if (!ext.name) return "Missing name";
		if (!ext.path) return "Missing path";
		if (!isModuleEntryKind(ext.track)) return `Unknown track: ${String(ext.track)}`;
		return undefined;
	},
});

export {
	isModuleEntryKind,
	LEGACY_EXTENSION_MODULE_KIND,
	moduleEntryId,
	moduleEntryName,
	PLUGIN_MODULE_KIND,
} from "./module-entry";

