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
import { expandEnvVarsDeep } from "../../discovery/helpers";
import { connectToServer, disconnectServer } from "../../mcp/client";
import { loadAllMCPConfigs } from "../../mcp/config";
import { readMCPConfigFile } from "../../mcp/config-writer";
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

export class McpOAuthService implements DaemonService {
	readonly key = "mcpOAuth";
	readonly routes = {
		"mcp.oauth.start": "startFlow",
		"mcp.oauth.status": "status",
		"mcp.oauth.cancel": "cancel",
	} as const;

	readonly #deps: McpOAuthServiceDeps;
	readonly #flows = new Map<string, McpOAuthFlowRecord>();

	constructor(deps: McpOAuthServiceDeps) {
		this.#deps = deps;
	}

	/**
	 * RPC mcp.oauth.start：为一个已配置的 http/sse 服务器开始浏览器授权。
	 * 返回的 authorizationUrl 只发给发起请求的 GUI；真实登录在后台继续，
	 * 状态由 `mcp.oauth.status` 轮询。
	 */
	async startFlow(params: { name?: unknown }): Promise<{ flowId: string; authorizationUrl: string }> {
		const name = readString(params?.name);
		if (!name) throw new Error("name required");
		const { config, url } = await this.#resolveServer(name);
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
				redirectUri: config.oauth?.redirectUri,
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
		const record: McpOAuthFlowRecord = { flowId, server: name, status: "pending", controller };
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

	/** RPC mcp.oauth.status：轮询一条流程的 pending/success/error。 */
	status(params: { flowId?: unknown }): McpOAuthStatus {
		const record = this.#record(params);
		return this.#project(record);
	}

	/** RPC mcp.oauth.cancel：中止一条仍在等待浏览器回调的流程。 */
	cancel(params: { flowId?: unknown }): McpOAuthStatus & { ok: true } {
		const record = this.#record(params);
		if (record.status === "pending") {
			record.cancelled = true;
			record.status = "error";
			record.error = "MCP OAuth login cancelled";
			record.controller.abort("MCP OAuth login cancelled");
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
	}

	#fail(record: McpOAuthFlowRecord, error: unknown): void {
		// A cancel already published its own terminal state; the abort it caused
		// must not overwrite it with the internal abort reason.
		if (record.cancelled || record.status === "error") return;
		record.status = "error";
		record.error = describeError(error);
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
		logger.info("MCP OAuth login completed", { server: record.server, flowId: record.flowId });
	}

	async #resolveServer(name: string): Promise<{
		config: MCPHttpServerConfig | MCPSseServerConfig;
		url: string;
	}> {
		const cwd = this.#deps.cwd();
		const { configs } = await loadAllMCPConfigs(cwd);
		const config = configs[name] ?? (await this.#readConfiguredServer(name, cwd));
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
