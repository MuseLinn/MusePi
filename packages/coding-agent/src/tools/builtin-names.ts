/**
 * Canonical tool name registry for advisor config validation.
 * MusePi has a smaller tool set than OMP — only these are available.
 */

export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"task",
	"hub",
	"todo",
	"web_search",
	"advisor",
	"memory_edit",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

const LEGACY_BUILTIN_TOOL_NAME_ALIASES: ReadonlyMap<string, string> = new Map([["search", "grep"]]);

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

/** MCP tool names carry the `mcp__<server>_<tool>` prefix. */
export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}
