import type { Model } from "@musepi/pi-ai";
import { applyModelCompactionThreshold } from "../config/compaction-threshold";
import type { CompactionSettings } from "../config/settings";
import { registerCompactionThresholdStrategy, resolveCompactionThreshold } from "./compaction-threshold-strategy";

/**
 * The compaction policy in force for `model`: the configured policy with every
 * applicable threshold strategy applied. The built-in rule is
 * `compaction.modelThresholds` (a token entry becomes the base the
 * percentage/reserve policy scales, a fixed entry is the exact trigger, a
 * percentage entry replaces both fields); a plugin strategy registered with a
 * later priority only sees models that rule left alone.
 */
export function resolveModelCompactionSettings(
	settings: CompactionSettings,
	model: Pick<Model, "provider" | "id"> | null | undefined,
): CompactionSettings {
	return resolveCompactionThreshold(settings, model);
}

let builtinRegistered = false;

/**
 * Register the per-model rule as the default strategy. Idempotent so a host
 * that imports this module twice (SDK embedding, tests) does not hit the
 * duplicate-id guard.
 */
export function registerBuiltinCompactionThresholdStrategy(): void {
	if (builtinRegistered) return;
	builtinRegistered = true;
	registerCompactionThresholdStrategy({
		id: "modelThresholds",
		priority: 0,
		resolve: ({ settings, model }) => {
			if (!model || settings.modelThresholdsEnabled === false) return undefined;
			const applied = applyModelCompactionThreshold(settings, settings.modelThresholds, model);
			return applied === settings ? undefined : applied;
		},
	});
}

registerBuiltinCompactionThresholdStrategy();

/** The selector key governing `model`, for diagnostics and the settings UI. */
export function modelCompactionSelector(model: Pick<Model, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}
