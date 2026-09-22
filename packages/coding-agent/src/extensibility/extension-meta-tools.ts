/**
 * Extension meta-tool set (issue #38 Step 2): the agent-facing extension
 * bootstrap/lifecycle tools. These cost real per-request tokens (full JSON
 * schemas in the `tools` field / `## functions` namespace) yet are used in
 * well under 1% of ordinary coding turns, so they are DEFAULT-INACTIVE:
 * registered in every session but excluded from the initial active set,
 * activated on demand via the `/extensions` command
 * (`AgentSession.activateExtensionMetaTools`).
 *
 * `extensions_list` (read-only inventory) intentionally stays active — it
 * is the cheap way for the model to see what is loaded.
 *
 * The GUI extension panels manage extensions through direct daemon RPCs and
 * do not depend on these agent-facing tools, so default-inactive does not
 * affect the GUI management paths.
 */

/** Names of the extension meta tools that start inactive (issue #38). */
export const EXTENSION_META_TOOL_NAMES: readonly string[] = [
	// Lifecycle (extension-lifecycle-tools.ts)
	"extension_load",
	"extension_reload",
	"extension_status",
	"extension_validate",
	"extension_rollback",
	// Runtime bootstrap (extension-runtime-tools.ts)
	"ext_define",
	"ext_run",
	"ext_stop",
	"ext_undefine",
	"ext_inspect",
] as const;

const EXTENSION_META_TOOL_NAME_SET = new Set<string>(EXTENSION_META_TOOL_NAMES);

export function isExtensionMetaToolName(name: string): boolean {
	return EXTENSION_META_TOOL_NAME_SET.has(name);
}
