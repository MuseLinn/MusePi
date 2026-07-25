/**
 * OAuth failure classification for the auth-broker refresher.
 *
 * - **Definitive failures** (`invalid_grant`, `invalid_token`, revoked,
 *   refresh-token expired, bare 401 without transient pattern) → permanent
 *   credential disable.
 * - **Transient failures** (network errors, 5xx, timeouts, rate limits) →
 *   retry next sweep.
 */

const DEFINITIVE_FAILURE_PATTERN =
	/\binvalid_grant\b|\binvalid_token\b|\brevoked\b|refresh_token.*expired|unauthorized_client/i;

const TRANSIENT_401_PATTERN = /\brate\b|\btry again\b|\btoo many\b|\bthrottl|\b429\b|\b5\d{2}\b|\btimeout\b|\bbusy\b/i;

/**
 * Returns true when the error message indicates a definitive OAuth failure
 * that should permanently disable the credential. Transient failures
 * (network blips, rate limits, 5xx) return false.
 */
export function isDefinitiveOAuthFailure(errorMsg: string): boolean {
	if (DEFINITIVE_FAILURE_PATTERN.test(errorMsg)) return true;
	// Bare HTTP 401 without transient co-matches is definitive.
	if (/\b401\b/.test(errorMsg) && !TRANSIENT_401_PATTERN.test(errorMsg)) return true;
	return false;
}
