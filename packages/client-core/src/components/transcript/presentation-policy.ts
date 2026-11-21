/**
 * Transcript presentation policy: one stable object derived from the three
 * independent reading preferences. Renderers select the capabilities below
 * instead of intersecting preference flags at each call site.
 *
 * Mode capabilities:
 *
 * - `compact`   — group every round, including the running one; no live
 *                 process detail and no settled reasoning detail.
 * - `standard`  — same grouping, with the running detail and the settled
 *                 reasoning detail.
 * - `detailed`  — group historical rounds only (the running turn stays flat),
 *                 with detail and the settled duration. This is the default
 *                 and reproduces the pre-preference transcript exactly.
 * - `verbose`   — never fold or group a round.
 */

import {
	type CollapseTiming,
	DEFAULT_COLLAPSE_TIMING,
	DEFAULT_FOLDED_REPLIES,
	DEFAULT_TRANSCRIPT_VIEW_MODE,
	type FoldedReplies,
	readTranscriptPrefs,
	type TranscriptViewMode,
} from "./transcript-prefs.js";

/** Capabilities one presentation mode enables. */
export interface TranscriptPresentationPolicy {
	/** Preference identity for diagnostics and layout resets. */
	readonly mode: TranscriptViewMode;
	/** Saved collapse timing; `completion` keeps immediate folding. */
	readonly collapseTiming: CollapseTiming;
	/** Assistant replies kept visible in a folded round. */
	readonly foldedReplies: FoldedReplies;
	/** Whether a completed round folds its process behind the 活动 header. */
	readonly foldCompletedTurns: boolean;
	/** Step group headers for every round (including the running one),
	 *  historical rounds only, or no rounds. */
	readonly stepGrouping: "collapsed" | "history" | "none";
	/** Whether the latest completed round stays expanded until the next user
	 *  message (`collapseTiming: "next-input"`). Grouping modes keep their
	 *  header on that round and hold it open; history mode leaves it flat.
	 *  The fold engine records this on `RoundFold.deferred`, which the
	 *  transcript's default-open rule consumes. */
	readonly deferTrailingFold: boolean;
	/** Show the running command/path/query detail in a live group header. */
	readonly liveProcessDetail: boolean;
	/** Whether a settled reasoning row keeps its duration detail
	 *  (`思考过程 · 12s`). MusePi has no first-line preview in a collapsed
	 *  reasoning row, so this capability is the settled label's detail — the
	 *  default keeps it, and compact drops it. */
	readonly settledReasoningPreview: boolean;
}

type ModeCapabilities = Omit<TranscriptPresentationPolicy, "collapseTiming" | "foldedReplies" | "deferTrailingFold">;

const MODE_CAPABILITIES: Readonly<Record<TranscriptViewMode, ModeCapabilities>> = {
	compact: {
		mode: "compact",
		foldCompletedTurns: true,
		stepGrouping: "collapsed",
		liveProcessDetail: false,
		settledReasoningPreview: false,
	},
	standard: {
		mode: "standard",
		foldCompletedTurns: true,
		stepGrouping: "collapsed",
		liveProcessDetail: true,
		settledReasoningPreview: true,
	},
	detailed: {
		mode: "detailed",
		foldCompletedTurns: true,
		stepGrouping: "history",
		liveProcessDetail: true,
		settledReasoningPreview: true,
	},
	verbose: {
		mode: "verbose",
		foldCompletedTurns: false,
		stepGrouping: "none",
		liveProcessDetail: false,
		settledReasoningPreview: true,
	},
};

/** Per-timing/reply tables: every (mode, timing, replies) triple resolves to
 *  the same object on every call, so renderers can pass the policy through
 *  memo comparisons by identity. */
const POLICIES: Readonly<
	Record<
		CollapseTiming,
		Readonly<Record<FoldedReplies, Readonly<Record<TranscriptViewMode, TranscriptPresentationPolicy>>>>
	>
> = {
	completion: {
		all: buildTimingTable("completion", "all"),
		final: buildTimingTable("completion", "final"),
	},
	"next-input": {
		all: buildTimingTable("next-input", "all"),
		final: buildTimingTable("next-input", "final"),
	},
};

function buildTimingTable(
	collapseTiming: CollapseTiming,
	foldedReplies: FoldedReplies,
): Readonly<Record<TranscriptViewMode, TranscriptPresentationPolicy>> {
	const deferTrailingFold = collapseTiming === "next-input";
	return {
		compact: { ...MODE_CAPABILITIES.compact, collapseTiming, foldedReplies, deferTrailingFold },
		standard: { ...MODE_CAPABILITIES.standard, collapseTiming, foldedReplies, deferTrailingFold },
		detailed: { ...MODE_CAPABILITIES.detailed, collapseTiming, foldedReplies, deferTrailingFold },
		verbose: { ...MODE_CAPABILITIES.verbose, collapseTiming, foldedReplies, deferTrailingFold },
	};
}

/**
 * Resolve one stable policy for a mode, collapse timing, and folded-reply
 * choice.
 * @param mode - persisted work-details mode.
 * @param collapseTiming - persisted timing; defaults to folding on completion.
 * @param foldedReplies - persisted reply choice; defaults to final answer only.
 * @returns the same policy object for the same choices.
 */
export function presentationPolicyFor(
	mode: TranscriptViewMode,
	collapseTiming: CollapseTiming = DEFAULT_COLLAPSE_TIMING,
	foldedReplies: FoldedReplies = DEFAULT_FOLDED_REPLIES,
): TranscriptPresentationPolicy {
	return POLICIES[collapseTiming][foldedReplies][mode];
}

/** Policy for the stored preferences — the default reading is exactly the
 *  pre-preference transcript (detailed + completion + final). */
export function transcriptPresentationPolicy(): TranscriptPresentationPolicy {
	const prefs = readTranscriptPrefs();
	return presentationPolicyFor(prefs.transcriptView, prefs.collapseTiming, prefs.foldedReplies);
}

/** The default policy without touching storage (tests and static defaults). */
export const DEFAULT_PRESENTATION_POLICY = presentationPolicyFor(DEFAULT_TRANSCRIPT_VIEW_MODE);
