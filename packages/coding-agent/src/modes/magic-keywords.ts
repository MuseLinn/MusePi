import { containsMagicKeyword, listMagicKeywordHighlighters, listMagicKeywords } from "./magic-keyword-registry";

/**
 * Gradient-highlight every registered magic keyword that appears as standalone
 * prose, skipping code spans, fenced blocks, and XML/HTML sections. Each
 * highlighter injects zero-width SGR escapes, so chained passes do not disturb
 * the next pass's markdown masking.
 *
 * `resetTo` is the foreground restored after each painted keyword. `phase`
 * cyclically rotates the gradient for the live editor; sent messages omit it to
 * keep a static gradient.
 */
export function highlightMagicKeywords(text: string, resetTo?: string, phase?: number): string {
	let painted = text;
	for (const highlighter of listMagicKeywordHighlighters()) {
		painted = highlighter(painted, resetTo, phase);
	}
	return painted;
}

/** Whether any registered keyword appears as standalone prose. A substring
 * probe avoids the markdown-aware check for the common keyword-free buffer. */
export function hasMagicKeyword(text: string): boolean {
	const keywords = listMagicKeywords();
	if (!keywords.some(keyword => text.includes(keyword.trigger ?? keyword.name))) return false;
	return keywords.some(keyword => containsMagicKeyword(keyword, text));
}
