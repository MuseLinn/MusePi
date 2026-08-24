import { useState } from "react";

/** Pending long-text paste awaiting the user's action choice. */
export interface LongPasteState {
	text: string;
	lineCount: number;
	charCount: number;
}

/** Large pastes gate behind a chooser (GUI parity with TUI paste.largeMenuThreshold).
 *  Threshold: >100 lines OR >4000 chars — a paste that would flood the chat. */
const MAX_GATE_LINES = 100;
const MAX_GATE_CHARS = 4000;

export function isLongPastedText(text: string): boolean {
	if (!text) return false;
	const lineCount = text.split("\n").length;
	return lineCount > MAX_GATE_LINES || text.length > MAX_GATE_CHARS;
}

/**
 * Hook for gating long text pastes behind a user-choice menu.
 * Returns the pending paste state and controls to show/dismiss it.
 */
export function useLongTextPaste(): {
	pending: LongPasteState | null;
	requestPaste: (text: string) => void;
	dismiss: () => void;
} {
	const [pending, setPending] = useState<LongPasteState | null>(null);

	const requestPaste = (text: string) => {
		setPending({ text, lineCount: text.split("\n").length, charCount: text.length });
	};

	const dismiss = () => setPending(null);

	return { pending, requestPaste, dismiss };
}