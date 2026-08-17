import { type DiagramColors, renderMermaidASCII, renderMermaidSVG } from "beautiful-mermaid";
import { t } from "../../i18n/index.js";
import { escapeHtml } from "./highlight";

export type MermaidMode = "svg" | "ascii";

/** Chat-settings pref (Settings → 聊天 → Mermaid 渲染), default SVG. */
export function mermaidMode(): MermaidMode {
	try {
		return localStorage.getItem("omp-gui-chat-mermaid") === "ascii" ? "ascii" : "svg";
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

/**
 * Hover toolbar (openchamber parity): copy the mermaid SOURCE (svg mode
 * additionally offers download of the rendered SVG). The copy button
 * shares the code-block hash scheme so its label flips to "copied"; the
 * source rides in data-mermaid-src (escaped) and the SVG is serialized
 * from the DOM at download time. Delegated in the Markdown component.
 */
const mermaidToolbar = (source: string, mode: MermaidMode): string => {
	const hash = fnv1a(source).toString(36);
	const copy = `<button type="button" class="tr-mermaid-copy tr-code-copy" data-copy-hash="${hash}" data-mermaid-src="${escapeHtml(source)}">${t("copy")}</button>`;
	const dl =
		mode === "svg"
			? `<button type="button" class="tr-mermaid-dl tr-code-copy" data-mermaid-download>${t("download")}</button>`
			: "";
	return `<div class="tr-mermaid-bar">${copy}${dl}</div>`;
};

/**
 * Render a fenced mermaid block to embeddable HTML — SVG via
 * beautiful-mermaid's sync renderer, or the ASCII fallback. Invalid
 * sources degrade to a plain code block instead of crashing the markdown.
 */
export function renderMermaidHtml(source: string, mode: MermaidMode): string {
	try {
		const bar = mermaidToolbar(source, mode);
		if (mode === "ascii") {
			// colorMode none → plain text (the html/ansi modes embed markup
			// that would need unescaped injection; we stay text-safe).
			const ascii = renderMermaidASCII(source, { colorMode: "none" });
			return `<div class="tr-mermaid-block">${bar}<pre class="tr-mermaid-ascii">${escapeHtml(ascii)}</pre></div>`;
		}
		return `<div class="tr-mermaid-block">${bar}<div class="tr-mermaid">${renderMermaidSVG(source, MERMAID_COLORS)}</div></div>`;
	} catch {
		return `<pre class="tr-mermaid-fallback"><code class="language-mermaid">${escapeHtml(source)}</code></pre>`;
	}
}
