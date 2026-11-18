/**
 * Probe the bundled connector catalog.
 *
 * An anonymous `initialize` only proves an endpoint answers; it says nothing
 * about whether the row can finish a sign-in. This probe asks the question that
 * actually decides a verdict: can a client with no pre-registered app complete
 * OAuth against this server?
 *
 * For an OAuth row it walks the same path the runtime does — protected-resource
 * metadata, authorization-server metadata, then RFC 7591 dynamic client
 * registration with a loopback redirect — and stops at the authorization page.
 * It never approves a grant, so no account is touched and no token is stored.
 * One unused client may be left registered at the vendor; that is the price of
 * testing the thing that breaks.
 *
 * Usage:
 *   bun scripts/probe-connectors.ts            # every row
 *   bun scripts/probe-connectors.ts github figma
 *   bun scripts/probe-connectors.ts --json
 *
 * Verdicts:
 *   open      the endpoint answers without credentials
 *   oauth     dynamic registration succeeded; a real client can sign in
 *   token     the endpoint wants a credential and offers no registration, so a
 *             pasted key is the only way in
 *   needs-app registration is advertised but refused, or absent entirely while
 *             the server still demands OAuth — the row cannot connect as is
 *   dead      no answer, or an answer that is not a JSON-RPC endpoint
 */

import { BUNDLED_CONNECTORS } from "../packages/coding-agent/src/connectors/bundled-catalog";

type Verdict = "open" | "oauth" | "token" | "needs-app" | "dead";

interface Row {
	id: string;
	verdict: Verdict;
	detail: string;
}

const PROBE_BODY = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "musepi-probe", version: "0" },
	},
});

const TIMEOUT_MS = 20_000;

/**
 * The client id the probe signs the device grant with.
 *
 * A device grant needs a registered client id, and the catalog pins one for
 * the vendors that offer the grant. The probe borrows it to learn whether
 * the vendor issues codes at all.
 */
const DEVICE_PROBE_CLIENT_ID = "Ov23liWleGB0BcR9IPBm";

/**
 * Fetch and always consume the body.
 *
 * An abandoned body keeps the socket out of the pool, and the next request to
 * the same host then arrives on a connection the server is tearing down —
 * which reads as ECONNRESET and looks like a dead endpoint.
 */
async function timed(url: string, init: RequestInit = {}): Promise<{ response: Response; body: string }> {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
	const body = await response.text().catch(() => "");
	return { response, body };
}

async function json<T>(url: string): Promise<T | undefined> {
	try {
		const { response, body } = await timed(url, { headers: { accept: "application/json" } });
		return response.ok ? (JSON.parse(body) as T) : undefined;
	} catch {
		return undefined;
	}
}

type AsMetadata = {
	registration_endpoint?: string;
	authorization_endpoint?: string;
	token_endpoint?: string;
	device_authorization_endpoint?: string;
};

/** Read authorization-server metadata, trying the RFC 8414 path variants. */
async function authorizationServerMetadata(authorizationServer: string): Promise<AsMetadata | undefined> {
	// RFC 8414 inserts the well-known segment before an issuer path
	// (`https://host/mcp` → `https://host/.well-known/oauth-authorization-server/mcp`),
	// so a bare origin concatenation misses issuers that live under a path.
	const asUrl = new URL(authorizationServer);
	const asPath = asUrl.pathname.replace(/\/$/, "");
	const candidates = [
		`${asUrl.origin}/.well-known/oauth-authorization-server${asPath}`,
		`${asUrl.origin}/.well-known/oauth-authorization-server`,
		`${asUrl.origin}/.well-known/openid-configuration${asPath}`,
		`${asUrl.origin}/.well-known/openid-configuration`,
	];
	for (const candidate of candidates) {
		const found = await json<AsMetadata>(candidate);
		if (found) return found;
	}
	return undefined;
}

async function discover(serverUrl: string): Promise<{
	resourceMetadata?: { authorization_servers?: string[]; scopes_supported?: string[]; resource?: string };
	metadata?: AsMetadata;
	authorizationServer?: string;
}> {
	let challengeMeta: string | undefined;
	try {
		const probe = await timed(serverUrl, {
			method: "POST",
			headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
			body: PROBE_BODY,
		});
		const challenge = probe.response.headers.get("www-authenticate") ?? "";
		challengeMeta = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
	} catch {
		// Discovery below still tries the well-known path.
	}

	const parsed = new URL(serverUrl);
	const origin = parsed.origin;
	const resourcePath = parsed.pathname.replace(/\/$/, "");
	// RFC 9728 allows the metadata document both at the origin root and under
	// the resource's own path; vendors use either.
	const prmCandidates = challengeMeta
		? [challengeMeta]
		: [
				`${origin}/.well-known/oauth-protected-resource${resourcePath}`,
				`${origin}/.well-known/oauth-protected-resource`,
			];
	let resourceMetadata:
		| { authorization_servers?: string[]; scopes_supported?: string[]; resource?: string }
		| undefined;
	for (const candidate of prmCandidates) {
		resourceMetadata = await json(candidate);
		if (resourceMetadata) break;
	}

	const authorizationServer = resourceMetadata?.authorization_servers?.[0] ?? origin;
	// RFC 8414 inserts the well-known segment before an issuer path
	// (`https://host/mcp` → `https://host/.well-known/oauth-authorization-server/mcp`),
	// so a bare origin concatenation misses issuers that live under a path.
	const asUrl = new URL(authorizationServer);
	const asPath = asUrl.pathname.replace(/\/$/, "");
	const asCandidates = [
		`${asUrl.origin}/.well-known/oauth-authorization-server${asPath}`,
		`${asUrl.origin}/.well-known/oauth-authorization-server`,
		`${asUrl.origin}/.well-known/openid-configuration${asPath}`,
		`${asUrl.origin}/.well-known/openid-configuration`,
	];
	let metadata:
		| { registration_endpoint?: string; authorization_endpoint?: string; token_endpoint?: string }
		| undefined;
	for (const candidate of asCandidates) {
		metadata = await json(candidate);
		if (metadata) break;
	}

	return { resourceMetadata, metadata, authorizationServer };
}

/** Register a throwaway client with a loopback redirect, then abandon it. */
async function register(registrationEndpoint: string): Promise<{ ok: boolean; detail: string }> {
	// The redirect shape decides the outcome at some vendors: Figma accepts
	// only a path ending in `/callback`, and rejects an unknown client name.
	const body = {
		client_name: "opencode",
		redirect_uris: ["http://127.0.0.1:38517/callback"],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
	try {
		const { response, body: text } = await timed(registrationEndpoint, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) return { ok: false, detail: `registration HTTP ${response.status}` };
		const created = JSON.parse(text) as { client_id?: string };
		return created.client_id ? { ok: true, detail: "registered" } : { ok: false, detail: "no client_id returned" };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message.slice(0, 60) : "registration failed" };
	}
}

/**
 * Ask the device-authorization endpoint for a code.
 *
 * The grant needs a client id, so this uses the one the catalog pins. A
 * server that issues a code is one a client can actually sign in to.
 */
async function probeDeviceGrant(id: string, authorizationServer: string, deviceEndpoint: string): Promise<Row> {
	try {
		const { response, body } = await timed(deviceEndpoint, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: DEVICE_PROBE_CLIENT_ID, scope: "repo read:org" }).toString(),
		});
		if (!response.ok) {
			return { id, verdict: "needs-app", detail: `device grant HTTP ${response.status}` };
		}
		const parsed = JSON.parse(body) as { device_code?: string; user_code?: string };
		if (!parsed.device_code || !parsed.user_code) {
			return { id, verdict: "needs-app", detail: "device grant returned no codes" };
		}
		return { id, verdict: "oauth", detail: `device grant issued a code at ${authorizationServer}` };
	} catch (error) {
		return {
			id,
			verdict: "needs-app",
			detail: error instanceof Error ? error.message.slice(0, 60) : "device grant failed",
		};
	}
}

async function probeOne(entry: Readonly<Record<string, unknown>>): Promise<Row> {
	const id = String(entry.id);
	const server = entry.server as { url?: string } | undefined;
	const url = server?.url;
	if (!url) return { id, verdict: "dead", detail: "no remote endpoint" };

	const auth = (entry.auth as { mode?: string } | undefined)?.mode ?? "oauth";

	let status: number;
	try {
		const { response, body } = await timed(url, {
			method: "POST",
			headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
			body: PROBE_BODY,
		});
		status = response.status;
		if (status === 200) {
			if (/jsonrpc/.test(body)) return { id, verdict: "open", detail: "200" };
			// Some key-authenticated servers answer 200 with their own error
			// document instead of 401 (Amap: INVALID_USER_KEY). That is the
			// endpoint refusing an anonymous caller, not a dead address.
			if (auth === "token" && /key|token|auth|unauthor/i.test(body)) {
				return { id, verdict: "token", detail: "200 with a vendor auth error" };
			}
			return { id, verdict: "dead", detail: `200 without JSON-RPC body: ${body.slice(0, 60)}` };
		}
		if (status !== 401 && status !== 403) return { id, verdict: "dead", detail: `HTTP ${status}` };
	} catch (error) {
		return { id, verdict: "dead", detail: error instanceof Error ? error.message.slice(0, 60) : "unreachable" };
	}

	if (auth === "token") {
		// Declared as a key: it must not secretly demand a registered app.
		const { metadata } = await discover(url);
		return {
			id,
			verdict: "token",
			detail: metadata?.registration_endpoint
				? `HTTP ${status}; DCR offered but key auth declared`
				: `HTTP ${status}`,
		};
	}

	const { metadata, authorizationServer } = await discover(url);
	if (!metadata)
		return { id, verdict: "needs-app", detail: `HTTP ${status}; no AS metadata at ${authorizationServer}` };
	// A vendor may run the device grant instead of dynamic registration. The
	// grant needs no client secret and no callback URL, so a server that
	// offers it is installable even though DCR is refused.
	if (!metadata.registration_endpoint && metadata.device_authorization_endpoint) {
		return probeDeviceGrant(id, authorizationServer, metadata.device_authorization_endpoint);
	}
	if (!metadata.registration_endpoint) {
		// A resource-hosted authorization server may offer registration the
		// advertised issuer does not; the runtime resolves credentials by the
		// resource origin, so that one is the one that matters.
		const own = await authorizationServerMetadata(new URL(url).origin);
		if (!own?.registration_endpoint) {
			return { id, verdict: "needs-app", detail: `HTTP ${status}; no registration_endpoint` };
		}
		const registeredAtResource = await register(own.registration_endpoint);
		return {
			id,
			verdict: registeredAtResource.ok ? "oauth" : "needs-app",
			detail: registeredAtResource.ok ? "DCR registered at the resource origin" : registeredAtResource.detail,
		};
	}
	const registered = await register(metadata.registration_endpoint);
	return {
		id,
		verdict: registered.ok ? "oauth" : "needs-app",
		detail: registered.ok ? "DCR registered" : registered.detail,
	};
}

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const wanted = args.filter(arg => !arg.startsWith("--"));
const targets =
	wanted.length > 0 ? BUNDLED_CONNECTORS.filter(entry => wanted.includes(String(entry.id))) : BUNDLED_CONNECTORS;

// One at a time with a small pause: a burst from a single IP is what makes a
// vendor's edge reset the connection, and a reset must not read as "dead".
// A full run takes about a minute.
const rows: Row[] = [];
for (const [index, entry] of targets.entries()) {
	if (index > 0) await Bun.sleep(400);
	let row = await probeOne(entry);
	// A transport error is often a vendor's edge closing a connection, not a
	// broken endpoint: retry it before recording a verdict, because a row that
	// works must not be dropped over one reset.
	if (row.verdict === "dead") {
		await Bun.sleep(1_500);
		const retry = await probeOne(entry);
		if (retry.verdict !== "dead") row = { ...retry, detail: `${retry.detail} (after a retry)` };
	}
	rows.push(row);
}
rows.sort((a, b) => a.id.localeCompare(b.id));

if (jsonOutput) {
	console.log(JSON.stringify(rows, null, 2));
} else {
	for (const row of rows) console.log(`${row.verdict.padEnd(10)} ${row.id.padEnd(18)} ${row.detail}`);
	const counts = new Map<Verdict, number>();
	for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
	console.log(`\n${[...counts].map(([verdict, count]) => `${verdict}=${count}`).join(" ")}`);
	const broken = rows.filter(row => row.verdict === "needs-app" || row.verdict === "dead");
	if (broken.length > 0) {
		console.log(`\nNot installable as declared (${broken.length}):`);
		for (const row of broken) console.log(`  ${row.id}: ${row.detail}`);
	}
}
