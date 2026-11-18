import { type TranslationKey, t } from "../../i18n/index.js";

/**
 * Thinking ladder, display order (TUI `--thinking` parity). `auto` is the
 * session sentinel rather than a rung: it is what the composer shows when the
 * host reports no level.
 */
export const THINKING_LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
export type ThinkingLadder = (typeof THINKING_LADDER)[number];

/** Level id → label key. The composer's ladder menu and the header chip share it. */
export const THINKING_KEY: Record<ThinkingLadder, TranslationKey> = {
	off: "transcript.thinkingOff",
	minimal: "transcript.thinkingMinimal",
	low: "transcript.thinkingLow",
	medium: "transcript.thinkingMedium",
	high: "transcript.thinkingHigh",
	xhigh: "transcript.thinkingXhigh",
	max: "transcript.thinkingMax",
	auto: "transcript.thinkingAuto",
};

export function isThinkingLadder(value: string | null | undefined): value is ThinkingLadder {
	return typeof value === "string" && (THINKING_LADDER as readonly string[]).includes(value);
}

/**
 * Localized label for a wire thinking level, or null when the session reports
 * none. An id this build does not know renders verbatim: a newer host's rung
 * must not be relabelled as one of ours.
 */
export function thinkingLevelLabel(level: string | null | undefined): string | null {
	if (!level) return null;
	return isThinkingLadder(level) ? t(THINKING_KEY[level]) : level;
}
