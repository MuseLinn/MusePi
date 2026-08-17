import { t } from "@musepi/desktop-web";

/** Thinking effort ladder (mirrors pi-catalog Effort) + auto (per-model
 * default, TUI /settings defaultThinkingLevel parity). */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** zh label for a level; null/undefined = off (no thinking blocks). */
export function thinkingLabel(level: string | null | undefined): string {
	switch (level) {
		case "minimal":
			return t("thinking minimal");
		case "low":
			return t("thinking low");
		case "medium":
			return t("thinking medium");
		case "high":
			return t("thinking high");
		case "xhigh":
			return t("thinking xhigh");
		case "max":
			return t("thinking max");
		case "auto":
			return t("thinking auto");
		default:
			return t("thinking off");
	}
}
