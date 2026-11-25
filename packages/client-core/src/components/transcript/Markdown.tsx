import { Marked, type Renderer, type Tokens } from "@musepi/pi-utils/marked";
import {
	Check as CheckGlyphData,
	Copy as CopyGlyphData,
	ListOrdered as LinesGlyphData,
	AlignJustify as NoLinesGlyphData,
	StretchHorizontal as NoWrapGlyphData,
	WrapText as WrapGlyphData,
} from "lucide";
import type { IconInput } from "morphicons";
import { defineMorphIcon } from "morphicons/element";

/** The `<morph-icon>` custom element surface this module drives. */
interface MorphIconElement extends HTMLElement {
	set(icon: IconInput): void;
	morphTo(icon: IconInput, spring?: string): void;
}

import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type TranslationKey, t } from "../../i18n/index.js";

const ADVISORY_SEV_KEY: Record<string, TranslationKey> = {
	blocker: "general.advisoryBlocker",
	concern: "general.advisoryConcern",
	nit: "general.advisoryNit",
};

import {
	advanceTail,
	EMPTY_TAIL,
	type MarkdownBlockLabels,
	type MarkdownTableCellPayload,
	type MarkdownTablePayload,
	markdownBlockDef,
	setBlockGlyph,
	type TailState,
} from "@musepi/client-markdown";
import { useDeepScrollShadow } from "@musepi/client-ui-primitives/client";
import { electronBridge } from "../../lib/electron-bridge";
import {
	applyAnswers,
	autoRepairFailedBlocks,
	handleAnswerClick,
	handleAnswerInput,
	setAnswerMarks,
} from "../../ui-blocks/answers.js";
import { isUiBlockLanguage, renderUiBlockFence, splitOpenUiFence } from "../../ui-blocks/render.js";
import { flyFrame, motionDisabled } from "../image-morph";
import { escapeHtml, highlightToCodeHtml } from "./highlight";
import { useCodeHighlight } from "./highlight-context";
import { isLocalImageSrc, localImagePath } from "./local-image.js";
import { isLocalFilePath } from "./markdown-shared";
import { displayMathSource, mathExtensions, renderDisplayHtml } from "./math";
import {
	diagramBlockSource,
	emitDiagramBlock,
	mermaidFallbackHtml,
	mermaidMode,
	renderDiagramAscii,
	renderDiagramSync,
	renderMermaidAsyncHtml,
} from "./mermaid";

import "../../ui-blocks/ui-blocks.css";
import { useStreamingReveal } from "./use-streaming-reveal";

export { isLocalImageSrc } from "./local-image.js";

/** Human-readable label for a fenced code block header. */
function codeLangLabel(lang: string): string {
	const key = lang.trim().toLowerCase();
	const known: Record<string, string> = {
		ts: "TypeScript",
		tsx: "TSX",
		js: "JavaScript",
		jsx: "JSX",
		py: "Python",
		rb: "Ruby",
		rs: "Rust",
		go: "Go",
		sh: "Shell",
		bash: "Shell",
		zsh: "Shell",
		json: "JSON",
		yml: "YAML",
		yaml: "YAML",
		md: "Markdown",
		sql: "SQL",
		css: "CSS",
		html: "HTML",
		xml: "XML",
		java: "Java",
		kt: "Kotlin",
		swift: "Swift",
		c: "C",
		cpp: "C++",
		cs: "C#",
		php: "PHP",
		toml: "TOML",
		ini: "INI",
		dockerfile: "Dockerfile",
	};
	if (key === "") return t("settings.plainText");
	return known[key] ?? key;
}

function unescapeHtml(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch (_) {}
		}
		return "";
	};

	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = entity.toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.startsWith("#x")) {
					return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				}
				if (lower.startsWith("#")) {
					return parseCodePoint(Number(lower.slice(1)));
				}
				return match;
			}
		}
	});
}
function safeHref(href: string): string | null {
	const trimmed = href.trim();
	if (/^(?:https?:|mailto:)/i.test(trimmed)) return trimmed;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // unknown scheme (javascript:, data:, …)
	return trimmed; // relative / fragment
}

/**
 * How the ui fences in the next parse read. marked's renderer is shared by
 * every message, so the flags travel beside the synchronous parse rather than
 * through the renderer API; {@link parseMarkdown} restores them even when
 * parsing throws. `settled` asks whether diagnostics may appear; `repair` says
 * whether this surface is the assistant's answer at all.
 */
let uiFenceSettled = true;
let uiFenceRepair = true;

const md = new Marked({
	gfm: true,
	extensions: mathExtensions,
	renderer: {
		// A table is handed to its React block instead of being serialized: the
		// block owns `<table>`/`<tr>`/`<td>`, so a stream tick cannot tear a
		// finished table down (and reset its scroll position). Cells keep only
		// their inline markup — that is the one `innerHTML` inside a cell.
		table(this: Renderer, token) {
			// `text` is what CSV and the clipboard carry, so it holds the cell's
			// content without its inline markup (`**x**` copies as `x`); `html` is
			// what the cell renders. The plain form is derived without a DOM: this
			// runs during parse, which also happens on the server and in tests.
			const cell = (value: Tokens.TableCell): MarkdownTableCellPayload => {
				const html = this.parser.parseInline(value.tokens).trim();
				return { text: plainTextOf(html), html };
			};
			const payload = {
				align: token.align,
				header: token.header.map(cell),
				rows: token.rows.map(row => row.map(cell)),
			};
			const hash = fnv1a(JSON.stringify(payload)).toString(36);
			rememberTableBlock(hash, payload);
			return `<div data-table-block="${hash}"></div>`;
		},
		// Raw HTML tokens (block + inline both arrive here) are escaped, never emitted.
		// `<advisory>` blocks (the advisor tool's note format) become styled
		// aside cards instead: severity drives the accent, the advisor name
		// labels the card, and the guidance note ("weigh, don't blindly obey")
		// shows as a muted caption.
		html({ text }) {
			if (/^\s*<advisory\b/i.test(text)) {
				const out: string[] = [];
				for (const m of text.matchAll(/<advisory\b([^>]*)>([\s\S]*?)<\/advisory>/gi)) {
					const attrs = m[1] ?? "";
					const severity = /severity="([^"]+)"/i.exec(attrs)?.[1] ?? "nit";
					const advisor = /advisor="([^"]+)"/i.exec(attrs)?.[1] ?? "";
					const note = escapeHtml(unescapeHtml((m[2] ?? "").trim()));
					const sev = (/^(blocker|concern|nit)$/.test(severity) ? severity : "nit") as
						| "blocker"
						| "concern"
						| "nit";
					out.push(
						`<aside class="tr-advisory tr-advisory--${sev}">` +
							`<div class="tr-advisory-head">` +
							`<span class="tr-advisory-tag">${t("general.advisor")}</span>` +
							(advisor ? `<span class="tr-advisory-name">${escapeHtml(advisor)}</span>` : "") +
							`<span class="tr-advisory-sev">${t(ADVISORY_SEV_KEY[sev] ?? sev)}</span>` +
							`</div>` +
							`<div class="tr-advisory-note">${note}</div>` +
							`</aside>`,
					);
				}
				if (out.length > 0) return out.join("\n");
			}
			const cleaned = text.replace(/<\/?(?:advisory|span|text)\b(?:\s[^>]*)?\s*\/?>/gi, "");
			if (cleaned === "") return "";
			return escapeHtml(unescapeHtml(cleaned));
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const url = href ?? "";
			// Local file paths (`[x](/abs/path.ts)`, `./rel`, `~/`, `file://`)
			// become clickable spans that open in the system default app via
			// the desktop bridge; guests render them as inert text.
			if (isLocalFilePath(url)) {
				const path = url.startsWith("file://") ? url.slice("file://".length) : url;
				return `<span class="tr-path" data-open-path="${escapeHtml(path)}">${inner}</span>`;
			}
			const safe = safeHref(url);
			if (safe === null) return inner;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(safe)}"${titleAttr} target="_blank" rel="noopener">${inner}</a>`;
		},
		// Fenced code blocks: wrap each line in a .tr-code-line span so the
		// appearance setting can number lines via CSS counters (numbers off by
		// default — spans are inline and render exactly like plain text). The
		// data-hl-hash lets the async highlighter (desktop only) swap the
		// plain body for tree-sitter spans; guests leave it plain. Mermaid
		// fences short-circuit to the diagram renderer (svg/ascii per the
		// chat setting) and never reach the highlighter.
		code({ text, lang, escaped }) {
			const l = (lang ?? "").trim().toLowerCase();
			if (l === "mermaid" || l === "mmd") {
				return emitDiagramBlock(text, mermaidMode());
			}
			// Declarative UI block: data and structure the reply should show
			// rather than describe. Rendered from JSON Lines so a fence still
			// streaming draws its finished lines.
			if (isUiBlockLanguage(l)) {
				return renderUiBlockFence(text, { settled: uiFenceSettled, repair: uiFenceRepair });
			}
			// The fence is handed to its React block: the block owns the header and
			// `<pre><code>`, so a stream tick cannot rebuild a finished block (and
			// re-run its highlight). The raw source travels by hash, like the table.
			const hash = fnv1a(text).toString(36);
			cacheSet(highlightSource, hash, { code: text, lang: lang || undefined });
			rememberCodeBlock(hash, { code: text, lang: l, label: codeLangLabel(l) });
			return `<div data-code-block="${hash}"></div>`;
		},
	},
	breaks: true,
});

/**
 * FNV-1a (32-bit) — cheap stable identity for code-block text. Serves as the
 * cache key for async highlights: streaming re-renders of the same block
 * (identical text) hit the cache instead of re-invoking the bridge.
 */
function fnv1a(s: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		hash ^= s.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Parsed table payloads, keyed by content hash.
 *
 * The renderer hands a table to its React block through a placeholder div
 * (`data-table-block`), and this map is how the block gets its cells back: the
 * renderer's output is one HTML string, so the only thing that can travel with
 * it is a hash. Entries are bounded — a long streaming reply would otherwise
 * keep every intermediate version of a table alive.
 */
const tableBlocks = new Map<string, MarkdownTablePayload>();
const TABLE_BLOCKS_LIMIT = 200;

const NL = String.fromCharCode(10);

/** Text content of inline HTML, without a DOM: tags are dropped, entities
 *  decoded, and `<br>` keeps a line break. This is the clipboard/CSV form of a
 *  table cell, so it must not carry the markup the cell renders. */
export function plainTextOf(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, NL)
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.trim();
}

/** Parsed code-fence payloads by content hash (the pipeline's lookup for a block). */
const codeBlocks = new Map<string, { code: string; lang: string; label: string }>();
const CODE_BLOCKS_LIMIT = TABLE_BLOCKS_LIMIT;

/** A code fence's source by content hash (the pipeline's lookup for a block). */
export function markdownCodeBlock(hash: string): { code: string; lang: string; label: string } | undefined {
	return codeBlocks.get(hash);
}

function rememberCodeBlock(hash: string, payload: { code: string; lang: string; label: string }): void {
	codeBlocks.set(hash, payload);
	if (codeBlocks.size <= CODE_BLOCKS_LIMIT) return;
	const overflow = codeBlocks.size - CODE_BLOCKS_LIMIT;
	const iterator = codeBlocks.keys();
	for (let i = 0; i < overflow; i++) {
		const key = iterator.next().value;
		if (key !== undefined) codeBlocks.delete(key);
	}
}

/** A parsed table payload by content hash (the pipeline's lookup for a block). */
function rememberTableBlock(hash: string, payload: MarkdownTablePayload): void {
	tableBlocks.set(hash, payload);
	if (tableBlocks.size <= TABLE_BLOCKS_LIMIT) return;
	const overflow = tableBlocks.size - TABLE_BLOCKS_LIMIT;
	const iterator = tableBlocks.keys();
	for (let i = 0; i < overflow; i++) {
		const key = iterator.next().value;
		if (key !== undefined) tableBlocks.delete(key);
	}
}

/**
 * True when `s` has no open code fence (``` / ~~~) or block math ($$)
 * at its end. Block tokenization is local across a balanced "\n\n"
 * boundary, which is what makes the streaming fast path safe. A trailing
 * unmatched fence (rare in streamed output) degrades the whole buffer to
 * the full parse instead of producing a split render.
 */
function fencesBalanced(s: string): boolean {
	let code = 0;
	let math = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "`" && s[i + 1] === "`" && s[i + 2] === "`") {
			code = code === 0 ? 1 : 0;
			i += 2;
		} else if (c === "~" && s[i + 1] === "~" && s[i + 2] === "~") {
			code = code === 0 ? 1 : 0;
			i += 2;
		} else if (c === "$" && s[i + 1] === "$") {
			math = math === 0 ? 1 : 0;
			i += 1;
		}
	}
	return code === 0 && math === 0;
}

/**
 * Bridge between the rendered HTML and the block registry.
 *
 * The renderer only leaves a hash behind (its output is one string); the parsed
 * cells live in `tableBlocks`. Reading the payload here, at render time, is why
 * the lookup is not in the block: a block receives props, and the map is the
 * pipeline's, not the component's.
 */
function TableFragment({
	hash,
	labels,
	quoteText,
}: {
	hash: string;
	labels: MarkdownBlockLabels;
	quoteText(text: string): void;
}): ReactNode {
	const payload = tableBlocks.get(hash);
	const def = markdownBlockDef("table");
	const Block = def?.Component;
	if (!payload || !Block) return null;
	// The flight and the motion check come from the host: the one-take tokens
	// are the app's, and a block package must not own them.
	return (
		<Block
			source=""
			table={payload}
			hash={hash}
			html={null}
			streaming={false}
			labels={labels}
			quoteText={quoteText}
			fly={flyFrame}
			motionDisabled={motionDisabled}
		/>
	);
}

/** A display formula's block: the marker travels in the string, the formula is
 *  re-rendered by its component (KaTeX markup → React nodes), so its scroll box
 *  and copy control are React's and survive a re-render. */
function MathFragment({ hash, labels }: { hash: string; labels: MarkdownBlockLabels }): ReactNode {
	const latex = displayMathSource(hash);
	const Block = markdownBlockDef("math")?.Component;
	if (latex === undefined || !Block) return null;
	return (
		<Block
			source={latex}
			html={null}
			hash={hash}
			streaming={false}
			labels={labels}
			rendered={renderDisplayHtml(latex)}
			latex={latex}
		/>
	);
}

/** A diagram's block: the stored source plus the renderers it needs. The
 *  block awaits the async render itself, so no observer watches the DOM for
 *  placeholders any more. */
function DiagramFragment({ hash, labels }: { hash: string; labels: MarkdownBlockLabels }): ReactNode {
	const stored = diagramBlockSource(hash);
	const Block = markdownBlockDef("diagram")?.Component;
	if (!stored || !Block) return null;
	const ascii = stored.mode === "ascii" ? renderDiagramAscii(stored.source) : null;
	const sync = stored.mode === "ascii" ? { svg: null, usable: false } : renderDiagramSync(stored.source);
	return (
		<Block
			source={stored.source}
			html={null}
			hash={hash}
			streaming={false}
			labels={labels}
			diagram={stored.source}
			svg={ascii ?? sync.svg}
			usable={ascii !== null || sync.usable}
			renderAsync={renderMermaidAsyncHtml}
			fallback={mermaidFallbackHtml}
		/>
	);
}

/** A code fence's block: its source comes from the pipeline's store, its
 *  highlight from the host (the desktop renderer owns tree-sitter). */
function CodeFragment({
	hash,
	labels,
	highlighted,
}: {
	hash: string;
	labels: MarkdownBlockLabels;
	highlighted: string | null;
}): ReactNode {
	const payload = markdownCodeBlock(hash);
	const Block = markdownBlockDef("code")?.Component;
	if (!payload || !Block) return null;
	return (
		<Block
			source={payload.code}
			html={null}
			hash={hash}
			streaming={false}
			labels={labels}
			code={payload.code}
			lang={payload.lang}
			label={payload.label}
			highlighted={highlighted}
		/>
	);
}

/** One run of the rendered HTML, or one table handed to its block component. */
export type MessageFragment =
	| { kind: "html"; html: string }
	| { kind: "table"; hash: string }
	| { kind: "code"; hash: string }
	| { kind: "diagram"; hash: string }
	| { kind: "math"; hash: string };

/**
 * Split the rendered HTML at the block placeholders the renderer emits.
 *
 * Everything else stays one `innerHTML` blob; a table and a code fence become
 * React blocks of their own, which is what keeps their `<table>` / `<pre>`
 * alive across a stream tick (an element rebuilt from `innerHTML` loses its
 * scroll position — measured, not assumed).
 */
export function splitTableFragments(html: string): MessageFragment[] {
	const fragments: MessageFragment[] = [];
	// A math marker is a bare, empty span: the formula's markup is rendered by
	// its block, never carried through the string.
	const pattern = /<div data-(table|code|diagram)-block="([^"]+)"><\/div>|<span data-math-block="([^"]+)"><\/span>/g;
	let cursor = 0;
	let match: RegExpExecArray | null = pattern.exec(html);
	while (match !== null) {
		if (match.index > cursor) fragments.push({ kind: "html", html: html.slice(cursor, match.index) });
		if (match[3] !== undefined) {
			fragments.push({ kind: "math", hash: match[3] });
		} else {
			const hash = match[2] ?? "";
			const kind = match[1] === "code" ? "code" : match[1] === "diagram" ? "diagram" : "table";
			fragments.push({ kind, hash } as MessageFragment);
		}
		cursor = match.index + match[0].length;
		match = pattern.exec(html);
	}
	if (cursor < html.length) fragments.push({ kind: "html", html: html.slice(cursor) });
	return fragments;
}

/**
 * Incremental streaming-markdown cache: `blocks` are frozen boundary-bounded
 * chunks; a later append reuses everything before the cut verbatim.
 *
 * STRONG boundaries are blank lines ("\n\n") — block structure is stable, so
 * a strong block's html is reusable on settle. WEAK boundaries are a single
 * "\n" whose inline markers are all closed (see {@link streamingBoundaryAt}):
 * they let markdown take shape on prose with no blank lines (the common
 * Chinese-model case) instead of staying raw text the whole stream, but a
 * soft-wrapped paragraph renders as two `<p>`s while streaming — settle
 * re-parses past the last STRONG boundary so the final layout matches a
 * reload, never permanently split.
 */
export interface StreamingRenderState {
	text: string;
	blocks: Array<{ start: number; end: number; html: string; weak?: boolean }>;
	/** Code-unit offset where the plain-text tail begins in `text`. */
	tailStart: number;
	/** Whether ui fences were parsed as belonging to a settled reply. A cached
	 *  quiet fence cannot be reused once the reply settles, because its HTML
	 *  has no diagnostics yet. */
	uiSettled: boolean;
	/** Whether that surface publishes diagnostics at all (see `Markdown`'s
	 *  `repair`); a cached reply body must not be reused on a silent surface. */
	uiRepair: boolean;
}

/** Are emphasis, links, inline code and autolinks closed before `s` ends?
 *  When yes, a single "\n" in `s` is a safe streaming cut: parse(prefix) +
 *  parse(rest) matches parse(whole) except for soft-wrapped paragraphs (which
 *  settle merges back). Conservative by design — a stray marker just keeps
 *  the region in the plain-text tail one more line.
 *
 *  Emphasis uses a run stack: consecutive `*`/`_` are one marker, and a
 *  same-length run closes the open one. CommonMark's real pairing rules are
 *  context-sensitive (`**a*b**` is valid), so the stack is an approximation
 *  that errs toward "unbalanced" — which only delays a weak cut, never
 *  mis-parses. Backtick runs count as code spans because those CAN span a
 *  newline; an open one must block the cut. */
export function inlineMarkersBalanced(s: string): boolean {
	let ticks = 0;
	let run = 0;
	const runStack: number[] = [];
	let brackets = 0;
	let parens = 0;
	let angle = 0;
	const closeRun = (): void => {
		if (run === 0) return;
		const top = runStack[runStack.length - 1];
		if (top === run) runStack.pop();
		else runStack.push(run);
		run = 0;
	};
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "\\") {
			i++; // escaped char carries no marker
			continue;
		}
		switch (c) {
			case "`":
				ticks++;
				continue;
			case "*":
			case "_":
				run++;
				continue;
			case "[":
				brackets++;
				continue;
			case "]":
				brackets--;
				continue;
			case "(":
				parens++;
				continue;
			case ")":
				parens--;
				continue;
			case "<":
				angle++;
				continue;
			case ">":
				angle--;
				continue;
			default:
				closeRun();
		}
	}
	closeRun();
	return ticks % 2 === 0 && runStack.length === 0 && brackets === 0 && parens === 0 && angle === 0;
}

/** A streaming cut at the "\n" ending at index `i`. A blank line is a strong
 *  (block) boundary; a lone "\n" is a weak one, allowed only when fences are
 *  balanced and inline markers are closed so the split cannot break emphasis,
 *  a link, or an open code span. Returns the end offset of the block (the cut
 *  itself is included) or null when the position is not a cut. */
function streamingBoundaryAt(text: string, i: number): { end: number; weak: boolean } | null {
	if (text[i] !== "\n") return null;
	if (text[i + 1] === "\n") {
		if (!fencesBalanced(text.slice(0, i + 2))) return null;
		return { end: i + 2, weak: false };
	}
	const prefix = text.slice(0, i + 1);
	if (!fencesBalanced(prefix)) return null;
	if (!inlineMarkersBalanced(prefix)) return null;
	return { end: i + 1, weak: true };
}

/** Parse one markdown region with the ui-fence state that belongs to this
 *  reply. Fences read the flags synchronously while the parse runs, which is
 *  how a settled reply exposes diagnostics, a growing one stays quiet, and a
 *  non-reply surface stays silent throughout. */
function parseMarkdown(text: string, settled: boolean, repair: boolean): string {
	uiFenceSettled = settled;
	uiFenceRepair = repair;
	try {
		return md.parse(text, { async: false });
	} finally {
		uiFenceSettled = true;
		uiFenceRepair = true;
	}
}

/**
 * Streaming markdown renderer. The settled render (`streaming: false`)
 * parses the complete text once — the stable final layout (what a reload
 * shows). While streaming, every COMPLETE block renders as markdown: the
 * head grows as boundaries appear (blank lines strongly, closed inline
 * lines weakly), so the message takes shape as it arrives. The region after
 * the last boundary is returned as RAW TEXT (`tail`) — only a plain region
 * can host the per-character span effects, which is also why an unclosed
 * fence stays literal until it closes.
 *
 * `uiSettled` says whether the reply has stopped generating. It is separate
 * from `streaming`, which only describes how much of this block has taken
 * markdown shape: a block can idle-settle between tokens while the turn is
 * still running, and its ui fences must stay quiet until the turn ends.
 */
export function renderStreamingMarkdown(
	text: string,
	streaming: boolean,
	prev: StreamingRenderState | null,
	options: { uiSettled?: boolean; uiRepair?: boolean } = {},
): { html: string; tail: string | null; state: StreamingRenderState | null } {
	const uiSettled = options.uiSettled ?? true;
	const uiRepair = options.uiRepair ?? true;
	if (!streaming) {
		// Settle: the STRONG head blocks before the first weak one are complete
		// markdown — reuse them verbatim and re-parse only the rest. WEAK cuts
		// (single newlines) are streaming-only: a soft-wrapped paragraph splits
		// into two <p>s across them, and that split poisons the parse context
		// of every later block too, so settle re-parses from the FIRST weak
		// block onward. The final layout then matches a fresh full parse (what
		// a reload shows); the cost is one parse of the weak region, paid once
		// at settle.
		if (
			prev &&
			prev.uiSettled === uiSettled &&
			prev.uiRepair === uiRepair &&
			prev.blocks.length > 0 &&
			text.startsWith(prev.text)
		) {
			const firstWeak = prev.blocks.findIndex(b => b.weak);
			const keep = firstWeak === -1 ? prev.blocks.length : firstWeak;
			const head = prev.blocks
				.slice(0, keep)
				.map(b => b.html)
				.join("");
			const tailText = text.slice(keep > 0 ? prev.blocks[keep - 1].end : 0);
			const tailHtml = parseMarkdown(tailText, uiSettled, uiRepair);
			return { html: head + tailHtml, tail: null, state: null };
		}
		return { html: parseMarkdown(text, uiSettled, uiRepair), tail: null, state: null };
	}
	try {
		if (
			prev &&
			prev.uiSettled === uiSettled &&
			prev.uiRepair === uiRepair &&
			text.length > prev.text.length &&
			text.startsWith(prev.text)
		) {
			// Append-only growth: the frozen head ADVANCES by promoting every
			// region that has just reached a boundary — a cut that did not
			// exist on the previous frame. Promoting it now is what lets
			// markdown take shape while the message streams (paragraphs,
			// lists, prose lines, and a code fence from the moment it closes)
			// instead of waiting for settle.
			//
			// The region AFTER the last boundary stays RAW TEXT: that is what
			// keeps the per-character span effects working (a stable plain
			// node the DOM pass can append spans to), and why an OPEN fence is
			// still shown literally. `blocks` is mutated in place — the caller
			// replaces its cached state with the object returned here, so the
			// previous entry is discarded. The tail DOM pass clears and
			// re-appends when the cut moves past its own prefix, so promoted
			// text is not re-animated.
			const blocks = prev.blocks;
			let tailStart = prev.tailStart ?? 0;
			for (let i = tailStart; i < text.length; i++) {
				const b = streamingBoundaryAt(text, i);
				if (b === null) continue;
				blocks.push({
					start: tailStart,
					end: b.end,
					weak: b.weak,
					html: parseMarkdown(text.slice(tailStart, b.end), uiSettled, uiRepair),
				});
				tailStart = b.end;
				if (!b.weak) i += 1; // skip the second \n of a blank-line cut
			}
			return {
				html: blocks.map(b => b.html).join(""),
				tail: text.slice(tailStart),
				state: { text, blocks, tailStart, uiSettled, uiRepair },
			};
		}
		// First streaming frame / non-append growth: parse once, split into
		// frozen boundary-bounded blocks so later appends can reuse everything
		// before the cut. Everything after the final boundary is an unfinished
		// tail — returned raw, same as the incremental path, so an open fence
		// never snaps into a code block on the very first frame.
		const blocks: Array<{ start: number; end: number; html: string; weak?: boolean }> = [];
		let from = 0;
		for (let i = 0; i < text.length; i++) {
			const b = streamingBoundaryAt(text, i);
			if (b === null) continue;
			blocks.push({
				start: from,
				end: b.end,
				weak: b.weak,
				html: parseMarkdown(text.slice(from, b.end), uiSettled, uiRepair),
			});
			from = b.end;
			if (!b.weak) i += 1;
		}
		return {
			html: blocks.map(b => b.html).join(""),
			tail: text.slice(from),
			state: { text, blocks, tailStart: from, uiSettled, uiRepair },
		};
	} catch {
		return { html: "", tail: text, state: null };
	}
}

const highlightSource = new Map<string, { code: string; lang?: string }>();
const highlightHtml = new Map<string, string>();

// Local-image bridge: markdown `![](/abs/path)` images are
// read through Electron IPC into data URLs so desktop sessions can display
// real files. Browser guests have no bridge and keep the raw src (which
// simply fails to load there). Bounded cache mirrors the highlight one.
const localImageCache = new Map<string, string>();
const LOCAL_IMAGE_CACHE_MAX = 100;

interface LocalImageBridge {
	readFileDataUrl?(filePath: string): Promise<{ dataUrl?: string; error?: string }>;
}

const localImageBridge = (): LocalImageBridge | null => electronBridge();

/**
 * Swap filesystem image srcs for data URLs via the desktop bridge.
 * Re-runs per text change; the bounded cache keeps repeated renders
 * instant and stale elements (replaced by re-render) are skipped.
 * `base` resolves relative paths (markdown in a workspace preview) against
 * the session cwd; absolute/tilde/file paths pass through untouched.
 */
export function resolveLocalImages(
	root: { querySelectorAll<T extends Element>(selectors: string): Iterable<T> },
	bridge: LocalImageBridge,
	cache: Map<string, string>,
	base?: string,
): void {
	if (!bridge.readFileDataUrl) return;
	for (const img of root.querySelectorAll<HTMLImageElement>("img[src]")) {
		const src = img.getAttribute("src") ?? "";
		if (!isLocalImageSrc(src)) continue;
		let key = localImagePath(src);
		if (!key.startsWith("/") && !key.startsWith("~") && !/^\.{1,2}\//.test(key) && base) {
			key = `${base.replace(/\/$/, "")}/${key}`;
		}
		const cached = cache.get(key);
		if (cached !== undefined) {
			img.src = cached;
			continue;
		}
		void Promise.resolve(bridge.readFileDataUrl(key)).then(res => {
			if (!res?.dataUrl) return;
			cacheSet(cache, key, res.dataUrl);
			// Re-renders replace imgs; skip stale elements.
			if (img.isConnected && img.getAttribute("src") === src) img.src = res.dataUrl;
		});
	}
}

// Bounded caches: long sessions accumulate a unique code block per text
// change, and the maps previously grew for the whole app lifetime. FIFO
// eviction (Map preserves insertion order) keeps the working set recent —
// the oldest blocks are exactly the ones that never re-render.
const HIGHLIGHT_CACHE_MAX = 300;

/** Long-message render budget (chars): past this, Markdown renders only
 *  the head until the user expands — prevents a 50k-char thinking dump or
 *  output from paying the full parse/highlight cost on every scroll/remount. */
const LONG_TEXT_CHARS = 12000;

function cacheSet(map: Map<string, unknown>, key: string, value: unknown): void {
	map.set(key, value);
	if (map.size > HIGHLIGHT_CACHE_MAX) {
		const oldest = map.keys().next().value as string | undefined;
		if (oldest !== undefined) map.delete(oldest);
	}
}

function applyHighlight(el: HTMLElement, html: string): void {
	el.innerHTML = html;
	el.classList.add("tr-code-hl");
	delete el.dataset.hlHash;
}

export const Markdown = memo(function Markdown({
	text: fullText,
	basePath,
	streaming = false,
	pending = false,
	working = false,
	repair = "off",
	smoothStreaming,
}: {
	text: string;
	basePath?: string;
	/** Live-streaming text — renders a kimi-style blinking caret at the end. */
	streaming?: boolean;
	/** The reply can still grow (the turn is running). This is broader than
	 *  `streaming`, which only follows markdown's idle cadence: ui-block
	 *  diagnostics wait for this to clear. */
	pending?: boolean;
	/** The agent is still working on this turn. Only the automatic repair
	 *  waits for it: a settled reply inside a running turn must not interrupt
	 *  the agent, but its diagnostics are already final. */
	working?: boolean;
	/** Which surface this text belongs to. Only the assistant's reply
	 *  (`"reply"`) publishes ui-block diagnostics and offers a repair; thinking
	 *  drafts, tool output, user text and document previews (`"off"`, the
	 *  default) draw what parses and stay silent. */
	repair?: "reply" | "off";
	/** display.smoothStreaming parity (TUI): false disables the reveal.
	 *  Omitted → falls back to the `gui-chat-no-smooth` html class (the
	 *  desktop chat pref), so guests and the web shell keep their behavior. */
	smoothStreaming?: boolean;
}): ReactNode {
	const highlight = useCodeHighlight();
	// Long-message budget (craft-agents large-response parity): render only
	// the first LONG_TEXT_CHARS of an oversized message — the full markdown
	// parse + highlight of a 50k-char thinking dump is what janks the chat.
	// "展开完整消息" swaps to the full text; the cap only kicks in past
	// the threshold so normal messages render exactly as before.
	const [longExpanded, setLongExpanded] = useState(false);
	const truncated = !longExpanded && fullText.length > LONG_TEXT_CHARS;
	// Budget input feeds BOTH the reveal and every downstream consumer
	// (render/highlight/images/tail), so the truncated view is internally
	// consistent; expanding re-renders from the full text.
	const revealInput = truncated ? fullText.slice(0, LONG_TEXT_CHARS) : fullText;
	const rootRef = useRef<HTMLDivElement | null>(null);
	// 横向边缘羽化:表格 / 代码块 / KaTeX / mermaid / 用量行都是
	// dangerouslySetInnerHTML 出来的 raw HTML,React 拿不到内部 ref——
	// 深扫描挂在 root 上,流式重建时 MutationObserver 增量补挂。
	// 左右羽化只在真实横向溢出时出现(data-left/right-scroll)。
	useDeepScrollShadow(
		rootRef,
		".tr-table-scroll, .tr-md pre, .katex-display, .tr-mermaid, .tr-mermaid-ascii, .tr-usage",
	);
	const [copiedHash, setCopiedHash] = useState<string | null>(null);
	// 表格加宽: widened tables by content hash, persisted so a remount (session
	// switch, transcript virtualization) keeps the user's choice. Held in a ref
	// (not state) because toggling must not re-render: a re-render rewrites the
	// markdown innerHTML, which would drop code highlighting and scroll position
	// for the whole message. The observer effect below re-applies the set
	// whenever that html is rebuilt anyway (stream tick, copy-label swap, settle).
	// 平滑流式渲染: character-level reveal (逐字输出). The setting writes
	// `gui-chat-no-smooth` on <html> when off; guest pages carry no class,
	// so they default to smooth on. `text` below is the reveal prefix — all
	// downstream code (streaming fast path, highlight, images) sees the
	// displayed text, so reveal and rendering stay consistent.
	const smooth =
		smoothStreaming !== false &&
		(typeof document === "undefined" || !document.documentElement.classList.contains("gui-chat-no-smooth"));
	const text = useStreamingReveal(revealInput, streaming, smooth);
	// 逐字动效 (settings → 聊天 → 逐字动效): typewriter (default, fade-in
	// tail + caret) / burst (rainbow-burst entrance) / shimmer (shine
	// sweep) / glitch (garble) / flip (per-grapheme 3D flip) / ink
	// (per-grapheme ink bleed) — tail-window effects live in
	// TAIL_RENDERERS; shimmer is pure CSS hosted on the stable .tr-md
	// root. Read from localStorage at render; only the block that is
	// streaming right now applies the effect (see the root className
	// below), finished blocks always render plain text.
	const effect =
		typeof document === "undefined"
			? "typewriter"
			: (() => {
					try {
						const v = localStorage.getItem("musepi-gui-chat-effect");
						return v === "burst" || v === "shimmer" || v === "glitch" || v === "flip" || v === "ink"
							? v
							: "typewriter";
					} catch {
						return "typewriter";
					}
				})();
	// mermaidMode is read at render so the setting change re-parses
	// (fences render svg vs ascii) even when the text is unchanged.
	const mode = mermaidMode();
	// Streaming fast path (TUI parity): marked has no resumable lexer, but
	// block tokenization is local across a "\n\n" boundary with balanced
	// fences — parse(prefix) ++ parse(tail) === parse(prefix+tail). On
	// append-only growth we re-parse only the grown tail instead of the
	// whole buffer, turning the O(N^2) reveal cost of a long streaming
	// message into O(N) (measured: 14KB message re-parsed per frame at
	// 11.5ms/frame → sub-ms with this cache). The streaming TAIL itself is
	// never markdown-parsed — see renderStreamingMarkdown.
	const streamRef = useRef<StreamingRenderState | null>(null);
	const render = useMemo(() => {
		// A reply that has opened a `ui` fence but not closed it yet still shows
		// its block: the parser takes any prefix, so the partial tree draws and
		// keeps growing. The fence never reaches the markdown parser, which would
		// otherwise hold it as an unfinished code block. The split stays in place
		// after settle too: an unclosed fence then means the output was cut off,
		// and it must say so instead of reading as prose.
		const open = splitOpenUiFence(text);
		// Diagnostics belong to a reply that has stopped generating. `streaming`
		// only follows this block's markdown cadence, so a 700ms token gap must
		// not turn a half-written block into a final one.
		const settled = !pending;
		const replySurface = repair === "reply";
		const result = renderStreamingMarkdown(open ? open.head : text, streaming && !open, streamRef.current, {
			uiSettled: settled,
			uiRepair: replySurface,
		});
		streamRef.current = result.state;
		if (open) result.html = `${result.html}${renderUiBlockFence(open.source, { settled, repair: replySurface })}`;
		return result;
	}, [text, streaming, pending, repair]);

	// Copy-button delegation: blocks render through dangerouslySetInnerHTML,
	// so clicks arrive here. Code blocks copy the <code> textContent —
	// identical to the original fenced text even after tree-sitter spans.
	// Display math copies the LaTeX source: the annotation element katex
	// embeds, whose textContent is the source (entities decoded by the
	// browser); without an annotation (parse fallback) the visible text is
	// the escaped source, which is what you'd want to copy anyway. Tables
	// copy/download via their toolbar menu (CSV/TSV/Markdown), extracted
	// from the rendered DOM so inline markdown never leaks into the cells,
	// and toggle their wide layout from the same toolbar.
	const onCopy = useCallback((e: ReactMouseEvent<HTMLDivElement>): void => {
		const target = e.target as HTMLElement;
		// A UI block's controls answer the block, not the transcript.
		if (handleAnswerClick(target)) {
			e.preventDefault();
			return;
		}
		// Chat link → managed in-app browser (proma AgentBrowserLinkProvider
		// parity): http(s) link clicks dispatch musepi-open-url so ChatView can
		// open them in the right-panel browser instead of the system browser
		// (the old target=_blank opened a bare Electron window). Modifier
		// clicks (ctrl/cmd) still open externally via the default behavior.
		const linkEl = target.closest<HTMLElement>("a[href]");
		if (linkEl && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
			const href = linkEl.getAttribute("href") ?? "";
			if (/^https?:\/\//i.test(href)) {
				e.preventDefault();
				window.dispatchEvent(new CustomEvent("musepi-open-url", { detail: { url: href } }));
				return;
			}
		}
		const pathEl = target.closest<HTMLElement>("[data-open-path]");
		if (pathEl) {
			const path = pathEl.getAttribute("data-open-path") ?? "";
			// Desktop GUI: dispatch for right-panel preview (ChatView listens);
			// fall back to the system default app when no panel handles it.
			const bridge = electronBridge();
			const openWith = bridge?.openWith;
			if (openWith) {
				let handled = false;
				const onHandled = (ev: Event): void => {
					if ((ev as CustomEvent<{ path: string }>).detail?.path === path) handled = true;
				};
				window.addEventListener("musepi-open-file", onHandled, { once: true });
				window.dispatchEvent(new CustomEvent("musepi-open-file", { detail: { path } }));
				window.setTimeout(() => {
					window.removeEventListener("musepi-open-file", onHandled);
					if (!handled && path) void openWith("", path);
				}, 120);
			}
			return;
		}
		// Only INLINE math still lives in the message string and needs this.
		// A display formula, a code fence and a diagram are React blocks now, and
		// they carry `.tr-code-copy` too — handling those here meant two writers
		// for one button: this branch copied the wrong text (a display formula's
		// wrapper includes the copy control's own label) and the block's own
		// feedback was overwritten by the hash-keyed one.
		const btn = target.closest<HTMLElement>(".tr-math-copy");
		if (!btn) return;
		const wrap = btn.closest<HTMLElement>(".tr-math");
		const text = wrap?.querySelector<HTMLElement>('annotation[encoding="application/x-tex"]')?.textContent ?? "";
		if (text === "") return;
		const hash = btn.dataset.mathCopy ?? "";
		void navigator.clipboard.writeText(text).then(() => {
			setCopiedHash(hash);
			window.setTimeout(() => setCopiedHash(cur => (cur === hash ? null : cur)), 1400);
		});
	}, []);

	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!highlight || !root) return;
		// Defer to rAF so the DOM is stable before we scan + dispatch IPC;
		// this batches highlights to paint cycles and avoids firing on
		// intermediate innerHTML rebuilds during streaming.
		const raf = requestAnimationFrame(() => {
			const pending = new Set<string>();
			const queue: Array<{
				hash: string;
				// highlightSource stores lang?: string and highlight() accepts
				// undefined — the narrower annotation here broke tsgo.
				source: { code: string; lang?: string };
				el: HTMLElement;
			}> = [];
			for (const el of Array.from(root.querySelectorAll<HTMLElement>("code[data-hl-hash]"))) {
				const hash = el.dataset.hlHash!;
				if (el.classList.contains("tr-code-hl")) continue;
				const cached = highlightHtml.get(hash);
				if (cached !== undefined) {
					applyHighlight(el, cached);
					continue;
				}
				const source = highlightSource.get(hash);
				if (!source) continue;
				// Dedup: same code block can appear in multiple ticks while
				// streaming; only queue the highlight once.
				if (pending.has(hash)) continue;
				pending.add(hash);
				queue.push({ hash, source, el });
			}
			if (queue.length === 0) return;
			// Concurrency cap: the highlight worker is single-threaded and
			// runs behind IPC; >3 in flight floods the main-process queue
			// and makes navigation / clicks lag during long-message render.
			const CONCURRENCY = 3;
			let running = 0;
			const drain = () => {
				while (running < CONCURRENCY && queue.length > 0) {
					const job = queue.shift()!;
					running++;
					void Promise.resolve(highlight(job.source.code, job.source.lang)).then(highlighted => {
						running--;
						if (highlighted == null) {
							drain();
							return;
						}
						const html = highlightToCodeHtml(highlighted);
						cacheSet(highlightHtml, job.hash, html);
						// Re-renders replace block bodies; skip stale elements.
						if (job.el.isConnected && job.el.dataset.hlHash === job.hash) {
							applyHighlight(job.el, html);
						}
						drain();
					});
				}
			};
			drain();
		});
		return () => cancelAnimationFrame(raf);
	}, [text, highlight]);

	// Per-character entrance effect (打字机): the streaming tail lives in a
	// STABLE ref container (sibling of the markdown innerHTML div — React
	// never rebuilds it), and each NEW grapheme is appended as its own span
	// with a one-shot CSS animation class. The span is never rebuilt after
	// mount, so the animation plays exactly once and the char rests — every
	// new char animates, not just the last window (the old position-window
	// pass re-styled only the newest ~10 graphemes every frame, reading as
	// "每行最后几个字才有动效").
	//   Append-only streaming: the tail only GROWS (text appends) or is
	// replaced wholesale when a balanced "\n\n" boundary advances its start
	// (then the previous tail moved into the frozen markdown head and the
	// new tail is unrelated text — rebuild once, no animation replay of
	// already-shown chars).
	const tailRef = useRef<HTMLDivElement | null>(null);
	const tailStateRef = useRef<TailState>(EMPTY_TAIL);
	useLayoutEffect(() => {
		const el = tailRef.current;
		if (!el) return;
		// The effect itself is the package's (`advanceTail`): it appends only the
		// delta and starts over when the streaming cut advanced, so a character's
		// entrance plays once and no rule about replaying lives here.
		tailStateRef.current = advanceTail(el, render.tail ?? "", effect, tailStateRef.current);
	}, [render.tail, effect]);

	// UI block answers: the markdown HTML is rewritten on every commit, so the
	// store's state is re-applied to the fresh DOM. A control that changed the
	// store redraws every mounted block, because the store is the single truth
	// and a block can be re-rendered by an unrelated stream tick.
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		applyAnswers(root);
		// A settled reply with a block that never drew asks for one repair by
		// itself (GenUI auto-repair parity). It waits for the reply to settle
		// AND the turn to end: a later tool round would otherwise be interrupted
		// by a repair for an earlier answer. Only the reply surface takes part —
		// a thinking draft or a tool's output is not the answer being repaired.
		// One call repairs every failed block in this reply as a single message.
		if (repair === "reply" && !streaming && !pending && !working) autoRepairFailedBlocks(root);
		setAnswerMarks(() => applyAnswers(document));
		return () => setAnswerMarks(null);
	}, [text, streaming, pending, working, repair]);

	// Text typed into a block's field never reaches React: it belongs to the
	// block's own answer state.
	const onBlockInput = useCallback((e: React.FormEvent<HTMLDivElement>): void => {
		handleAnswerInput(e.target as Element);
	}, []);

	// Local images: swap raw filesystem srcs for data URLs via the desktop
	// bridge. Re-runs on each text change (new message content), like the
	// highlight pass; cache keeps repeated renders instant.
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		resolveLocalImages(root, localImageBridge() ?? {}, localImageCache, basePath);
	}, [text]);

	// P1/P2: official-mermaid fallback for blocks beautiful-mermaid can't
	// render synchronously (gantt/pie/timeline/…). A module-level
	// MutationObserver (ensureMermaidFallbackObserver, idempotent) watches
	// for .tr-mermaid-async placeholders appearing anywhere in the DOM —
	// component-lifecycle/timing independent — and fills each with the
	// debounced official-mermaid render (streaming blocks keep changing
	// hash → their placeholder is replaced by the next sync render, and
	// the stale timer's element is no longer connected).

	// The copy button's feedback is applied to the rendered DOM (attribute +
	// morphicon), not by rewriting the markdown HTML — a string swap replaced
	// the whole body and dropped the icon element with it.
	const body = render.html;
	const fragments = useMemo(() => splitTableFragments(body), [body]);

	// `morphicons` needs the element instance: plant the resting glyph after
	// each HTML commit (streaming rebuilds the body), keeping the copy state
	// the click handler already resolved.
	useLayoutEffect(() => {
		const host = rootRef.current;
		if (!host) return;
		defineMorphIcon();
		const globalLines = document.documentElement.classList.contains("gui-code-lines");
		for (const glyph of host.querySelectorAll<MorphIconElement>("morph-icon[data-glyph]")) {
			const button = glyph.closest<HTMLElement>(".tr-code-btn");
			const block = glyph.closest<HTMLElement>(".tr-code");
			const glyphName = glyph.dataset.glyph;
			if (glyphName === "wrap") {
				glyph.set(block?.classList.contains("tr-code--wrap") ? WrapGlyphData : NoWrapGlyphData);
			} else if (glyphName === "lines") {
				const on =
					block?.classList.contains("tr-code--lines") === true ||
					(globalLines && block?.classList.contains("tr-code--no-lines") !== true);
				glyph.set(on ? LinesGlyphData : NoLinesGlyphData);
			} else {
				const copied = button != null && copiedHash != null && button.dataset.copyHash === copiedHash;
				glyph.set(copied ? CheckGlyphData : CopyGlyphData);
			}
		}
	}, [render.html, copiedHash]);

	// Copy feedback for the HTML-built blocks. A fenced code block morphs its
	// `<morph-icon>`; the math toolbar still comes out of the string (math lives
	// inside a paragraph, so it cannot be cut into a block), and it carries a
	// plain inline SVG, which is swapped instead. Table and diagram blocks are
	// React components and own their copy state — writing here as well would be
	// a second writer for the same attribute.
	useLayoutEffect(() => {
		const host = rootRef.current;
		if (!host) return;
		for (const button of host.querySelectorAll<HTMLElement>(".tr-code-copy")) {
			const copied = copiedHash != null && button.dataset.copyHash === copiedHash;
			button.toggleAttribute("data-copied", copied);
			button.setAttribute("aria-label", t(copied ? "settings.copied" : "settings.copy"));
			button.setAttribute("title", t(copied ? "settings.copied" : "settings.copy"));
			if (button.querySelector("svg[data-glyph]")) {
				setBlockGlyph(button, copied ? "check" : "copy");
				continue;
			}
			button
				.querySelector<MorphIconElement>("morph-icon")
				?.morphTo(copied ? CheckGlyphData : CopyGlyphData, "snappy");
		}
	}, [copiedHash]);

	// 表格加宽 state → DOM: applied now and re-applied whenever React rewrites
	// the markdown html (`body` goes through dangerouslySetInnerHTML, so a
	// stream tick or the copy-label swap replaces the table markup wholesale).
	// The observer's childList signal is exact regardless of commit ordering,
	// and only classes/attributes change — the table's own innerHTML and its
	// scroll position are never rebuilt.
	const widenLabel = t("general.widenTable");
	const resetWideLabel = t("general.resetTableWidth");
	const quoteText = useCallback((text: string): void => {
		window.dispatchEvent(new CustomEvent("musepi-gui-quote-append", { detail: { text } }));
	}, []);
	const blockLabels = useMemo<MarkdownBlockLabels>(
		() => ({
			close: t("settings.close"),
			copied: t("settings.copied"),
			copy: t("settings.copy"),
			download: t("settings.download"),
			lineNumbers: t("settings.lineNumbers"),
			expand: t("general.tableExpand"),
			moreFormats: t("general.tableFormats"),
			quoteRegion: t("general.quoteTableRegion"),
			resetWidth: resetWideLabel,
			widen: widenLabel,
			wrapLines: t("settings.wrapLines"),
			zoomIn: t("settings.zoomIn"),
			zoomOut: t("settings.zoomOut"),
			renderingDiagram: t("settings.renderingDiagram"),
		}),
		[widenLabel, resetWideLabel],
	);
	// Effect class on the streaming root: typewriter carries one too so
	// the caret (CSS ::after) can be scoped to the typewriter preset only.
	const effectCls = streaming ? ` gui-chat-effect-${effect}` : "";
	return (
		<>
			<div
				ref={rootRef}
				className={`tr-md${streaming ? " tr-md--streaming" : ""}${effectCls}`}
				onClick={onCopy}
				onInput={onBlockInput}
			>
				{fragments.map((fragment, index) =>
					fragment.kind === "html" ? (
						<div
							key={`html:${index}`}
							className="tr-md-fragment"
							dangerouslySetInnerHTML={{ __html: fragment.html }}
						/>
					) : fragment.kind === "table" ? (
						<TableFragment
							key={`table:${fragment.hash}`}
							hash={fragment.hash}
							labels={blockLabels}
							quoteText={quoteText}
						/>
					) : fragment.kind === "code" ? (
						<CodeFragment
							key={`code:${fragment.hash}`}
							hash={fragment.hash}
							labels={blockLabels}
							highlighted={highlightHtml.get(fragment.hash) ?? null}
						/>
					) : fragment.kind === "diagram" ? (
						<DiagramFragment key={`diagram:${fragment.hash}`} hash={fragment.hash} labels={blockLabels} />
					) : (
						<MathFragment key={`math:${fragment.hash}`} hash={fragment.hash} labels={blockLabels} />
					),
				)}
				{/* Stable streaming-tail container: React never rebuilds this
				 * element's children — the per-char spans are appended by the
				 * layout effect above, so each char's entrance animation plays
				 * exactly once. Absent when settled (the tail is then part of
				 * the markdown html above). */}
				{streaming && render.tail !== null && (
					<div ref={tailRef} className="tr-md-streaming-tail" aria-live="polite" />
				)}
			</div>
			{truncated && (
				<button type="button" className="tr-long-expand" onClick={() => setLongExpanded(true)}>
					{t("settings.expandFullMessage")}（{fullText.length.toLocaleString()}）
				</button>
			)}
		</>
	);
});
