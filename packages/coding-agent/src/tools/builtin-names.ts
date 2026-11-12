export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"ast_grep",
	"ast_edit",
	"ask",
	"debug",
	"eval",
	"github",
	"glob",
	"grep",
	"lsp",
	"inspect_image",
	"browser",
	"computer",
	"checkpoint",
	"rewind",
	"security_scan",
	"task",
	"hub",
	"todo",
	"knowledge",
	"notify_user",
	"connector_catalog",
	"web_search",
	"write",
	"memory_edit",
	"retain",
	"recall",
	"reflect",
	"learn",
	"manage_skill",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/**
 * First-party tools that ship in bundled plugins rather than the built-in
 * factory table, but stay part of the built-in vocabulary: shell completion,
 * advisor config validation and docs coverage must still know their names.
 *
 * `widget` moved to the `musepi-visuals` plugin (registered and gated there);
 * it is deliberately NOT a key of `BUILTIN_TOOLS`.
 */
export const PLUGIN_TOOL_NAMES = ["widget", "board"] as const;

/** Every tool name a user may name in `--tools`, an advisor config or a preset. */
export const KNOWN_BUILTIN_TOOL_NAMES = [...BUILTIN_TOOL_NAMES, ...PLUGIN_TOOL_NAMES] as const;

export const HIDDEN_TOOL_NAMES = ["yield", "goal", "think"] as const;

export type HiddenToolName = (typeof HIDDEN_TOOL_NAMES)[number];

const LEGACY_BUILTIN_TOOL_NAME_ALIASES: ReadonlyMap<string, BuiltinToolName> = new Map([
	["search", "grep"],
	["find", "glob"],
]);

/** Return the canonical tool name for current and legacy built-in tool IDs. */
export function normalizeToolName(name: string): string {
	const normalized = name.toLowerCase();
	return LEGACY_BUILTIN_TOOL_NAME_ALIASES.get(normalized) ?? normalized;
}

/** Normalize and deduplicate tool names while preserving first-seen order. */
export function normalizeToolNames(names: Iterable<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const normalized = normalizeToolName(name);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

/** MCP tool names carry the `mcp__<server>_<tool>` prefix minted by `createMCPToolName`. */
export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}
