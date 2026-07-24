// ============================================================
// Model Roles — OMP-style per-purpose model routing (pure types).
//
// Six built-in roles ship first; the table is open-ended so future
// roles (vision / slow / designer / commit) slot in without schema
// churn. A role value is a model spec string:
//
//     provider/model[:thinkingLevel]
//     provider:model[:thinkingLevel]
//     model[:thinkingLevel]
//
// When every role is unset, all resolution falls back to "default"
// and then to undefined — callers keep their existing behavior, so
// an empty table never interferes with the main model decision.
// ============================================================

/** Built-in roles. "default" is the ultimate fallback for every role. */
export const MODEL_ROLES = ["default", "smol", "plan", "advisor", "task", "tiny"] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

/** Reserved roles — recognized but not yet consumed by built-in features. */
export const RESERVED_MODEL_ROLES = ["vision", "slow", "designer", "commit"] as const;

export type ReservedModelRole = (typeof RESERVED_MODEL_ROLES)[number];

/** Thinking-level suffixes accepted after the model id (OMP-compatible). */
export const ROLE_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type RoleThinkingLevel = (typeof ROLE_THINKING_LEVELS)[number];

/** A parsed role value. */
export interface RoleModelSpec {
	/** Provider id when the value names one ("anthropic/claude-..."); else undefined. */
	provider?: string;
	/** Model id within the provider (or a bare model id when provider is omitted). */
	modelId: string;
	/** Optional thinking-level suffix parsed from ":level". */
	thinkingLevel?: RoleThinkingLevel;
}

/** Settings shape consumed by the resolvers (mirrors musepi.modelRoles in the schema). */
export interface ModelRolesConfig {
	default?: string;
	smol?: string;
	plan?: string;
	advisor?: string;
	task?: string;
	tiny?: string;
	/** Roles to cycle through when the user rotates models (ordered). */
	cycleOrder?: string[];
	/** Per-role ordered fallback candidates for 429/quota degradation. */
	fallbackChains?: Record<string, string[]>;
}

export function isModelRole(name: string): name is ModelRole {
	return (MODEL_ROLES as readonly string[]).includes(name);
}

export function isKnownRoleName(name: string): boolean {
	return isModelRole(name) || (RESERVED_MODEL_ROLES as readonly string[]).includes(name);
}

export function isRoleThinkingLevel(value: string): value is RoleThinkingLevel {
	return (ROLE_THINKING_LEVELS as readonly string[]).includes(value);
}
