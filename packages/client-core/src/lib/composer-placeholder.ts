import { t } from "../i18n/index.js";

/**
 * One contextual placeholder for every composer surface (desktop session,
 * desktop welcome, mobile/web). The priority is the user's current situation,
 * not the surface: read-only and waiting states come first, then the design
 * mode's own brief, then a running turn, then staged attachments. Only an idle,
 * empty box teaches the @ and / affordances — after a conversation exists, a
 * shorter prompt keeps the composer quiet.
 */
export interface ComposerPlaceholderInput {
	surface: "session" | "welcome";
	compact?: boolean;
	readOnly?: boolean;
	waiting?: boolean;
	working?: boolean;
	attachmentCount?: number;
	hasConversation?: boolean;
	/** Creation/design rail's own chip-specific brief, when it has one. */
	designPlaceholder?: string | null;
}

export function composerPlaceholder(input: ComposerPlaceholderInput): string {
	if (input.readOnly) return t("composer.readOnlySessionWatching");
	if (input.waiting) return t("composer.waitingSession");
	if (input.designPlaceholder) return input.designPlaceholder;
	if (input.working) return t("composer.placeholderWorking");
	if ((input.attachmentCount ?? 0) > 0) return t("composer.placeholderAttachments");
	if (input.surface === "welcome") {
		return input.compact ? t("composer.askAnythingShort") : t("composer.placeholderWelcome");
	}
	if (input.compact) return t("composer.askAnythingShort");
	return input.hasConversation ? t("composer.placeholderSession") : t("composer.placeholderSessionCoach");
}
