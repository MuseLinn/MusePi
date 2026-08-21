import { type DiagramColors, renderMermaidASCII, renderMermaidSVG } from "beautiful-mermaid";
import { t } from "../../i18n/index.js";
import { escapeHtml } from "./highlight";

export type MermaidMode = "svg" | "ascii";

/** Chat-settings pref (Settings → 聊天 → Mermaid 渲染), default SVG. */
export function mermaidMode(): MermaidMode {
	try {
		return localStorage.getItem("musepi-gui-chat-mermaid") === "ascii" ? "ascii" : "svg";
	} catch {
		return "svg";
	}
}

/**
 * Theme-following palette. IMPORTANT: beautiful-mermaid assigns each option
 * to the SAME-NAMED custom property on the svg (--bg/--fg/--accent/…), so
 * passing e.g. `bg: "var(--bg)"` creates a self-reference that is
 * guaranteed-invalid (renders black). Every value here names a DIFFERENT
 * document token that resolves without a cycle.
 */
const MERMAID_COLORS: DiagramColors = {
	bg: "var(--background)",
	fg: "var(--color-text)",
	line: "var(--border)",
	accent: "var(--accent-hover)",
	muted: "var(--fg-muted)",
	surface: "var(--bg-raised)",
	border: "var(--border-strong)",
};

/** FNV-1a (32-bit) — copy-button identity (same scheme as Markdown.tsx). */
const fnv1a = (s: string): number => {
	let hash = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		hash ^= s.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
};

/** Debounce for async fallback renders (P2: never hammer the official
 *  renderer while a block is still streaming in). */
export const MERMAID_FALLBACK_DEBOUNCE_MS = 350;

/**
 * Guard against beautiful-mermaid / official mermaid emitting a broken or
 * error SVG instead of throwing (Proma's isUsableSvg port): NaN/Infinity
 * coordinates, or mermaid's error-marked output — those must go to the
 * fallback path instead of painting garbage.
 */
export function isUsableSvg(svg: unknown): svg is string {
	if (typeof svg !== "string" || !svg.includes("<svg")) return false;
	if (/(?:^|[^a-z])(?:NaN|Infinity|-Infinity)(?:[^a-z]|$)/i.test(svg)) return false;
	if (svg.includes('aria-roledescription="error"')) return false;
	if (svg.includes('class="error-text"')) return false;
	return true;
}

const FS_ICON =
	'<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M8 3V5H4V9H2V3H8ZM2 21V15H4V19H8V21H2ZM22 21H16V19H20V15H22V21ZM22 9H20V5H16V3H22V9Z" fill="currentColor"/></svg>';

/**
 * Hover toolbar (openchamber parity): copy the mermaid SOURCE (svg mode
 * additionally offers zoom in/out and download of the rendered SVG). The
 * copy button shares the code-block hash scheme so its label flips to
 * "copied"; the source rides in data-mermaid-src (escaped) and the SVG is
 * serialized from the DOM at download time. Delegated in the Markdown
 * component.
 */
const mermaidToolbar = (source: string, mode: MermaidMode): string => {
	const hash = fnv1a(source).toString(36);
	const copy = `<button type="button" class="tr-mermaid-copy tr-code-copy" data-copy-hash="${hash}" data-mermaid-src="${escapeHtml(source)}">${t("copy")}</button>`;
	if (mode === "ascii") {
		return `<div class="tr-mermaid-bar">${copy}</div>`;
	}
	const zoomIn = `<button type="button" class="tr-mermaid-zoom tr-code-copy" data-mermaid-zoom="in" title="${t("zoom in")}">+</button>`;
	const zoomOut = `<button type="button" class="tr-mermaid-zoom tr-code-copy" data-mermaid-zoom="out" title="${t("zoom out")}">−</button>`;
	const fs = `<button type="button" class="tr-mermaid-fs tr-code-copy" data-mermaid-fullscreen title="${t("fullscreen")}">${FS_ICON}</button>`;
	const dl = `<button type="button" class="tr-mermaid-dl tr-code-copy" data-mermaid-download>${t("download")}</button>`;
	return `<div class="tr-mermaid-bar">${copy}${zoomIn}${zoomOut}${fs}${dl}</div>`;
};

/**
 * Render a fenced mermaid block to embeddable HTML — SVG via
 * beautiful-mermaid's sync renderer, or the ASCII fallback. When the sync
 * renderer fails or the diagram type is outside its coverage (gantt, pie,
 * timeline, quadrant…), the SVG path emits a placeholder that the Markdown
 * component fills asynchronously with the official mermaid renderer
 * (P1 fallback, debounced — see MERMAID_FALLBACK_DEBOUNCE_MS).
 */
export function renderMermaidHtml(source: string, mode: MermaidMode): string {
	const bar = mermaidToolbar(source, mode);
	if (mode === "ascii") {
		// colorMode none → plain text (the html/ansi modes embed markup
		// that would need unescaped injection; we stay text-safe).
		try {
			const ascii = renderMermaidASCII(source, { colorMode: "none" });
			return `<div class="tr-mermaid-block">${bar}<pre class="tr-mermaid-ascii">${escapeHtml(ascii)}</pre></div>`;
		} catch {
			// ASCII has no official fallback — degrade to a plain code block.
			return `<pre class="tr-mermaid-fallback"><code class="language-mermaid">${escapeHtml(source)}</code></pre>`;
		}
	}
	try {
		const svg = renderMermaidSVG(source, MERMAID_COLORS);
		if (isUsableSvg(svg)) {
			return `<div class="tr-mermaid-block">${bar}<div class="tr-mermaid">${svg}</div></div>`;
		}
	} catch {
		// fall through to the async placeholder
	}
	// A source that names no mermaid diagram type is not a diagram — render
	// it as a plain code block instead of an async placeholder that would
	// just fail downstream. (Known types like gantt/pie/timeline still take
	// the official-mermaid fallback path.)
	const KNOWN_TYPES =
		/\b(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|timeline|quadrant|journey|requirementDiagram|gitGraph|mindmap|block-beta|sankey-beta)\b/i;
	if (!KNOWN_TYPES.test(source)) {
		return `<pre class="tr-mermaid-fallback"><code class="language-mermaid">${escapeHtml(source)}</code></pre>`;
	}
	// Outside beautiful-mermaid coverage or unparseable → async official
	// mermaid fallback placeholder (filled by Markdown's effect).
	const hash = fnv1a(source).toString(36);
	return `<div class="tr-mermaid-block">${bar}<div class="tr-mermaid-async" data-mermaid-hash="${hash}" data-mermaid-code="${escapeHtml(source)}"><div class="tr-mermaid-loading">${t("rendering diagram")}…</div></div></div>`;
}

let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
let mermaidRenderSeq = 0;

function loadOfficialMermaid(): Promise<typeof import("mermaid")> {
	// Lazy + singleton: the official renderer is heavy (code-split out of
	// the hot markdown path); only loaded when a fallback is actually needed.
	mermaidPromise ??= import("mermaid");
	return mermaidPromise;
}

function currentScheme(): "dark" | "light" {
	if (typeof document === "undefined") return "dark";
	const root = document.documentElement;
	return (root.dataset.colorScheme ?? root.dataset.theme) === "light" ? "light" : "dark";
}

/**
 * Official-mermaid fallback (P1): covers diagram types beautiful-mermaid
 * doesn't support (gantt/pie/timeline/quadrant/…). strict security, error
 * rendering suppressed so a failed parse can't inject a stray error bar
 * into the document.
 */
export async function renderMermaidAsyncHtml(source: string): Promise<string> {
	const { default: mermaid } = await loadOfficialMermaid();
	const dark = currentScheme() === "dark";
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: "strict",
		suppressErrorRendering: true,
		theme: dark ? "dark" : "default",
		themeVariables: dark
			? {
					background: "#17181c",
					mainBkg: "#1e1f24",
					primaryColor: "#1e1f24",
					primaryTextColor: "#e8e8ea",
					primaryBorderColor: "#3a3b42",
					lineColor: "#8b8d98",
					textColor: "#e8e8ea",
				}
			: {
					background: "#ffffff",
					mainBkg: "#f8f8f6",
					primaryColor: "#f8f8f6",
					primaryTextColor: "#1f2328",
					primaryBorderColor: "#d9d9d4",
					lineColor: "#6b7280",
					textColor: "#1f2328",
				},
	});
	const id = `omp-mermaid-${Date.now()}-${mermaidRenderSeq++}`;
	const { svg } = await mermaid.render(id, source);
	if (!isUsableSvg(svg)) throw new Error("mermaid rendered an invalid SVG");
	const hash = fnv1a(source).toString(36);
	return `<div class="tr-mermaid-block">${mermaidToolbar(source, "svg")}<div class="tr-mermaid">${svg}</div></div>`;
}

/** Wrap a failed fallback render as a plain code block. */
export function mermaidFallbackHtml(source: string): string {
	return `<pre class="tr-mermaid-fallback"><code class="language-mermaid">${escapeHtml(source)}</code></pre>`;
}

/** Official-mermaid fallback render cache (hash → block HTML), bounded. */
const mermaidAsyncHtml = new Map<string, string>();
const MERMAID_ASYNC_CACHE_MAX = 100;

function mermaidCacheSet(hash: string, html: string): void {
	if (mermaidAsyncHtml.has(hash)) mermaidAsyncHtml.delete(hash);
	mermaidAsyncHtml.set(hash, html);
	while (mermaidAsyncHtml.size > MERMAID_ASYNC_CACHE_MAX) {
		const oldest = mermaidAsyncHtml.keys().next().value;
		if (oldest !== undefined) mermaidAsyncHtml.delete(oldest);
	}
}

/** Fill one .tr-mermaid-async placeholder (debounced, stale-safe). */
function fillMermaidPlaceholder(el: HTMLElement): void {
	const hash = el.dataset.mermaidHash ?? "";
	const code = el.dataset.mermaidCode ?? "";
	if (!code || el.dataset.mermaidPending) return;
	const cached = mermaidAsyncHtml.get(hash);
	if (cached !== undefined) {
		el.outerHTML = cached;
		return;
	}
	el.dataset.mermaidPending = "1";
	window.setTimeout(() => {
		// Streaming replaced the block (new hash) or it left the DOM —
		// the next sync render emitted a fresh placeholder for the new
		// content, so this render is stale and skipped.
		if (!el.isConnected || el.dataset.mermaidHash !== hash) return;
		void renderMermaidAsyncHtml(code)
			.then(html => {
				mermaidCacheSet(hash, html);
				if (el.isConnected && el.dataset.mermaidHash === hash) el.outerHTML = html;
			})
			.catch(() => {
				if (el.isConnected && el.dataset.mermaidHash === hash) {
					el.outerHTML = mermaidFallbackHtml(code);
				}
			});
	}, MERMAID_FALLBACK_DEBOUNCE_MS);
}

let mermaidObserver: MutationObserver | null = null;

/**
 * Idempotent global watcher for .tr-mermaid-async placeholders (P1): the
 * Markdown component calls this on mount; the observer reacts to NEW
 * placeholders wherever they appear (component timing independent), and an
 * initial sweep catches ones already in the DOM.
 */
export function ensureMermaidFallbackObserver(): void {
	if (mermaidObserver !== null || typeof document === "undefined" || !document.body) return;
	const observer = new MutationObserver(records => {
		for (const rec of records) {
			for (const node of rec.addedNodes) {
				if (!(node instanceof HTMLElement)) continue;
				if (node.matches?.(".tr-mermaid-async")) {
					fillMermaidPlaceholder(node);
				} else {
					node.querySelectorAll?.(".tr-mermaid-async").forEach(el => fillMermaidPlaceholder(el as HTMLElement));
				}
			}
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });
	mermaidObserver = observer;
	// Initial sweep: placeholders rendered before the observer attached.
	document.querySelectorAll(".tr-mermaid-async").forEach(el => fillMermaidPlaceholder(el as HTMLElement));
}
