import { resolveThresholdTokens } from "@musepi/pi-agent-core/compaction";
import type { Model } from "@musepi/pi-ai";
import { matchModelCompactionThreshold } from "../config/compaction-threshold";
import type { CompactionSettings } from "../config/settings";
import { resolveModelCompactionSettings } from "./model-compaction-threshold";

/**
 * The auto-compaction trigger as every usage surface reads it: a percentage
 * of the live model's context window, the mode that produced it, and the
 * layer a write must target to change it.
 */
export interface CompactionThresholdView {
	/** Effective trigger in tokens (what `shouldCompact` compares against). */
	thresholdTokens: number;
	/** Effective trigger as a share of the context window (0–100). */
	thresholdPercent: number;
	/** `auto` = legacy reserve policy, `percent` = configured share, `fixed`
	 *  = exact token trigger (global `thresholdTokens` or a model `fN`). */
	thresholdMode: "auto" | "percent" | "fixed";
	/** Which layer decides the trigger: the global policy or this model's
	 *  `compaction.modelThresholds` entry. */
	thresholdScope: "global" | "model";
	/** Explicit percentage the slider rests on; null while `auto` decides. */
	thresholdValuePercent: number | null;
	/** The governing `compaction.modelThresholds` key, when one applies. */
	thresholdModelKey: string | null;
}

/**
 * Project the configured compaction policy for `model` against a concrete
 * context window. `null` when the window is unknown or compaction is off (the
 * GUI then renders no threshold row at all).
 */
export function projectCompactionThreshold(
	settings: CompactionSettings,
	contextWindow: number,
	model: Pick<Model, "provider" | "id"> | null | undefined,
): CompactionThresholdView | null {
	if (!(contextWindow > 0) || !settings.enabled) return null;
	const effective = resolveModelCompactionSettings(settings, model);
	const thresholdTokens = resolveThresholdTokens(contextWindow, effective);
	if (!(thresholdTokens > 0)) return null;

	const match =
		settings.modelThresholdsEnabled !== false && model
			? matchModelCompactionThreshold(settings.modelThresholds, model)
			: undefined;
	const thresholdModelKey = match?.key ?? null;

	let thresholdMode: CompactionThresholdView["thresholdMode"] = "auto";
	let thresholdScope: CompactionThresholdView["thresholdScope"] = "global";
	let thresholdValuePercent: number | null = null;
	if (effective.thresholdTokens > 0) {
		// A fixed trigger (`fN`) is exact and cannot scale; a global token cap
		// is the same shape for every model.
		thresholdMode = "fixed";
		thresholdScope = match?.threshold.fixed ? "model" : "global";
	} else if (effective.thresholdPercent > 0) {
		thresholdMode = "percent";
		thresholdScope = (match?.threshold.thresholdPercent ?? 0) > 0 ? "model" : "global";
		thresholdValuePercent = effective.thresholdPercent;
	}

	return {
		thresholdTokens,
		thresholdPercent: (thresholdTokens / contextWindow) * 100,
		thresholdMode,
		thresholdScope,
		thresholdValuePercent,
		thresholdModelKey,
	};
}
