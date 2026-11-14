import { t } from "@musepi/client-core";

/** Thinking effort ladder (mirrors pi-catalog Effort) + auto (per-model
 * default, TUI /settings defaultThinkingLevel parity). */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** zh label for a level; null/undefined = off (no thinking blocks). */
export function thinkingLabel(level: string | null | undefined): string {
	switch (level) {
		case "minimal":
			return t("transcript.thinkingMinimal");
		case "low":
			return t("transcript.thinkingLow");
		case "medium":
			return t("transcript.thinkingMedium");
		case "high":
			return t("transcript.thinkingHigh");
		case "xhigh":
			return t("transcript.thinkingXhigh");
		case "max":
			return t("transcript.thinkingMax");
		case "auto":
			return t("transcript.thinkingAuto");
		default:
			return t("transcript.thinkingOff");
	}
}
