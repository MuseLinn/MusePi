/**
 * Shape of the full `session.contextUsage` answer used by the composer's
 * `/context` facets (thresholds, snapcompact, breakdown). The live ring/panel
 * numbers come from the host `contextUsage` projection; this wider shape is
 * only fetched on an explicit user open.
 */
import type { SnapcompactSavingsView, UsageSummaryView } from "../components/ContextRing";
import type { CompactionThresholdView } from "../components/composer/auto-compact-threshold";
import type { ContextBreakdownView } from "./context-command";

export type SessionUsageSnapshot = {
	tokens: number;
	contextWindow: number;
	percent: number;
	model?: string | null;
	snapcompact?: SnapcompactSavingsView | null;
	breakdown?: ContextBreakdownView | null;
	usage?: UsageSummaryView | null;
	autoCompactBufferTokens?: number;
	freeTokens?: number;
} & CompactionThresholdView;
