import type { ExtensionItem } from "../../lib/slot-host";

/**
 * The「内置插件」rows on the integrations page: first-party Cordis plugins the
 * distribution ships, read from `extensions.list` so the switch reflects real
 * enablement instead of a second local inventory.
 *
 * The rule is data-shaped, not path-shaped:
 *
 * - Only module entries (`plugin-module` / `extension-module`); every other
 *   kind is a different capability surface.
 * - `source.level === "native"` — the distribution ships it. User-installed
 *   plugins are `user`/`project` and stay in the plugin manager.
 * - Not `presetOnly` (persona packages are provided per preset, not toggled
 *   on their own) and not `readonly` (prompt/render packs have no enablement
 *   control; the daemon refuses `extensions.setEnabled` for them).
 * - The manifest declares a human label (`displayName !== name`). A row known
 *   only by its package slug — the desktop shell's own UI plugins — is not
 *   something a person can decide about on this page.
 */

const MODULE_KINDS: ReadonlySet<string> = new Set(["plugin-module", "extension-module"]);

/** Whether a listed extension is a builtin plugin a person can switch here. */
export function isBuiltinPlugin(extension: ExtensionItem): boolean {
	return (
		MODULE_KINDS.has(extension.kind) &&
		extension.source.level === "native" &&
		extension.presetOnly !== true &&
		extension.readonly !== true &&
		extension.displayName !== extension.name
	);
}

/**
 * The rows to render, in list order, minus the ids the catalog already shows as
 * integration cards — the same switch must not appear twice on one page.
 */
export function selectBuiltinPlugins(
	extensions: readonly ExtensionItem[],
	promotedPluginIds: readonly string[],
): ExtensionItem[] {
	const promoted = new Set(promotedPluginIds);
	return extensions.filter(extension => isBuiltinPlugin(extension) && !promoted.has(extension.id));
}
