/**
 * TUI-parity session accent color (port of packages/coding-agent/src/utils/
 * session-color.ts): a STABLE hue derived from the session id via djb2,
 * picked from a theme-appropriate band (warm red→green on dark themes,
 * cool cyan→purple on light), rendered as a hex. The TUI colors its
 * status line segments with this per-session accent — the GUI status line
 * uses it for the braille spinner / orb.
 */

/** djb2 hash → 0-359 hue. */
function nameToHue(name: string): number {
	let hash = 5381;
	for (let i = 0; i < name.length; i++) {
		hash = ((hash << 5) + hash) ^ name.charCodeAt(i);
		hash = hash >>> 0; // keep 32-bit unsigned
	}
	return hash % 360;
}

/** HSL → #rrggbb. */
function hslToHex(h: number, s: number, l: number): string {
	h = ((h % 360) + 360) % 360;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0;
	let g = 0;
	let b = 0;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	const to = (v: number): string =>
		Math.round((v + m) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${to(r)}${to(g)}${to(b)}`;
}

/** Warm band on dark themes, cool band on light (same ranges as the TUI). */
const DARK_HUE_START = 0;
const DARK_HUE_END = 120;
const LIGHT_HUE_START = 180;
const LIGHT_HUE_END = 300;

/** Derive the per-session accent hex from a stable session key. */
export function sessionAccentHex(key: string): string {
	const dark = document.documentElement.getAttribute("data-theme") !== "light";
	const hueStart = dark ? DARK_HUE_START : LIGHT_HUE_START;
	const range = (dark ? DARK_HUE_END : LIGHT_HUE_END) - hueStart;
	const hue = hueStart + (nameToHue(key) % range);
	// Vivid on dark; lower lightness on light so the accent stays legible.
	return hslToHex(hue, 0.8, dark ? 0.68 : 0.5);
}
