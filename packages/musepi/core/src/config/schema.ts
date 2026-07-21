// ============================================================
// MusePi settings schema (pure, host-agnostic).
//
// Single source of truth for MusePi feature configuration: field
// types, defaults, and per-key documentation. The fork's
// SettingsManager stores this under the `musepi` nested settings key
// (same pattern as `terminal` / `compaction`); a future settings
// menu edits these fields. mergeMusepiSettings applies defaults
// deep-merged with whatever the user configured.
// ============================================================

import { isModelRole, MODEL_ROLES } from "../model-roles/types.ts";

export interface MusepiGoalSettings {
	/** Show the goal badge in the footer. */
	badge?: boolean; // default: true
}

export interface MusepiTodoSettings {
	/** Max rows in the folded panel. */
	maxVisible?: number; // default: 5
}

export interface MusepiSwarmSettings {
	/** Default max_concurrency when the model does not specify it. */
	maxConcurrency?: number; // default: 5
	/** Default subagent timeout in ms. */
	timeoutMs?: number; // default: 1800000 (30 min)
	/** Default model tier when unspecified. */
	modelTier?: "cheap" | "balanced" | "premium" | "auto"; // default: "auto"
	/**
	 * Subagent filesystem isolation: "worktree" runs each subagent in a
	 * detached git worktree at HEAD and merges changes back on completion
	 * (auto-apply only while the main tree is untouched, otherwise the patch
	 * lands in the session patches dir); "none" runs in the main worktree.
	 */
	isolation?: "worktree" | "none"; // default: "worktree"
}

export interface MusepiTuiSettings {
	/** Editor chrome style. */
	style?: "plain" | "boxed" | "compact"; // default: "boxed"
	/** Show the model name in the editor's top border. */
	modelInBorder?: boolean; // default: false
}

export interface MusepiTruncationSettings {
	/** Spill threshold in chars. */
	thresholdChars?: number; // default: 40000
	/** Preview head/tail sizes in chars. */
	headChars?: number; // default: 1500
	tailChars?: number; // default: 500
}

export interface MusepiEditSettings {
	/**
	 * Hashline editing: read/grep output carries [path#TAG] headers and
	 * LINE:TEXT rows, and edit takes a tag-anchored patch. Off = pi-native
	 * exact-replacement edit with plain read output.
	 */
	hashline?: boolean; // default: true
	/** Reject edits on lines read/grep never displayed (hashline only). */
	enforceSeenLines?: boolean; // default: false
}

/**
 * Progressive tool disclosure (experimental). When enabled for a capable
 * model, extension-registered tools stay out of the top-level tools[] and
 * the model loads them on demand via the select_tools tool, keeping the
 * prompt-cache prefix stable (Kimi K3 wire: deferredToolsMode "kimi").
 */
export interface MusepiToolSelectSettings {
	/** Master switch (experimental). */
	enabled?: boolean; // default: false
	/**
	 * Model allowlist fallback when the catalog does not declare a
	 * deferred-tools capability. Entries: `provider/model` or bare model id.
	 */
	models?: string[]; // default: []
	/** Extra tool names to force-defer regardless of source. */
	defer?: string[]; // default: []
}

/**
 * One language server override (musepi.lsp.servers.<name>). Fields merge
 * onto the built-in table entry of the same name; `disabled` removes it.
 */
export interface MusepiLspServerSettings {
	command?: string;
	args?: string[];
	fileTypes?: string[];
	rootMarkers?: string[];
	isLinter?: boolean;
	disabled?: boolean;
	initOptions?: Record<string, unknown>;
	settings?: Record<string, unknown>;
}

/**
 * LSP integration: lazy language-server clients behind the `lsp` tool,
 * plus deferred post-edit diagnostics re-injected into the session.
 */
export interface MusepiLspSettings {
	/** Master switch. Off = tool errors politely, deferred diagnostics disarmed. */
	enabled?: boolean; // default: true
	/** Per-server overrides / custom servers, merged onto the built-in table. */
	servers?: Record<string, MusepiLspServerSettings>; // default: {}
	/** Idle clients are shut down after this many ms. */
	idleTimeoutMs?: number; // default: 600000 (10 min)
}

/**
 * OMP-style per-purpose model routing. Each role value is a model spec
 * string `provider/model[:thinkingLevel]` (also `provider:model` or a
 * bare model id). Empty string = unset → the role falls back to
 * `default`, and an unset `default` keeps the session's current model,
 * so a fully empty table never interferes with model selection.
 */
export interface MusepiModelRolesSettings {
	/** Fallback for every other role; also the "main conversation" role. */
	default?: string;
	/** Cheap/fast model for lightweight foreground work. */
	smol?: string;
	/** Model used while plan mode is active. */
	plan?: string;
	/** Sideline reviewer model (advisory calls). */
	advisor?: string;
	/** Model for swarm subagents (overrides auto-routing when set). */
	task?: string;
	/** Tiny model for background chores (titles, memory distillation). */
	tiny?: string;
	/** Roles to cycle through when rotating models (ordered). */
	cycleOrder?: string[];
	/** Per-role ordered fallback candidates for 429/quota degradation. */
	fallbackChains?: Record<string, string[]>;
}

export interface MusepiSettings {
	goal?: MusepiGoalSettings;
	todo?: MusepiTodoSettings;
	swarm?: MusepiSwarmSettings;
	tui?: MusepiTuiSettings;
	truncation?: MusepiTruncationSettings;
	edit?: MusepiEditSettings;
	modelRoles?: MusepiModelRolesSettings;
	toolSelect?: MusepiToolSelectSettings;
	lsp?: MusepiLspSettings;
	memory?: MusepiMemorySettings;
}

/**
 * Long-term memory (markdown file tree + BM25 recall + budgeted startup
 * injection). Disabled by default.
 */
export interface MusepiMemorySettings {
	/** Master switch. Off = no injection, memory tool hidden. */
	enabled?: boolean; // default: false
	/** project = project memory only; global = project + global memory. */
	scope?: "project" | "global"; // default: "project"
	/** Per-section injection budgets (estimated tokens). */
	caps?: {
		project?: number; // default: 10000
		global?: number; // default: 6000
	};
}

/** Default values, applied per-field when unset. */
export const MUSEPI_DEFAULTS: Required<{
	goal: Required<MusepiGoalSettings>;
	todo: Required<MusepiTodoSettings>;
	swarm: Required<MusepiSwarmSettings>;
	tui: Required<MusepiTuiSettings>;
	truncation: Required<MusepiTruncationSettings>;
	edit: Required<MusepiEditSettings>;
	modelRoles: Required<MusepiModelRolesSettings>;
	toolSelect: Required<MusepiToolSelectSettings>;
	lsp: { enabled: boolean; servers: Record<string, MusepiLspServerSettings>; idleTimeoutMs: number };
	memory: { enabled: boolean; scope: "project" | "global"; caps: { project: number; global: number } };
}> = {
	goal: { badge: true },
	todo: { maxVisible: 5 },
	swarm: { maxConcurrency: 5, timeoutMs: 1_800_000, modelTier: "auto", isolation: "worktree" },
	tui: { style: "boxed", modelInBorder: false },
	truncation: { thresholdChars: 40_000, headChars: 1_500, tailChars: 500 },
	edit: { hashline: true, enforceSeenLines: false },
	modelRoles: { default: "", smol: "", plan: "", advisor: "", task: "", tiny: "", cycleOrder: [], fallbackChains: {} },
	toolSelect: { enabled: false, models: [], defer: [] },
	lsp: { enabled: true, servers: {}, idleTimeoutMs: 600_000 },
	memory: { enabled: false, scope: "project", caps: { project: 10_000, global: 6_000 } },
};

export type ResolvedMusepiSettings = typeof MUSEPI_DEFAULTS;

function pick<T extends object>(defaults: T, override: unknown): T {
	if (!override || typeof override !== "object") return { ...defaults };
	const defaultsRecord = defaults as unknown as Record<string, unknown>;
	const out: Record<string, unknown> = { ...defaultsRecord };
	for (const key of Object.keys(defaultsRecord)) {
		const v = (override as Record<string, unknown>)[key];
		if (v !== undefined && typeof v === typeof defaultsRecord[key]) {
			out[key] = v;
		}
	}
	return out as T;
}

/**
 * modelRoles needs a custom merge: role values are plain strings, but
 * cycleOrder is a filtered list of known role names and fallbackChains
 * is a nested record of per-role string lists (unknown keys dropped).
 */
function pickModelRoles(override: unknown): ResolvedMusepiSettings["modelRoles"] {
	const defaults = MUSEPI_DEFAULTS.modelRoles;
	const out = { ...defaults, cycleOrder: [] as string[], fallbackChains: {} as Record<string, string[]> };
	if (!override || typeof override !== "object") return out;
	const record = override as Record<string, unknown>;
	for (const role of MODEL_ROLES) {
		const v = record[role];
		if (typeof v === "string") out[role] = v;
	}
	if (Array.isArray(record.cycleOrder)) {
		out.cycleOrder = record.cycleOrder.filter(
			(v): v is string => typeof v === "string" && isModelRole(v),
		);
	}
	if (record.fallbackChains && typeof record.fallbackChains === "object" && !Array.isArray(record.fallbackChains)) {
		for (const [role, chain] of Object.entries(record.fallbackChains as Record<string, unknown>)) {
			if (!isModelRole(role) || !Array.isArray(chain)) continue;
			const entries = chain.filter((v): v is string => typeof v === "string");
			if (entries.length > 0) out.fallbackChains[role] = entries;
		}
	}
	return out;
}

/**
 * toolSelect needs a custom merge: `enabled` is a boolean, `models`/`defer`
 * are filtered string lists (non-string entries dropped).
 */
function pickToolSelect(override: unknown): ResolvedMusepiSettings["toolSelect"] {
	const defaults = MUSEPI_DEFAULTS.toolSelect;
	const out = { ...defaults, models: [] as string[], defer: [] as string[] };
	if (!override || typeof override !== "object") return out;
	const record = override as Record<string, unknown>;
	if (typeof record.enabled === "boolean") out.enabled = record.enabled;
	if (Array.isArray(record.models)) out.models = record.models.filter((v): v is string => typeof v === "string");
	if (Array.isArray(record.defer)) out.defer = record.defer.filter((v): v is string => typeof v === "string");
	return out;
}

/**
 * lsp needs a custom merge: `enabled` boolean, `idleTimeoutMs` number, and
 * `servers` is a record of per-server override objects (non-object entries
 * dropped; only known override fields are kept).
 */
function pickLsp(override: unknown): ResolvedMusepiSettings["lsp"] {
	const defaults = MUSEPI_DEFAULTS.lsp;
	const out = { ...defaults, servers: {} as Record<string, MusepiLspServerSettings> };
	if (!override || typeof override !== "object") return out;
	const record = override as Record<string, unknown>;
	if (typeof record.enabled === "boolean") out.enabled = record.enabled;
	if (typeof record.idleTimeoutMs === "number" && record.idleTimeoutMs > 0) {
		out.idleTimeoutMs = record.idleTimeoutMs;
	}
	if (record.servers && typeof record.servers === "object" && !Array.isArray(record.servers)) {
		for (const [name, value] of Object.entries(record.servers as Record<string, unknown>)) {
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			const v = value as Record<string, unknown>;
			const server: MusepiLspServerSettings = {};
			if (typeof v.command === "string") server.command = v.command;
			if (Array.isArray(v.args)) server.args = v.args.filter((a): a is string => typeof a === "string");
			if (Array.isArray(v.fileTypes)) server.fileTypes = v.fileTypes.filter((a): a is string => typeof a === "string");
			if (Array.isArray(v.rootMarkers)) {
				server.rootMarkers = v.rootMarkers.filter((a): a is string => typeof a === "string");
			}
			if (typeof v.isLinter === "boolean") server.isLinter = v.isLinter;
			if (typeof v.disabled === "boolean") server.disabled = v.disabled;
			if (v.initOptions && typeof v.initOptions === "object") {
				server.initOptions = v.initOptions as Record<string, unknown>;
			}
			if (v.settings && typeof v.settings === "object") server.settings = v.settings as Record<string, unknown>;
			out.servers[name] = server;
		}
	}
	return out;
}

/**
 * memory needs a custom merge: `enabled` boolean, `scope` enum, and a
 * nested `caps` record of positive numbers.
 */
function pickMemory(override: unknown): ResolvedMusepiSettings["memory"] {
	const defaults = MUSEPI_DEFAULTS.memory;
	const out = { ...defaults, caps: { ...defaults.caps } };
	if (!override || typeof override !== "object") return out;
	const record = override as Record<string, unknown>;
	if (typeof record.enabled === "boolean") out.enabled = record.enabled;
	if (record.scope === "project" || record.scope === "global") out.scope = record.scope;
	if (record.caps && typeof record.caps === "object" && !Array.isArray(record.caps)) {
		const caps = record.caps as Record<string, unknown>;
		if (typeof caps.project === "number" && caps.project > 0) out.caps.project = caps.project;
		if (typeof caps.global === "number" && caps.global > 0) out.caps.global = caps.global;
	}
	return out;
}

/**
 * Resolve user settings against defaults: each known field falls back
 * to its default when unset or mistyped; unknown fields are dropped.
 */
export function mergeMusepiSettings(raw: MusepiSettings | undefined): ResolvedMusepiSettings {
	const r = raw ?? {};
	return {
		goal: pick(MUSEPI_DEFAULTS.goal, r.goal),
		todo: pick(MUSEPI_DEFAULTS.todo, r.todo),
		swarm: pick(MUSEPI_DEFAULTS.swarm, r.swarm),
		tui: pick(MUSEPI_DEFAULTS.tui, r.tui),
		truncation: pick(MUSEPI_DEFAULTS.truncation, r.truncation),
		edit: pick(MUSEPI_DEFAULTS.edit, r.edit),
		modelRoles: pickModelRoles(r.modelRoles),
		toolSelect: pickToolSelect(r.toolSelect),
		lsp: pickLsp(r.lsp),
		memory: pickMemory(r.memory),
	};
}

/** Per-key documentation for the future settings menu. */
export const MUSEPI_SETTINGS_DOCS: Array<{ key: string; description: string; defaultValue: unknown }> = [
	{ key: "goal.badge", description: "Show the goal badge in the footer", defaultValue: true },
	{ key: "todo.maxVisible", description: "Max rows in the folded todo panel", defaultValue: 5 },
	{ key: "swarm.maxConcurrency", description: "Default parallel workers for agent_swarm", defaultValue: 5 },
	{ key: "swarm.timeoutMs", description: "Subagent timeout in milliseconds", defaultValue: 1_800_000 },
	{ key: "swarm.modelTier", description: "Default model tier for subagents", defaultValue: "auto" },
	{
		key: "swarm.isolation",
		description: "Subagent filesystem isolation: git worktree per subagent + merge-back, or none",
		defaultValue: "worktree",
	},
	{ key: "tui.style", description: "Editor chrome style (plain/boxed/compact)", defaultValue: "boxed" },
	{ key: "tui.modelInBorder", description: "Show model name in the editor top border", defaultValue: false },
	{ key: "truncation.thresholdChars", description: "Tool-result spill threshold (chars)", defaultValue: 40_000 },
	{ key: "truncation.headChars", description: "Preview head size (chars)", defaultValue: 1_500 },
	{ key: "truncation.tailChars", description: "Preview tail size (chars)", defaultValue: 500 },
	{ key: "edit.hashline", description: "Hash-anchored (hashline) editing for read/grep/edit", defaultValue: true },
	{
		key: "toolSelect.enabled",
		description: "Progressive tool disclosure: extension tools load on demand via select_tools (experimental)",
		defaultValue: false,
	},
	{
		key: "toolSelect.models",
		description: "Extra models to treat as deferred-tools capable: provider/model or bare model id",
		defaultValue: [],
	},
	{
		key: "toolSelect.defer",
		description: "Extra tool names to defer regardless of source",
		defaultValue: [],
	},
	{
		key: "edit.enforceSeenLines",
		description: "Reject edits on lines read/grep never displayed",
		defaultValue: false,
	},
	{
		key: "lsp.enabled",
		description: "LSP integration: lsp tool + post-edit diagnostics (graceful when no server installed)",
		defaultValue: true,
	},
	{
		key: "lsp.servers",
		description: "Language server overrides merged onto the built-in table",
		defaultValue: {},
	},
	{
		key: "lsp.idleTimeoutMs",
		description: "Idle language servers are shut down after this many ms",
		defaultValue: 600000,
	},
	{
		key: "modelRoles.default",
		description: "Fallback model for all roles: provider/model[:thinkingLevel]",
		defaultValue: "",
	},
	{ key: "modelRoles.smol", description: "Cheap/fast model for lightweight work", defaultValue: "" },
	{ key: "modelRoles.plan", description: "Model used while plan mode is active", defaultValue: "" },
	{ key: "modelRoles.advisor", description: "Sideline reviewer model", defaultValue: "" },
	{ key: "modelRoles.task", description: "Model for swarm subagents (overrides auto-routing)", defaultValue: "" },
	{ key: "modelRoles.tiny", description: "Tiny model for background chores (titles, memory)", defaultValue: "" },
	{ key: "modelRoles.cycleOrder", description: "Roles to cycle through when rotating models", defaultValue: [] },
	{
		key: "modelRoles.fallbackChains",
		description: "Per-role ordered fallback models for 429/quota degradation",
		defaultValue: {},
	},
	{
		key: "memory.enabled",
		description: "Long-term memory: BM25 recall + budgeted startup injection (default off)",
		defaultValue: false,
	},
	{
		key: "memory.scope",
		description: "Memory injection scope: project only, or project + global",
		defaultValue: "project",
	},
	{
		key: "memory.caps.project",
		description: "Project memory injection budget (estimated tokens)",
		defaultValue: 10000,
	},
	{
		key: "memory.caps.global",
		description: "Global memory injection budget (estimated tokens)",
		defaultValue: 6000,
	},
];
