/**
 * Collab share-link format + wire envelope. Browser-safe (base64url through
 * btoa/atob — no Buffer), merged from the host and guest implementations.
 *
 * Link format: `wss://<host[:port]>/r/<roomId>#<base64url-key>` — the room
 * secret rides the fragment, which browsers and proxies never put on the
 * wire. The legacy `wss://<host[:port]>/r/<roomId>.<key>` path form is still
 * parsed but no longer generated. The default relay collapses to a bare
 * `<roomId>.<key>`, a form with no origin and no path at all.
 * Wire envelope: `[4B uint32 BE peerId][sealed payload]` — the guest always
 * sends peerId 0; the relay rewrites it to the sender's id.
 */
import {
	DEFAULT_RELAY_URL,
	ENVELOPE_HEADER_LENGTH,
	type ParsedCollabLink,
	ROOM_ID_BYTES,
	ROOM_KEY_BYTES,
	WRITE_TOKEN_BYTES,
} from "@musepi/pi-wire";

export type { ParsedCollabLink } from "@musepi/pi-wire";
export { COLLAB_PROTO, DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH, ROOM_ID_BYTES } from "@musepi/pi-wire";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const LOCAL_HOSTNAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

// ── base64url (browser-safe) ────────────────────────────────────────────────

export function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(text: string): Uint8Array | null {
	if (!B64URL_RE.test(text)) return null;
	const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.length % 4 === 0 ? base64 : base64 + "=".repeat(4 - (base64.length % 4));
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		return null;
	}
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

// ── Wire envelope ───────────────────────────────────────────────────────────

/** `[4B uint32 BE peerId][sealed payload]`. peerId 0 broadcasts to all guests. */
export function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
	new DataView(out.buffer).setUint32(0, peerId, false);
	out.set(sealed, ENVELOPE_HEADER_LENGTH);
	return out;
}

/** Inverse of {@link packEnvelope}; null on truncated input. */
export function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
	if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
	return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

/** Rewrite the peerId in place without copying the payload. */
export function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
	new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}

// ── Link format ─────────────────────────────────────────────────────────────

/** Random room id, base64url. */
export function generateRoomId(): string {
	const bytes = new Uint8Array(ROOM_ID_BYTES);
	crypto.getRandomValues(bytes);
	return encodeBase64Url(bytes);
}

function isLocalHostname(hostname: string): boolean {
	if (LOCAL_HOSTNAMES[hostname] === true) return true;
	return isPrivateIpv4(hostname);
}

/**
 * RFC 1918 / link-local / CGNAT (Tailscale) IPv4: plaintext ws:// to a
 * private address is acceptable (LAN shares; a Tailscale tailnet is itself
 * encrypted), while public hosts still require wss.
 */
function isPrivateIpv4(hostname: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
	if (!m) return false;
	const a = Number(m[1]);
	const b = Number(m[2]);
	return (
		a === 10 ||
		(a === 192 && b === 168) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 169 && b === 254) ||
		(a === 100 && b >= 64 && b <= 127) // 100.64/10 CGNAT — Tailscale
	);
}

/** Normalize a relay base URL (ws/wss/http/https) into a ws/wss origin, or an error. */
export function normalizeRelayOrigin(relayUrl: string): { origin: string } | { error: string } {
	let url: URL;
	try {
		url = new URL(relayUrl);
	} catch {
		return { error: `Invalid relay URL: ${relayUrl}` };
	}
	let scheme: string;
	switch (url.protocol) {
		case "wss:":
		case "https:":
			scheme = "wss:";
			break;
		case "ws:":
		case "http:":
			scheme = "ws:";
			break;
		default:
			return { error: `Unsupported relay URL scheme: ${url.protocol}` };
	}
	if (scheme === "ws:" && !isLocalHostname(url.hostname)) {
		return { error: "relay link must be wss:// (plain ws:// is only allowed for localhost)" };
	}
	const port = url.port ? `:${url.port}` : "";
	return { origin: `${scheme}//${url.hostname}${port}` };
}

export interface CollabLinkOptions {
	/**
	 * Generate the legacy path-borne secret (`/r/<roomId>.<key>`). Only for
	 * links that stay on one machine or a trusted private network. Default false.
	 */
	keyInPath?: boolean;
}

/**
 * Render the shareable join link. Compact forms: the default relay collapses
 * to `<roomId>.<key>`, other wss relays drop the scheme (`host[:port]/r/…`);
 * only localhost/private ws:// links keep their full URL so parsing cannot
 * mis-infer wss.
 *
 * The room secret goes in the fragment. A link is pasted into browsers and
 * terminals, and every byte of a URL path is sent to — and logged by — the
 * outermost proxy: with a tunnel share that is the tunnel edge. Fragments
 * never leave the client. The legacy path form
 * (`/r/<roomId>.<key>`) stays parseable; it is no longer generated.
 *
 * Full links append the write token to the key
 * (`base64url(key ∥ writeToken)`); read-only (view) links carry the bare
 * 32-byte key, which is also the pre-token link format.
 */
export function formatCollabLink(
	relayUrl: string,
	roomId: string,
	key: Uint8Array,
	writeToken?: Uint8Array,
	options: CollabLinkOptions = {},
): string {
	const normalized = normalizeRelayOrigin(relayUrl);
	if ("error" in normalized) throw new Error(normalized.error);
	const secret = writeToken ? concat(key, writeToken) : key;
	const keyText = encodeBase64Url(secret);
	if (normalized.origin === DEFAULT_RELAY_URL) {
		// The bare form carries no origin and no path, so nothing reaches the
		// relay until a client expands it; the dot keeps it free of `#` so web
		// deep links can wrap it without a second, fragile fragment marker.
		return `${roomId}.${keyText}`;
	}
	// LAN relays (localhost / RFC 1918 IPv4) keep their full scheme: a
	// scheme-less LAN link would be re-parsed as wss:// and hit the wrong
	// port. Public wss relays stay compact (`host[:port]/r/…`).
	const hostname = new URL(normalized.origin).hostname;
	const keepScheme = isLocalHostname(hostname) || isPrivateIpv4(hostname);
	const compact =
		normalized.origin.startsWith("wss://") && !keepScheme
			? normalized.origin.slice("wss://".length)
			: normalized.origin;
	return `${compact}/r/${roomId}${options.keyInPath ? `.${keyText}` : `#${keyText}`}`;
}

function normalizeCollabWebBaseUrl(relayUrl: string, webUrl?: string): string {
	const explicitWebUrl = webUrl?.trim();
	if (!explicitWebUrl) {
		const normalized = normalizeRelayOrigin(relayUrl);
		if ("error" in normalized) throw new Error(normalized.error);
		return normalized.origin.startsWith("wss://")
			? `https://${normalized.origin.slice("wss://".length)}`
			: `http://${normalized.origin.slice("ws://".length)}`;
	}

	let url: URL;
	try {
		url = new URL(explicitWebUrl);
	} catch {
		throw new Error("collab.webUrl must start with http:// or https://");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("collab.webUrl must start with http:// or https://");
	}
	if (url.protocol === "http:" && !isLocalHostname(url.hostname)) {
		throw new Error("collab.webUrl must use https:// unless it targets localhost");
	}
	if (url.search || url.hash) {
		throw new Error("collab.webUrl must not include a query string or fragment");
	}
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path}`;
}

/**
 * Render the browser deep link. The browser UI may be hosted separately from
 * the relay; the fragment always carries the relay-specific collab link, so
 * room secrets stay out of HTTP path and query bytes. The inner link keeps the
 * dot form: it already lives in a fragment, and a second `#` inside one is
 * what strict URL stacks percent-encode.
 */
export function formatCollabWebLink(
	relayUrl: string,
	roomId: string,
	key: Uint8Array,
	writeToken?: Uint8Array,
	webUrl?: string,
): string {
	return `${normalizeCollabWebBaseUrl(relayUrl, webUrl)}/#${formatCollabLink(relayUrl, roomId, key, writeToken, { keyInPath: true })}`;
}

/** Parse any accepted link form back into its parts. Errors carry a message. */
export function parseCollabLink(link: string, defaultRelay = DEFAULT_RELAY_URL): ParsedCollabLink | { error: string } {
	// Lenient input: terminals that open OSC 8 links through strict URL stacks
	// (macOS Foundation) percent-encode the legacy second `#` to `%23`.
	let text = link.trim().replace(/%23/gi, "#");
	// Bare `<roomId>.<key>` (legacy `<roomId>#<key>`) carries no origin at all,
	// so it needs a relay supplied from outside — either the configured one or
	// an explicit argument. Without one the link names no reachable host, and
	// guessing is not available: this build ships no default relay.
	const bare = BARE_LINK_RE.exec(text);
	if (bare) {
		const relay = defaultRelay.trim();
		if (!relay) {
			return {
				error: "This link has no relay: configure collab.relayUrl (or paste the full wss:// link) so its origin is known",
			};
		}
		text = `${relay}/r/${bare[1]}.${bare[2]}`;
	}
	// Scheme-less `host[:port]/r/…` → wss.
	else if (!text.includes("://")) text = `wss://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { error: `Invalid collab link: ${link}` };
	}
	if ((url.protocol === "http:" || url.protocol === "https:") && url.hash) {
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		// A web deep link names its relay twice: as the page origin and, when it
		// is bare, only inside the fragment. The page origin is therefore the
		// correct default for a bare inner link — the link itself carries the
		// host, so no built-in relay has to be assumed.
		const wrapperOrigin = url.origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
		const parsed = parseCollabLink(inner, defaultRelay.trim() || wrapperOrigin);
		if (!("error" in parsed)) return parsed;
	}
	const normalized = normalizeRelayOrigin(url.origin);
	if ("error" in normalized) return normalized;
	const match = ROOM_PATH_RE.exec(url.pathname);
	if (!match) {
		// Non-http(s) deep links may also carry a complete collab link in the
		// fragment. http(s) links are handled once above so invalid fragments
		// fall through to direct relay validation instead of double-recursing.
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		if (inner && url.protocol !== "http:" && url.protocol !== "https:") return parseCollabLink(inner, defaultRelay);
		return { error: "Collab link must contain a /r/<roomId> path" };
	}
	const roomId = match[1]!;
	// Secret forms: generated links carry it in the fragment
	// (`/r/<roomId>#<key>`); legacy links carry it dot-joined in the path
	// (`/r/<roomId>.<key>`), as does the bare default-relay form.
	const fragment = match[2] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
	if (!fragment) {
		return { error: "Collab link is missing the <key> part" };
	}
	const secret = B64URL_RE.test(fragment) ? decodeBase64Url(fragment) : null;
	if (!secret || (secret.byteLength !== ROOM_KEY_BYTES && secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES)) {
		return { error: "Collab link key must be 32 (view) or 48 (full) base64url bytes" };
	}
	const key = secret.subarray(0, ROOM_KEY_BYTES);
	const writeToken = secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined;
	return { wsUrl: `${normalized.origin}/r/${roomId}`, roomId, key, writeToken };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.byteLength + b.byteLength);
	out.set(a, 0);
	out.set(b, a.byteLength);
	return out;
}
