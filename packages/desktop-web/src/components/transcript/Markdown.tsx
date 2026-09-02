import { Marked } from "@musepi/pi-utils/marked";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/index.js";
import { electronBridge } from "../../lib/electron-bridge";
import { escapeHtml, highlightToCodeHtml } from "./highlight";
import { useCodeHighlight } from "./highlight-context";
import { isLocalFilePath } from "./markdown-shared";
import { mathExtensions } from "./math";
import { ensureMermaidFallbackObserver, mermaidMode, renderMermaidHtml } from "./mermaid";
import { graphemeSpans } from "./reveal";
import { useStreamingReveal } from "./use-streaming-reveal";

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

const md = new Marked({
	gfm: true,
	extensions: mathExtensions,
	renderer: {
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
							`<span class="tr-advisory-tag">${t("advisor")}</span>` +
							(advisor ? `<span class="tr-advisory-name">${escapeHtml(advisor)}</span>` : "") +
							`<span class="tr-advisory-sev">${t(`advisory ${sev}`)}</span>` +
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
				return renderMermaidHtml(text, mermaidMode());
			}
			const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
			const body = escaped ? text : escapeHtml(text);
			const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
			const lines = trimmed
				.split("\n")
				.map(line => `<span class="tr-code-line">${line}</span>`)
				.join("\n");
			const hash = fnv1a(text).toString(36);
			cacheSet(highlightSource, hash, { code: text, lang: lang || undefined });
			// Header carries the language tag + a copy button (delegated in
			// the component below); textContent of <code> stays the raw
			// source even after tree-sitter spans replace the body.
			const head =
				`<div class="tr-code-head">` +
				`<span class="tr-code-lang">${lang ? escapeHtml(lang) : "text"}</span>` +
				`<button type="button" class="tr-code-copy" data-copy-hash="${hash}">${t("copy")}</button>` +
				`</div>`;
			return `<div class="tr-code">${head}<pre><code${langAttr} data-hl-hash="${hash}">${lines}\n</code></pre></div>`;
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

// ---- Table copy/download helpers (openchamber parity) ---------------------
// Cells are extracted from the rendered DOM (textContent), so inline
// markdown formatting never leaks into CSV/TSV/Markdown output.

function extractTableData(table: HTMLTableElement): { headers: string[]; rows: string[][] } {
	const headers = Array.from(table.querySelectorAll("thead th")).map(th => th.textContent?.trim() ?? "");
	const rows = Array.from(table.querySelectorAll("tbody tr")).map(tr =>
		Array.from(tr.querySelectorAll("td")).map(td => td.textContent?.trim() ?? ""),
	);
	return { headers, rows };
}

const escapeCsv = (value: string): string => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

function tableToCSV({ headers, rows }: { headers: string[]; rows: string[][] }): string {
	return [headers, ...rows].map(row => row.map(escapeCsv).join(",")).join("\n");
}

function tableToTSV({ headers, rows }: { headers: string[]; rows: string[][] }): string {
	return [headers, ...rows].map(row => row.join("\t")).join("\n");
}

function tableToMarkdown({ headers, rows }: { headers: string[]; rows: string[][] }): string {
	const sep = `| ${headers.map(() => "---").join(" | ")} |`;
	const line = (row: string[]): string => `| ${row.join(" | ")} |`;
	return [line(headers), sep, ...rows.map(line)].join("\n");
}

function downloadBlob(name: string, content: string, mime: string): void {
	const blob = new Blob([content], { type: mime });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	URL.revokeObjectURL(url);
}

/**
 * Table toolbar HTML (openchamber parity): hover-revealed copy
 * (CSV/TSV/Markdown) + download (CSV/Markdown) menus. The copy button
 * shares the code-block hash scheme so its label flips to "copied"; menu
 * items are delegated in the component below.
 */
function tableToolbarHtml(hash: string): string {
	const menuWrap = (children: string): string => `<span class="tr-table-menu-wrap">${children}</span>`;
	return (
		`<div class="tr-table-bar">` +
		menuWrap(
			`<button type="button" class="tr-table-btn tr-code-copy" data-copy-hash="${hash}">${t("copy")}</button>` +
				`<span class="tr-table-menu" role="menu">` +
				`<button type="button" role="menuitem" data-table-copy="csv">CSV</button>` +
				`<button type="button" role="menuitem" data-table-copy="tsv">TSV</button>` +
				`<button type="button" role="menuitem" data-table-copy="markdown">Markdown</button>` +
				`</span>`,
		) +
		menuWrap(
			`<button type="button" class="tr-table-btn tr-code-copy">${t("download")}</button>` +
				`<span class="tr-table-menu" role="menu">` +
				`<button type="button" role="menuitem" data-table-download="csv">CSV</button>` +
				`<button type="button" role="menuitem" data-table-download="markdown">Markdown</button>` +
				`</span>`,
		) +
		`</div>`
	);
}

/**
 * Wrap rendered `<table>` blocks with the hover toolbar. Post-process
 * instead of a renderer override: this marked fork dispatches `table`
 * tokens straight to the default renderer (the other tokens go through
 * the overrides path), so a custom `renderer.table` is silently ignored.
 * Tables are block-level and never nest, so the regex is safe.
 */
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

function decorateTables(html: string): string {
	return html.replace(/<table>([\s\S]*?)<\/table>/g, (_full, inner: string) => {
		const hash = fnv1a(inner).toString(36);
		return (
			`<div class="tr-table">` +
			tableToolbarHtml(hash) +
			`<div class="tr-table-scroll"><table>${inner}</table></div></div>`
		);
	});
}

/**
 * Incremental streaming-markdown cache: `blocks` are frozen "\n\n"-bounded
 * chunks; a later append reuses everything before the cut verbatim.
 */
export interface StreamingRenderState {
	text: string;
	blocks: Array<{ start: number; html: string }>;
	/** Code-unit offset where the plain-text tail begins in `text`. */
	tailStart: number;
}

/**
 * Streaming markdown renderer. The settled render (`streaming: false`)
 * parses the complete text once — the stable final layout (what a reload
 * shows). While streaming, completed blocks render as markdown (reused
 * verbatim across frames) and the not-yet-settled TAIL is returned as RAW
 * TEXT (`tail`) — the caller appends it incrementally as per-character
 * spans (each new char's entrance animation plays ONCE; a plain tail only
 * grows, and the full markdown renders once on settle).
 */
export function renderStreamingMarkdown(
	text: string,
	streaming: boolean,
	prev: StreamingRenderState | null,
): { html: string; tail: string | null; state: StreamingRenderState | null } {
	if (!streaming) {
		// Settle: the streaming head blocks were parsed at balanced "\n\n"
		// boundaries and are COMPLETE markdown — reuse them verbatim and
		// re-parse only the plain-text tail as real markdown (a fence now
		// closed, a list complete). Avoids the full-message synchronous
		// md.parse on settle — the user-visible "卡一下才都渲染" stall on
		// long messages.
		if (prev && prev.blocks.length > 0 && text.startsWith(prev.text)) {
			const head = prev.blocks.map(b => b.html).join("");
			const tailText = text.slice(prev.tailStart);
			const tailHtml = decorateTables(md.parse(tailText, { async: false }));
			return { html: head + tailHtml, tail: null, state: null };
		}
		return { html: decorateTables(md.parse(text, { async: false })), tail: null, state: null };
	}
	try {
		if (prev && text.length > prev.text.length && text.startsWith(prev.text)) {
			// Append-only growth: the plain-tail start NEVER advances during
			// streaming. Re-parsing the region that was shown as plain text
			// as markdown mid-stream is exactly the structural jump the
			// plain-tail contract forbids — the region stays plain (kept in
			// the stable DOM container) until settle re-parses everything.
			// The frozen markdown head blocks are reused verbatim.
			return {
				html: prev.blocks.map(b => b.html).join(""),
				tail: text.slice(prev.tailStart ?? 0),
				state: { text, blocks: prev.blocks, tailStart: prev.tailStart ?? 0 },
			};
		}
		// First streaming frame / non-append growth: parse once, split into
		// frozen "\n\n"-bounded blocks so later appends can reuse everything
		// before the cut. Everything after the final balanced boundary is an
		// unfinished tail — returned raw, same as the incremental path, so
		// an open fence never snaps into a code block on the very first
		// frame.
		const blocks: Array<{ start: number; html: string }> = [];
		let from = 0;
		for (let i = 0; i < text.length; i++) {
			if (text[i] === "\n" && text[i + 1] === "\n" && fencesBalanced(text.slice(0, i + 2))) {
				blocks.push({ start: from, html: decorateTables(md.parse(text.slice(from, i + 2), { async: false })) });
				from = i + 2;
				i += 1;
			}
		}
		return {
			html: blocks.map(b => b.html).join(""),
			tail: text.slice(from),
			state: { text, blocks, tailStart: from },
		};
	} catch {
		return { html: "", tail: text, state: null };
	}
}

const highlightSource = new Map<string, { code: string; lang?: string }>();
const highlightHtml = new Map<string, string>();

// Local-image bridge (bitfun parity): markdown `![](/abs/path)` images are
// read through Electron IPC into data URLs so desktop sessions can display
// real files. Browser guests have no bridge and keep the raw src (which
// simply fails to load there). Bounded cache mirrors the highlight one.
const localImageCache = new Map<string, string>();
const LOCAL_IMAGE_CACHE_MAX = 100;

interface LocalImageBridge {
	readFileDataUrl?(filePath: string): Promise<{ dataUrl?: string; error?: string }>;
}

const localImageBridge = (): LocalImageBridge | null => electronBridge();

/** `/abs/path.png`, `~/x.png`, `./rel.png`, `../rel.png`, `file://…` — but
 *  never http(s)/data/blob URLs, and never local paths without a known
 *  image extension (`/etc/hosts` stays a plain text path). */
export function isLocalImageSrc(src: string): boolean {
	if (/^(https?:|data:|blob:)/i.test(src)) return false;
	const path = src.startsWith("file://") ? src.slice("file://".length) : src;
	return /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(path);
}

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
		let key = src.startsWith("file://") ? src.slice("file://".length) : src;
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

/**
 * Fullscreen mermaid preview (image/widget lightbox parity): frosted
 * overlay (same .tr-img-lb chrome as the image lightbox), the rendered SVG
 * scaled with CSS zoom, and its own zoom/copy/download controls. Esc or
 * the floating close button dismisses.
 */
function MermaidLightbox({
	value,
	zoom,
	onZoom,
	onClose,
}: {
	value: { html: string; source: string; hash: string };
	zoom: number;
	onZoom(next: number): void;
	onClose(): void;
}): ReactNode {
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	const step = (dir: 1 | -1): void => {
		onZoom(Math.min(4, Math.max(0.5, zoom * (dir === 1 ? 1.2 : 1 / 1.2))));
	};
	return createPortal(
		<div className="tr-img-lb tr-mm-lb" onClick={onClose}>
			<button type="button" className="tr-img-lb-x" aria-label={t("close")} title={t("close")} onClick={onClose}>
				✕
			</button>
			<div className="tr-mm-lb-body" onClick={e => e.stopPropagation()}>
				<div className="tr-mm-lb-toolbar">
					<button type="button" className="tr-mm-lb-btn" title={t("zoom out")} onClick={() => step(-1)}>
						−
					</button>
					<span className="tr-mm-lb-zoom">{Math.round(zoom * 100)}%</span>
					<button type="button" className="tr-mm-lb-btn" title={t("zoom in")} onClick={() => step(1)}>
						+
					</button>
					<button
						type="button"
						className="tr-mm-lb-btn"
						title={t("copy")}
						onClick={() => {
							if (value.source) void navigator.clipboard.writeText(value.source).catch(() => {});
						}}
					>
						{t("copy")}
					</button>
					<button
						type="button"
						className="tr-mm-lb-btn"
						title={t("download")}
						onClick={() => downloadBlob("diagram.svg", value.html, "image/svg+xml;charset=utf-8")}
					>
						{t("download")}
					</button>
				</div>
				<div className="tr-mm-lb-scroll">
					<div className="tr-mm-lb-svg" style={{ zoom }} dangerouslySetInnerHTML={{ __html: value.html }} />
				</div>
			</div>
		</div>,
		document.body,
	);
}
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
	smoothStreaming,
}: {
	text: string;
	basePath?: string;
	/** Live-streaming text — renders a kimi-style blinking caret at the end. */
	streaming?: boolean;
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
	const [copiedHash, setCopiedHash] = useState<string | null>(null);
	const [mermaidFull, setMermaidFull] = useState<{ html: string; source: string; hash: string } | null>(null);
	const [mermaidFsZoom, setMermaidFsZoom] = useState(1);
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
		const result = renderStreamingMarkdown(text, streaming, streamRef.current);
		streamRef.current = result.state;
		return result;
	}, [text, streaming]);

	// Copy-button delegation: blocks render through dangerouslySetInnerHTML,
	// so clicks arrive here. Code blocks copy the <code> textContent —
	// identical to the original fenced text even after tree-sitter spans.
	// Display math copies the LaTeX source: the annotation element katex
	// embeds, whose textContent is the source (entities decoded by the
	// browser); without an annotation (parse fallback) the visible text is
	// the escaped source, which is what you'd want to copy anyway. Tables
	// copy/download via their toolbar menu (CSV/TSV/Markdown), extracted
	// from the rendered DOM so inline markdown never leaks into the cells.
	const onCopy = useCallback((e: ReactMouseEvent<HTMLDivElement>): void => {
		const target = e.target as HTMLElement;
		// Chat link → managed in-app browser (proma AgentBrowserLinkProvider
		// parity): http(s) link clicks dispatch omp-open-url so ChatView can
		// open them in the right-panel browser instead of the system browser
		// (the old target=_blank opened a bare Electron window). Modifier
		// clicks (ctrl/cmd) still open externally via the default behavior.
		const linkEl = target.closest<HTMLElement>("a[href]");
		if (linkEl && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
			const href = linkEl.getAttribute("href") ?? "";
			if (/^https?:\/\//i.test(href)) {
				e.preventDefault();
				window.dispatchEvent(new CustomEvent("omp-open-url", { detail: { url: href } }));
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
				window.addEventListener("omp-open-file", onHandled, { once: true });
				window.dispatchEvent(new CustomEvent("omp-open-file", { detail: { path } }));
				window.setTimeout(() => {
					window.removeEventListener("omp-open-file", onHandled);
					if (!handled && path) void openWith("", path);
				}, 120);
			}
			return;
		}
		const mermaidZoom = target.closest<HTMLElement>("[data-mermaid-zoom]");
		if (mermaidZoom) {
			// P3: scale the rendered SVG with CSS `zoom` (layout scaling —
			// the wrapper's overflow:auto gains real scrollbars, unlike
			// transform, which only scales visually and spills). Stored as
			// a data-zoom fraction so repeated clicks compound 1.2× / ÷1.2.
			// svg has max-width:100% in CSS, which would pin the zoomed
			// layout — clear it while zoomed (restored at 1×).
			const svgWrap = mermaidZoom
				.closest<HTMLElement>(".tr-mermaid-block")
				?.querySelector<HTMLElement>(".tr-mermaid");
			if (!svgWrap) return;
			const dir = mermaidZoom.dataset.mermaidZoom;
			const cur = Number.parseFloat(svgWrap.dataset.zoom ?? "1") || 1;
			const next = Math.min(4, Math.max(0.5, dir === "in" ? cur * 1.2 : cur / 1.2));
			svgWrap.dataset.zoom = String(next);
			const svg = svgWrap.querySelector<HTMLElement>("svg");
			if (svg) {
				svg.style.zoom = String(next);
				svg.style.maxWidth = next === 1 ? "" : "none";
			}
			return;
		}
		const mermaidFs = target.closest<HTMLElement>("[data-mermaid-fullscreen]");
		if (mermaidFs) {
			// Fullscreen preview (image/widget lightbox parity): lift the
			// rendered SVG into a frosted overlay with its own zoom/copy/
			// download controls.
			const block = mermaidFs.closest<HTMLElement>(".tr-mermaid-block");
			const svg = block?.querySelector<SVGElement>(".tr-mermaid svg");
			if (!svg || !block) return;
			const src = block.querySelector<HTMLElement>("[data-mermaid-src]")?.getAttribute("data-mermaid-src") ?? "";
			setMermaidFull({ html: svg.outerHTML, source: src, hash: src });
			setMermaidFsZoom(1);
			return;
		}
		const mermaidCopy = target.closest<HTMLElement>("[data-mermaid-src]");
		if (mermaidCopy) {
			const text = mermaidCopy.getAttribute("data-mermaid-src") ?? "";
			if (!text) return;
			const hash = mermaidCopy.getAttribute("data-copy-hash") ?? "";
			void navigator.clipboard.writeText(text).then(() => {
				setCopiedHash(hash);
				window.setTimeout(() => setCopiedHash(cur => (cur === hash ? null : cur)), 1400);
			});
			return;
		}
		const mermaidDl = target.closest<HTMLElement>("[data-mermaid-download]");
		if (mermaidDl) {
			const svg = mermaidDl.closest<HTMLElement>(".tr-mermaid-block")?.querySelector(".tr-mermaid svg");
			if (!svg) return;
			const xml = new XMLSerializer().serializeToString(svg);
			downloadBlob("diagram.svg", xml, "image/svg+xml;charset=utf-8");
			return;
		}
		const tableCopy = target.closest<HTMLElement>("[data-table-copy]");
		if (tableCopy) {
			const table = tableCopy.closest<HTMLElement>(".tr-table")?.querySelector("table");
			if (!table) return;
			const data = extractTableData(table);
			const fmt = tableCopy.dataset.tableCopy ?? "csv";
			const text = fmt === "tsv" ? tableToTSV(data) : fmt === "markdown" ? tableToMarkdown(data) : tableToCSV(data);
			const hash =
				tableCopy
					.closest<HTMLElement>(".tr-table")
					?.querySelector("[data-copy-hash]")
					?.getAttribute("data-copy-hash") ?? "";
			if (!text || hash === "") return;
			void navigator.clipboard.writeText(text).then(() => {
				setCopiedHash(hash);
				window.setTimeout(() => setCopiedHash(cur => (cur === hash ? null : cur)), 1400);
			});
			return;
		}
		const tableDl = target.closest<HTMLElement>("[data-table-download]");
		if (tableDl) {
			const table = tableDl.closest<HTMLElement>(".tr-table")?.querySelector("table");
			if (!table) return;
			const data = extractTableData(table);
			const fmt = tableDl.dataset.tableDownload ?? "csv";
			const content = fmt === "markdown" ? tableToMarkdown(data) : tableToCSV(data);
			downloadBlob(
				fmt === "markdown" ? "table.md" : "table.csv",
				content,
				fmt === "markdown" ? "text/markdown" : "text/csv",
			);
			return;
		}
		const btn = target.closest<HTMLElement>(".tr-code-copy, .tr-math-copy");
		if (!btn) return;
		let text: string | undefined;
		if (btn.classList.contains("tr-math-copy")) {
			const wrap = btn.closest<HTMLElement>(".tr-math");
			text =
				wrap?.querySelector<HTMLElement>('annotation[encoding="application/x-tex"]')?.textContent ??
				wrap?.textContent ??
				"";
		} else {
			const code = btn.closest<HTMLElement>(".tr-code")?.querySelector("code");
			text = code?.textContent ?? undefined;
		}
		if (text === undefined) return;
		const hash = btn.dataset.copyHash ?? btn.dataset.mathCopy ?? "";
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
				source: { code: string; lang: string };
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
	const tailAppendedRef = useRef<string>("");
	useLayoutEffect(() => {
		const el = tailRef.current;
		if (!el) return;
		const target = render.tail ?? "";
		const prev = tailAppendedRef.current;
		if (target === prev) return;
		if (!target.startsWith(prev)) {
			// Cut advanced (or a non-append reset): the previous tail moved
			// into the head, or the stream restarted — drop everything and
			// re-append the current tail fresh.
			el.textContent = "";
			tailAppendedRef.current = "";
		}
		const frag = document.createDocumentFragment();
		const delta = target.slice(tailAppendedRef.current.length);
		// shimmer is a root-level CSS sweep (no per-char spans); every other
		// preset animates each new char exactly once via its CSS class.
		if (effect === "shimmer") {
			frag.appendChild(document.createTextNode(delta));
		} else {
			const effCls = effect === "typewriter" ? "tr-char tr-char--typewriter" : `tr-char tr-char--${effect}`;
			for (const { word } of graphemeSpans(delta)) {
				if (word === "\n") {
					frag.appendChild(document.createTextNode("\n"));
					continue;
				}
				const span = document.createElement("span");
				span.className = effCls;
				span.textContent = word;
				frag.appendChild(span);
			}
		}
		el.appendChild(frag);
		tailAppendedRef.current = target;
	}, [render.tail, effect]);

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
	useLayoutEffect(() => {
		ensureMermaidFallbackObserver();
	}, []);

	// The copy button swaps to a transient "copied" label (same width).
	const copiedLabel = t("copied");
	const body =
		copiedHash == null
			? render.html
			: render.html.replace(
					new RegExp(`((?:data-copy-hash|data-math-copy)="${copiedHash}"[^>]*)(>${t("copy")}<)`, "g"),
					`$1 data-copied>${copiedLabel}<`,
				);

	// Effect class on the streaming root: typewriter carries one too so
	// the caret (CSS ::after) can be scoped to the typewriter preset only.
	const effectCls = streaming ? ` gui-chat-effect-${effect}` : "";
	return (
		<>
			<div ref={rootRef} className={`tr-md${streaming ? " tr-md--streaming" : ""}${effectCls}`} onClick={onCopy}>
				<div dangerouslySetInnerHTML={{ __html: body }} />
				{/* Stable streaming-tail container: React never rebuilds this
				 * element's children — the per-char spans are appended by the
				 * layout effect above, so each char's entrance animation plays
				 * exactly once. Absent when settled (the tail is then part of
				 * the markdown html above). */}
				{streaming && render.tail !== null && (
					<div ref={tailRef} className="tr-md-streaming-tail" aria-live="polite" />
				)}
				{mermaidFull && (
					<MermaidLightbox
						value={mermaidFull}
						zoom={mermaidFsZoom}
						onZoom={setMermaidFsZoom}
						onClose={() => setMermaidFull(null)}
					/>
				)}
			</div>
			{truncated && (
				<button type="button" className="tr-long-expand" onClick={() => setLongExpanded(true)}>
					{t("expand full message")}（{fullText.length.toLocaleString()}）
				</button>
			)}
		</>
	);
});
