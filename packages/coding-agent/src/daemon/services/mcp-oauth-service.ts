/**
 * McpOAuthService — browser-completed MCP OAuth login for the desktop GUI.
 *
 * The TUI owns this flow behind `/mcp` (`MCPOAuthFlow` + the command
 * controller's endpoint resolution); the daemon had no equivalent, so an
 * OAuth-protected server could only be configured with a pasted token. This
 * service is the daemon half of the same contract: start the flow for one
 * configured http/sse server, hand the authorization URL back to the
 * requesting GUI, and — once the provider redirects to the daemon's loopback
 * callback — store the grant where the MCP manager already looks
 * (`mcpOAuthCredentialId(serverUrl)` in `modelRegistry.authStorage`) before
 * reloading the connectors so cached managers reconnect with the new token.
 *
 * Capability seam (M2-2.4):
 * - Input: RPC `mcp.oauth.start` `{name}`, `mcp.oauth.status` `{flowId}`,
 *   `mcp.oauth.cancel` `{flowId}`.
 * - Output: `{flowId, authorizationUrl}`. The URL carries the CSRF `state`
 *   and the PKCE challenge, so it is returned only in that start reply —
 *   never logged, broadcast, or duplicated in status.
 *   Status is `pending | success | error`, plus `error` and `cancelled` for
 *   the GUI's failure/abort copy.
 * - Lifecycle: flows live in this process; `stop()` aborts pending ones, and
 *   a second start for the same server supersedes the first so two loopback
 *   flows never race on one credential row.
 * - Conflict: none with `McpServersService` — that owns the mcp.json file,
 *   this owns the runtime flow and the credential row. No new persisted field:
 *   the config keeps `auth: {type: "oauth"}` and the grant lives in
 *   auth-storage keyed by server URL.
 *
 * Browser callback only. The flow listens on the daemon host's loopback
 * callback server, so the browser must be able to reach the daemon. There is
 * no manual-code path on this surface; a grant that never arrives ends as a
 * timeout error (the start reply never waits for the grant, so the GUI is not
 * left hanging).
 */

import { randomUUID } from "node:crypto";
import { getMCPConfigPath, logger, withTimeout } from "@musepi/pi-utils";
import { loadConnectorCatalog } from "../../connectors/catalog";
import { expandEnvVarsDeep } from "../../discovery/helpers";
import { connectToServer, disconnectServer } from "../../mcp/client";
import { loadAllMCPConfigs } from "../../mcp/config";
import { readMCPConfigFile } from "../../mcp/config-writer";
import { DeviceGrantError, pollDeviceAuthorization, startDeviceAuthorization } from "../../mcp/device-grant";
import {
	type AuthDetectionResult,
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	type OAuthEndpoints,
} from "../../mcp/oauth-discovery";
import { MCPOAuthFlow, type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "../../mcp/oauth-flow";
import type { MCPHttpServerConfig, MCPServerConfig, MCPServerConnection, MCPSseServerConfig } from "../../mcp/types";
import type { AuthStorage } from "../../session/auth-storage";
import type { DaemonService } from "./types";

/** How long `start` waits for the flow to mint its authorization URL. */
const AUTH_URL_TIMEOUT_MS = 30_000;
/** Settled flows kept for late status polls before the oldest are dropped. */
const MAX_RETAINED_FLOWS = 8;
/** Failure text is one line, capped: provider bodies must not flood the wire. */
const MAX_ERROR_LENGTH = 400;

export type McpOAuthFlowStatus = "pending" | "success" | "error";

/** One flow's wire status. Secrets and the authorization URL stay out. */
export interface McpOAuthStatus {
	flowId: string;
	server: string;
	status: McpOAuthFlowStatus;
	/** Failure reason; absent while pending or after success. */
	error?: string;
	/** True when the failure is the caller's own `mcp.oauth.cancel`. */
	cancelled?: boolean;
}

export interface McpOAuthServiceDeps {
	/** Daemon working directory — the same cwd the MCP discovery reads. */
	cwd(): string;
	/** Shared auth storage; null when no registry could be bootstrapped. */
	authStorage(): Promise<AuthStorage | null>;
	/** Reconcile cached MCP managers after the grant lands. */
	reloadConnectors?(): Promise<unknown>;
}

interface McpOAuthFlowRecord {
	flowId: string;
	server: string;
	status: McpOAuthFlowStatus;
	error?: string;
	cancelled?: boolean;
	controller: AbortController;
	flow?: MCPOAuthFlow;
	/** Resolves at the terminal transition. A parked tool call waits here; the
	 *  record itself stays queryable through `status` for late clients. */
	settled: McpOAuthSettlement;
}

/** Promise pair for one flow's terminal state. */
interface McpOAuthSettlement {
	promise: Promise<McpOAuthStatus>;
	resolve(value: McpOAuthStatus): void;
}

/**
 * A device-grant flow.
 *
 * The RFC 8628 grant has no callback and no authorization URL: the user types
 * a short code on a page the server names. It therefore carries its own
 * record rather than sharing the browser flow's shape.
 */
interface McpDeviceFlowRecord {
	flowId: string;
	server: string;
	status: "pending" | "success" | "error";
	error?: string;
	deviceCode: string;
	clientId: string;
	tokenUrl: string;
	scopes?: string;
	interval: number;
	expiresAt: number;
	/** The page the user opens, and the code they type there. */
	verificationUri: string;
	userCode: string;
	material: McpOAuthMaterial;
}

/** Refresh material captured at flow construction, persisted with the grant. */
interface McpOAuthMaterial {
	serverUrl: string;
	tokenUrl: string;
	clientId?: string;
	clientSecret?: string;
}

function describeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
	const line = firstLine || "MCP OAuth flow failed";
	return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH)}…` : line;
}

function readString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** A custom scheme (or non-loopback host) cannot be served by our loopback listener. */
function isExternalRedirect(uri: string): boolean {
	try {
		const parsed = new URL(uri);
		const loopback = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
		return !loopback;
	} catch {
		return false;
	}
}

export class McpOAuthService implements DaemonService {
	readonly key = "mcpOAuth";
	readonly routes = {
		"mcp.oauth.start": "startFlow",
		"mcp.oauth.status": "status",
		"mcp.oauth.cancel": "cancel",
		"mcp.oauth.callback": "callback",
		"mcp.oauth.device.start": "deviceStart",
		"mcp.oauth.device.poll": "devicePoll",
		"mcp.oauth.device.cancel": "deviceCancel",
	} as const;

	readonly #deps: McpOAuthServiceDeps;
	readonly #flows = new Map<string, McpOAuthFlowRecord>();
	readonly #deviceFlows = new Map<string, McpDeviceFlowRecord>();

	constructor(deps: McpOAuthServiceDeps) {
		this.#deps = deps;
	}

	/**
	 * RPC mcp.oauth.start：为一个已配置的 http/sse 服务器开始浏览器授权。
	 * 返回的 authorizationUrl 只发给发起请求的 GUI；真实登录在后台继续，
	 * 状态由 `mcp.oauth.status` 轮询。
	 */
	async startFlow(params: { name?: unknown; redirectUri?: unknown }): Promise<{
		flowId: string;
		authorizationUrl: string;
	}> {
		const name = readString(params?.name);
		if (!name) throw new Error("name required");
		const { config, url } = await this.#resolveServer(name);
		const requestedRedirectUri = readString(params?.redirectUri) || config.oauth?.redirectUri;
		const externalCallback = requestedRedirectUri !== undefined && isExternalRedirect(requestedRedirectUri);
		const controller = new AbortController();
		const endpoints = await this.#resolveEndpoints(name, config, controller.signal);

		const material: McpOAuthMaterial = {
			serverUrl: url,
			tokenUrl: endpoints.tokenUrl,
			clientId: endpoints.clientId ?? config.oauth?.clientId,
			clientSecret: config.oauth?.clientSecret,
		};
		const authUrl = Promise.withResolvers<string>();
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: endpoints.authorizationUrl,
				tokenUrl: endpoints.tokenUrl,
				registrationUrl: endpoints.registrationUrl,
				clientId: material.clientId,
				clientSecret: material.clientSecret,
				scopes: endpoints.scopes,
				prompt: config.oauth?.prompt,
				redirectUri: requestedRedirectUri,
				externalCallback,
				callbackPort: config.oauth?.callbackPort,
				callbackPath: config.oauth?.callbackPath,
				// TUI parity: a server-URL fallback resource is stripped when it
				// shares the authorization server's origin; advertised ones stay.
				resource: endpoints.resource ?? url,
				stripSameOriginResource: endpoints.resource === undefined,
			},
			{
				onAuth: info => authUrl.resolve(info.url),
				signal: controller.signal,
			},
		);

		const flowId = randomUUID();
		const record: McpOAuthFlowRecord = {
			flowId,
			server: name,
			status: "pending",
			controller,
			flow,
			settled: Promise.withResolvers<McpOAuthStatus>(),
		};
		this.#cancelPendingFor(name, "superseded by a newer OAuth login");
		this.#register(record);

		void flow
			.login()
			.then(credentials => this.#succeed(record, flow, credentials, material))
			.catch(error => this.#fail(record, error));

		try {
			const authorizationUrl = await withTimeout(
				authUrl.promise,
				AUTH_URL_TIMEOUT_MS,
				`MCP OAuth flow did not issue an authorization URL within ${AUTH_URL_TIMEOUT_MS / 1000}s`,
				controller.signal,
			);
			logger.info("MCP OAuth flow started", { server: name, flowId });
			return { flowId, authorizationUrl };
		} catch (error) {
			// The flow can fail before it ever issues a URL (busy callback port,
			// rejected dynamic registration, provider error): surface that reason
			// instead of leaving a pending record behind.
			this.#abortRecord(record, "MCP OAuth login could not start");
			this.#flows.delete(flowId);
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	/**
	 * RPC mcp.oauth.callback：桌面自定义协议收到的回调 URL。状态校验在
	 * flow 内完成；不匹配的 URL 不会结束任何流程。
	 */
	callback(params: { url?: unknown }): { ok: true; flowId: string } {
		const url = readString(params?.url);
		if (!url) throw new Error("url required");
		for (const record of this.#flows.values()) {
			if (record.status !== "pending" || !record.flow) continue;
			if (record.flow.submitCallbackUrl(url)) return { ok: true, flowId: record.flowId };
		}
		throw new Error("no pending OAuth flow accepted the callback");
	}

	/** RPC mcp.oauth.status：轮询一条流程的 pending/success/error。 */
	status(params: { flowId?: unknown }): McpOAuthStatus {
		const record = this.#record(params);
		return this.#project(record);
	}

	/**
	 * Wait for one flow's terminal state. The session-host auth challenge uses
	 * this: its tool call is parked until the grant lands, so it cannot poll.
	 * With no deadline the wait ends when the grant lands, the flow fails, or a
	 * caller cancels it; a deadline also cancels the flow so no callback listener
	 * outlives the wait.
	 */
	async whenSettled(flowId: string, options: { timeoutMs?: number } = {}): Promise<McpOAuthStatus> {
		const record = this.#record({ flowId });
		if (record.status !== "pending") return this.#project(record);
		if (options.timeoutMs === undefined) return await record.settled.promise;
		try {
			return await withTimeout(
				record.settled.promise,
				options.timeoutMs,
				`MCP OAuth login did not finish within ${Math.round(options.timeoutMs / 1000)}s`,
			);
		} catch (error) {
			if (record.status === "pending") this.cancel({ flowId });
			throw error;
		}
	}

	/**
	 * RPC mcp.oauth.device.start：开始一次设备码登录。
	 *
	 * The RFC 8628 grant needs a client id but no client secret and no
	 * callback URL, so it serves the vendors that publish no registration
	 * endpoint — GitHub among them. The reply carries the page the user opens
	 * and the code they type there.
	 */
	async deviceStart(params: { name?: unknown }): Promise<{
		flowId: string;
		userCode: string;
		verificationUri: string;
		interval: number;
		expiresIn: number;
	}> {
		const name = readString(params?.name);
		if (!name) throw new Error("name required");
		const { config, url } = await this.#resolveServer(name);
		const controller = new AbortController();
		const endpoints = await this.#resolveEndpoints(name, config, controller.signal);
		const clientId = endpoints.clientId ?? config.oauth?.clientId;
		if (!clientId) {
			throw new Error(
				"MCP server has no client id; the device grant needs one, and this server publishes no registration endpoint",
			);
		}
		const authorizationServer = new URL(endpoints.authorizationUrl).origin;
		const start = await startDeviceAuthorization({
			authorizationServer,
			clientId,
			...(endpoints.scopes ? { scopes: endpoints.scopes } : {}),
			...(endpoints.deviceAuthorizationUrl ? { deviceAuthorizationEndpoint: endpoints.deviceAuthorizationUrl } : {}),
		});
		const flowId = randomUUID();
		const record: McpDeviceFlowRecord = {
			flowId,
			server: name,
			status: "pending",
			deviceCode: start.deviceCode,
			clientId,
			tokenUrl: endpoints.tokenUrl,
			...(endpoints.scopes ? { scopes: endpoints.scopes } : {}),
			interval: start.interval,
			expiresAt: Date.now() + start.expiresIn * 1000,
			verificationUri: start.verificationUri,
			userCode: start.userCode,
			material: { serverUrl: url, tokenUrl: endpoints.tokenUrl, clientId },
		};
		this.#deviceFlows.set(flowId, record);
		logger.info("MCP OAuth device flow started", { server: name, flowId });
		return {
			flowId,
			userCode: start.userCode,
			verificationUri: start.verificationUri,
			interval: start.interval,
			expiresIn: start.expiresIn,
		};
	}

	/**
	 * RPC mcp.oauth.device.poll：问一次设备码登录的结果。
	 *
	 * The caller drives the cadence: `interval` says how many seconds the
	 * server asked to wait between polls, and `slow_down` means the poll came
	 * too early. A grant is stored in the same credential row the browser
	 * flow uses, so the two are interchangeable afterwards.
	 */
	async devicePoll(params: { flowId?: unknown }): Promise<{
		flowId: string;
		status: "pending" | "success" | "error";
		error?: string;
		interval?: number;
	}> {
		const flowId = readString(params?.flowId);
		if (!flowId) throw new Error("flowId required");
		const record = this.#deviceFlows.get(flowId);
		if (!record) throw new Error(`unknown device OAuth flow: ${flowId}`);
		if (record.status !== "pending") {
			return { flowId, status: record.status, ...(record.error ? { error: record.error } : {}) };
		}
		if (Date.now() > record.expiresAt) {
			record.status = "error";
			record.error = "The device code expired before it was authorized";
			this.#deviceFlows.delete(flowId);
			return { flowId, status: "error", error: record.error };
		}
		try {
			const result = await pollDeviceAuthorization({
				tokenUrl: record.tokenUrl,
				clientId: record.clientId,
				deviceCode: record.deviceCode,
			});
			if (result.status === "pending") {
				// The server adds five seconds when a poll comes too early.
				if (result.slowDown) record.interval += 5;
				return { flowId, status: "pending", interval: record.interval };
			}
			const tokens = result.tokens;
			if (!tokens) throw new Error("device flow returned no token");
			const storage = await this.#deps.authStorage();
			if (!storage) throw new Error("Model registry is unavailable; cannot store the MCP OAuth credential");
			const credential: MCPStoredOAuthCredential = {
				type: "oauth",
				access: tokens.accessToken,
				refresh: tokens.refreshToken ?? "",
				expires: tokens.expiresIn ?? 0,
				tokenUrl: record.tokenUrl,
				clientId: record.clientId,
				resource: record.material.serverUrl,
				authorizationUrl: record.tokenUrl,
			};
			await storage.set(mcpOAuthCredentialId(record.material.serverUrl), credential);
			record.status = "success";
			this.#deviceFlows.delete(flowId);
			try {
				await this.#deps.reloadConnectors?.();
			} catch (error) {
				logger.warn("MCP reload after device login failed", {
					server: record.server,
					error: describeError(error),
				});
			}
			logger.info("MCP OAuth device login completed", { server: record.server, flowId });
			return { flowId, status: "success" };
		} catch (error) {
			const code = error instanceof DeviceGrantError ? error.code : undefined;
			// A pending or slow-down answer is progress, not a failure.
			if (code === "authorization_pending" || code === "slow_down") {
				if (code === "slow_down") record.interval += 5;
				return { flowId, status: "pending", interval: record.interval };
			}
			record.status = "error";
			record.error = describeError(error);
			this.#deviceFlows.delete(flowId);
			logger.info("MCP OAuth device login failed", { server: record.server, flowId, error: record.error });
			return { flowId, status: "error", error: record.error };
		}
	}

	/**
	 * RPC mcp.oauth.device.cancel：放弃一条设备码流程。
	 *
	 * Closing the sign-in surface means the person stopped walking away from
	 * the code; forgetting the record also keeps a later poll from finishing a
	 * grant they left behind.
	 */
	deviceCancel(params: { flowId?: unknown }): { ok: true } {
		const flowId = readString(params?.flowId);
		if (!flowId) throw new Error("flowId required");
		this.#deviceFlows.delete(flowId);
		return { ok: true };
	}

	/** RPC mcp.oauth.cancel：中止一条仍在等待浏览器回调的流程。 */
	cancel(params: { flowId?: unknown }): McpOAuthStatus & { ok: true } {
		const record = this.#record(params);
		if (record.status === "pending") {
			record.cancelled = true;
			record.status = "error";
			record.error = "MCP OAuth login cancelled";
			record.controller.abort("MCP OAuth login cancelled");
			record.settled.resolve(this.#project(record));
			logger.info("MCP OAuth flow cancelled", { server: record.server, flowId: record.flowId });
		}
		return { ok: true, ...this.#project(record) };
	}

	/** Daemon shutdown: abort every pending flow so no callback server leaks. */
	stop(): void {
		for (const record of this.#flows.values()) {
			if (record.status === "pending") this.#abortRecord(record, "MCP OAuth login cancelled by daemon shutdown");
		}
		this.#flows.clear();
		// A device flow holds no process and no listener, but its record must
		// not outlive the daemon that owns it.
		this.#deviceFlows.clear();
	}

	#project(record: McpOAuthFlowRecord): McpOAuthStatus {
		return {
			flowId: record.flowId,
			server: record.server,
			status: record.status,
			...(record.error ? { error: record.error } : {}),
			...(record.cancelled ? { cancelled: true } : {}),
		};
	}

	#record(params: { flowId?: unknown }): McpOAuthFlowRecord {
		const flowId = readString(params?.flowId);
		if (!flowId) throw new Error("flowId required");
		const record = this.#flows.get(flowId);
		if (!record) throw new Error(`Unknown MCP OAuth flow: ${flowId}`);
		return record;
	}

	#register(record: McpOAuthFlowRecord): void {
		this.#flows.set(record.flowId, record);
		const settled = [...this.#flows.values()].filter(entry => entry.status !== "pending");
		const drop = settled.length - MAX_RETAINED_FLOWS;
		for (const stale of settled.slice(0, Math.max(0, drop))) this.#flows.delete(stale.flowId);
	}

	#cancelPendingFor(server: string, reason: string): void {
		for (const record of this.#flows.values()) {
			if (record.server === server && record.status === "pending") this.#abortRecord(record, reason, true);
		}
	}

	#abortRecord(record: McpOAuthFlowRecord, reason: string, cancelled = false): void {
		if (record.status === "pending") {
			record.status = "error";
			record.error = reason;
			if (cancelled) record.cancelled = true;
		}
		record.controller.abort(reason);
		record.settled.resolve(this.#project(record));
	}

	#fail(record: McpOAuthFlowRecord, error: unknown): void {
		// A cancel already published its own terminal state; the abort it caused
		// must not overwrite it with the internal abort reason.
		if (record.cancelled || record.status === "error") return;
		record.status = "error";
		record.error = describeError(error);
		record.settled.resolve(this.#project(record));
		logger.warn("MCP OAuth flow failed", {
			server: record.server,
			flowId: record.flowId,
			error: record.error,
		});
	}

	/**
	 * Store the finished grant under the URL-keyed credential id the manager
	 * already resolves, then reload connectors so a cached manager reconnects.
	 */
	async #succeed(
		record: McpOAuthFlowRecord,
		flow: MCPOAuthFlow,
		credentials: { access: string; refresh: string; expires: number },
		material: McpOAuthMaterial,
	): Promise<void> {
		if (record.cancelled) return;
		const storage = await this.#deps.authStorage();
		if (!storage) throw new Error("Model registry is unavailable; cannot store the MCP OAuth credential");
		// Self-contained grant: refresh material rides the credential so refresh
		// works even though mcp.json carries no token.
		const credential: MCPStoredOAuthCredential = {
			type: "oauth",
			...credentials,
			tokenUrl: material.tokenUrl,
			clientId: flow.resolvedClientId ?? material.clientId,
			clientSecret: flow.registeredClientSecret ?? material.clientSecret,
			resource: flow.resource,
			authorizationUrl: flow.authorizationUrl,
		};
		await storage.set(mcpOAuthCredentialId(material.serverUrl), credential);
		try {
			await this.#deps.reloadConnectors?.();
		} catch (error) {
			// The credential write is the authority; a manager that failed to
			// restart picks the grant up on the next reload.
			logger.warn("MCP reload after OAuth login failed", {
				server: record.server,
				error: describeError(error),
			});
		}
		record.status = "success";
		record.error = undefined;
		record.settled.resolve(this.#project(record));
		logger.info("MCP OAuth login completed", { server: record.server, flowId: record.flowId });
	}

	async #resolveServer(name: string): Promise<{
		config: MCPHttpServerConfig | MCPSseServerConfig;
		url: string;
	}> {
		const cwd = this.#deps.cwd();
		const { configs } = await loadAllMCPConfigs(cwd);
		const config =
			configs[name] ?? (await this.#readConfiguredServer(name, cwd)) ?? (await this.#catalogServer(name));
		if (!config) {
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);
			throw new Error(`MCP server "${name}" is not configured (checked ${userPath} and ${projectPath})`);
		}
		if (config.type !== "http" && config.type !== "sse") {
			throw new Error(
				`MCP server "${name}" uses the ${config.type ?? "stdio"} transport; browser OAuth login requires an http or sse server`,
			);
		}
		const url = config.url?.trim();
		if (!url) throw new Error(`MCP server "${name}" has no url`);
		return { config, url };
	}

	/**
	 * Raw user/project read for servers the capability loader suppressed
	 * (disabled or denylisted): the owner may still want a fresh grant. Same
	 * precedence as `/mcp add` — user wins over project. Env references are
	 * expanded the way the discovery providers do, so the probe and the stored
	 * credential key both see the live URL.
	 */
	async #readConfiguredServer(name: string, cwd: string): Promise<MCPServerConfig | undefined> {
		for (const filePath of [getMCPConfigPath("user", cwd), getMCPConfigPath("project", cwd)]) {
			const parsed = await readMCPConfigFile(filePath).catch(() => null);
			if (!parsed?.mcpServers) continue;
			const candidate = expandEnvVarsDeep(parsed.mcpServers)[name];
			if (candidate) return candidate;
		}
		return undefined;
	}

	/**
	 * A connector is authorized before it is enabled, so it is not in any MCP
	 * config yet. The catalog still holds its endpoint and pinned OAuth hints,
	 * which is all a flow needs; the grant is keyed by the same URL either way.
	 */
	async #catalogServer(name: string): Promise<MCPHttpServerConfig | MCPSseServerConfig | undefined> {
		if (!name.startsWith("connector:")) return undefined;
		const id = name.slice("connector:".length);
		const { entries } = await loadConnectorCatalog();
		const entry = entries.find(candidate => candidate.id === id);
		const server = entry?.server;
		if (!entry || (server?.type !== "http" && server?.type !== "sse")) return undefined;
		const oauth = entry.oauth;
		return {
			type: server.type,
			url: server.url,
			...(server.headers ? { headers: server.headers } : {}),
			oauth: {
				...(oauth?.clientId ? { clientId: oauth.clientId } : {}),
				...(oauth?.authorizationUrl ? { authorizationUrl: oauth.authorizationUrl } : {}),
				...(oauth?.tokenUrl ? { tokenUrl: oauth.tokenUrl } : {}),
				...(oauth?.deviceAuthorizationUrl ? { deviceAuthorizationUrl: oauth.deviceAuthorizationUrl } : {}),
				...(oauth?.scopes ? { scopes: oauth.scopes } : {}),
				...(oauth?.callbackPort ? { callbackPort: oauth.callbackPort } : {}),
				...(oauth?.callbackPath ? { callbackPath: oauth.callbackPath } : {}),
			},
		};
	}

	/**
	 * Resolve the authorization/token endpoints exactly like the TUI: trust
	 * published metadata first, otherwise probe the MCP endpoint without a
	 * grant and let `analyzeAuthError` read the RFC 6750/9728 hints.
	 */
	async #resolveEndpoints(
		name: string,
		config: MCPHttpServerConfig | MCPSseServerConfig,
		signal: AbortSignal,
	): Promise<OAuthEndpoints> {
		let endpoints = await discoverOAuthEndpoints(config.url, undefined, undefined, { signal }).catch(() => null);
		if (!endpoints) {
			const challenge = await this.#probeAuthChallenge(name, config, signal);
			const detection: AuthDetectionResult = analyzeAuthError(challenge, config.url);
			if (!detection.requiresAuth) {
				throw new Error(
					`MCP server "${name}" did not report an authentication challenge; browser OAuth login is not applicable`,
				);
			}
			endpoints = await discoverOAuthEndpoints(config.url, detection.authServerUrl, detection.resourceMetadataUrl, {
				protectedScopes: detection.scopes,
				signal,
			});
			if (endpoints && !endpoints.scopes && detection.resourceMetadataUrl) {
				// JSON-challenge path skips `discoverOAuthEndpoints`; the advertised
				// protected-resource metadata is where the required scopes live.
				const scopes = await fetchResourceMetadataScopes(detection.resourceMetadataUrl, { signal });
				if (scopes) endpoints = { ...endpoints, scopes };
			}
		}
		if (!endpoints) {
			throw new Error(`Could not discover OAuth endpoints for "${name}" (${config.url})`);
		}
		// A catalog may pin the device endpoint when the vendor publishes no
		// metadata to discover it from (GitHub documents it, but not as
		// authorization-server metadata).
		if (!endpoints.deviceAuthorizationUrl && config.oauth?.deviceAuthorizationUrl) {
			endpoints = { ...endpoints, deviceAuthorizationUrl: config.oauth.deviceAuthorizationUrl };
		}
		return endpoints;
	}

	/**
	 * Connect without a grant to obtain the server's auth challenge. Errors and
	 * disconnects are the transport's own, so the message carries the same
	 * `WWW-Authenticate`/`Mcp-Auth-Server` hints the MCP client sees.
	 */
	async #probeAuthChallenge(
		name: string,
		config: MCPHttpServerConfig | MCPSseServerConfig,
		signal: AbortSignal,
	): Promise<Error> {
		const probeConfig: MCPServerConfig = { ...config };
		delete (probeConfig as { auth?: unknown }).auth;
		let connection: MCPServerConnection | undefined;
		try {
			connection = await connectToServer(name, probeConfig, { signal });
		} catch (error) {
			signal.throwIfAborted();
			return error instanceof Error ? error : new Error(String(error));
		}
		await disconnectServer(connection);
		throw new Error(
			`MCP server "${name}" accepted an unauthenticated connection; browser OAuth login is not applicable`,
		);
	}
}
