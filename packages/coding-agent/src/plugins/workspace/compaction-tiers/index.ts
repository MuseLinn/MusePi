import type { Model } from "@musepi/pi-ai";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { isVolatileRef } from "@musepi/pi-coding-agent/plugin-config";

import type { Config } from "./config";

export { Config } from "./config";

export const name = "musepi-compaction-tiers";
export const inject = [] as const;
export const provide = [] as const;

/** Fallback for a direct `apply` call; a mounted plugin receives the schema default. */
const DEFAULT_CAP_PERCENT = 70;

/**
 * Whether the catalog prices this model's long context at a premium: a
 * `cost.longContext` tier means requests past `inputThreshold` bill more, so
 * compaction should fire before the prompt crosses it.
 */
function hasPremiumLongContext(model: Pick<Model, "provider" | "id">): boolean {
	const cost = (model as { cost?: { longContext?: { inputThreshold?: number } } }).cost;
	const threshold = cost?.longContext?.inputThreshold;
	return typeof threshold === "number" && threshold > 0;
}

/**
 * Cap the compaction trigger on models that bill long context at a premium.
 *
 * This is the reference use of the threshold-strategy seam: the rule lives in a
 * plugin, needs no host field, and stays out of the way of everything else.
 *
 * - The built-in `compaction.modelThresholds` rule runs first (priority 0), so
 *   an explicit per-model entry a user typed always wins over this cap.
 * - Only the threshold percentage is rewritten. Compaction on/off, the method
 *   order and the keep-recent budget stay the user's configuration.
 * - A model with no premium tier, or one whose effective trigger is already at
 *   or below the cap, is left untouched, so the configured policy still
 *   decides.
 */
/** The effective cap: a volatile ref is read per resolve, so an edit is live. */
function capOf(value: unknown): number {
	const raw = isVolatileRef(value) ? value.get() : value;
	const configured = Number(raw ?? DEFAULT_CAP_PERCENT);
	return Number.isFinite(configured) && configured > 0 && configured < 100 ? configured : DEFAULT_CAP_PERCENT;
}

export function apply(pi: PluginAPI, config?: Config): void {
	const capRef = config?.capPercent;
	pi.registerCompactionThresholdStrategy({
		id: "compactionTiers.premiumCap",
		priority: 10,
		resolve: ({ settings, model }) => {
			const cap = capOf(capRef);
			if (!model || !hasPremiumLongContext(model)) return undefined;
			const effective = settings.thresholdPercent;
			// A fixed token trigger or the legacy reserve policy is not a share of
			// the window, so a percentage cap has nothing to rewrite.
			if (!(effective > 0) || effective <= cap) return undefined;
			return { ...settings, thresholdPercent: cap };
		},
	});
}
