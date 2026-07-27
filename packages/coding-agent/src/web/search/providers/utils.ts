/**
 * Provider helper utilities — credential lookup, signal management,
 * source mapping, and HTTP error classification.
 */

import type { SearchSource } from "../types.ts";

/**
 * Find an API key for a provider from environment variables.
 */
export function findApiKey(envVarName: string): string | undefined {
	return process.env[envVarName];
}

/**
 * Create an AbortSignal that combines a caller signal with a hard timeout.
 * Returns the caller's signal directly if no timeout is needed, or a
 * combined signal when both exist.
 */
export function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (!signal) return timeoutSignal;
	try {
		return AbortSignal.any([signal, timeoutSignal]);
	} catch {
		// AbortSignal.any requires Node 20+; fall back to caller signal only
		return signal;
	}
}

/**
 * Map raw search items to SearchSource[] with a common shape.
 */
export function toSearchSources(
	items: Array<{ title: string; url: string; snippet: string; ageSeconds?: number }>,
): SearchSource[] {
	return items.map((item) => ({
		title: item.title,
		url: item.url,
		snippet: item.snippet,
		ageSeconds: item.ageSeconds,
	}));
}

/**
 * Classify an HTTP error from a provider.
 */
export function classifyProviderHttpError(
	status: number,
	body?: string,
): { message: string; isQuota: boolean; isAuth: boolean } {
	if (status === 401 || status === 403) {
		return { message: body ?? "Authentication failed (check API key)", isQuota: false, isAuth: true };
	}
	if (status === 429 || status === 402) {
		return { message: body ?? "Rate limited or quota exceeded", isQuota: true, isAuth: false };
	}
	if (status >= 500) {
		return { message: body ?? `Server error (HTTP ${status})`, isQuota: false, isAuth: false };
	}
	return { message: body ?? `HTTP ${status}`, isQuota: false, isAuth: false };
}
