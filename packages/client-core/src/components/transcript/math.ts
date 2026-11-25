/**
 * LaTeX math for transcript markdown (KaTeX), openchamber-style:
 *
 * - `$...$` inline math — remark-math delimiter rules (opening `$` not
 *   followed by whitespace, closing `$` not preceded by whitespace, no
 *   empty content, no newlines). This keeps currency text (`$50`,
 *   `US$ 680`) and `$$` display math from being consumed as inline math.
 * - `$$...$$` display math — block-level, fired only at line starts.
 * - `\(...\)` inline / `\[...\]` display — backslash delimiters (TUI and
 *   many models emit these too).
 *
 * Math is tokenized at the markdown level (extensions run before the
 * built-in inline/block tokenizers in this marked fork), so the source
 * reaches KaTeX RAW — `&` in `\begin{aligned}` is not HTML-escaped — and
 * code fences/spans are consumed by their own tokenizers first, so math
 * inside code is never rendered.
 */
import katex from "katex";
import "katex/dist/katex.min.css";
import { blockGlyph } from "@musepi/client-markdown";
import { t } from "../../i18n/index.js";
import { escapeHtml } from "./highlight";

const renderKatex = (source: string, displayMode: boolean): string => {
	try {
		return katex.renderToString(source, { displayMode, throwOnError: false, strict: false });
	} catch {
		// Last-resort fallback: never break the message on unparseable math.
		return escapeHtml(source);
	}
};

/**
 * FNV-1a (32-bit) — stable identity for the copy button's transient
 * "copied" label (same scheme as code blocks in Markdown.tsx).
 */
const fnv1a = (s: string): number => {
	let hash = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		hash ^= s.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
};

/**
 * Display math block. The KaTeX output is wrapped so the transcript can
 * offer a copy button — code blocks already copy their source, formulas
 * copy their LaTeX source. The source is read back from the annotation
 * element katex embeds (`<annotation encoding="application/x-tex">`): the
 * browser decodes HTML entities in textContent, so it IS the original
 * source. The button floats on the wrapper, OUTSIDE `.katex-display`'s
 * overflow-x scroll container, so wide formulas scroll under it instead of
 * carrying it away. Same action button as a fence's copy (`tr-code-btn`).
 */
const renderDisplay = (source: string): string => {
	const hash = fnv1a(source).toString(36);
	const label = escapeHtml(t("settings.copy"));
	// Display math is INLINE content: it sits inside the paragraph it stood in,
	// so it cannot be lifted out of the message's HTML the way a table or a
	// fence can — splitting there left the paragraph's own tags straddling the
	// boundary. Its wrapper and copy control therefore stay in the string, and
	// the delegated copy handler feeds their feedback.
	//
	// KNOWN COST, measured: `.katex-display` scrolls sideways, and the whole HTML
	// blob is rewritten on every re-render, so a wide formula snapped back to
	// `scrollLeft: 0` when text was appended below it (17 → 0). It could not be
	// fixed from the host: the box lives inside `dangerouslySetInnerHTML`, so a
	// layout effect's cleanup already sees the NEW node and a capture-phase
	// `scroll` listener has nothing left to read once a stream tick lands.
	// The fix is to make display math a BLOCK token (`$$` on its own line), which
	// takes it out of the paragraph and hands it to a block component — same
	// seam as `table`/`code`/`diagram`. Block-extensions are consulted at every
	// line position (`blockTokens` in the fork), so this needs no mdast.
	return (
		`<span class="tr-math">${renderKatex(source, true)}` +
		`<button type="button" class="tr-code-btn tr-math-copy tr-code-copy" data-math-copy="${hash}" data-copy-hash="${hash}" aria-label="${label}" title="${label}">` +
		blockGlyph("copy") +
		`</button>` +
		`</span>`
	);
};

interface MathToken {
	type: string;
	raw: string;
	text: string;
}

/** `$...$` inline math with remark-math delimiter rules. */
export const inlineMathExtension = {
	name: "inlineMath",
	level: "inline" as const,
	start(src: string): number | undefined {
		// Next unescaped `$` (skip `\$`); `$` is not a built-in special
		// char in this marked fork, so without this the lexer skips it.
		const m = /(^|[^\\])\$/.exec(src);
		return m ? m.index + m[1].length : undefined;
	},
	tokenizer(src: string): MathToken | undefined {
		// katex auto-render rules: opening `$` not followed by whitespace
		// or a digit (currency: "$50", "$50M to $72M"); closing `$` not
		// preceded by whitespace; no empty content; no newlines; no `$$`.
		const match = /^\$(?!\$)(?!\s)(?!\d)([^$\n]+?)(?<!\s)\$(?!\$)/.exec(src);
		if (!match) return undefined;
		return { type: "inlineMath", raw: match[0], text: match[1] ?? "" };
	},
	renderer(token: MathToken): string {
		return renderKatex(token.text, false);
	},
};

/** `$$...$$` display math. Inline level: `$$` is not a BLOCK_RULES
 *  start in this marked fork, so a block tokenizer only fires when the
 *  math sits at the very first line — a `$$` line after prose is absorbed
 *  into the paragraph and never reaches a block extension. As an inline
 *  tokenizer (tried first, before the single-`$` rules) it matches the
 *  whole `$$...$$` span inside paragraph text, raw `&` and all. */
export const displayMathExtension = {
	name: "displayMath",
	level: "inline" as const,
	start(src: string): number | undefined {
		// Next unescaped `$$` (skip `\$\$`).
		const m = /(^|[^\\])\$\$/.exec(src);
		return m ? m.index + m[1].length : undefined;
	},
	tokenizer(src: string): MathToken | undefined {
		const match = /^\$\$\n?([\s\S]*?)\n?\$\$(\n|$)/.exec(src);
		if (!match) return undefined;
		const text = match[1] ?? "";
		if (text.trim() === "") return undefined;
		return { type: "displayMath", raw: match[0], text };
	},
	renderer(token: MathToken): string {
		return renderDisplay(token.text);
	},
};

/**
 * `$$...$$` on its OWN LINES is a block, not paragraph content.
 *
 * This is what lets a display formula be a real block, like a table or a fence:
 * it leaves the paragraph it used to sit in, so the message pipeline can hand it
 * to a component (and keep its scroll position and copy animation across a
 * re-render). The earlier inline tokenizer above stays for the single-line
 * `$$a+b$$` form, whose meaning inside prose must not change.
 *
 * Own-line only on purpose: `^$$` followed by a line break. A `$$` that shares
 * its line with text keeps the inline path.
 */
export const displayMathBlockExtension = {
	name: "displayMathOwnLine",
	// The renderer is looked up by TOKEN type; this extension's name differs.
	tokenType: "displayMathBlock",
	level: "block" as const,
	tokenizer(src: string) {
		const match = /^ {0,3}\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$[ \t]*(?:\n|$)/.exec(src);
		if (!match) return undefined;
		const text = (match[1] ?? "").trim();
		if (text === "") return undefined;
		return { type: "displayMathBlock", raw: match[0], text };
	},
	renderer(token: MathToken) {
		return renderDisplayBlock(token.text);
	},
};

/**
 * A display formula as a block: the pipeline gets a marker and renders the
 * formula through its block component, so the KaTeX subtree is a React node
 * rather than a piece of a rewritten HTML blob.
 */
const renderDisplayBlock = (source: string): string => {
	const hash = fnv1a(source).toString(36);
	rememberDisplayMath(hash, source);
	return `<span data-math-block="${hash}"></span>`;
};

/** KaTeX markup for a display formula (the block turns it into React nodes). */
export function renderDisplayHtml(source: string): string {
	return renderKatex(source, true);
}

/** Display-formula sources by hash (the pipeline's lookup for the block). */
const displayMathBlocks = new Map<string, string>();
const DISPLAY_MATH_LIMIT = 100;

/** A display formula's LaTeX source by hash. */
export function displayMathSource(hash: string): string | undefined {
	return displayMathBlocks.get(hash);
}

function rememberDisplayMath(hash: string, source: string): void {
	displayMathBlocks.set(hash, source);
	while (displayMathBlocks.size > DISPLAY_MATH_LIMIT) {
		const oldest = displayMathBlocks.keys().next().value;
		if (oldest === undefined) break;
		displayMathBlocks.delete(oldest);
	}
}

/** `\(...\)` inline math (backslash delimiters survive escape tokenizing
 *  only because extensions run first). */
export const inlineParenMathExtension = {
	name: "inlineParenMath",
	level: "inline" as const,
	start(src: string): number | undefined {
		const i = src.indexOf("\\(");
		return i < 0 ? undefined : i;
	},
	tokenizer(src: string): MathToken | undefined {
		const match = /^\\\(([\s\S]+?)\\\)/.exec(src);
		if (!match) return undefined;
		return { type: "inlineParenMath", raw: match[0], text: match[1] ?? "" };
	},
	renderer(token: MathToken): string {
		return renderKatex(token.text, false);
	},
};

/** `\[...\]` display math — inline level because block tokenizers only
 *  fire at line starts and `\[` commonly appears mid-paragraph. */
export const blockBracketMathExtension = {
	name: "blockBracketMath",
	level: "inline" as const,
	start(src: string): number | undefined {
		const i = src.indexOf("\\[");
		return i < 0 ? undefined : i;
	},
	tokenizer(src: string): MathToken | undefined {
		const match = /^\\\[([\s\S]+?)\\\]/.exec(src);
		if (!match) return undefined;
		return { type: "blockBracketMath", raw: match[0], text: match[1] ?? "" };
	},
	renderer(token: MathToken): string {
		return renderDisplay(token.text);
	},
};

export const mathExtensions = [
	displayMathBlockExtension,
	displayMathExtension,
	inlineMathExtension,
	inlineParenMathExtension,
	blockBracketMathExtension,
];
