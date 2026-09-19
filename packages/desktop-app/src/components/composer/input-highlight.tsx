import type { ReactNode } from "react";

/**
 * In-input token highlighting (TUI editor parity): an overlay mirror of the
 * composer textarea that paints line-leading slash commands and standalone
 * magic keywords in accent colour while the textarea's own text is
 * transparent (the caret stays visible via caret-color). Pure visual —
 * pointer-events none, aria-hidden; the textarea remains the single input
 * surface and the overlay never intercepts anything.
 *
 * Pairing rules (the overlay MUST track the textarea pixel-for-pixel):
 * same box (absolute inset-0 inside the shared stack), same font metrics
 * (per-variant class), `white-space: pre-wrap` + the same wrapping, and a
 * scroll mirror — the textarea's onScroll copies scrollTop onto the
 * overlay (its previousElementSibling inside the stack).
 */

export type HighlightKind = "slash" | "magic";

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
 *  it opens the line, so mid-text "/btw" must NOT read as live syntax. */
const LEADING_SLASH_RE = /(^|\n)(\/[^\s/][^\s]*)/gu;

export function parseHighlightSpans(text: string): HighlightSpan[] {
	const spans: HighlightSpan[] = [];
	for (const m of text.matchAll(LEADING_SLASH_RE)) {
		const idx = (m.index ?? 0) + m[1]!.length;
		spans.push({ start: idx, end: idx + m[2]!.length, kind: "slash" });
	}
	for (const w of MAGIC_WORDS) {
		for (const m of text.matchAll(KW(w))) {
			const idx = m.index ?? 0;
			spans.push({ start: idx, end: idx + w.length, kind: "magic" });
		}
	}
	return spans.sort((a, b) => a.start - b.start);
}

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
			<span key={i} className={s.kind === "slash" ? "gui-ta-hl-slash" : "gui-ta-hl-magic"}>
				{text.slice(s.start, s.end)}
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
