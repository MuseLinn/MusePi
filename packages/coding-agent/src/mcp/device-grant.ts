/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * Some vendors publish no dynamic-registration endpoint, so a client cannot
 * obtain a client id on its own and the browser-callback path is unavailable
 * without a pre-registered application. GitHub is the case this exists for:
 * its authorization server offers `authorization_code` and the device grant
 * but no `registration_endpoint`, and it refuses a PKCE-only code exchange, so
 * a callback sign-in needs a client secret while the device grant does not.
 *
 * The device grant replaces the redirect with a short user code: the user
 * opens a verification URL, types the code, and the client polls for the
 * token. Nothing has to listen on a port, and the same flow works from a
 * phone.
 *
 * The grant type is chosen by the authorization server, not by the client.
 * This module is entered when the catalog says the server supports it; the
 * server's own metadata decides whether a device endpoint exists at all.
 */

import type { FetchImpl } from "@musepi/pi-ai/types";

const DEFAULT_DEVICE_ENDPOINT = "/.well-known/oauth-device-authorization";
const REQUEST_TIMEOUT_MS = 20_000;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceAuthorizationStart {
	/** Code the user types on the verification page. */
	userCode: string;
	/** Where the user enters the code. */
	verificationUri: string;
	/** Verification page that also accepts the code directly, when advertised. */
	verificationUriComplete?: string;
	/** Opaque handle for the poll loop. */
	deviceCode: string;
	/** Minimum seconds between polls. */
	interval: number;
	/** Seconds until the code expires. */
	expiresIn: number;
}

export interface DeviceAuthorizationTokens {
	accessToken: string;
	refreshToken?: string;
	expiresIn?: number;
	scope?: string;
	tokenType?: string;
}

/** Errors the device grant reports, each with the server's own wording. */
export type DeviceGrantErrorCode =
	| "authorization_pending"
	| "slow_down"
	| "expired_token"
	| "access_denied"
	| "unsupported_grant_type"
	| "incorrect_device_code"
	| "device_flow_disabled"
	| "incorrect_client_credentials";

export class DeviceGrantError extends Error {
	readonly code: DeviceGrantErrorCode;
	readonly description?: string;

	constructor(code: DeviceGrantErrorCode, description?: string) {
		super(description ?? code);
		this.name = "DeviceGrantError";
		this.code = code;
		this.description = description;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The device-authorization endpoint for an authorization server.
 *
 * RFC 8628 does not fix a discovery path, and vendors disagree on it:
 * GitHub publishes the endpoint in its own metadata, others use the
 * OAuth-Authorization-Server style path. The advertised value wins; the
 * conventional path is the fallback.
 */
export function deviceAuthorizationUrl(authorizationServer: string, advertised?: string): string {
	if (advertised) return advertised;
	const base = authorizationServer.replace(/\/$/, "");
	return `${base}${DEFAULT_DEVICE_ENDPOINT}`;
}

/** Ask the server for a user code and a device code. */
export async function startDeviceAuthorization(options: {
	authorizationServer: string;
	clientId: string;
	scopes?: string;
	deviceAuthorizationEndpoint?: string;
	fetch?: FetchImpl;
}): Promise<DeviceAuthorizationStart> {
	const { clientId, scopes, fetch: request = fetch } = options;
	if (!clientId) throw new DeviceGrantError("incorrect_client_credentials", "no client id");
	const url = deviceAuthorizationUrl(options.authorizationServer, options.deviceAuthorizationEndpoint);
	const body = new URLSearchParams({ client_id: clientId });
	if (scopes) body.set("scope", scopes);

	let response: Response;
	try {
		response = await request(url, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body: body.toString(),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		throw new DeviceGrantError(
			"unsupported_grant_type",
			error instanceof Error ? error.message : "device authorization request failed",
		);
	}
	const payload = await response.json().catch(() => undefined);
	if (!isRecord(payload))
		throw new DeviceGrantError("unsupported_grant_type", `device endpoint answered ${response.status}`);
	if (typeof payload.error === "string") {
		throw new DeviceGrantError(
			payload.error as DeviceGrantErrorCode,
			typeof payload.error_description === "string" ? payload.error_description : undefined,
		);
	}
	const deviceCode = typeof payload.device_code === "string" ? payload.device_code : "";
	const userCode = typeof payload.user_code === "string" ? payload.user_code : "";
	const verificationUri =
		(typeof payload.verification_uri === "string" ? payload.verification_uri : "") ||
		(typeof payload.verification_url === "string" ? payload.verification_url : "");
	if (!deviceCode || !userCode || !verificationUri) {
		throw new DeviceGrantError("unsupported_grant_type", "device authorization response is missing its codes");
	}
	return {
		userCode,
		verificationUri,
		...(typeof payload.verification_uri_complete === "string"
			? { verificationUriComplete: payload.verification_uri_complete }
			: {}),
		deviceCode,
		interval: typeof payload.interval === "number" && payload.interval > 0 ? payload.interval : 5,
		expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : 900,
	};
}

/**
 * One poll step.
 *
 * `pending` means the user has not finished yet; `slow_down` means the poll
 * came too early and the interval grew. Both are ordinary progress, not
 * failures — a caller keeps polling on them.
 */
export async function pollDeviceAuthorization(options: {
	tokenUrl: string;
	clientId: string;
	deviceCode: string;
	fetch?: FetchImpl;
}): Promise<{
	status: "pending" | "success";
	tokens?: DeviceAuthorizationTokens;
	interval?: number;
	slowDown?: boolean;
}> {
	const { clientId, deviceCode, fetch: request = fetch } = options;
	const body = new URLSearchParams({
		client_id: clientId,
		device_code: deviceCode,
		grant_type: DEVICE_CODE_GRANT,
	});
	let response: Response;
	try {
		response = await request(options.tokenUrl, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body: body.toString(),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		throw new DeviceGrantError(
			"authorization_pending",
			error instanceof Error ? error.message : "device token request failed",
		);
	}
	const payload = await response.json().catch(() => undefined);
	if (!isRecord(payload))
		throw new DeviceGrantError("authorization_pending", `token endpoint answered ${response.status}`);
	const error = typeof payload.error === "string" ? payload.error : "";
	if (error === "authorization_pending") return { status: "pending" };
	if (error === "slow_down") return { status: "pending", slowDown: true };
	if (error) {
		throw new DeviceGrantError(
			error as DeviceGrantErrorCode,
			typeof payload.error_description === "string" ? payload.error_description : undefined,
		);
	}
	const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
	if (!accessToken) throw new DeviceGrantError("authorization_pending", "token response carried no access token");
	return {
		status: "success",
		tokens: {
			accessToken,
			...(typeof payload.refresh_token === "string" ? { refreshToken: payload.refresh_token } : {}),
			...(typeof payload.expires_in === "number" ? { expiresIn: payload.expires_in } : {}),
			...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
			...(typeof payload.token_type === "string" ? { tokenType: payload.token_type } : {}),
		},
	};
}
