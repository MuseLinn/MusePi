/**
 * PluginPackageIcon — a deterministic colored glyph for an installed plugin
 * package. DSH's plugin list shows a per-plugin colored logo; these are
 * internal tool packages (no Lobe brand icon covers them), so the mark is
 * derived from the name: hue from a string hash, glyph = the leading
 * letter(s) rendered in a rounded tile. Deterministic across renders and
 * restarts — same package, same mark.
 */
import type { ReactNode } from "react";

function hueOf(name: string): number {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = (hash * 31 + name.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % 360;
}

/** Leading letters for the glyph: first char of up to two words, or the
 *  first two chars of one word ("musepi-auth-hub" → "ma"). */
function glyphOf(name: string): string {
	const parts = name
		.replace(/^[@a-z-]+[/-]/, "")
		.split(/[-_.]/)
		.filter(Boolean);
	if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toLowerCase();
	const word = parts[0] ?? name;
	return word.slice(0, 2).toLowerCase();
}

export function PluginPackageIcon({ name, size = 30 }: { name: string; size?: number }): ReactNode {
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
				background: `oklch(0.72 0.13 ${hue} / 0.22)`,
				color: `oklch(0.68 0.16 ${hue})`,
				fontSize: Math.round(size * 0.42),
				fontWeight: 700,
				letterSpacing: "0.02em",
				userSelect: "none",
			}}
		>
			{glyphOf(name)}
		</span>
	);
}
