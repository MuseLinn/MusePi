/**
 * Navigation policy for the browser tool (Proma 吸收: browser-policy.ts).
 *
 * Pure URL boundary checks with no Electron/Bun dependency so the logic runs
 * in plain unit tests. `restrictToPublic` (setting `browser.policy.restrictToPublic`)
 * turns the launched/managed browser into a public-internet-only surface:
 * - only http/https schemes (no javascript:, file:, data:, …)
 * - no URLs carrying credentials, no localhost/private/loopback hosts
 * - a DNS re-check before navigation so a hostname resolving to a private
 *   address is rejected even when the literal hostname looks public
 *   (DNS-rebinding guard).
 *
 * Default is OFF: navigating localhost dev servers is a core musepi feature.
 * The guard is opt-in for workflows that need a strictly public browser.
 */
import { lookup } from "node:dns/promises";

const PRIVATE_IPV6_PREFIXES = ["fc", "fd", "fe8", "fe9", "fea", "feb", "ff"];

/** True for loopback / private / link-local / multicast / ULA addresses. */
export function isPrivateAddress(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
	const ipv6 = host.replace(/^\[/, "").replace(/\]$/, "");
	// IPv6 loopback/unspecified, IPv4-mapped, ULA, link-local and multicast
	// can never be public destinations. IPv4-mapped addresses are rejected
	// outright so a `::ffff:10.x` mapping cannot bypass the IPv4 checks.
	if (
		ipv6 === "::" ||
		ipv6 === "::1" ||
		ipv6.startsWith("::ffff:") ||
		PRIVATE_IPV6_PREFIXES.some(prefix => ipv6.startsWith(prefix))
	) {
		return true;
	}
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!match) return false;
	const a = Number(match[1]);
	const b = Number(match[2]);
	return (
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a === 0 ||
		a >= 224
	);
}

/**
 * Normalize address-bar input: `example.com/docs` → https, bare
 * `localhost:3000`/`example.com:8080` keep their port, explicit schemes pass
 * through for the scheme check below. `//host` protocol-relative input is
 * rejected outright so it can never be misread as a hostname.
 */
export function normalizeBrowserUrl(input: string): string {
	const value = input.trim();
	if (!value) throw new Error("Browser URL must not be empty");
	if (value.startsWith("//")) throw new Error("Browser URL must use http or https");
	// `localhost:3000` and `example.com:8080` are common no-scheme inputs that
	// must not be mistaken for a scheme.
	if (/^[^/?#:\s]+:\d+(?:[/?#]|$)/.test(value)) return `https://${value}`;
	if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return value;
	return `https://${value}`;
}

/** Scheme + private-address check only (no DNS). Throws with a user-facing message. */
export function assertSafeBrowserUrl(input: string): string {
	const normalized = normalizeBrowserUrl(input);
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new Error("Browser URL is invalid; enter a public hostname or a complete http/https URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Browser URL protocol "${parsed.protocol}" is not allowed`);
	}
	if (parsed.username || parsed.password || isPrivateAddress(parsed.hostname)) {
		throw new Error(
			"Browser URL must be a public http/https address (no credentials, localhost or private networks)",
		);
	}
	return parsed.toString();
}

/**
 * Full guard: URL checks + DNS re-resolution. Chromium is still the final
 * network stack; this cannot stop a later DNS rebinding inside the page, but
 * it blocks the common attack path where the hostname currently resolves to a
 * private address.
 */
export async function assertSafeBrowserDestination(input: string): Promise<string> {
	const safeUrl = assertSafeBrowserUrl(input);
	const hostname = new URL(safeUrl).hostname;
	try {
		const addresses = await lookup(hostname, { all: true, verbatim: true });
		if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
			throw new Error("Browser URL resolves to localhost or a private network address");
		}
	} catch (error) {
		if (error instanceof Error && error.message.includes("resolves to localhost")) throw error;
		throw new Error(`Browser URL DNS lookup failed for "${hostname}"`);
	}
	return safeUrl;
}
