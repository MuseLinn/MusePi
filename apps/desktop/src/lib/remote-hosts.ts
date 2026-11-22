/**
 * Remote daemon host shape for the GUI instance switcher (openchamber
 * DesktopHostSwitcher parity).
 *
 * A host is a ws:// endpoint plus an optional bearer token. Tokens ride the
 * WebSocket URL as `?token=` because browsers cannot set request headers
 * (the daemon's ws-transport accepts both Authorization and the query form).
 *
 * This module no longer owns persistence: `lib/connection/target-store.ts`
 * (which also carries the kind and its parameters) is the single owner of the
 * host slot, and the switcher's host list is derived from it.
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

export function newHostId(): string {
	return `host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Build the WebSocket URL for a host, appending the token query when set. */
export function buildWsUrl(host: RemoteHost): string {
	if (!host.token) return host.url;
	const sep = host.url.includes("?") ? "&" : "?";
	return `${host.url}${sep}token=${encodeURIComponent(host.token)}`;
}

/** Normalize user input before it becomes a persisted daemon endpoint. */
export function normalizeRemoteHostUrl(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Instance URL is required");
	const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`);
	if (parsed.protocol === "http:") parsed.protocol = "ws:";
	if (parsed.protocol === "https:") parsed.protocol = "wss:";
	if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
		throw new Error("Instance URL must use ws, wss, http or https");
	}
	if (parsed.username || parsed.password || parsed.hash) {
		throw new Error("Use the token field instead of URL credentials or fragments");
	}
	const pathname = parsed.pathname.replace(/\/+$/, "");
	return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
}
