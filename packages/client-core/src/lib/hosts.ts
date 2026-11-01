/**
 * Saved remote hosts. Public metadata lives in localStorage; each room link
 * (including its E2E key and write token) lives in a separate secure-store
 * item. Native shells never mirror new host credentials into plaintext.
 */
import { parseCollabLink } from "@musepi/collab-proto";
import { secureGet, secureRemove, secureSet } from "./secure-store";

export interface HostCandidate {
	id: string;
	kind: "lan" | "tunnel" | "relay";
	/** Relay WebSocket URL, without the E2E key or write token. */
	address: string;
}

export interface HostRecord {
	id: string;
	label: string;
	deviceName: string;
	access: { kind: "guest"; credentialRef: string };
	candidates: HostCandidate[];
	lastUsedAt: number;
}

export interface ResolvedHost extends HostRecord {
	link: string;
}

interface LegacyConnection {
	link: string;
	name: string;
	label?: string;
	at: number;
}

const HOSTS_KEY = "musepi.hosts.v1";
const LEGACY_KEY = "musepi.collab.recent";
const HOSTS_MAX = 8;

function credentialRef(id: string): string {
	return `musepi.host.${id}.credential`;
}

/** Stable local dedupe id. This is not a server-issued identity. */
export function hostIdForLink(link: string): string {
	const parsed = parseCollabLink(link);
	const text = "error" in parsed ? link : parsed.wsUrl;
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193);
		second = Math.imul(second ^ code, 0x85ebca6b);
	}
	return `host-${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

/** Host part used as the default display label. */
export function hostOf(link: string): string {
	const parsed = parseCollabLink(link);
	try {
		return new URL("error" in parsed ? link : parsed.wsUrl).host;
	} catch {
		return link;
	}
}

function candidateFor(address: string): HostCandidate {
	let lan = false;
	try {
		const hostname = new URL(address).hostname;
		lan =
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "::1" ||
			hostname === "[::1]" ||
			/^(10\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(hostname) ||
			(/^172\./.test(hostname) && Number(hostname.split(".")[1]) >= 16 && Number(hostname.split(".")[1]) <= 31);
	} catch {
		// parseCollabLink already validates real records; keep malformed data inert.
	}
	return { id: "primary", kind: lan ? "lan" : "relay", address };
}

function isHostRecord(value: unknown): value is HostRecord {
	if (typeof value !== "object" || value === null) return false;
	const host = value as HostRecord;
	return (
		typeof host.id === "string" &&
		typeof host.label === "string" &&
		typeof host.deviceName === "string" &&
		host.access?.kind === "guest" &&
		typeof host.access.credentialRef === "string" &&
		Array.isArray(host.candidates) &&
		host.candidates.every(
			candidate =>
				typeof candidate === "object" &&
				candidate !== null &&
				typeof candidate.id === "string" &&
				(candidate.kind === "lan" || candidate.kind === "tunnel" || candidate.kind === "relay") &&
				typeof candidate.address === "string",
		) &&
		typeof host.lastUsedAt === "number"
	);
}

function persistHosts(hosts: HostRecord[]): void {
	localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts.slice(0, HOSTS_MAX)));
}

export function loadHosts(): HostRecord[] {
	try {
		const raw = localStorage.getItem(HOSTS_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isHostRecord).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
	} catch {
		return [];
	}
}

export async function resolveHost(record: HostRecord): Promise<ResolvedHost | null> {
	const link = await secureGet(record.access.credentialRef);
	if (!link || hostIdForLink(link) !== record.id) return null;
	return { ...record, link };
}

/** Record a successfully welcomed host, preserving a user-chosen label. */
export async function rememberHost(link: string, deviceName: string, label?: string): Promise<ResolvedHost | null> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) return null;
	const id = hostIdForLink(link);
	const access = { kind: "guest" as const, credentialRef: credentialRef(id) };
	if (!(await secureSet(access.credentialRef, link, { mirror: false }))) return null;
	const existing = loadHosts().find(host => host.id === id);
	const record: HostRecord = {
		id,
		label: label?.trim() || existing?.label || hostOf(link),
		deviceName: deviceName.trim() || existing?.deviceName || "guest",
		access,
		candidates: [candidateFor(parsed.wsUrl)],
		lastUsedAt: Date.now(),
	};
	persistHosts([record, ...loadHosts().filter(host => host.id !== id)]);
	return { ...record, link };
}

export async function loadResolvedHosts(): Promise<ResolvedHost[]> {
	await migrateLegacyConnections();
	const resolved = await Promise.all(loadHosts().map(resolveHost));
	return resolved.filter((host): host is ResolvedHost => host !== null).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export function renameHost(id: string, label: string): void {
	persistHosts(
		loadHosts().map(host =>
			host.id === id ? { ...host, label: label.trim() || hostOf(host.candidates[0]?.address ?? host.label) } : host,
		),
	);
}

export async function removeHost(id: string): Promise<void> {
	const host = loadHosts().find(item => item.id === id);
	if (!host) return;
	await secureRemove(host.access.credentialRef);
	persistHosts(loadHosts().filter(item => item.id !== id));
}

function isLegacyConnection(value: unknown): value is LegacyConnection {
	if (typeof value !== "object" || value === null) return false;
	const connection = value as LegacyConnection;
	return typeof connection.link === "string" && typeof connection.name === "string";
}

/** Migrate only after every new credential reaches its target store. A failed
 *  native write keeps the legacy source intact for the next launch. */
async function migrateLegacyConnections(): Promise<void> {
	const raw = await secureGet(LEGACY_KEY);
	if (!raw) return;
	let complete = true;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			for (const entry of parsed.filter(isLegacyConnection)) {
				if (!(await rememberHost(entry.link, entry.name, entry.label))) complete = false;
			}
		}
	} catch {
		complete = false;
	}
	if (complete) await secureRemove(LEGACY_KEY);
}
