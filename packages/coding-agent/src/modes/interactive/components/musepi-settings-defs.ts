// ============================================================
// MusePi settings panel definitions (pure data, host-agnostic).
//
// Declares which `musepi.*` keys the settings selector exposes and
// how each one is edited: boolean toggle, enum cycle, number preset
// cycle, free-text input, or an info panel pointing at settings.json
// for nested structures (server registries, string lists, role
// chains) that would not fit a list row. Per-key descriptions are
// reused from MUSEPI_SETTINGS_DOCS in @musepi/core (single source
// of truth), so docs stay in sync with the schema.
// ============================================================

import { MUSEPI_SETTINGS_DOCS, type ResolvedMusepiSettings } from "@musepi/core";

export type MusepiSettingKind = "bool" | "enum" | "number" | "text" | "info";

export interface MusepiSettingDef {
	/** Dot path inside the `musepi` settings object (e.g. "memory.enabled"). */
	path: string;
	/** Short row label (the section heading provides the context). */
	label: string;
	/** Section heading grouping consecutive rows. */
	section: string;
	kind: MusepiSettingKind;
	/** Enum choices, cycled in order. */
	options?: string[];
	/** Number presets, cycled in order. */
	presets?: number[];
	/** Extra body lines for kind "info" panels. */
	info?: string[];
}

const TIMEOUT_PRESETS = [60_000, 300_000, 600_000, 1_800_000];
const TOKEN_CAP_PRESETS = [2_000, 6_000, 10_000, 20_000];

export const MUSEPI_SETTING_DEFS: MusepiSettingDef[] = [
	// Memory
	{ path: "memory.enabled", label: "Enabled", section: "Memory", kind: "bool" },
	{ path: "memory.scope", label: "Scope", section: "Memory", kind: "enum", options: ["project", "global"] },
	{ path: "memory.caps.project", label: "Project cap", section: "Memory", kind: "number", presets: TOKEN_CAP_PRESETS },
	{ path: "memory.caps.global", label: "Global cap", section: "Memory", kind: "number", presets: TOKEN_CAP_PRESETS },
	// MCP
	{ path: "mcp.enabled", label: "Enabled", section: "MCP", kind: "bool" },
	{ path: "mcp.startupDiscovery", label: "Startup discovery", section: "MCP", kind: "bool" },
	{ path: "mcp.idleTimeoutMs", label: "Idle timeout (ms)", section: "MCP", kind: "number", presets: TIMEOUT_PRESETS },
	{
		path: "mcp.servers",
		label: "Servers",
		section: "MCP",
		kind: "info",
		info: [
			"MCP servers are a nested registry and are edited in settings.json.",
			'Under "musepi.mcp.servers", map a name to a stdio server',
			'{ "command": "...", "args": [...], "env": {...} } or an HTTP server',
			'{ "url": "...", "headers": {...} }. Per-server "enabled": false',
			"disables without deleting. Manage interactively via /mcp.",
		],
	},
	// LSP
	{ path: "lsp.enabled", label: "Enabled", section: "LSP", kind: "bool" },
	{ path: "lsp.idleTimeoutMs", label: "Idle timeout (ms)", section: "LSP", kind: "number", presets: TIMEOUT_PRESETS },
	{
		path: "lsp.servers",
		label: "Servers",
		section: "LSP",
		kind: "info",
		info: [
			"Language-server overrides are a nested registry edited in settings.json.",
			'Under "musepi.lsp.servers", map a server name to override fields',
			"(command, args, fileTypes, rootMarkers, isLinter, disabled,",
			"initOptions, settings); fields merge onto the built-in table entry",
			'of the same name, and "disabled": true removes it.',
		],
	},
	// Advisor
	{ path: "advisor.enabled", label: "Enabled", section: "Advisor", kind: "bool" },
	{ path: "advisor.model", label: "Model", section: "Advisor", kind: "text" },
	{
		path: "advisor.maxContextChars",
		label: "Context budget (chars)",
		section: "Advisor",
		kind: "number",
		presets: [20_000, 60_000, 120_000, 200_000],
	},
	// Model roles
	{ path: "modelRoles.default", label: "Default", section: "Model Roles", kind: "text" },
	{ path: "modelRoles.smol", label: "Smol", section: "Model Roles", kind: "text" },
	{ path: "modelRoles.plan", label: "Plan", section: "Model Roles", kind: "text" },
	{ path: "modelRoles.advisor", label: "Advisor", section: "Model Roles", kind: "text" },
	{ path: "modelRoles.task", label: "Task (swarm)", section: "Model Roles", kind: "text" },
	{ path: "modelRoles.tiny", label: "Tiny", section: "Model Roles", kind: "text" },
	{
		path: "modelRoles.cycleOrder",
		label: "Cycle order",
		section: "Model Roles",
		kind: "info",
		info: [
			"Cycle order and fallback chains are lists/maps edited in settings.json.",
			'"musepi.modelRoles.cycleOrder": ordered role names to rotate through;',
			'"musepi.modelRoles.fallbackChains": per-role ordered fallback models',
			"for 429/quota degradation.",
		],
	},
	// Tools
	{ path: "toolSelect.enabled", label: "Tool select (experimental)", section: "Tools", kind: "bool" },
	{
		path: "toolSelect.models",
		label: "Tool select models",
		section: "Tools",
		kind: "info",
		info: [
			"String lists are edited in settings.json:",
			'"musepi.toolSelect.models": extra provider/model entries treated as',
			'deferred-tools capable; "musepi.toolSelect.defer": extra tool names',
			"to defer regardless of source.",
		],
	},
	{ path: "edit.hashline", label: "Hashline editing", section: "Tools", kind: "bool" },
	{ path: "edit.enforceSeenLines", label: "Enforce seen lines", section: "Tools", kind: "bool" },
	{ path: "skills.kimiCodeCompat", label: "Kimi Code skill dirs", section: "Tools", kind: "bool" },
	{
		path: "compaction.strategy",
		label: "Compaction strategy",
		section: "Tools",
		kind: "enum",
		options: ["default", "snapcompact"],
	},
	// Swarm
	{
		path: "swarm.maxConcurrency",
		label: "Max concurrency",
		section: "Swarm",
		kind: "number",
		presets: [1, 3, 5, 8, 12],
	},
	{
		path: "swarm.timeoutMs",
		label: "Timeout (ms)",
		section: "Swarm",
		kind: "number",
		presets: [300_000, 900_000, 1_800_000, 3_600_000],
	},
	{
		path: "swarm.modelTier",
		label: "Model tier",
		section: "Swarm",
		kind: "enum",
		options: ["auto", "cheap", "balanced", "premium"],
	},
	{ path: "swarm.isolation", label: "Isolation", section: "Swarm", kind: "enum", options: ["worktree", "none"] },
	// Interface
	{
		path: "tui.style",
		label: "Editor style",
		section: "Interface",
		kind: "enum",
		options: ["boxed", "plain", "compact"],
	},
	{ path: "tui.modelInBorder", label: "Model in border", section: "Interface", kind: "bool" },
	{ path: "goal.badge", label: "Goal badge", section: "Interface", kind: "bool" },
	{ path: "todo.maxVisible", label: "Todo rows", section: "Interface", kind: "number", presets: [3, 5, 8, 12] },
	{ path: "notifications.enabled", label: "Notifications", section: "Interface", kind: "bool" },
	{
		path: "notifications.condition",
		label: "Notify when",
		section: "Interface",
		kind: "enum",
		options: ["unfocused", "always"],
	},
	{
		path: "truncation.thresholdChars",
		label: "Spill threshold (chars)",
		section: "Interface",
		kind: "number",
		presets: [10_000, 40_000, 80_000, 160_000],
	},
	{
		path: "truncation.headChars",
		label: "Preview head (chars)",
		section: "Interface",
		kind: "number",
		presets: [500, 1_500, 3_000],
	},
	{
		path: "truncation.tailChars",
		label: "Preview tail (chars)",
		section: "Interface",
		kind: "number",
		presets: [250, 500, 1_000],
	},
	// Updates & compat
	{ path: "updateCheck", label: "Update check", section: "Updates & Compat", kind: "bool" },
	{ path: "compat.loadPiExtensions", label: "Load legacy pi extensions", section: "Updates & Compat", kind: "bool" },
];

const DOCS_BY_KEY = new Map(MUSEPI_SETTINGS_DOCS.map((doc) => [doc.key, doc.description]));

/** Per-key description reused from the @musepi/core schema docs. */
export function musepiSettingDescription(path: string): string {
	return DOCS_BY_KEY.get(path) ?? "";
}

/** Read a dot path (e.g. "memory.caps.project") from resolved MusePi settings. */
export function getMusepiPathValue(values: ResolvedMusepiSettings, path: string): unknown {
	let current: unknown = values;
	for (const segment of path.split(".")) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/** Display string for a def's current value. */
export function formatMusepiValue(def: MusepiSettingDef, values: ResolvedMusepiSettings): string {
	if (def.kind === "info") return "…";
	const value = getMusepiPathValue(values, def.path);
	if (def.kind === "text") {
		return typeof value === "string" && value.length > 0 ? value : "(unset)";
	}
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number" || typeof value === "string") return String(value);
	return "";
}

/**
 * Parse a cycled/typed display string back into a typed value for
 * setMusepiValue. Returns undefined for input that does not fit the kind
 * (caller should ignore the change).
 */
export function parseMusepiValue(def: MusepiSettingDef, raw: string): unknown {
	switch (def.kind) {
		case "bool":
			return raw === "true" ? true : raw === "false" ? false : undefined;
		case "enum":
			return def.options?.includes(raw) ? raw : undefined;
		case "number": {
			const parsed = Number.parseInt(raw, 10);
			return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
		}
		case "text":
			return raw;
		case "info":
			return undefined;
	}
}
