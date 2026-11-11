/**
 * Cordis fiber state names for diagnostics.
 *
 * `FiberState` is a const enum in `@deepseek-ai/cordis`, so it does not survive
 * cross-module imports. This mirror must stay in the vendor's ordinal order:
 * PENDING..UNLOADING = 0..5.
 */
const FIBER_STATE_NAMES = ["PENDING", "LOADING", "ACTIVE", "FAILED", "DISPOSED", "UNLOADING"] as const;

/** Ordinal of the FAILED state, for callers that skip effects on a dead fiber. */
export const FIBER_STATE_FAILED = 3;

/** The provider's state name, or the raw ordinal for an unknown value. */
export function fiberStateName(state: number): string {
	return FIBER_STATE_NAMES[state] ?? String(state);
}
