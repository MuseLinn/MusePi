/**
 * PluginPackageIcon — one mark per installed plugin package.
 *
 * A package may declare `icon` in its manifest (emoji, text glyph, or an
 * http(s)/file URI); that wins so a plugin can brand itself like the
 * reference plugin panel's colored logos. Otherwise a deterministic mark is
 * derived from the package name — hue from a string hash, leading letters in
 * a rounded tile — same package, same mark, across renders and restarts.
 */
import type { ReactNode } from "react";

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

export function PluginPackageIcon({
	name,
	icon,
	size = 30,
}: {
	name: string;
	icon?: string | null;
	size?: number;
}): ReactNode {
	if (icon && isUri(icon)) {
		return (
			<img
				alt=""
				src={icon}
				style={{
					flex: "none",
					width: size,
					height: size,
					borderRadius: Math.round(size * 0.28),
					objectFit: "cover",
				}}
			/>
		);
	}
	const glyph = icon?.trim() || glyphOf(name);
	const derived = !icon;
	const hue = hueOf(name);
	return (
		<span
			aria-hidden="true"
			style={{
				display: "inline-flex",
				flex: "none",
				alignItems: "center",
				justifyContent: "center",
				width: size,
				height: size,
				borderRadius: Math.round(size * 0.28),
				background: derived ? `oklch(0.72 0.13 ${hue} / 0.22)` : "transparent",
				color: derived ? `oklch(0.68 0.16 ${hue})` : "var(--color-text)",
				fontSize: Math.round(size * (derived ? 0.42 : 0.6)),
				fontWeight: derived ? 700 : 400,
				letterSpacing: "0.02em",
				userSelect: "none",
				overflow: "hidden",
			}}
		>
			{glyph}
		</span>
	);
}
