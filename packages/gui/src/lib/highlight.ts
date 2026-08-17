import { type CodeHighlightFn, useThemePreference } from "@musepi/desktop-web";
import { useCallback } from "react";

/**
 * Desktop code highlighting: routes through the Electron preload bridge to
 * the main process, which runs the same Rust tree-sitter `highlightCode` the
 * TUI uses. The renderer is sandboxed and cannot load native modules, so the
 * ANSI-colored output comes back over IPC and is converted to DOM spans by
 * desktop-web's `highlightToCodeHtml`.
 */

/** Preload bridge surface used by the renderer (`window.electronAPI`). */
export interface ElectronApi {
	highlightCode?: (code: string, lang: string | null, colors: Record<string, string>) => Promise<string | null>;
	/** Window glass toggle: true = native under-window vibrancy, false = opaque. */
	setWindowGlass?: (enabled: boolean) => Promise<unknown>;
}

/**
 * Token palettes (hex), one per color scheme. GitHub-flavored hues tuned for
 * the code-block backgrounds; the scheme split keeps dark-palette pastels
 * out of light blocks and vice versa.
 */
export const CODE_TOKEN_PALETTES = {
	light: {
		comment: "#6e7781",
		keyword: "#cf222e",
		function: "#8250df",
		variable: "#953800",
		string: "#0a3069",
		number: "#0550ae",
		type: "#116329",
		operator: "#cf222e",
		punctuation: "#57606a",
	},
	dark: {
		comment: "#8b949e",
		keyword: "#ff7b72",
		function: "#d2a8ff",
		variable: "#79c0ff",
		string: "#a5d6ff",
		number: "#79c0ff",
		type: "#ffa657",
		operator: "#ff7b72",
		punctuation: "#c9d1d9",
	},
} as const;

const ansi = (hex: string): string => {
	const n = Number.parseInt(hex.slice(1), 16);
	return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};

/**
 * Highlight via the Electron bridge; null when running in a plain browser
 * (no preload API) or the addon is unavailable — callers fall back to plain.
 */
export async function nativeHighlight(
	code: string,
	lang: string | undefined,
	scheme: "light" | "dark",
): Promise<string | null> {
	const api = (window as unknown as { electronAPI?: ElectronApi }).electronAPI;
	if (!api?.highlightCode) return null;
	const palette = CODE_TOKEN_PALETTES[scheme];
	const colors: Record<string, string> = {};
	for (const [role, hex] of Object.entries(palette)) colors[role] = ansi(hex);
	try {
		const out = await api.highlightCode(code, lang ?? null, colors);
		return typeof out === "string" && out.length > 0 ? out : null;
	} catch {
		return null;
	}
}

/**
 * Chat-block highlighter bound to the resolved color scheme; stable per
 * scheme so Markdown's effect only re-runs on scheme flips.
 */
export function useChatHighlight(): CodeHighlightFn {
	const { resolved } = useThemePreference();
	return useCallback((code, lang) => nativeHighlight(code, lang, resolved), [resolved]);
}
