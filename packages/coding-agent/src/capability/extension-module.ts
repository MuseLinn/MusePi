/**
 * Extension Modules Capability
 *
 * TypeScript/JavaScript extension modules loaded by the extension system.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A loaded extension module.
 */
export interface ExtensionModule {
	/** Extension module name (derived from path) */
	name: string;
	/** Absolute path to extension entrypoint */
	path: string;
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
	displayName: "Extension Modules",
	description: "TypeScript/JavaScript extension modules loaded by the extension system",
	key: ext => ext.name,
	toExtensionId: ext => `extension-module:${ext.name}`,
	validate: ext => {
		if (!ext.name) return "Missing name";
		if (!ext.path) return "Missing path";
		return undefined;
	},
});
