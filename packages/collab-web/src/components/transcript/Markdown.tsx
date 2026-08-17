import { Marked } from "@musepi/pi-utils/marked";
import type { Tokens } from "@musepi/pi-utils/marked";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { escapeHtml, highlightToCodeHtml } from "./highlight";
import { useCodeHighlight } from "./highlight-context";
import { isLocalFilePath } from "./markdown-shared";
import { mathExtensions } from "./math";
import { mermaidMode, renderMermaidHtml } from "./mermaid";

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

const escapeCsv = (value: string): string =>
	/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

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

const localImageBridge = (): LocalImageBridge | null =>
	((window as unknown as { electronAPI?: LocalImageBridge }).electronAPI) ?? null;

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
	text,
	basePath,
	streaming = false,
}: {
	text: string;
	basePath?: string;
	/** Live-streaming text — renders a kimi-style blinking caret at the end. */
	streaming?: boolean;
}): ReactNode {
	const highlight = useCodeHighlight();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [copiedHash, setCopiedHash] = useState<string | null>(null);
	// mermaidMode is read at render so the setting change re-parses
	// (fences render svg vs ascii) even when the text is unchanged.
	const mode = mermaidMode();
	// Streaming fast path (TUI parity): marked has no resumable lexer, but
	// block tokenization is local across a "\n\n" boundary with balanced
	// fences — parse(prefix) ++ parse(tail) === parse(prefix+tail). On
	// append-only growth we re-parse only the grown tail instead of the
	// whole buffer, turning the O(N^2) reveal cost of a long streaming
	// message into O(N) (measured: 14KB message re-parsed per frame at
	// 11.5ms/frame → sub-ms with this cache).
	const streamRef = useRef<{ text: string; blocks: Array<{ start: number; html: string }> } | null>(null);
	const html = useMemo(() => {
		try {
			const prev = streamRef.current;
			if (prev && text.length > prev.text.length && text.startsWith(prev.text)) {
				// Largest balanced "\n\n" boundary at/before the previous tail.
				let cut = prev.text.length;
				while (cut > 0) {
					const nl = prev.text.lastIndexOf("\n\n", cut - 1);
					if (nl < 0) break;
					const b = nl + 2;
					if (fencesBalanced(prev.text.slice(0, b))) {
						cut = b;
						break;
					}
					cut = nl;
				}
				if (cut > 0) {
					// Head blocks lie entirely before the cut (each block ends
					// at a balanced "\n\n" boundary, so no block straddles it).
					const head = prev.blocks.filter(b => b.start < cut);
					if (head.length > 0) {
						const tailText = text.slice(cut);
						const tailHtml = decorateTables(md.parse(tailText, { async: false }));
						// Persist the tail as frozen blocks too — dropping it
						// would lose everything between the old and new cuts
						// on the next append.
						const tailBlocks: Array<{ start: number; html: string }> = [];
						let from = 0;
						for (let i = 0; i < tailText.length; i++) {
							if (tailText[i] === "\n" && tailText[i + 1] === "\n" && fencesBalanced(tailText.slice(0, i + 2))) {
								tailBlocks.push({ start: cut + from, html: decorateTables(md.parse(tailText.slice(from, i + 2), { async: false })) });
								from = i + 2;
								i += 1;
							}
						}
						if (from < tailText.length) tailBlocks.push({ start: cut + from, html: decorateTables(md.parse(tailText.slice(from), { async: false })) });
						const out = head.map(b => b.html).join("") + tailHtml;
						streamRef.current = { text, blocks: [...head, ...tailBlocks] };
						return out;
					}
				}
			}
			// Full parse, split into frozen "\n\n"-bounded blocks so later
			// appends can reuse everything before the cut.
			const out = decorateTables(md.parse(text, { async: false }));
			const blocks: Array<{ start: number; html: string }> = [];
			let from = 0;
			for (let i = 0; i < text.length; i++) {
				if (text[i] === "\n" && text[i + 1] === "\n" && fencesBalanced(text.slice(0, i + 2))) {
					blocks.push({ start: from, html: decorateTables(md.parse(text.slice(from, i + 2), { async: false })) });
					from = i + 2;
					i += 1;
				}
			}
			if (from < text.length) blocks.push({ start: from, html: decorateTables(md.parse(text.slice(from), { async: false })) });
			streamRef.current = { text, blocks };
			return out;
		} catch {
			return escapeHtml(text);
		}
	}, [text]);

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
		const pathEl = target.closest<HTMLElement>("[data-open-path]");
		if (pathEl) {
			const path = pathEl.getAttribute("data-open-path") ?? "";
			// Desktop GUI: dispatch for right-panel preview (ChatView listens);
			// fall back to the system default app when no panel handles it.
			const bridge = (window as unknown as { electronAPI?: { openWith?(app: string, path: string): Promise<boolean> } })
				.electronAPI;
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
			const text =
				fmt === "tsv" ? tableToTSV(data) : fmt === "markdown" ? tableToMarkdown(data) : tableToCSV(data);
			const hash = tableCopy.closest<HTMLElement>(".tr-table")?.querySelector("[data-copy-hash]")?.getAttribute("data-copy-hash") ?? "";
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
			downloadBlob(fmt === "markdown" ? "table.md" : "table.csv", content, fmt === "markdown" ? "text/markdown" : "text/csv");
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: effect re-runs on each text change to highlight new blocks
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!highlight || !root) return;
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
			void Promise.resolve(highlight(source.code, source.lang)).then(highlighted => {
				if (highlighted == null) return;
				// The native highlighter returns ANSI-colored text (TUI parity);
				// convert to DOM spans before it touches innerHTML — raw ESC
				// sequences would render as visible "[38;2;…m" garbage and leak
				// into the copy button's textContent (tool views already do this
				// conversion; the transcript markdown path was missing it).
				const html = highlightToCodeHtml(highlighted);
				cacheSet(highlightHtml, hash, html);
				// Re-renders replace block bodies; skip stale elements.
				if (el.isConnected && el.dataset.hlHash === hash) applyHighlight(el, html);
			});
		}
	}, [text, highlight]);

	// Local images: swap raw filesystem srcs for data URLs via the desktop
	// bridge. Re-runs on each text change (new message content), like the
	// highlight pass; cache keeps repeated renders instant.
	// biome-ignore lint/correctness/useExhaustiveDependencies: effect re-runs on each text change to resolve new images
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		resolveLocalImages(root, localImageBridge() ?? {}, localImageCache, basePath);
	}, [text]);

	// The copy button swaps to a transient "copied" label (same width).
	const copiedLabel = t("copied");
	const body =
		copiedHash == null
			? html
			: html.replace(
					new RegExp(`((?:data-copy-hash|data-math-copy)="${copiedHash}"[^>]*)(>${t("copy")}<)`, "g"),
					`$1 data-copied>${copiedLabel}<`,
				);

	// biome-ignore lint/security/noDangerouslySetInnerHtml: html built from escaped marked output
	return (
		<div
			ref={rootRef}
			className={streaming ? "tr-md tr-md--streaming" : "tr-md"}
			onClick={onCopy}
			dangerouslySetInnerHTML={{ __html: body }}
		/>
	);
});
