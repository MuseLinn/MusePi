/**
 * Saved connections (multi-server management).
 *
 * A connection is a collab link + a display label + the guest name used at
 * connect time. Persisted as a list under RECENT_KEY, mirrored into the OS
 * secure store on native shells (room links carry the E2E key — see
 * ./secure-store). The localStorage mirror is the synchronous read path; the
 * secure copy hydrates asynchronously in ConnectScreen.
 */
import { secureSet } from "./secure-store";

export interface Connection {
	link: string;
	/** Guest display name used when connecting (not the server's label). */
	name: string;
	/** Optional human label for this server ("客厅电脑"); falls back to the
	 *  link's host when absent. */
	label?: string;
	at: number;
}

const CONNECTIONS_KEY = "musepi.collab.recent";
const CONNECTIONS_MAX = 8;

export function loadConnections(): Connection[] {
	try {
		const raw = localStorage.getItem(CONNECTIONS_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter(
					(c): c is Connection =>
						typeof c === "object" && c !== null && typeof (c as Connection).link === "string",
				)
			: [];
	} catch {
		return [];
	}
}

/** Host part of a link, used as the default label ("192.168.1.5:8300"). */
export function hostOf(link: string): string {
	try {
		return new URL(link).host;
	} catch {
		return link;
	}
}

function persist(next: Connection[]): void {
	localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(next));
	void secureSet(CONNECTIONS_KEY, JSON.stringify(next));
}

/** Record a successful connection (dedup by link, most recent first). */
export function rememberConnection(link: string, name: string, label?: string): void {
	const next = [
		{ link, name, label: label ?? hostOf(link), at: Date.now() },
		...loadConnections().filter(c => c.link !== link),
	].slice(0, CONNECTIONS_MAX);
	persist(next);
}

/** Forget a saved connection. */
export function removeConnection(link: string): void {
	persist(loadConnections().filter(c => c.link !== link));
}

/** Relabel a saved connection. */
export function renameConnection(link: string, label: string): void {
	persist(loadConnections().map(c => (c.link === link ? { ...c, label: label || hostOf(link) } : c)));
}
