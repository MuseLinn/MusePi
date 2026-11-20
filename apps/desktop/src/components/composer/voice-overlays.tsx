import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { VoiceStatusStrip } from "./action-buttons";

/** The voice surfaces both composer skins float inside the card.
 *
 * Dictation is input state, not scene state, so the live strip, the error row
 * and the setup dialog render the same way in the welcome card and in session.
 * `showHint` is the one real difference: only the in-session composer advertises
 * the Esc-cancel affordance.
 */
export interface VoiceOverlaysProps {
	dictation: {
		phase: "idle" | "recording" | "transcribing";
		seconds: number;
		level: number;
		partialText: string;
		error: string | null;
	};
	/** The voice setup dialog's node, when the host mounts one. */
	dialog?: ReactNode;
	showHint?: boolean;
}

export function VoiceOverlays({ dictation, dialog, showHint = false }: VoiceOverlaysProps): ReactNode {
	return (
		<>
			{dictation.phase !== "idle" && (
				<VoiceStatusStrip
					phase={dictation.phase}
					seconds={dictation.seconds}
					level={dictation.level}
					partialText={dictation.partialText}
				/>
			)}
			{dictation.error && (
				<div className="gui-voice-error" role="status" aria-live="polite">
					<span className="gui-voice-error-dot" aria-hidden />
					<span className="min-w-0 flex-1">{dictation.error}</span>
					{showHint && <span className="gui-voice-error-hint">{t("settings.voiceEscCancel")}</span>}
				</div>
			)}
			{dialog}
		</>
	);
}
