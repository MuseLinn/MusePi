import type { ReactNode } from "react";

/**
 * In-input token highlighting (TUI editor parity): an overlay mirror of the
 * composer textarea that paints line-leading slash commands, message-leading
 * shell bangs and standalone magic keywords as accent pills while the
 * textarea's own text is transparent (the caret stays visible via
 * caret-color). Pure visual — pointer-events none, aria-hidden; the
 * textarea remains the single input surface and the overlay never
 * intercepts anything.
 *
 * Pairing rules (the overlay MUST track the textarea pixel-for-pixel):
 * same box (absolute inset-0 inside the shared stack), same font metrics
 * (per-variant class), `white-space: pre-wrap` + the same wrapping, and a
 * scroll mirror — the textarea's onScroll copies scrollTop onto the
 * overlay (its previousElementSibling inside the stack). The pills are
 * members of the shared liquid-glass material family (gui-composer.css):
 * metric-neutral by construction — colour/fill/rim/sheen only, horizontal
 * padding repaid by an equal negative margin, and the token text wrapped
 * in an inner <span> so the `> *` rescue lifts it above the family's
 * sheen layer. ANY glyph-advance change skews the caret.
 *
 * Deliberately NOT highlighted: `@` and `#` tokens — nothing in the send
 * path expands them (no mention/memory syntax in this product), so a pill
 * would promise behaviour that does not exist. `@file` expansion is a
 * print-mode/TUI flow, not a composer one.
 */

export type HighlightKind = "slash" | "bang" | "magic";

export interface HighlightSpan {
	start: number;
	end: number;
	kind: HighlightKind;
}

/** Standalone magic keywords (same prose-boundary regex as the agent and
 *  magic-keyword-tip.tsx: no letters/digits/underscore/slash/hyphen/dot/
 *  paren adjacency — "/ultrathink" or "foo.ultrathink" stay plain). */
const MAGIC_WORDS = ["ultrathink", "orchestrate", "workflowz"] as const;

const KW = (kw: string): RegExp =>
	new RegExp(String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)${kw}(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`, "gu");

/** Line-leading slash commands only — the TUI executes a command only when
 *  it opens the line, so mid-text "/btw" must NOT read as live syntax.
 *  (The daemon dispatches the whole-message head — a mid-draft line-leading
 *  token is an affordance, not a promise; the tip row shares this rule.) */
const LEADING_SLASH_RE = /(^|\n)(\/[^\s/][^\s]*)/gu;

/** Line-leading shell prefix (TUI !/!! parity): "!" or "!!" opening a line
 *  plus the command head. "! cmd" also executes (the send path trims the
 *  body), so inner whitespace rides inside the pill. */
const LEADING_BANG_RE = /(^|\n)(!!?[^\S\n]*[^\s]+)/gu;

export function parseHighlightSpans(text: string): HighlightSpan[] {
	const spans: HighlightSpan[] = [];
	for (const m of text.matchAll(LEADING_SLASH_RE)) {
		const idx = (m.index ?? 0) + m[1]!.length;
		spans.push({ start: idx, end: idx + m[2]!.length, kind: "slash" });
	}
	for (const m of text.matchAll(LEADING_BANG_RE)) {
		const idx = (m.index ?? 0) + m[1]!.length;
		spans.push({ start: idx, end: idx + m[2]!.length, kind: "bang" });
	}
	for (const w of MAGIC_WORDS) {
		for (const m of text.matchAll(KW(w))) {
			const idx = m.index ?? 0;
			spans.push({ start: idx, end: idx + w.length, kind: "magic" });
		}
	}
	return dedupeSpans(spans.sort((a, b) => a.start - b.start));
}

/** First span wins: paint order by start, later spans that begin inside a
 *  painted one are dropped (same greedy the renderer's cursor guard uses —
 *  the parser just guarantees the invariant up front). "!!workflowz" is a
 *  shell bang, not a thinking trigger. */
function dedupeSpans(sorted: HighlightSpan[]): HighlightSpan[] {
	const out: HighlightSpan[] = [];
	let cursor = -1;
	for (const s of sorted) {
		if (s.start < cursor) continue;
		out.push(s);
		cursor = s.end;
	}
	return out;
}

const HL_CLASS: Record<HighlightKind, string> = {
	slash: "gui-ta-hl-slash",
	bang: "gui-ta-hl-bang",
	magic: "gui-ta-hl-magic",
};

/** Mirror layer: render `text` with the parsed spans wrapped in tinted
 *  spans. Trailing newline gets a zero-width space so pre-wrap keeps the
 *  final empty line's height (the textarea scrolls one line further). */
export function ComposerHighlight({ text, className }: { text: string; className: string }): ReactNode {
	const spans = parseHighlightSpans(text);
	const parts: ReactNode[] = [];
	let cursor = 0;
	spans.forEach((s, i) => {
		if (s.start < cursor) return; // overlapping match — first span wins
		if (s.start > cursor) parts.push(text.slice(cursor, s.start));
		parts.push(
			<span key={i} className={HL_CLASS[s.kind]}>
				{/* Inner span: the glass family paints a sheen ::before at
				 * z-index 0 over raw inline text; the `> *` rescue rule lifts
				 * this wrapper above it. Pure stacking — zero metrics. */}
				<span>{text.slice(s.start, s.end)}</span>
			</span>,
		);
		cursor = s.end;
	});
	if (cursor < text.length) parts.push(text.slice(cursor));
	return (
		<div aria-hidden className={`gui-ta-highlight ${className}`}>
			{parts}
			{text.endsWith("\n") || text.length === 0 ? "\u200b" : null}
		</div>
	);
}
