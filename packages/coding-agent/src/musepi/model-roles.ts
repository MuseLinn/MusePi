// ============================================================
// MusePi model roles — host-side glue.
//
// The pure role table / parsing / fallback logic lives in
// @musepi/core/model-roles (zero pi imports). This module is the
// consumer-facing seam: it resolves a role to a concrete Model from
// the registry and exposes resolveModelForRole('tiny') & friends to
// host features (swarm subagents, plan mode, future memory calls).
// ============================================================

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRole, ModelRolesConfig, RoleModelSpec } from "@musepi/core/model-roles/index.js";
import {
	resolveModelForRole as coreResolveModelForRole,
	resolveCandidatesForRole,
} from "@musepi/core/model-roles/index.js";

export interface RoleModelMatch {
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	/** Which table entry produced the model ("default" = fell back). */
	source: ModelRole | "none";
	diagnostics: string[];
}

/** Find a registry model for a parsed spec: exact provider+id first, then bare id. */
export function findModelForSpec(
	spec: RoleModelSpec,
	available: Array<Model<any>>,
	rawValue?: string,
): Model<any> | undefined {
	if (spec.provider) {
		const exact = available.find((m) => m.provider === spec.provider && m.id === spec.modelId);
		if (exact) return exact;
		// Case-insensitive fallback — config strings are hand-typed.
		const provider = spec.provider.toLowerCase();
		const modelId = spec.modelId.toLowerCase();
		const ci = available.find((m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId);
		if (ci) return ci;
	}
	// Bare-id match — also covers model ids that themselves contain "/"
	// or ":" (the original value may not be a provider prefix at all).
	const candidates = [spec.modelId, ...(rawValue ? [rawValue] : [])];
	for (const candidate of candidates) {
		const exact = available.find((m) => m.id === candidate);
		if (exact) return exact;
		const lower = candidate.toLowerCase();
		const ci = available.find((m) => m.id.toLowerCase() === lower);
		if (ci) return ci;
	}
	return undefined;
}

/**
 * Resolve a role to a concrete registry model. Returns undefined when
 * the role (and "default") is unconfigured or names a model the
 * registry doesn't have — callers then keep their existing behavior.
 */
export function resolveRoleModel(
	role: ModelRole,
	config: ModelRolesConfig | undefined,
	available: Array<Model<any>>,
): RoleModelMatch | undefined {
	const resolution = coreResolveModelForRole(config, role);
	if (!resolution.spec) return undefined;
	const model = findModelForSpec(resolution.spec, available);
	if (!model) {
		return undefined;
	}
	return {
		model,
		thinkingLevel: resolution.spec.thinkingLevel as ThinkingLevel | undefined,
		source: resolution.source,
		diagnostics: resolution.diagnostics,
	};
}

/**
 * Ordered fallback candidates for a role (role value first, then its
 * fallback chain), each resolved against the registry. Candidates the
 * registry lacks are dropped.
 */
export function resolveRoleFallbackModels(
	role: ModelRole,
	config: ModelRolesConfig | undefined,
	available: Array<Model<any>>,
): Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
	const { specs } = resolveCandidatesForRole(config, role);
	const out: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> = [];
	const seen = new Set<string>();
	for (const spec of specs) {
		const model = findModelForSpec(spec, available);
		if (!model) continue;
		const key = `${model.provider}:${model.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ model, thinkingLevel: spec.thinkingLevel as ThinkingLevel | undefined });
	}
	return out;
}
