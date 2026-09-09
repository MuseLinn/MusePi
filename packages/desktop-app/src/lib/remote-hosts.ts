/**
 * Remote daemon host registry for the GUI instance switcher (openchamber
 * DesktopHostSwitcher parity).
 *
 * A host is a ws:// endpoint plus an optional bearer token. Tokens ride the
 * WebSocket URL as `?token=` because browsers cannot set request headers
 * (the daemon's ws-transport accepts both Authorization and the query form).
 * Persisted in localStorage — the same store the app's daemon URL uses.
 */

export interface RemoteHost {
	/** Stable id (crypto random) — survives label/url edits. */
	id: string;
	/** Display label shown in the instance menu. */
	label: string;
	/** Base WebSocket endpoint, e.g. ws://192.168.1.20:8300. */
	url: string;
	/** Optional bearer token for remote daemons (musepi serve --remote-token). */
	token?: string;
}

const STORAGE_KEY = "musepi-gui-hosts";

export function loadHosts(): RemoteHost[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(h): h is RemoteHost =>
					typeof h === "object" &&
					h !== null &&
					typeof (h as RemoteHost).id === "string" &&
					typeof (h as RemoteHost).label === "string" &&
					typeof (h as RemoteHost).url === "string",
			)
			.map(h => ({ ...h, token: typeof h.token === "string" && h.token.length > 0 ? h.token : undefined }));
	} catch {
		return [];
	}
}

export function saveHosts(hosts: RemoteHost[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(hosts));
	} catch {
		// storage unavailable (private mode) — the switcher just won't persist
	}
}

export function newHostId(): string {
	return `host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Build the WebSocket URL for a host, appending the token query when set. */
export function buildWsUrl(host: RemoteHost): string {
	if (!host.token) return host.url;
	const sep = host.url.includes("?") ? "&" : "?";
	return `${host.url}${sep}token=${encodeURIComponent(host.token)}`;
}
