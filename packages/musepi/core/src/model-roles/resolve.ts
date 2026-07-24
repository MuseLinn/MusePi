// ============================================================
// Role resolution (pure).
//
// Every role falls back to "default" when unset or invalid; when the
// default role is also unset the result is undefined and the caller
// keeps its existing behavior (session model / auto routing).
// Diagnostics are returned, never thrown — a bad config value must
// degrade gracefully, not crash the session.
// ============================================================

import { formatSpecForLookup, parseRoleModelSpec } from "./parse.ts";
import { isModelRole, type ModelRole, type ModelRolesConfig, type RoleModelSpec } from "./types.ts";

export interface RoleResolution {
	/** Resolved spec, or undefined when neither the role nor "default" is configured. */
	spec?: RoleModelSpec;
	/** Which table entry produced the spec. */
	source: ModelRole | "none";
	/** Non-fatal problems found while resolving (invalid values, unknown roles). */
	diagnostics: string[];
}

function roleValue(config: ModelRolesConfig | undefined, role: ModelRole): string {
	const v = config?.[role];
	return typeof v === "string" ? v.trim() : "";
}

/**
 * Resolve the effective model spec for a role.
 * Order: the role's own value → the "default" role value → undefined.
 */
export function resolveModelForRole(config: ModelRolesConfig | undefined, role: string): RoleResolution {
	const diagnostics: string[] = [];
	if (!isModelRole(role)) {
		return { source: "none", diagnostics: [`unknown model role "${role}"`] };
	}

	const own = roleValue(config, role);
	if (own) {
		const parsed = parseRoleModelSpec(own);
		if (parsed.ok) return { spec: parsed.spec, source: role, diagnostics };
		diagnostics.push(`modelRoles.${role}: ${parsed.error} — falling back to "default"`);
	}

	if (role !== "default") {
		const dflt = roleValue(config, "default");
		if (dflt) {
			const parsed = parseRoleModelSpec(dflt);
			if (parsed.ok) return { spec: parsed.spec, source: "default", diagnostics };
			diagnostics.push(`modelRoles.default: ${parsed.error}`);
		}
	}

	return { source: "none", diagnostics };
}

/**
 * Resolve a role's fallback chain into ordered candidate specs.
 * Invalid entries are skipped with diagnostics; order is preserved.
 */
export function resolveFallbackChain(
	config: ModelRolesConfig | undefined,
	role: string,
): { specs: RoleModelSpec[]; diagnostics: string[] } {
	const diagnostics: string[] = [];
	if (!isModelRole(role)) {
		return { specs: [], diagnostics: [`unknown model role "${role}"`] };
	}
	const raw = config?.fallbackChains?.[role];
	if (!Array.isArray(raw)) return { specs: [], diagnostics };

	const specs: RoleModelSpec[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || !entry.trim()) {
			diagnostics.push(`modelRoles.fallbackChains.${role}: skipped non-string entry`);
			continue;
		}
		const parsed = parseRoleModelSpec(entry);
		if (parsed.ok) specs.push(parsed.spec);
		else diagnostics.push(`modelRoles.fallbackChains.${role}: ${parsed.error}`);
	}
	return { specs, diagnostics };
}

/**
 * Resolve the cycle order: valid built-in role names in the configured
 * order; unknown names are dropped with diagnostics. Empty when unset.
 */
export function resolveCycleOrder(config: ModelRolesConfig | undefined): { roles: ModelRole[]; diagnostics: string[] } {
	const diagnostics: string[] = [];
	const raw = config?.cycleOrder;
	if (!Array.isArray(raw)) return { roles: [], diagnostics };
	const roles: ModelRole[] = [];
	for (const entry of raw) {
		if (typeof entry === "string" && isModelRole(entry)) roles.push(entry);
		else diagnostics.push(`modelRoles.cycleOrder: unknown role "${String(entry)}"`);
	}
	return { roles, diagnostics };
}

/** Convenience: ordered candidate specs for a role — role value first, then the fallback chain. */
export function resolveCandidatesForRole(
	config: ModelRolesConfig | undefined,
	role: string,
): { specs: RoleModelSpec[]; diagnostics: string[] } {
	const diagnostics: string[] = [];
	const primary = resolveModelForRole(config, role);
	diagnostics.push(...primary.diagnostics);
	const chain = resolveFallbackChain(config, role);
	diagnostics.push(...chain.diagnostics);

	const specs: RoleModelSpec[] = [];
	const seen = new Set<string>();
	if (primary.spec) {
		specs.push(primary.spec);
		seen.add(formatSpecForLookup(primary.spec));
	}
	for (const spec of chain.specs) {
		const key = formatSpecForLookup(spec);
		if (seen.has(key)) continue;
		seen.add(key);
		specs.push(spec);
	}
	return { specs, diagnostics };
}
