/**
 * Streaming block boundaries taken from the lexer, not from scanning the text.
 *
 * The streaming renderer freezes the leading blocks of a reply and re-parses only
 * the tail. Deciding WHERE to freeze by scanning characters means re-deriving
 * markdown's block rules by hand — and getting them subtly wrong at the edges
 * (a display-math opener, a list that continues across a blank line, a reference
 * definition that resolves links in the frozen prefix).
 *
 * This module asks the lexer instead: `md.lexer(rest)` returns tokens whose
 * `raw` tiles the source exactly, so a boundary is "the end of a token that ends
 * on a blank-line break no further append can move". That is the same guarantee
 * the frozen prefix needs — `lex(src) = lex(head) ++ lex(tail)` — and it comes
 * from the parser that will render the result.
 *
 * The four escapes below are the cases where the split cannot be reproduced
 * exactly; each one falls back to rendering the whole text, so a boundary is
 * never guessed:
 *
 * - `\r`: marked normalizes line structure, so token raws stop tiling the source.
 * - a tab: expanded to four spaces first (marked's own normalization), otherwise
 *   raws and source disagree about every following offset.
 * - a link reference definition anywhere: it resolves links in the frozen
 *   prefix, which was lexed without knowing it.
 * - an own-line display-math opener at or after the candidate: a closer appended
 *   later turns everything from there into one block across blank lines.
 */

import type { TokensList } from "@musepi/pi-utils/marked";

/** The rendered leading blocks of a streaming text. */
export interface FrozenPrefix {
	/** Source the frozen blocks cover; always a prefix of the normalized text. */
	readonly source: string;
	/** Their markup, byte-identical to what a full parse would produce. */
	readonly html: string;
}

export const NO_PREFIX: FrozenPrefix = { source: "", html: "" };

/** An own-line display-math opener: a closer appended later swallows the blank
 *  lines after it into one block, so nothing at or past it can freeze. */
const MATH_OPENER_LINE = /^ {0,3}(?:\$\$|\\\[)[ \t]*$/m;

/** A whitespace-only line from a sticky offset, capturing its terminator. */
const WHITESPACE_LINE = /[^\S\n]*(\n|$)/y;

/** A token stream as the fork exposes it: an array that also carries `links`. */
export interface LexedText {
	readonly tokens: readonly { type: string; raw: string }[];
	readonly links: Record<string, unknown>;
}

/**
 * Index of the first token that may not freeze, plus the source offset its
 * predecessor ends at. `count === 0` means nothing is stable yet.
 */
export function stableTokenCount(
	source: string,
	stream: LexedText,
	listMayContinueAt: (source: string, offset: number, listRaw: string) => boolean,
): { count: number; end: number } {
	const opener = MATH_OPENER_LINE.exec(source);
	const mathLimit = opener === null ? source.length : opener.index;
	let pos = 0;
	let count = 0;
	let end = 0;
	for (let i = 0; i < stream.tokens.length; i++) {
		const token = stream.tokens[i]!;
		const tokenEnd = pos + token.raw.length;
		if (tokenEnd > mathLimit) break;
		// The break has to be followed by real block content: at end of text the
		// next line is unknown, and a leading space, newline or whitespace line
		// joins the blank run in front of the cut (so a later append can still
		// change where the block starts).
		if (token.raw.endsWith("\n\n") && tokenEnd < source.length) {
			const next = source.charCodeAt(tokenEnd);
			WHITESPACE_LINE.lastIndex = tokenEnd;
			const previous = i > 0 ? stream.tokens[i - 1] : undefined;
			if (
				next !== 0x20 &&
				next !== 0x0a &&
				WHITESPACE_LINE.exec(source) === null &&
				(previous?.type !== "list" || !listMayContinueAt(source, tokenEnd, previous.raw))
			) {
				count = i + 1;
				end = tokenEnd;
			}
		}
		pos = tokenEnd;
	}
	return { count, end };
}

/** What the renderer needs from the fork: lex, parse a token slice, normalize. */
export interface LexicalRenderer {
	/** Tab expansion + carriage-return policy; null means "cannot split this text". */
	normalize(text: string): string | null;
	lex(source: string): LexedText;
	/** Markup for a slice of tokens, byte-identical to the full parse's slice. */
	parseTokens(stream: LexedText, from: number, to: number): string;
	/** Markup for the whole text, used by every fallback. */
	parseWhole(source: string): string;
	/** Whether a list's item could still be continued by an append at `offset`. */
	listMayContinueAt(source: string, offset: number, listRaw: string): boolean;
}

/**
 * Render a streaming text, reusing `prefix` when `text` extends it.
 *
 * The returned `html` equals `parseWhole(text)`; when the split could not be
 * reproduced exactly the whole text renders instead and the prefix resets, which
 * only costs the next call's incremental win.
 */
export function renderStreamingBlocks(
	text: string,
	prefix: FrozenPrefix,
	renderer: LexicalRenderer,
): { html: string; prefix: FrozenPrefix } {
	const source = renderer.normalize(text);
	if (source === null) return { html: renderer.parseWhole(text), prefix: NO_PREFIX };
	const base = source.length > prefix.source.length && source.startsWith(prefix.source) ? prefix : NO_PREFIX;
	const rest = base.source.length === 0 ? source : source.slice(base.source.length);
	try {
		const stream = renderer.lex(rest);
		// A reference definition resolves links anywhere, including the frozen
		// prefix, which was lexed without it.
		if (Object.keys(stream.links).length > 0) {
			return base === NO_PREFIX
				? { html: renderer.parseTokens(stream, 0, stream.tokens.length), prefix: NO_PREFIX }
				: { html: renderer.parseWhole(text), prefix: NO_PREFIX };
		}
		const { count, end } = stableTokenCount(rest, stream, renderer.listMayContinueAt);
		if (count === 0) {
			return { html: base.html + renderer.parseTokens(stream, 0, stream.tokens.length), prefix: base };
		}
		const frozen: FrozenPrefix = {
			source: source.slice(0, base.source.length + end),
			html: base.html + renderer.parseTokens(stream, 0, count),
		};
		return { html: frozen.html + renderer.parseTokens(stream, count, stream.tokens.length), prefix: frozen };
	} catch {
		return { html: renderer.parseWhole(text), prefix: NO_PREFIX };
	}
}

/** Narrow a fork token list to what this module reads. */
export function lexedText(tokens: TokensList): LexedText {
	return { tokens, links: (tokens as TokensList & { links?: Record<string, unknown> }).links ?? {} };
}
