import { logger } from "@musepi/pi-utils";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
// MusePi-canonical env name; OMP_* kept as a compatibility fallback so
// existing user configs (and the upstream omp lineage) keep working.
const MCP_TIMEOUT_ENV = "MUSEPI_MCP_TIMEOUT_MS";
const MCP_TIMEOUT_ENV_FALLBACK = "OMP_MCP_TIMEOUT_MS";

let neverAbortController: AbortController | undefined;

export function resolveMCPTimeoutMs(configTimeout?: number): number {
	const raw = Bun.env[MCP_TIMEOUT_ENV]?.trim() ?? Bun.env[MCP_TIMEOUT_ENV_FALLBACK]?.trim();
	if (raw) {
		const value = Number(raw);
		if (Number.isFinite(value) && value >= 0) return value;
		logger.warn(`Ignoring invalid ${MCP_TIMEOUT_ENV} env value; expected a non-negative number`, {
			value: raw,
		});
	}
	return configTimeout ?? DEFAULT_MCP_TIMEOUT_MS;
}

export function isMCPTimeoutEnabled(timeoutMs: number): boolean {
	return timeoutMs > 0;
}

export function describeMCPTimeout(timeoutMs: number): string {
	return isMCPTimeoutEnabled(timeoutMs) ? `${timeoutMs}ms` : "disabled";
}

export function getNeverAbortSignal(): AbortSignal {
	neverAbortController ??= new AbortController();
	return neverAbortController.signal;
}

export function createMCPTimeout(
	timeoutMs: number,
	signal?: AbortSignal,
): {
	signal?: AbortSignal;
	clear: () => void;
	isTimeoutAbort: (error: unknown) => boolean;
	/** True when this operation's own timer fired (regardless of what error a consumer saw). */
	timedOut: () => boolean;
} {
	if (!isMCPTimeoutEnabled(timeoutMs)) {
		return {
			signal,
			clear: () => {},
			isTimeoutAbort: () => false,
			timedOut: () => false,
		};
	}

	const abortController = new AbortController();
	// Track which abort source fired first so neither a later caller abort nor
	// a later timer can overwrite the earlier one. Without this:
	// - Timer fires during response.json(), caller aborts before catch →
	//   both signals aborted, old `!signal?.aborted` was false → timeout
	//   leaked as SyntaxError ("Unexpected end of JSON input").
	// - Caller aborts first, body-read rejects after timeoutMs → timer still
	//   fires → caller cancellation misreported as timeout.
	let timerFired = false;
	let callerAborted = false;
	const clearFns: Array<() => void> = [];
	if (signal?.aborted) {
		callerAborted = true;
		abortController.abort();
	} else {
		const timeoutId = setTimeout(() => {
			if (callerAborted) return;
			timerFired = true;
			abortController.abort();
		}, timeoutMs);
		clearFns.push(() => clearTimeout(timeoutId));
		if (signal) {
			const onCallerAbort = () => {
				callerAborted = true;
				clearTimeout(timeoutId);
			};
			signal.addEventListener("abort", onCallerAbort, { once: true });
			clearFns.push(() => signal.removeEventListener("abort", onCallerAbort));
		}
	}
	const operationSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	return {
		signal: operationSignal,
		clear: () => {
			for (const fn of clearFns) fn();
		},
		isTimeoutAbort: error =>
			timerFired &&
			(error instanceof Error
				? error.name === "AbortError" || (error.name === "SyntaxError" && operationSignal.aborted)
				: false),
		timedOut: () => timerFired,
	};
}
