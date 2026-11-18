import { parseMentionTokens } from "./mention-token";

/**
 * Token span parser shared by the CodeMirror composer decorations (TUI editor
 * parity): line-leading slash commands, message-leading shell bangs,
 * standalone magic keywords and attachment-mention tokens become paint spans.
 *
 * CodeMirror owns the text and the caret now, so this module only answers
 * "which ranges are tokens"; the host paints `HL_CLASS[kind]` as mark
 * decorations and resolves hover/click from coordinates. A `@名字` candidate
 * is painted ONLY when 名字 resolves against the live chip list, and the same
 * gate drives the send-path expansion so paint and expand cannot disagree.
 * Bare `@path` stays unpainted and unexpanded (print-mode/TUI semantics); a
 * token whose attachment was removed stops resolving and reverts to text.
 */

export type HighlightKind = "slash" | "bang" | "magic" | "mention";

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

/** Attachment data behind a mention pill, resolved by the host from its
 *  live chip list. Returning null means "no chip with this name" — the
 *  token is plain text: not painted here, not expanded on send. */
export interface MentionPreview {
	kind: "image" | "file";
	name: string;
	size?: number;
	/** Image thumbnail (data URL) for the hover card. */
	dataUrl?: string;
}

export type MentionResolver = (name: string) => MentionPreview | null;

export function parseHighlightSpans(text: string, resolveMention: MentionResolver): HighlightSpan[] {
	const spans: HighlightSpan[] = [];
	// Mentions first: only candidates that resolve against the live chips
	// are painted. Pushed BEFORE slash/bang/magic so the stable sort hands
	// equal-start regions to the mention pill (an attachment literally
	// named "workflowz" reads as a reference, not the thinking trigger);
	// unresolved candidates are simply absent, leaving magic/slash free to
	// claim the region.
	for (const m of parseMentionTokens(text)) {
		if (resolveMention(m.name)) spans.push({ start: m.start, end: m.end, kind: "mention" });
	}
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

export const HL_CLASS: Record<HighlightKind, string> = {
	slash: "gui-ta-hl-slash",
	bang: "gui-ta-hl-bang",
	magic: "gui-ta-hl-magic",
	mention: "gui-ta-hl-mention",
};
