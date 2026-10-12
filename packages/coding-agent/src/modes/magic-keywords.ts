import { containsMagicKeyword, listMagicKeywordHighlighters, listMagicKeywords } from "./magic-keyword-registry";
import { containsOrchestrate, highlightOrchestrate } from "./orchestrate";
import { containsUltrathink, highlightUltrathink } from "./ultrathink";
import { containsWorkflow, highlightWorkflow } from "./workflow";

/**
 * Gradient-highlight every magic keyword that appears as standalone prose,
 * skipping any occurrence inside a code block, inline code span, or XML/HTML
 * section. Each highlighter paints its own keyword with its own gradient, so
 * chaining is order-independent — the earlier passes only inject zero-width SGR
 * escapes (no backticks or angle brackets), which never confuse the later
 * passes' markdown masking.
 *
 * Two sources are painted: the three compiled-in keywords and every keyword an
 * extension contributed through `pi.registerMagicKeyword`. An extension's
 * keyword gets the same affordance, so a word that nudges the model also reads
 * as active in the editor instead of sitting there as plain prose.
 *
 * `resetTo` is the SGR foreground sequence restored after each painted keyword;
 * pass the surrounding text color when decorating already-colored content (e.g.
 * a themed message bubble) so the gradient does not bleed into the rest of the
 * line. Defaults to a plain foreground reset for default-colored editor text.
 *
 * `phase` ∈ [0, 1) cyclically rotates each gradient — the editor passes a
 * `Date.now()`-derived value to animate a Claude-Code-style shimmer while a
 * keyword is on screen and the prompt is focused; sent message bubbles omit it
 * to keep the static gradient.
 */
export function highlightMagicKeywords(text: string, resetTo?: string, phase?: number): string {
	const builtin = highlightWorkflow(
		highlightOrchestrate(highlightUltrathink(text, resetTo, phase), resetTo, phase),
		resetTo,
		phase,
	);
	// Contribution highlighters chain over the built-ins, in registration order.
	let painted = builtin;
	for (const highlighter of listMagicKeywordHighlighters()) {
		painted = highlighter(painted, resetTo, phase);
	}
	return painted;
}

/**
 * Cheap test for "does this text contain any magic keyword as standalone
 * prose?". Short-circuits on a substring probe before paying for the
 * markdown-aware prose check, so the common "no keyword in buffer" path stays
 * cheap. Used by the live editor to gate the shimmer timer.
 *
 * Reads the registry rather than a fixed list: an extension's keyword must gate
 * the shimmer too, or it would silently never animate.
 */
export function hasMagicKeyword(text: string): boolean {
	const names = listMagicKeywords().map(keyword => keyword.name);
	if (
		!text.includes("ultrathink") &&
		!text.includes("orchestrate") &&
		!text.includes("workflowz") &&
		!names.some(name => text.includes(name))
	) {
		return false;
	}
	if (containsUltrathink(text) || containsOrchestrate(text) || containsWorkflow(text)) return true;
	for (const keyword of listMagicKeywords()) {
		if (containsMagicKeyword(keyword, text)) return true;
	}
	return false;
}
