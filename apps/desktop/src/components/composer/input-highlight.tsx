import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseMentionTokens } from "./mention-token";

/**
 * In-input token highlighting (TUI editor parity): an overlay mirror of the
 * composer textarea that paints line-leading slash commands, message-leading
 * shell bangs, standalone magic keywords and attachment-mention tokens as
 * pills while the textarea's own text is transparent (the caret stays
 * visible via caret-color). The textarea remains the single input surface.
 *
 * Pairing rules (the overlay MUST track the textarea pixel-for-pixel):
 * same box (absolute inset-0 inside the shared stack), same font metrics
 * (per-variant class), `white-space: pre-wrap` + the same wrapping, and a
 * scroll mirror — the textarea's onScroll copies scrollTop onto the
 * overlay (its previousElementSibling inside the stack). The pills are
 * members of the shared liquid-glass material family (gui-composer.css):
 * metric-neutral by construction — colour/fill only, horizontal
 * padding repaid by an equal negative margin, and the token text wrapped
 * in an inner <span> so the `> *` rescue lifts it above the family's
 * sheen layer. ANY glyph-advance change skews the caret.
 *
 * `@` note (updated 2026-09-26, v2 grammar): a `@名字` candidate is
 * painted ONLY when 名字 resolves against the host's live chip list —
 * the host passes `resolveMention` (required: mention paint DEPENDS on
 * it) and the same gate drives the send-path expansion, so paint and
 * expand can never disagree. Bare `@path` stays unpainted and unexpanded
 * (that flow is print-mode/TUI); a token whose attachment was removed
 * stops resolving and silently reverts to plain text. Unpainted tokens
 * carry no pointer events — hover preview / click-to-caret live on the
 * resolved pills only.
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

const HL_CLASS: Record<HighlightKind, string> = {
	slash: "gui-ta-hl-slash",
	bang: "gui-ta-hl-bang",
	magic: "gui-ta-hl-magic",
	mention: "gui-ta-hl-mention",
};

/** Hover-card size labels ("1.2 MB"). */
function mentionSizeLabel(size: number | undefined): string {
	if (!size || !Number.isFinite(size) || size <= 0) return "";
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

interface MentionPop {
	name: string;
	preview: MentionPreview | null;
	x: number;
	y: number;
}

/** Mirror layer: render `text` with the parsed spans wrapped in tinted
 *  spans. Trailing newline gets a zero-width space so pre-wrap keeps the
 *  final empty line's height (the textarea scrolls one line further).
 *  `resolveMention` is required — mention paint is gated on it; pass
 *  `onMentionClick` to give the resolved pills their click-to-caret jump. */
export function ComposerHighlight({
	text,
	className,
	resolveMention,
	onMentionClick,
}: {
	text: string;
	className: string;
	resolveMention: MentionResolver;
	onMentionClick?(start: number): void;
}): ReactNode {
	// Hover preview state — one portaled card at a time, positioned from
	// the pill's own rect (the overlay's overflow:hidden would clip a
	// nested card, so the card lives outside it).
	const [pop, setPop] = useState<MentionPop | null>(null);
	const popHideRef = useRef<Timer | undefined>(undefined);
	const showPop = (name: string, el: HTMLElement): void => {
		clearTimeout(popHideRef.current);
		const rect = el.getBoundingClientRect();
		setPop({ name, preview: resolveMention(name), x: rect.left, y: rect.top });
	};
	const hidePop = (): void => {
		clearTimeout(popHideRef.current);
		popHideRef.current = setTimeout(() => setPop(null), 60);
	};

	const spans = parseHighlightSpans(text, resolveMention);
	const parts: ReactNode[] = [];
	let cursor = 0;
	spans.forEach((s, i) => {
		if (s.start < cursor) return; // overlapping match — first span wins
		if (s.start > cursor) parts.push(text.slice(cursor, s.start));
		const isMention = s.kind === "mention";
		const token = text.slice(s.start, s.end);
		const mentionName = isMention ? token.slice(1) : "";
		const cls = HL_CLASS[s.kind];
		parts.push(
			<span
				key={i}
				className={cls}
				{...(isMention
					? {
							onMouseDown: (e: React.MouseEvent) => {
								// Keep the textarea focused (a mousedown elsewhere
								// would blur it out of the user's hands).
								e.preventDefault();
							},
							onClick: () => onMentionClick?.(s.start),
							onMouseEnter: (e: React.MouseEvent<HTMLElement>) => showPop(mentionName, e.currentTarget),
							onMouseLeave: hidePop,
						}
					: {})}
			>
				{/* Inner span: the glass family paints a sheen ::before at
				 * z-index 0 over raw inline text; the `> *` rescue rule lifts
				 * this wrapper above it. Pure stacking — zero metrics. */}
				<span>{token}</span>
			</span>,
		);
		cursor = s.end;
	});
	if (cursor < text.length) parts.push(text.slice(cursor));
	const popNode = pop ? (
		<div className="gui-mention-pop" style={{ left: `${pop.x}px`, top: `${pop.y - 8}px` }} aria-hidden>
			{(() => {
				const p = pop.preview;
				if (!p) return <span className="gui-mention-pop-name">{pop.name}</span>;
				return (
					<>
						{p.kind === "image" && p.dataUrl ? (
							<img className="gui-mention-pop-thumb" src={p.dataUrl} alt="" draggable={false} />
						) : null}
						<span className="gui-mention-pop-name">{p.name}</span>
						{mentionSizeLabel(p.size) && <span className="gui-mention-pop-size">{mentionSizeLabel(p.size)}</span>}
					</>
				);
			})()}
		</div>
	) : null;
	return (
		<>
			<div aria-hidden className={`gui-ta-highlight ${className}`}>
				{parts}
				{text.endsWith("\n") || text.length === 0 ? "\u200b" : null}
			</div>
			{popNode ? createPortal(popNode, document.body) : null}
		</>
	);
}
