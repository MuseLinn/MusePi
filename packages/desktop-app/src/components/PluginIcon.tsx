/**
 * PluginIcon — one mark per plugin, used by the plugin list rows, cards and
 * the package detail dialog.
 *
 * A package may declare `icon` in its manifest (emoji, text glyph, or an
 * http(s)/file URI); that wins so a plugin can brand itself like the
 * reference plugin panel's colored logos. Built-in units instead get a
 * glyph from their kind (desktop shell, theme, card renderer, …), so the
 * official section reads as distinct marks rather than one shared plug.
 * Otherwise a deterministic mark is derived from the name — hue from a
 * string hash, leading letters in a rounded tile.
 *
 * The status dot rides as a corner badge ON the mark instead of sitting
 * beside it: as a sibling it overlapped wide emoji icons (the glyph and the
 * dot fought for the same 30px row).
 */
import type { ReactNode } from "react";

/** Glyphs for the host's built-in plugin units, keyed by extension kind —
 *  the kinds the built-in registry actually declares (theme-pack,
 *  tool-render-pack, desktop-shell, voice, magic-keyword, …), so the
 *  official section reads as distinct marks instead of one shared plug. */
const GLYPH_BY_KIND: Record<string, string> = {
	"theme-pack": "🎨",
	theme: "🎨",
	"tool-render-pack": "🖼",
	"tool-render": "🖼",
	"desktop-shell": "🖥",
	shell: "🖥",
	terminal: "🐚",
	voice: "🎙",
	"voice:stt": "🎙",
	"voice:tts": "🔊",
	browser: "🌐",
	file: "📁",
	computer: "💻",
	lsp: "🧭",
	"magic-keyword": "✨",
	"magic-keywords": "✨",
	style: "🎴",
	skill: "🎯",
	"bundled-skill": "🎯",
	notification: "🔔",
	status: "📡",
	"status-bar": "📡",
	mode: "🎛",
	preset: "🎛",
	integration: "🔌",
	connector: "🔌",
	mcp: "🔌",
	provider: "🧠",
	tool: "🛠",
	command: "⌨️",
	agent: "🤖",
};

function hueOf(name: string): number {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = (hash * 31 + name.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % 360;
}

/** Leading letters for the derived glyph: first char of up to two words, or
 *  the first two chars of one word ("musepi-auth-hub" → "ma"). */
function glyphOf(name: string): string {
	const parts = name
		.replace(/^[@a-z-]+[/-]/, "")
		.split(/[-_.]/)
		.filter(Boolean);
	if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toLowerCase();
	const word = parts[0] ?? name;
	return word.slice(0, 2).toLowerCase();
}

/** URI icons render as an image; everything else as a text glyph. */
function isUri(icon: string): boolean {
	return icon.startsWith("http://") || icon.startsWith("https://") || icon.startsWith("file://");
}

export function PluginIcon({
	name,
	icon,
	size = 30,
	status,
}: {
	name: string;
	/** Manifest-declared icon (packages) or a kind glyph (built-in units). */
	icon?: string | null;
	size?: number;
	/** "active" | "off" | "error" | "shadowed" — drawn as a corner badge. */
	status?: "active" | "off" | "error" | "shadowed";
}): ReactNode {
	const badge = status && status !== "active" ? status : null;
	const mark = (() => {
		if (icon && isUri(icon)) {
			return (
				<img
					alt=""
					src={icon}
					style={{
						width: "100%",
						height: "100%",
						borderRadius: "inherit",
						objectFit: "cover",
						display: "block",
					}}
				/>
			);
		}
		const glyph = icon?.trim() || glyphOf(name);
		const derived = !icon;
		const hue = hueOf(name);
		return (
			<span
				style={{
					display: "flex",
					width: "100%",
					height: "100%",
					alignItems: "center",
					justifyContent: "center",
					borderRadius: "inherit",
					background: derived ? `oklch(0.72 0.13 ${hue} / 0.22)` : "transparent",
					color: derived ? `oklch(0.68 0.16 ${hue})` : "var(--color-text)",
					fontSize: Math.round(size * (derived ? 0.42 : 0.62)),
					fontWeight: derived ? 700 : 400,
					lineHeight: 1,
					letterSpacing: "0.02em",
					userSelect: "none",
					overflow: "hidden",
				}}
			>
				{glyph}
			</span>
		);
	})();

	return (
		<span
			aria-hidden={badge ? undefined : "true"}
			style={{
				position: "relative",
				flex: "none",
				display: "inline-flex",
				width: size,
				height: size,
				borderRadius: Math.round(size * 0.28),
			}}
		>
			{mark}
			{badge && (
				<span
					className={`gui-plugin-icon-badge gui-plugin-icon-badge--${badge}`}
					style={{
						position: "absolute",
						right: -1,
						bottom: -1,
						width: Math.max(7, Math.round(size * 0.3)),
						height: Math.max(7, Math.round(size * 0.3)),
						borderRadius: "50%",
					}}
				/>
			)}
		</span>
	);
}

/** The glyph a built-in unit shows: its kind's mark, else name-derived. */
export function kindGlyph(kind: string): string | null {
	return GLYPH_BY_KIND[kind] ?? null;
}
