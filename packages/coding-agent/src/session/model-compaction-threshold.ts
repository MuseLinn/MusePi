import type { Model } from "@musepi/pi-ai";
import { applyModelCompactionThreshold } from "../config/compaction-threshold";
import type { CompactionSettings } from "../config/settings";

/**
 * The compaction policy in force for `model`: the configured policy with its
 * `compaction.modelThresholds` entry applied. A token entry becomes the base
 * the percentage/reserve policy scales; a fixed entry is the exact trigger; a
 * percentage entry replaces both threshold fields.
 */
export function resolveModelCompactionSettings(
	settings: CompactionSettings,
	model: Pick<Model, "provider" | "id"> | null | undefined,
): CompactionSettings {
	if (settings.modelThresholdsEnabled === false) return settings;
	return applyModelCompactionThreshold(settings, settings.modelThresholds, model);
}

/** The selector key governing `model`, for diagnostics and the settings UI. */
export function modelCompactionSelector(model: Pick<Model, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}
