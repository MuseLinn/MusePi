/**
 * Creation tool ring (issue #38 Step 2): the agent-facing self-bootstrap
 * tools. They cost real per-request tokens (full JSON schemas in the `tools`
 * field / `## functions` namespace) yet are used in well under 1% of ordinary
 * coding turns, so they are DEFAULT-INACTIVE: registered in every session but
 * excluded from the initial active set.
 *
 * Two separate lifetimes:
 * - {@link CREATION_RING_TOOL_NAMES} — session-scoped dynamic Cordis plugins
 *   plus the read-only inventory. This is the creation ring: what "make me a
 *   plugin" means to the model, and the plugin inventory an ordinary work
 *   session does not carry. The creator preset activates it from session start
 *   (`tools.extensionMetaTools`).
 * - {@link LEGACY_EXTENSION_TOOL_NAMES} — the session-level legacy extension
 *   loader (Track B, the compatibility surface for other agents' plugin
 *   formats). It exists so old extensions can still be loaded when the user
 *   explicitly asks for one from the extension management surface; it is NOT
 *   part of the creation ring and the creator preset never activates it.
 *
 * The GUI extension panels manage extensions through direct daemon RPCs and
 * do not depend on these agent-facing tools, so default-inactive does not
 * affect the GUI management paths.
 */

/** Creation ring: session-scoped dynamic Cordis plugins (lifecycle + read-only inspect verbs). */
export const CORDIS_TOOL_NAMES: readonly string[] = [
	"cordis_define",
	"cordis_run",
	"cordis_stop",
	"cordis_undefine",
	"cordis_inspect",
	"cordis_inspect_list",
	"cordis_inspect_query",
	"cordis_inspect_self",
] as const;

/** Creation ring: the tools the creator preset activates from session start —
 *  dynamic Cordis plugins, the inventory they are verified with, plugin
 *  management, and read-only market browsing (the reference harness composes
 *  `tool-plugin-manager` and `tool-plugin-market` into the same preset). */
export const CREATION_RING_TOOL_NAMES: readonly string[] = [
	...CORDIS_TOOL_NAMES,
	"extensions_list",
	"plugin_manager",
	"plugin_market",
] as const;

/** Track B compatibility loader — explicit extension management only, never the creator ring. */
export const LEGACY_EXTENSION_TOOL_NAMES: readonly string[] = [
	"extension_load",
	"extension_reload",
	"extension_status",
	"extension_validate",
	"extension_rollback",
] as const;

/** Every default-inactive tool; the extension management surface activates this full set. */
export const EXTENSION_META_TOOL_NAMES: readonly string[] = [
	...CREATION_RING_TOOL_NAMES,
	...LEGACY_EXTENSION_TOOL_NAMES,
] as const;

const CREATION_RING_TOOL_NAME_SET = new Set<string>(CREATION_RING_TOOL_NAMES);
const EXTENSION_META_TOOL_NAME_SET = new Set<string>(EXTENSION_META_TOOL_NAMES);

export function isExtensionMetaToolName(name: string): boolean {
	return EXTENSION_META_TOOL_NAME_SET.has(name);
}

/** Whether a tool belongs to the creation ring the creator preset activates. */
export function isCreationRingToolName(name: string): boolean {
	return CREATION_RING_TOOL_NAME_SET.has(name);
}
