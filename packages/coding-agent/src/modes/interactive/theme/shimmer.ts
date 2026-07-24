import type { Theme, ThemeColor } from "./theme.ts";

/**
 *
 * Provides a character-level time-varying intensity profile that sweeps
 * across text, mapping each character to a 3-tier palette. Designed for
 * Loader status lines where the message text gets a subtle "light band"
 * scanning left to right at ~30fps.
 *
 * Modes:
 *   "classic" — smooth cosine bump sweeping left-to-right
 *   "kitt"    — Knight Rider K.I.T.T. scanner (single bright head + trail)
 *   "disabled" — plain text, no animation
 *
 * Ported from oh-my-pi's shimmer system.
 */

// ─── Animation velocity ───────────────────────────────────────────────────
// Band/head travel speed in cells per second. Driving position by a fixed
// velocity makes smoothness independent of message length.
const SHIMMER_SPEED_CELLS_PER_S = 30;

// ─── Classic sweep tunables ───────────────────────────────────────────────
const CLASSIC_PADDING = 10; // virtual padding cells before first char
const CLASSIC_BAND_HALF_WIDTH = 6; // radius of the cosine bump

// ─── KITT scanner tunables ───────────────────────────────────────────────
const KITT_HEAD_HALF = 0.6; // radius of the bright head
const KITT_TRAIL_LEN = 7; // length of the quadratic-fade trail

// ─── Raw ANSI codes ──────────────────────────────────────────────────────
const FG_RESET = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

const DEFAULT_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "muted",
	high: "accent",
};

export type ShimmerMode = "classic" | "kitt" | "disabled";

/**
 * Three-tier color stack. Each character's intensity maps to low/mid/high.
 * A tier can be a ThemeColor string or a raw ANSI escape code.
 */
export interface ShimmerPalette {
	low: ThemeColor | { ansi: string };
	mid: ThemeColor | { ansi: string };
	high: ThemeColor | { ansi: string };
	bold?: boolean;
}

/** One run of text that shares a palette inside a larger shimmer sweep. */
export interface ShimmerSegment {
	text: string;
	palette?: ShimmerPalette;
}

// ─── Global shimmer mode (defaults on, settable from settings) ────────────

let globalShimmerMode: ShimmerMode = "classic";

/** Override the shimmer mode at runtime (e.g., from settings init). */
export function setShimmerMode(mode: ShimmerMode): void {
	globalShimmerMode = mode;
}

/** Get the current shimmer mode. */
export function getShimmerMode(): ShimmerMode {
	return globalShimmerMode;
}

/** Check whether shimmer animation is enabled (classic or kitt, not disabled). */
export function shimmerEnabled(): boolean {
	return globalShimmerMode !== "disabled";
}

// ─── Intensity profiles ──────────────────────────────────────────────────

/**
 * Smooth cosine bump sweeping left-to-right with edge padding.
 * Each character gets intensity 0.0–1.0 based on how close the sweep
 * center is to its index.
 */
function classicIntensity(time: number, index: number, length: number): number {
	const period = length + CLASSIC_PADDING * 2;
	const center = ((time * SHIMMER_SPEED_CELLS_PER_S) % period) - CLASSIC_PADDING + CLASSIC_BAND_HALF_WIDTH;
	const dist = Math.abs(index - center);
	if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
	return (Math.cos((dist / CLASSIC_BAND_HALF_WIDTH) * Math.PI) + 1) / 2;
}

/**
 * K.I.T.T. scanner: a single bright head ping-pongs across with a
 * quadratic-decay trail behind it.
 */
function kittIntensity(time: number, index: number, length: number): number {
	const period = Math.max(1, length - 1) * 2;
	const rawPos = (time * SHIMMER_SPEED_CELLS_PER_S) % period;
	// Ping-pong: sweep forward then backward
	const pos = rawPos <= period / 2 ? rawPos : period - rawPos;
	const dist = Math.abs(index - pos);
	if (dist <= KITT_HEAD_HALF) return 1;
	if (dist <= KITT_HEAD_HALF + KITT_TRAIL_LEN) {
		const t = (dist - KITT_HEAD_HALF) / KITT_TRAIL_LEN;
		return 1 - t * t; // quadratic decay
	}
	return 0;
}

type Tier = "low" | "mid" | "high";

const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

function tierFor(intensity: number): Tier {
	if (intensity >= TIER_HIGH) return "high";
	if (intensity >= TIER_MID) return "mid";
	return "low";
}

// ─── ANSI resolution ─────────────────────────────────────────────────────

function resolveTierAnsi(theme: Theme, tier: ThemeColor | { ansi: string }): string {
	return typeof tier === "string" ? theme.getFgAnsi(tier) : tier.ansi;
}

// ─── Main shimmer functions ──────────────────────────────────────────────

let shimmerStartTime: number | undefined;

/** Get or initialize the shimmer epoch timestamp. */
function getShimmerTime(): number {
	if (shimmerStartTime === undefined) {
		shimmerStartTime = performance.now() / 1000;
	}
	return performance.now() / 1000 - shimmerStartTime;
}

/**
 * Apply a shimmer sweep across one or more segments, treating them as a
 * single visual sweep. Each segment can have its own palette.
 *
 * Time is derived from `performance.now()` so the animation advances
 * on every call — ideal for Loader's re-render cycle.
 */
export function shimmerSegments(segments: readonly ShimmerSegment[], theme: Theme): string {
	const totalLength = segments.reduce((sum, s) => sum + s.text.length, 0);
	if (totalLength === 0) return "";

	const mode = globalShimmerMode;
	if (mode === "disabled") {
		return segments
			.map((s) => {
				const p = s.palette ?? DEFAULT_PALETTE;
				const ansi = resolveTierAnsi(theme, p.mid);
				return `${ansi}${s.text}${FG_RESET}`;
			})
			.join("");
	}

	const time = getShimmerTime();
	const intensityFn = mode === "kitt" ? kittIntensity : classicIntensity;

	let result = "";
	let offset = 0;

	for (const seg of segments) {
		const palette = seg.palette ?? DEFAULT_PALETTE;
		const lowAnsi = resolveTierAnsi(theme, palette.low);
		const midAnsi = resolveTierAnsi(theme, palette.mid);
		const highAnsi = resolveTierAnsi(theme, palette.high);
		const useBold = palette.bold ?? false;

		for (let i = 0; i < seg.text.length; i++) {
			const intensity = intensityFn(time, offset + i, totalLength);
			const tier = tierFor(intensity);
			const ansi = tier === "high" ? highAnsi : tier === "mid" ? midAnsi : lowAnsi;
			const bold = useBold && tier === "high" ? BOLD_OPEN : "";
			const boldClose = bold ? BOLD_CLOSE : "";
			result += `${bold}${ansi}${seg.text[i]}${boldClose}${FG_RESET}`;
		}
		offset += seg.text.length;
	}

	return result;
}

/**
 * Convenience wrapper for single-segment shimmer text.
 * Applies the default palette (low=dim, mid=muted, high=accent).
 */
export function shimmerText(text: string, theme: Theme, palette?: ShimmerPalette): string {
	return shimmerSegments([{ text, palette }], theme);
}

// ============================================================================
// Spinner frames (minimal — full symbol system in ./symbols.ts)
// ============================================================================

export type SpinnerPreset = "unicode" | "ascii";

export type SpinnerSymbols = {
	spinnerFrames: string[];
	success: string;
	error: string;
	warning: string;
	info: string;
};

let globalSpinnerPreset: SpinnerPreset = "unicode";

export function setSpinnerPreset(preset: SpinnerPreset): void {
	globalSpinnerPreset = preset;
}

export function getSpinnerPreset(): SpinnerPreset {
	return globalSpinnerPreset;
}

export function getSpinnerFrames(): string[] {
	if (globalSpinnerPreset === "ascii") return ["|", "/", "-", "\\"];
	return ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
}

export function getSpinnerSymbols(): SpinnerSymbols {
	return {
		spinnerFrames: getSpinnerFrames(),
		success: globalSpinnerPreset === "ascii" ? "+" : "✓",
		error: globalSpinnerPreset === "ascii" ? "x" : "✗",
		warning: globalSpinnerPreset === "ascii" ? "!" : "⚠",
		info: globalSpinnerPreset === "ascii" ? "i" : "ℹ",
	};
}
