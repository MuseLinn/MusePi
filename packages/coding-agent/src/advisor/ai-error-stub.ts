/**
 * Minimal AI error types — inline stub for @musepi/pi-ai/error which
 * doesn't exist in MusePi.
 */

export class ProviderError extends Error {
	readonly code?: string;
	readonly statusCode?: number;

	constructor(message: string, code?: string, statusCode?: number) {
		super(message);
		this.name = "ProviderError";
		this.code = code;
		this.statusCode = statusCode;
	}
}

export function isProviderError(err: unknown): err is ProviderError {
	return err instanceof ProviderError;
}

export function isQuotaError(err: unknown): boolean {
	return (
		err instanceof ProviderError &&
		(err.code === "quota_exceeded" ||
			err.code === "insufficient_quota" ||
			err.code === "rate_limit_exceeded" ||
			err.statusCode === 429)
	);
}
