import type { DiagramColors } from "beautiful-mermaid";
import { escapeHtml } from "./highlight";

/**
 * beautiful-mermaid is loaded lazily: it statically imports `elkjs` (1.4 MB of
 * the entry bundle) for graph layout, which every first paint would otherwise
 * pay for even when a session contains no diagram at all.
 *
 * The synchronous helpers below keep their signatures — markdown rendering
 * wants a diagram inline, not a placeholder — but a call made before the
 * module resolves returns "not usable" so the caller falls back to the async
 * path it already has (`renderMermaidAsyncHtml`). Loading starts on the first
 * diagram encountered, so a transcript without diagrams never pays for it.
 */
type MermaidLib = typeof import("beautiful-mermaid");
let beautifulPromise: Promise<MermaidLib> | null = null;
let beautifulLib: MermaidLib | null = null;

/** Await the lazy renderer. Callers that must draw in the same tick (and the
 *  tests that pin the sync contract) wait here first; the transcript's own
 *  path does not — it takes the async render already available to it. */
export function preloadDiagramRenderer(): Promise<MermaidLib> {
	return loadBeautifulMermaid();
}

function loadBeautifulMermaid(): Promise<MermaidLib> {
	if (beautifulLib) return Promise.resolve(beautifulLib);
	beautifulPromise ??= import("beautiful-mermaid").then(lib => {
		beautifulLib = lib;
		return lib;
	});
	return beautifulPromise;
}

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

/** Fenced diagram sources by hash (the pipeline's lookup for the block). */
const diagramBlocks = new Map<string, { source: string; mode: MermaidMode }>();

export function diagramBlockSource(hash: string): { source: string; mode: MermaidMode } | undefined {
	return diagramBlocks.get(hash);
}

/** Store a fenced diagram and return its placeholder marker. The block renders
 *  the SVG and its toolbar, so the marker is all that travels in the string. */
export function emitDiagramBlock(source: string, mode: MermaidMode): string {
	const hash = fnv1a(source).toString(36);
	diagramBlocks.set(hash, { source, mode });
	while (diagramBlocks.size > 100) {
		const oldest = diagramBlocks.keys().next().value;
		if (oldest === undefined) break;
		diagramBlocks.delete(oldest);
	}
	return `<div data-diagram-block="${hash}"></div>`;
}

/** Whether beautiful-mermaid can draw this source synchronously, and its SVG.
 *  Returns `usable: false` until the lazily imported renderer has loaded, which
 *  makes the caller take its async path instead of waiting. */
export function renderDiagramSync(source: string): { svg: string | null; usable: boolean } {
	void loadBeautifulMermaid();
	if (!beautifulLib) return { svg: null, usable: false };
	try {
		const svg = beautifulLib.renderMermaidSVG(source, MERMAID_COLORS);
		return { svg, usable: isUsableSvg(svg) };
	} catch {
		return { svg: null, usable: false };
	}
}

/** ASCII mode: the text rendering wrapped in a `<pre>`, or null when it fails. */
export function renderDiagramAscii(source: string): string | null {
	void loadBeautifulMermaid();
	if (!beautifulLib) return null;
	try {
		return `<pre class="tr-mermaid-ascii">${escapeHtml(beautifulLib.renderMermaidASCII(source, { colorMode: "none" }))}</pre>`;
	} catch {
		return null;
	}
}

/** Whether a fence names a diagram type at all. A fence of prose in a
 *  `mermaid` block is a plain code block, not a diagram that failed to draw. */
export function namesDiagramType(source: string): boolean {
	return /\b(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|timeline|quadrant|journey|requirementDiagram|gitGraph|mindmap|block-beta|sankey-beta)\b/i.test(
		source,
	);
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
	// The SVG alone: the block owns the wrapper and its toolbar.
	return svg;
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

/** Async diagram renderer, named for the preview and block callers. */
export { renderMermaidAsyncHtml as renderDiagramAsync };
