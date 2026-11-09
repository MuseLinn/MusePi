const CONSENT_KEY = "musepi-gui-remote-access-consent";
const CONSENT_VERSION = "1";

export function hasRemoteAccessConsent(storage?: Storage): boolean {
	try {
		return (storage ?? localStorage).getItem(CONSENT_KEY) === CONSENT_VERSION;
	} catch {
		return false;
	}
}

export function grantRemoteAccessConsent(storage?: Storage): void {
	try {
		(storage ?? localStorage).setItem(CONSENT_KEY, CONSENT_VERSION);
	} catch {
		// The in-memory gate still permits this renderer session when storage is unavailable.
	}
}
