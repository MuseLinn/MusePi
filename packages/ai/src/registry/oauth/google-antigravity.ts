/**
 * Antigravity OAuth flow (Gemini 3, Claude, GPT-OSS via Google Cloud)
 * Uses different OAuth credentials than google-gemini-cli for access to additional models.
 */
import { getAntigravityUserAgent, getAntigravityVersion } from "@musepi/pi-catalog/wire/gemini-headers";
import * as AIError from "../../error";
import { oauthFetch, runGoogleOAuthLogin, throwIfLoginCancelled } from "./google-oauth-shared";
import type { OAuthController, OAuthCredentials } from "./types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";

const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_CODE_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const DAILY_CLOUD_CODE_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const NODE_API_CLIENT_USER_AGENT = "google-api-nodejs-client/10.3.0";
const GOOG_API_CLIENT_HEADER = "gl-node/22.21.1";
const TIER_FREE = "free-tier";
const PROJECT_ONBOARD_MAX_ATTEMPTS = 5;
const PROJECT_ONBOARD_INTERVAL_MS = 2000;
interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string | { id?: string };
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

interface LongRunningOperationResponse {
	done?: boolean;
	response?: {
		cloudaicompanionProject?: string | { id?: string };
	};
}

export const ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA = Object.freeze({
	ideType: "ANTIGRAVITY",
});

export interface AntigravityOnboardMetadata {
	ide_type: string;
	ide_version: string;
	ide_name: string;
}

export function getAntigravityOnboardMetadata(): AntigravityOnboardMetadata {
	return {
		ide_type: "ANTIGRAVITY",
		ide_version: getAntigravityVersion(),
		ide_name: "antigravity",
	};
}

function readProjectId(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) {
		return value.trim();
	}
	if (value && typeof value === "object" && "id" in value && typeof (value as { id?: unknown }).id === "string") {
		const id = (value as { id: string }).id.trim();
		if (id.length > 0) return id;
	}
	return undefined;
}

function extractProjectId(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const record = payload as Record<string, unknown>;
	for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
		const id = readProjectId(record[key]);
		if (id) return id;
	}
	return undefined;
}

function getDefaultTierId(
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>,
	currentTier?: { id?: string },
): string {
	if (allowedTiers && allowedTiers.length > 0) {
		const defaultTier = allowedTiers.find(
			tier => tier.isDefault && typeof tier.id === "string" && tier.id.trim().length > 0,
		);
		if (defaultTier?.id) {
			return defaultTier.id.trim();
		}
	}
	if (currentTier && typeof currentTier.id === "string" && currentTier.id.trim().length > 0) {
		return currentTier.id.trim();
	}
	return TIER_FREE;
}

async function onboardProjectWithRetries(
	endpoint: string,
	headers: Record<string, string>,
	onboardBody: { tier_id: string; metadata: AntigravityOnboardMetadata },
	signal: AbortSignal | undefined,
	onProgress?: (message: string) => void,
): Promise<string> {
	for (let attempt = 1; attempt <= PROJECT_ONBOARD_MAX_ATTEMPTS; attempt += 1) {
		if (attempt > 1) {
			onProgress?.(`Waiting for project provisioning (attempt ${attempt}/${PROJECT_ONBOARD_MAX_ATTEMPTS})...`);
			throwIfLoginCancelled(signal);
			await Bun.sleep(PROJECT_ONBOARD_INTERVAL_MS);
		}

		throwIfLoginCancelled(signal);
		const onboardResponse = await oauthFetch(
			`${endpoint}/v1internal:onboardUser`,
			{ method: "POST", headers, body: JSON.stringify(onboardBody) },
			{ provider: "google-antigravity", signal },
		);

		if (!onboardResponse.ok) {
			const errorText = await onboardResponse.text();
			throw new AIError.OAuthError(
				`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${errorText}`,
				{ kind: "provisioning", provider: "google-antigravity", status: onboardResponse.status },
			);
		}

		const operation = (await onboardResponse.json()) as LongRunningOperationResponse;
		if (!operation.done) {
			continue;
		}

		const projectId = extractProjectId(operation.response);
		if (projectId) {
			return projectId;
		}
	}

	throw new AIError.OAuthError(
		`onboardUser did not return a provisioned project id after ${PROJECT_ONBOARD_MAX_ATTEMPTS} attempts`,
		{ kind: "provisioning", provider: "google-antigravity" },
	);
}

async function discoverProject(
	accessToken: string,
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<string> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": getAntigravityUserAgent(),
	};

	onProgress?.("Checking for existing project...");
	try {
		let lastErrorText: string | undefined;
		let lastStatus: number | undefined;
		let fallbackTierId = TIER_FREE;
		let loadedSuccessfully = false;

		for (const endpoint of [DAILY_CLOUD_CODE_ENDPOINT, CLOUD_CODE_ENDPOINT]) {
			throwIfLoginCancelled(signal);
			const loadResponse = await oauthFetch(
				`${endpoint}/v1internal:loadCodeAssist`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
					}),
				},
				{ provider: "google-antigravity", signal },
			);

			if (!loadResponse.ok) {
				lastStatus = loadResponse.status;
				lastErrorText = await loadResponse.text();
				continue;
			}

			loadedSuccessfully = true;
			const loadPayload = (await loadResponse.json()) as LoadCodeAssistPayload;
			const existingProject = extractProjectId(loadPayload);
			if (existingProject) {
				return existingProject;
			}
			fallbackTierId = getDefaultTierId(loadPayload.allowedTiers, loadPayload.currentTier);
		}

		if (!loadedSuccessfully && lastStatus !== undefined) {
			throw new AIError.OAuthError(`loadCodeAssist failed: ${lastStatus}: ${lastErrorText || "unknown error"}`, {
				kind: "discovery",
				status: lastStatus,
			});
		}

		onProgress?.("Provisioning project...");
		const onboardBody = {
			tier_id: fallbackTierId,
			metadata: getAntigravityOnboardMetadata(),
		};
		const onboardHeaders: Record<string, string> = {
			...headers,
			"User-Agent": `${headers["User-Agent"]} ${NODE_API_CLIENT_USER_AGENT}`,
			"X-Goog-Api-Client": GOOG_API_CLIENT_HEADER,
		};
		const provisionedProject = await onboardProjectWithRetries(
			DAILY_CLOUD_CODE_ENDPOINT,
			onboardHeaders,
			onboardBody,
			signal,
			onProgress,
		);
		return provisionedProject;
	} catch (error) {
		if (error instanceof AIError.LoginCancelledError || error instanceof AIError.OAuthError) {
			throw error;
		}
		throw new AIError.OAuthError(
			`Could not discover or provision an Antigravity project. ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "discovery", provider: "google-antigravity", cause: error },
		);
	}
}

export async function loginAntigravity(ctrl: OAuthController): Promise<OAuthCredentials> {
	return runGoogleOAuthLogin(ctrl, {
		provider: "google-antigravity",
		clientId: CLIENT_ID,
		clientSecret: CLIENT_SECRET,
		authUrl: AUTH_URL,
		tokenUrl: TOKEN_URL,
		scopes: SCOPES,
		callbackPort: CALLBACK_PORT,
		callbackPath: CALLBACK_PATH,
		discoverProject,
	});
}

/**
 * Refresh Antigravity token
 */
export async function refreshAntigravityToken(refreshToken: string, projectId: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new AIError.OAuthError(`Antigravity token refresh failed: ${error}`, { kind: "token-refresh" });
	}

	const data = (await response.json()) as {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
	};

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		projectId,
	};
}
