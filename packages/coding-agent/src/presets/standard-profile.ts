/**
 * The standard work surface, as one reviewable list.
 *
 * A preset may declare its own `topLevelTools`; the default `work` profile
 * uses this list so "which tools sit in the top-level schema" is a data
 * decision rather than an inference from load modes. The drift test keeps it
 * equal to the registries it mirrors: `ESSENTIAL_BUILTIN_TOOL_NAMES` plus
 * `XDEV_KEEP_TOP_LEVEL`.
 *
 * Everything outside this list remains reachable through the `xd://` catalog.
 */
export const STANDARD_TOP_LEVEL_TOOL_NAMES: readonly string[] = [
	"read",
	"write",
	"bash",
	"edit",
	"glob",
	"grep",
	"computer",
	"eval",
	"task",
	"hub",
	"learn",
	"manage_skill",
	"todo",
	"ask",
	"web_search",
] as const;
