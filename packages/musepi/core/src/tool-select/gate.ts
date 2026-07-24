// ============================================================
// Gate: is progressive tool disclosure active for this model?
//
// Two conditions must both hold (mirrors kimi-code's toolSelectService.enabled):
//   1. the experimental config switch is on (default off), AND
//   2. the model declares a deferred-tools capability
//      (`compat.deferredToolsMode === "kimi"`, e.g. moonshotai/kimi-k3)
//      or appears in the user allowlist (`musepi.toolSelect.models`).
// ============================================================

import type { ToolSelectGateConfig, ToolSelectModelRef } from "./types.ts";

/** Whether the model catalog natively serializes deferred tool loads. */
export function modelSupportsDeferredTools(model: ToolSelectModelRef | undefined): boolean {
	return model?.deferredToolsMode === "kimi";
}

/** Whether the model is named in the user allowlist (`provider/model` or bare id). */
export function modelInAllowlist(
	model: ToolSelectModelRef | undefined,
	allowlist: readonly string[] | undefined,
): boolean {
	if (!model || !allowlist || allowlist.length === 0) return false;
	const qualified = `${model.provider}/${model.id}`;
	return allowlist.some((entry) => entry === qualified || entry === model.id);
}

export function isToolSelectEnabled(
	config: ToolSelectGateConfig | undefined,
	model: ToolSelectModelRef | undefined,
): boolean {
	if (config?.enabled !== true) return false;
	return modelSupportsDeferredTools(model) || modelInAllowlist(model, config?.models);
}
