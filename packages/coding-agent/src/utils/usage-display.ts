/**
 * Shared title composition for usage limits.
 *
 * The tier rule was written three times — the command-line report, the ACP
 * report text and the terminal panel — so any change to it had to be made
 * three times or the surfaces disagreed. The window suffix stays with each
 * renderer: they differ in where it belongs and whether the label already
 * carries it.
 */
import type { UsageLimit } from "@musepi/pi-ai";

/** Include the usage tier in a limit title unless its label already names it. */
export function formatLimitTitle(limit: UsageLimit): string {
	const tier = limit.scope.tier;
	if (tier && !limit.label.toLowerCase().includes(tier.toLowerCase())) {
		return `${limit.label} (${tier})`;
	}
	return limit.label;
}
