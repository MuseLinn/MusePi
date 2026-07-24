// ============================================================
// MusePi advisor — gate and review-model selection (pure).
//
// Enable gate: on unless explicitly disabled; the host strips the
// advisor tool from the active set when off (memory pattern), so a
// disabled advisor has zero surface.
//
// Model chain: musepi.advisor.model → modelRoles.advisor →
// modelRoles.default → "" (the host then falls back to the session's
// current model, so an unconfigured advisor still works — as a
// fresh-context self-review with the reviewer persona).
// Zero host imports.
// ============================================================

export interface AdvisorGateConfig {
	enabled?: boolean;
}

/** Advisor is on unless explicitly disabled (default on). */
export function isAdvisorEnabled(config: AdvisorGateConfig | undefined): boolean {
	return config?.enabled !== false;
}

export interface AdvisorModelConfig {
	model?: string;
}

export interface AdvisorRoleChain {
	advisor?: string;
	default?: string;
}

/**
 * Resolve the review-model spec string. Returns "" when nothing is
 * configured — the host falls back to the session model. The spec uses
 * the model-roles syntax (provider/model[:thinkingLevel]); parsing and
 * registry matching happen host-side.
 */
export function resolveAdvisorModelSpec(
	advisor: AdvisorModelConfig | undefined,
	roles: AdvisorRoleChain | undefined,
): string {
	for (const candidate of [advisor?.model, roles?.advisor, roles?.default]) {
		const trimmed = candidate?.trim();
		if (trimmed) return trimmed;
	}
	return "";
}
