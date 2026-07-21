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
	modelRoles?: MusepiModelRolesSettings;
}

/** Default values, applied per-field when unset. */
export const MUSEPI_DEFAULTS: Required<{
	goal: Required<MusepiGoalSettings>;
	todo: Required<MusepiTodoSettings>;
	swarm: Required<MusepiSwarmSettings>;
	tui: Required<MusepiTuiSettings>;
	truncation: Required<MusepiTruncationSettings>;
	modelRoles: Required<MusepiModelRolesSettings>;
}> = {
	goal: { badge: true },
	todo: { maxVisible: 5 },
	swarm: { maxConcurrency: 5, timeoutMs: 1_800_000, modelTier: "auto" },
	tui: { style: "boxed", modelInBorder: false },
	truncation: { thresholdChars: 40_000, headChars: 1_500, tailChars: 500 },
	modelRoles: { default: "", smol: "", plan: "", advisor: "", task: "", tiny: "", cycleOrder: [], fallbackChains: {} },
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
		modelRoles: pickModelRoles(r.modelRoles),
	};
}

/** Per-key documentation for the future settings menu. */
export const MUSEPI_SETTINGS_DOCS: Array<{ key: string; description: string; defaultValue: unknown }> = [
	{ key: "goal.badge", description: "Show the goal badge in the footer", defaultValue: true },
	{ key: "todo.maxVisible", description: "Max rows in the folded todo panel", defaultValue: 5 },
	{ key: "swarm.maxConcurrency", description: "Default parallel workers for agent_swarm", defaultValue: 5 },
	{ key: "swarm.timeoutMs", description: "Subagent timeout in milliseconds", defaultValue: 1_800_000 },
	{ key: "swarm.modelTier", description: "Default model tier for subagents", defaultValue: "auto" },
	{ key: "tui.style", description: "Editor chrome style (plain/boxed/compact)", defaultValue: "boxed" },
	{ key: "tui.modelInBorder", description: "Show model name in the editor top border", defaultValue: false },
	{ key: "truncation.thresholdChars", description: "Tool-result spill threshold (chars)", defaultValue: 40_000 },
	{ key: "truncation.headChars", description: "Preview head size (chars)", defaultValue: 1_500 },
	{ key: "truncation.tailChars", description: "Preview tail size (chars)", defaultValue: 500 },
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
];
