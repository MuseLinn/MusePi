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
 * carrying it away. It reuses `.tr-code-copy`'s visuals (both classes).
 */
const renderDisplay = (source: string): string => {
	const body = renderKatex(source, true);
	const hash = fnv1a(source).toString(36);
	return (
		`<span class="tr-math">${body}` +
		`<button type="button" class="tr-math-copy tr-code-copy" data-math-copy="${hash}">${t("copy")}</button>` +
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
	displayMathExtension,
	inlineMathExtension,
	inlineParenMathExtension,
	blockBracketMathExtension,
];
