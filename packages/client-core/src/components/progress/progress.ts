/**
 * Progress math shared by every GUI surface.
 *
 * The wire carries no estimated total for a running agent, so a fraction is an
 * honest lower bound, not a percentage: it may grow but must never claim the
 * work is finished. Two rules keep every host readable the same way:
 *
 * - determinate values floor, so 99.6 renders 99 and only 100 renders full;
 * - a running fraction is capped below 1, so a long-running agent cannot fill
 *   the track before it settles.
 */

/** A running surface stops here until it actually settles (kimi-code parity). */
export const UNFINISHED_PROGRESS_CAP = 0.85;

/** Floors one 0–100 value into [0, max]; non-finite input reads empty. */
export function clampProgress(value: number, max = 100): number {
	return Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : 0;
}

/** Clamps one 0–1 fraction into [0, 1]; non-finite input reads empty. */
export function clampFraction(value: number): number {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * Caps a running fraction. `settled` work is allowed to read full; anything
 * still running lands at or below {@link UNFINISHED_PROGRESS_CAP}.
 */
export function capRunningFraction(value: number, settled: boolean): number {
	const fraction = clampFraction(value);
	return settled ? fraction : Math.min(UNFINISHED_PROGRESS_CAP, fraction);
}

/** One 0–100 percentage for a fraction, floored so 99.6% never reads 100. */
export function fractionPercent(value: number): number {
	return clampProgress(clampFraction(value) * 100);
}
