import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/index.js";
import { MENTION_TOKEN_PREFIX, parseMentionTokens } from "./mention-token";

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
 * metric-neutral by construction — colour/fill/rim/sheen only, horizontal
 * padding repaid by an equal negative margin, and the token text wrapped
 * in an inner <span> so the `> *` rescue lifts it above the family's
 * sheen layer. ANY glyph-advance change skews the caret.
 *
 * `@` note (updated 2026-09-26): bare `@path` stays unpainted — nothing in
 * the send path expands it (that flow is print-mode/TUI). The exception is
 * the attachment-mention token `@附件[文件名]`, which DOES have send
 * semantics now (expanded to explicit attachment references on send), so
 * it earns a pill — with pointer-events enabled on that pill only, for
 * the hover preview + caret-jump click.
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
	// Mention tokens: painted from the same parse the send-path expansion
	// uses (one grammar, two consumers). A magic word inside the brackets
	// ("@附件[workflowz]") starts AFTER the mention's `@`, so the greedy
	// first-wins dedupe below hands the region to the mention pill.
	for (const m of parseMentionTokens(text)) {
		spans.push({ start: m.start, end: m.end, kind: "mention" });
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

/** Attachment data behind a mention pill, resolved by the host from its
 *  live chip list. `stale` marks a token whose attachment is gone — the
 *  pill downgrades and the preview says so. */
export interface MentionPreview {
	kind: "image" | "file";
	name: string;
	size?: number;
	/** Image thumbnail (data URL) for the hover card. */
	dataUrl?: string;
	stale?: boolean;
}

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
 *  `resolveMention` + `onMentionClick` are optional — pass them to give
 *  the mention pills their hover preview card and click-to-caret jump. */
export function ComposerHighlight({
	text,
	className,
	resolveMention,
	onMentionClick,
}: {
	text: string;
	className: string;
	resolveMention?(name: string): MentionPreview | null;
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
		setPop({ name, preview: resolveMention ? resolveMention(name) : null, x: rect.left, y: rect.top });
	};
	const hidePop = (): void => {
		clearTimeout(popHideRef.current);
		popHideRef.current = setTimeout(() => setPop(null), 60);
	};

	const spans = parseHighlightSpans(text);
	const parts: ReactNode[] = [];
	let cursor = 0;
	spans.forEach((s, i) => {
		if (s.start < cursor) return; // overlapping match — first span wins
		if (s.start > cursor) parts.push(text.slice(cursor, s.start));
		const isMention = s.kind === "mention";
		const token = text.slice(s.start, s.end);
		const mentionPreview =
			isMention && resolveMention ? resolveMention(token.slice(MENTION_TOKEN_PREFIX.length, -1)) : null;
		const cls = `${HL_CLASS[s.kind]}${mentionPreview?.stale ? " gui-ta-hl-mention--stale" : ""}`;
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
							onMouseEnter: (e: React.MouseEvent<HTMLElement>) =>
								showPop(token.slice(MENTION_TOKEN_PREFIX.length, -1), e.currentTarget),
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
				if (p.stale) {
					return (
						<>
							<span className="gui-mention-pop-name">{pop.name}</span>
							<span className="gui-mention-pop-stale">{t("attachment removed")}</span>
						</>
					);
				}
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
