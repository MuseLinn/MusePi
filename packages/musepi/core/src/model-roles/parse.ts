// ============================================================
// Role model-spec parsing (pure).
//
// Accepted forms:
//   provider/model            anthropic/claude-sonnet-4-5
//   provider/model:level      anthropic/claude-sonnet-4-5:medium
//   provider:model            anthropic:claude-sonnet-4-5
//   provider:model:level      anthropic:claude-sonnet-4-5:high
//   model                     claude-sonnet-4-5
//   model:level               claude-sonnet-4-5:low
//
// A trailing ":<level>" is only stripped when it is a valid thinking
// level; a trailing colon segment that is NOT a valid level is an
// error (likely a typo'd suffix), never silently dropped.
// ============================================================

import { isRoleThinkingLevel, ROLE_THINKING_LEVELS, type RoleModelSpec } from "./types.ts";

export type ParseRoleSpecResult = { ok: true; spec: RoleModelSpec } | { ok: false; error: string };

function invalidSuffixError(value: string, suffix: string): string {
	return `invalid thinking level "${suffix}" in "${value}" (valid: ${ROLE_THINKING_LEVELS.join(", ")})`;
}

/** Parse one role value into a structured spec, or explain why it is invalid. */
export function parseRoleModelSpec(raw: string): ParseRoleSpecResult {
	const value = (raw ?? "").trim();
	if (!value) return { ok: false, error: "empty model spec" };

	// Slash form: provider/model[:level] — the provider boundary is the
	// first "/", everything after is model[:level].
	const slashIdx = value.indexOf("/");
	if (slashIdx >= 0) {
		const provider = value.slice(0, slashIdx).trim();
		let rest = value.slice(slashIdx + 1).trim();
		if (!provider) return { ok: false, error: `missing provider in "${value}"` };
		if (!rest) return { ok: false, error: `missing model id in "${value}"` };
		const spec: RoleModelSpec = { provider, modelId: rest };
		const colonIdx = rest.lastIndexOf(":");
		if (colonIdx >= 0) {
			const suffix = rest.slice(colonIdx + 1);
			if (!isRoleThinkingLevel(suffix)) return { ok: false, error: invalidSuffixError(value, suffix) };
			spec.thinkingLevel = suffix;
			rest = rest.slice(0, colonIdx).trim();
			if (!rest) return { ok: false, error: `missing model id in "${value}"` };
			spec.modelId = rest;
		}
		return { ok: true, spec };
	}

	// Colon forms (no slash): split into segments and classify.
	const segments = value.split(":");
	if (segments.length === 1) {
		return { ok: true, spec: { modelId: value } };
	}
	if (segments.length === 2) {
		const [head, tail] = segments.map((s) => s.trim());
		if (!head || !tail) return { ok: false, error: `malformed model spec "${value}"` };
		if (isRoleThinkingLevel(tail)) {
			// model:level
			return { ok: true, spec: { modelId: head, thinkingLevel: tail } };
		}
		// provider:model
		return { ok: true, spec: { provider: head, modelId: tail } };
	}
	if (segments.length === 3) {
		const [provider, modelId, suffix] = segments.map((s) => s.trim());
		if (!provider || !modelId) return { ok: false, error: `malformed model spec "${value}"` };
		if (!isRoleThinkingLevel(suffix)) return { ok: false, error: invalidSuffixError(value, suffix) };
		return { ok: true, spec: { provider, modelId, thinkingLevel: suffix } };
	}
	return { ok: false, error: `malformed model spec "${value}" (too many ":" segments)` };
}

/** Format a spec back to the canonical "provider:modelId" lookup form (no thinking suffix). */
export function formatSpecForLookup(spec: RoleModelSpec): string {
	return spec.provider ? `${spec.provider}:${spec.modelId}` : spec.modelId;
}
