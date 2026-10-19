/**
 * Color manipulation utilities for hex colors.
 *
 * @example
 * ```ts
 * import { hexToHsv, hsvToHex } from "@musepi/pi-utils";
 *
 * // Rotate the hue by 90°
 * const hsv = hexToHsv("#4ade80");
 * hsv.h = (hsv.h + 90) % 360;
 * const newHex = hsvToHex(hsv);
 * ```
 */

export interface HSV {
	/** Hue in degrees (0-360) */
	h: number;
	/** Saturation (0-1) */
	s: number;
	/** Value/brightness (0-1) */
	v: number;
}

export interface RGB {
	/** Red (0-255) */
	r: number;
	/** Green (0-255) */
	g: number;
	/** Blue (0-255) */
	b: number;
}

/**
 * Parse a hex color string to RGB.
 * Supports #RGB, #RRGGBB formats.
 */
export function hexToRgb(hex: string): RGB {
	const h = hex.startsWith("#") ? hex.slice(1) : hex;
	if (h.length === 3) {
		return {
			r: parseInt(h[0] + h[0], 16),
			g: parseInt(h[1] + h[1], 16),
			b: parseInt(h[2] + h[2], 16),
		};
	}
	return {
		r: parseInt(h.slice(0, 2), 16),
		g: parseInt(h.slice(2, 4), 16),
		b: parseInt(h.slice(4, 6), 16),
	};
}

/**
 * Convert RGB to hex color string.
 */
export function rgbToHex(rgb: RGB): string {
	const toHex = (n: number) =>
		Math.max(0, Math.min(255, Math.round(n)))
			.toString(16)
			.padStart(2, "0");
	return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

/**
 * Convert RGB to HSV.
 */
export function rgbToHsv(rgb: RGB): HSV {
	const r = rgb.r / 255;
	const g = rgb.g / 255;
	const b = rgb.b / 255;

	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;

	let h = 0;
	if (d !== 0) {
		if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
		else if (max === g) h = ((b - r) / d + 2) / 6;
		else h = ((r - g) / d + 4) / 6;
	}

	return {
		h: h * 360,
		s: max === 0 ? 0 : d / max,
		v: max,
	};
}

/**
 * Convert HSV to RGB.
 */
export function hsvToRgb(hsv: HSV): RGB {
	const { s, v } = hsv;
	const h = ((hsv.h % 360) + 360) % 360; // Normalize to 0-360

	const i = Math.floor(h / 60);
	const f = h / 60 - i;
	const p = v * (1 - s);
	const q = v * (1 - f * s);
	const t = v * (1 - (1 - f) * s);

	let r: number, g: number, b: number;
	switch (i % 6) {
		case 0:
			r = v;
			g = t;
			b = p;
			break;
		case 1:
			r = q;
			g = v;
			b = p;
			break;
		case 2:
			r = p;
			g = v;
			b = t;
			break;
		case 3:
			r = p;
			g = q;
			b = v;
			break;
		case 4:
			r = t;
			g = p;
			b = v;
			break;
		default:
			r = v;
			g = p;
			b = q;
			break;
	}

	return {
		r: Math.round(r * 255),
		g: Math.round(g * 255),
		b: Math.round(b * 255),
	};
}

/**
 * Convert hex color to HSV.
 */
export function hexToHsv(hex: string): HSV {
	return rgbToHsv(hexToRgb(hex));
}

/**
 * Convert HSV to hex color.
 */
export function hsvToHex(hsv: HSV): string {
	return rgbToHex(hsvToRgb(hsv));
}

/**
 * Shift the hue of a hex color by a given number of degrees.
 */
export function shiftHue(hex: string, degrees: number): string {
	const hsv = hexToHsv(hex);
	hsv.h = (hsv.h + degrees) % 360;
	if (hsv.h < 0) hsv.h += 360;
	return hsvToHex(hsv);
}
export interface HSVAdjustment {
	/** Hue shift in degrees (additive) */
	h?: number;
	/** Saturation multiplier */
	s?: number;
	/** Value/brightness multiplier */
	v?: number;
}

/**
 * Adjust HSV components of a hex color.
 *
 * @param hex - Hex color string (#RGB or #RRGGBB)
 * @param adj - Adjustments: h is additive degrees, s and v are multipliers
 * @returns New hex color string
 *
 * @example
 * ```ts
 * // Shift hue +60°, reduce saturation to 71%
 * adjustHsv("#00ff88", { h: 60, s: 0.71 }) // "#4a9eff"
 * ```
 */
export function adjustHsv(hex: string, adj: HSVAdjustment): string {
	const hsv = hexToHsv(hex);
	if (adj.h !== undefined) {
		hsv.h = (hsv.h + adj.h) % 360;
		if (hsv.h < 0) hsv.h += 360;
	}
	if (adj.s !== undefined) {
		hsv.s = Math.max(0, Math.min(1, hsv.s * adj.s));
	}
	if (adj.v !== undefined) {
		hsv.v = Math.max(0, Math.min(1, hsv.v * adj.v));
	}
	return hsvToHex(hsv);
}

/**
 * Convert HSL (h: 0-360, s: 0-1, l: 0-1) to a CSS hex string.
 */
export function hslToHex(h: number, s: number, l: number): string {
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
		return Math.round(255 * color)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${f(0)}${f(8)}${f(4)}`;
}

// Conventional xterm RGB for the 16 base ANSI colors. Terminals may remap these,
// so they're a best-effort approximation for light/dark classification.
const ANSI_16: readonly (readonly [number, number, number])[] = [
	[0, 0, 0],
	[128, 0, 0],
	[0, 128, 0],
	[128, 128, 0],
	[0, 0, 128],
	[128, 0, 128],
	[0, 128, 128],
	[192, 192, 192],
	[128, 128, 128],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[0, 0, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];
const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;

/** Parse a 256-color palette index (0–255) to RGB (0..255). */
function paletteToRgb(index: number): RGB | undefined {
	if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
	if (index < 16) {
		const rgb = ANSI_16[index];
		return rgb ? { r: rgb[0], g: rgb[1], b: rgb[2] } : undefined;
	}
	if (index < 232) {
		const n = index - 16;
		return {
			r: CUBE_STEPS[Math.floor(n / 36) % 6] ?? 0,
			g: CUBE_STEPS[Math.floor(n / 6) % 6] ?? 0,
			b: CUBE_STEPS[n % 6] ?? 0,
		};
	}
	const gray = 8 + (index - 232) * 10;
	return { r: gray, g: gray, b: gray };
}

/** Parse a theme color value — `#rgb`/`#rrggbb` hex or 256-color palette index — to RGB (0..255). */
function toRgb(value: string | number): RGB | undefined {
	if (typeof value === "number") return paletteToRgb(value);
	if (typeof value !== "string" || value[0] !== "#") return undefined;
	if (value.length !== 4 && value.length !== 7) return undefined;
	const rgb = hexToRgb(value);
	if (Number.isNaN(rgb.r) || Number.isNaN(rgb.g) || Number.isNaN(rgb.b)) return undefined;
	return rgb;
}

/** Gamma-decode a single 0..255 sRGB channel to linear 0..1. */
function linearizeChannel(channel: number): number {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Perceptual luma (gamma-encoded BT.709 weights over raw sRGB), normalized to 0..1.
 *
 * Accepts a hex string (`#rgb` / `#rrggbb`) or a 256-color palette index; returns
 * `undefined` for var refs, empty strings, or anything unparseable.
 *
 * Cheap and good enough for a light/dark *classification* threshold. NOT suitable
 * for contrast ratios — use {@link relativeLuminance} for those.
 */
export function colorLuma(value: string | number): number | undefined {
	const rgb = toRgb(value);
	if (!rgb) return undefined;
	return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

/**
 * WCAG 2.x relative luminance (BT.709 weights over linearized sRGB), normalized to
 * 0..1. This is the value the WCAG contrast-ratio formula expects.
 *
 * Accepts a hex string (`#rgb` / `#rrggbb`) or a 256-color palette index; returns
 * `undefined` for var refs, empty strings, or anything unparseable.
 */
export function relativeLuminance(value: string | number): number | undefined {
	const rgb = toRgb(value);
	if (!rgb) return undefined;
	return 0.2126 * linearizeChannel(rgb.r) + 0.7152 * linearizeChannel(rgb.g) + 0.0722 * linearizeChannel(rgb.b);
}

/** RGBA in 0..255 / 0..1. */
export interface ColorRGBA {
	r: number;
	g: number;
	b: number;
	a: number;
}

/**
 * Parse a CSS color for measurement, including the forms {@link toRgb} skips.
 *
 * `toRgb` covers the theme palette's own values (hex, palette index); this adds
 * `rgb()`/`rgba()` and 8-digit hex, because a measured color arrives from
 * `getComputedStyle` — which resolves a token to whatever the theme actually
 * declared, not necessarily hex. Values that still cannot be parsed (var refs,
 * `color-mix()`, named colors, `oklch()`) return undefined; callers decide
 * whether to keep the original.
 */
export function parseCssColor(value: string): ColorRGBA | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(text);
	if (hex) {
		const full = hex[1]!.length <= 4 ? [...hex[1]!].map(c => c + c).join("") : hex[1]!;
		const rgb = hexToRgb(`#${full.slice(0, 6)}`);
		if (Number.isNaN(rgb.r) || Number.isNaN(rgb.g) || Number.isNaN(rgb.b)) return undefined;
		const a = full.length === 8 ? Number.parseInt(full.slice(6), 16) / 255 : 1;
		return { r: rgb.r, g: rgb.g, b: rgb.b, a };
	}
	const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)$/i.exec(text);
	if (!rgb) return undefined;
	const channel = (raw: string): number => Math.max(0, Math.min(255, Number(raw)));
	const alpha = rgb[4];
	return {
		r: channel(rgb[1]!),
		g: channel(rgb[2]!),
		b: channel(rgb[3]!),
		a:
			alpha === undefined
				? 1
				: alpha.endsWith("%")
					? Number(alpha.slice(0, -1)) / 100
					: Math.max(0, Math.min(1, Number(alpha))),
	};
}

/** Composite a possibly-translucent color over an opaque backdrop. */
export function compositeOver(front: ColorRGBA, back: ColorRGBA): ColorRGBA {
	return {
		r: front.r * front.a + back.r * (1 - front.a),
		g: front.g * front.a + back.g * (1 - front.a),
		b: front.b * front.a + back.b * (1 - front.a),
		a: 1,
	};
}

/** WCAG 2.x contrast ratio between two colors, or undefined if unparseable. */
export function contrastRatio(foreground: string, background: string, canvas?: string): number | undefined {
	const fg = parseCssColor(foreground);
	const under = parseCssColor(background);
	if (!fg || !under) return undefined;
	// A translucent background must be composited first: measuring its own
	// channels would score a tinted surface as if it were solid.
	const back = canvas ? parseCssColor(canvas) : undefined;
	const surface = back ? compositeOver(under, back) : under;
	return ratioOf(compositeOver(fg, surface), surface);
}

function ratioOf(foreground: ColorRGBA, background: ColorRGBA): number {
	const lum = (c: ColorRGBA): number =>
		0.2126 * linearizeChannel(c.r) + 0.7152 * linearizeChannel(c.g) + 0.0722 * linearizeChannel(c.b);
	const x = lum(foreground);
	const y = lum(background);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Nudge a color until it is readable on `background`, keeping as much of the
 * author's own hue as possible.
 *
 * A theme can ship a semantic color that reads fine on the app surface but
 * disappears on a tinted one (a blue accent on a blue card). Binary-searching
 * the blend toward whichever of black/white contrasts more preserves the hue —
 * the result is still recognizably the author's color, just legible.
 *
 * Returns the input unchanged when it is already readable, or when either color
 * cannot be parsed: a token the host cannot measure is a token it must not
 * silently rewrite.
 */
export function ensureReadableColor(foreground: string, background: string, minimum = 4.5, canvas?: string): string {
	const fg = parseCssColor(foreground);
	const under = parseCssColor(background);
	if (!fg || !under) return foreground;
	const back = canvas ? parseCssColor(canvas) : undefined;
	const surface = back ? compositeOver(under, back) : under;
	if (ratioOf(compositeOver(fg, surface), surface) >= minimum) return foreground;

	const black: ColorRGBA = { r: 0, g: 0, b: 0, a: 1 };
	const white: ColorRGBA = { r: 255, g: 255, b: 255, a: 1 };
	const target = ratioOf(black, surface) >= ratioOf(white, surface) ? black : white;
	const mix = (amount: number): ColorRGBA => ({
		r: fg.r + (target.r - fg.r) * amount,
		g: fg.g + (target.g - fg.g) * amount,
		b: fg.b + (target.b - fg.b) * amount,
		a: 1,
	});
	let low = 0;
	let high = 1;
	let result = target;
	for (let step = 0; step < 16; step += 1) {
		const amount = (low + high) / 2;
		const candidate = mix(amount);
		// Overshoot slightly so the returned color clears the bar after
		// rounding to 8-bit, which can land a hair under it.
		if (ratioOf(candidate, surface) >= minimum + 0.1) {
			result = candidate;
			high = amount;
		} else {
			low = amount;
		}
	}
	const hex = [result.r, result.g, result.b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
	return `#${hex}`;
}
