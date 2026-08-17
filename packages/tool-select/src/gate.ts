// ============================================================
// Gate: is progressive tool disclosure active for this model?
// ============================================================

import type { ToolSelectGateConfig, ToolSelectModelRef } from "./types.ts";

/** Model catalog `deferredToolsMode` values that enable native deferred tools. */
const NATIVE_DEFERRED_MODES = new Set(["kimi"]);

/**
 * Whether the model catalog natively serializes deferred tool loads.
 */
export function modelSupportsDeferredTools(model: ToolSelectModelRef | undefined): boolean {
	return model?.deferredToolsMode !== undefined && NATIVE_DEFERRED_MODES.has(model.deferredToolsMode);
}

/**
 * Whether the model is named in the user allowlist (`provider/model` or bare id).
 */
export function modelInAllowlist(
	model: ToolSelectModelRef | undefined,
	config: ToolSelectGateConfig | undefined,
): boolean {
	if (!model || !config?.models?.length) return false;
	const id = `${model.provider}/${model.id}`;
	return config.models.some(entry => entry === model.id || entry === id);
}

/**
 * Master gate: is tool-select active for this model + config combo?
 *
 * Two conditions must both hold:
 *   1. the experimental config switch is on, AND
 *   2. the model declares a deferred-tools capability (`deferredToolsMode === "kimi"`)
 *      OR appears in the user allowlist.
 */
export function isToolSelectEnabled(
	model: ToolSelectModelRef | undefined,
	config: ToolSelectGateConfig | undefined,
): boolean {
	if (!config?.enabled) return false;
	return modelSupportsDeferredTools(model) || modelInAllowlist(model, config);
}
