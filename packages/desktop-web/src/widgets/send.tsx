import type { ReactNode } from "react";
import { t } from "../i18n/index.js";

/**
 * Shared "send to conversation" chip (kimi sendPrompt parity). Inline
 * chat widgets render it when the host wires `sendPrompt`; board cards
 * (no conversation) never pass it and the chip stays invisible.
 */
export function SendChip({ text, onSend }: { text: string; onSend?: (text: string) => void }): ReactNode {
	if (!onSend) return null;
	return (
		<button type="button" className="gui-widget-send" onClick={() => onSend(text)}>
			<span className="gui-widget-send-arrow">↗</span>
			{t("widget send")}
		</button>
	);
}
