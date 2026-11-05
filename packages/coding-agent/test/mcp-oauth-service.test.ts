/**
 * McpOAuthService — daemon-side MCP OAuth login state machine.
 *
 * Everything here runs the real machinery: a real `MCPOAuthFlow` binds a real
 * loopback callback server, a real `AuthStorage` row is written, and the real
 * connector reload hook fires. The provider is a local `Bun.serve` fixture, so
 * "the browser completed the grant" is an actual HTTP callback to the flow's
 * `redirect_uri` rather than a mocked `login()`.
 *
 * Pinned contracts:
 *  1. `start` returns the authorization URL before the grant exists, with PKCE
 *     and the flow's `state`; the flow stays `pending` while it waits.
 *  2. The callback completes the exchange and stores a self-contained grant
 *     under `mcpOAuthCredentialId(serverUrl)`, then reloads connectors — the
 *     two steps the GUI's "login succeeded" depends on.
 *  3. A challenge-only server (no published metadata) still resolves through
 *     the unauthenticated probe + `analyzeAuthError`.
 *  4. Cancel and provider rejection both land as `error`, and a cancelled
 *     flow never overwrites its own terminal state afterwards.
 *  5. Stdio/unknown/no-auth servers fail `start` with an actionable message
 *     instead of leaving a pending flow behind.
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { McpOAuthService } from "../src/daemon/services/mcp-oauth-service";
import { type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "../src/mcp/oauth-flow";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

interface ProviderOptions {
	/** Serve `/.well-known/oauth-authorization-server` (default true). */
	metadata?: boolean;
	/** Advertise `resource_metadata` on the 401 challenge (default false). */
	challenge?: boolean;
	/** Let an unauthenticated MCP initialize succeed (default false). */
	allowAnonymous?: boolean;
	/** Token endpoint status; non-2xx exercises the rejected-grant path. */
	tokenStatus?: number;
}

interface Provider {
	origin: string;
	serverUrl: string;
	tokenRequests: URLSearchParams[];
	stop(): void;
}

/**
 * Local authorization server + MCP endpoint for one test.
 *
 * `challenge: true` splits the two roles onto separate origins: the MCP server
 * publishes only a 401 + `resource_metadata` pointer, so discovery can only
 * succeed through the probe → protected-resource → auth-server chain (the
 * well-known document lives on a different origin than the MCP URL).
 */
function startProvider(options: ProviderOptions = {}): Provider {
	const tokenRequests: URLSearchParams[] = [];
	const tokenResponse = (): Response => {
		if (options.tokenStatus && options.tokenStatus >= 400) {
			return Response.json({ error: "invalid_grant" }, { status: options.tokenStatus });
		}
		return Response.json({
			access_token: "access-token-value",
			refresh_token: "refresh-token-value",
			expires_in: 3600,
			token_type: "Bearer",
		});
	};
	const metadata = (origin: string): Response =>
		Response.json({
			issuer: origin,
			authorization_endpoint: `${origin}/authorize`,
			token_endpoint: `${origin}/token`,
			scopes_supported: ["mcp.read"],
			client_id: "test-client",
		});

	const authServer = options.challenge
		? Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const url = new URL(request.url);
					if (url.pathname === "/.well-known/oauth-authorization-server") return metadata(url.origin);
					if (url.pathname === "/authorize") return new Response("authorize", { status: 200 });
					if (url.pathname === "/token") {
						tokenRequests.push(new URLSearchParams(await request.text()));
						return tokenResponse();
					}
					return new Response("not found", { status: 404 });
				},
			})
		: undefined;
	const authOrigin = authServer ? `http://127.0.0.1:${authServer.port}` : "";

	const mcpServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const origin = url.origin;

			if (url.pathname === "/.well-known/oauth-authorization-server") {
				if (options.metadata === false) return new Response("not found", { status: 404 });
				return metadata(origin);
			}
			if (url.pathname === "/prm") {
				return Response.json({
					resource: `${origin}/mcp`,
					authorization_servers: [authOrigin],
					scopes_supported: ["mcp.read"],
				});
			}
			if (url.pathname === "/authorize") {
				return new Response("authorize", { status: 200 });
			}
			if (url.pathname === "/token") {
				tokenRequests.push(new URLSearchParams(await request.text()));
				return tokenResponse();
			}
			if (url.pathname === "/mcp") {
				if (request.method === "GET") {
					// No server-initiated stream; the transport treats 405 as
					// "SSE listener unsupported" and continues.
					return new Response("method not allowed", { status: 405 });
				}
				const body = (await request.json().catch(() => null)) as { method?: string; id?: number } | null;
				if (options.allowAnonymous) {
					if (body?.method === "initialize") {
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								protocolVersion: "2025-11-25",
								capabilities: {},
								serverInfo: { name: "fixture", version: "1.0.0" },
							},
						});
					}
					return new Response(null, { status: 202 });
				}
				const challenge = options.challenge ? `Bearer resource_metadata="${origin}/prm"` : 'Bearer realm="mcp"';
				return new Response("unauthorized", {
					status: 401,
					headers: { "WWW-Authenticate": challenge },
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	const origin = authServer ? authOrigin : `http://127.0.0.1:${mcpServer.port}`;
	return {
		origin,
		serverUrl: `http://127.0.0.1:${mcpServer.port}/mcp`,
		tokenRequests,
		stop: () => {
			mcpServer.stop(true);
			authServer?.stop(true);
		},
	};
}

interface Harness {
	service: McpOAuthService;
	storage: AuthStorage;
	reloads: number;
	projectDir: string;
}

let agentDir = "";
const openStorages: AuthStorage[] = [];
const tempDirs: string[] = [];
const providers: Provider[] = [];

async function createHarness(servers: Record<string, unknown>): Promise<Harness> {
	const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-mcp-oauth-"));
	tempDirs.push(projectDir);
	await fs.mkdir(path.join(projectDir, ".musepi"), { recursive: true });
	await Bun.write(
		path.join(projectDir, ".musepi", "mcp.json"),
		`${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
	);
	const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	openStorages.push(storage);
	await storage.reload();
	const harness: Harness = { service: null as unknown as McpOAuthService, storage, reloads: 0, projectDir };
	harness.service = new McpOAuthService({
		cwd: () => projectDir,
		authStorage: async () => storage,
		reloadConnectors: async () => {
			harness.reloads += 1;
		},
	});
	return harness;
}

/** Wait for a terminal status; the exchange runs off the RPC reply path. */
async function settled(
	service: McpOAuthService,
	flowId: string,
	timeoutMs = 5000,
): Promise<{ status: string; error?: string; cancelled?: boolean }> {
	const deadline = Date.now() + timeoutMs;
	let last = service.status({ flowId });
	while (last.status === "pending" && Date.now() < deadline) {
		await Bun.sleep(20);
		last = service.status({ flowId });
	}
	return last;
}

/** Complete the grant the way a browser would: hit the flow's redirect URI. */
async function completeBrowserCallback(authorizationUrl: string, code: string): Promise<number> {
	const auth = new URL(authorizationUrl);
	const redirectUri = auth.searchParams.get("redirect_uri");
	const state = auth.searchParams.get("state");
	expect(redirectUri).toBeTruthy();
	expect(state).toBeTruthy();
	const callback = new URL(redirectUri!);
	// The flow binds both loopback literals; target IPv4 explicitly so this does
	// not depend on whether `localhost` resolves to ::1 first on the host.
	callback.hostname = "127.0.0.1";
	callback.searchParams.set("code", code);
	callback.searchParams.set("state", state!);
	const response = await fetch(callback);
	await response.text();
	return response.status;
}

beforeEach(async () => {
	agentDir = await isolateAgentDirForTest("musepi-mcp-oauth-agent-");
});

afterEach(async () => {
	while (providers.length > 0) providers.pop()?.stop();
	while (openStorages.length > 0) openStorages.pop()?.close();
	while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

afterAll(async () => {
	await restoreAgentDirForTest(agentDir);
}, 30_000);

describe("McpOAuthService", () => {
	it("returns the authorization URL while pending, then stores the grant and reloads", async () => {
		const provider = startProvider();
		providers.push(provider);
		const harness = await createHarness({
			"oauth-server": { type: "http", url: provider.serverUrl },
		});

		const started = await harness.service.startFlow({ name: "oauth-server" });
		expect(started.flowId).toBeTruthy();
		const auth = new URL(started.authorizationUrl);
		expect(auth.origin).toBe(provider.origin);
		expect(auth.pathname).toBe("/authorize");
		expect(auth.searchParams.get("response_type")).toBe("code");
		expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
		expect(auth.searchParams.get("code_challenge")).toBeTruthy();
		expect(auth.searchParams.get("state")).toBeTruthy();
		expect(auth.searchParams.get("scope")).toBe("mcp.read");
		expect(auth.searchParams.get("client_id")).toBe("test-client");
		// Nothing is stored before the browser completes the grant.
		expect(harness.storage.get(mcpOAuthCredentialId(provider.serverUrl))).toBeUndefined();
		expect(harness.service.status({ flowId: started.flowId })).toMatchObject({
			flowId: started.flowId,
			server: "oauth-server",
			status: "pending",
		});

		expect(await completeBrowserCallback(started.authorizationUrl, "auth-code-1")).toBe(200);

		const done = await settled(harness.service, started.flowId);
		expect(done).toMatchObject({ status: "success" });
		expect(done.error).toBeUndefined();

		const credential = harness.storage.get(mcpOAuthCredentialId(provider.serverUrl)) as MCPStoredOAuthCredential;
		expect(credential).toMatchObject({
			type: "oauth",
			access: "access-token-value",
			refresh: "refresh-token-value",
			tokenUrl: `${provider.origin}/token`,
			clientId: "test-client",
			authorizationUrl: `${provider.origin}/authorize`,
		});
		expect(credential.expires).toBeGreaterThan(Date.now());

		// Token exchange carries the PKCE verifier and the code from the callback.
		expect(provider.tokenRequests).toHaveLength(1);
		const tokenRequest = provider.tokenRequests[0]!;
		expect(tokenRequest.get("grant_type")).toBe("authorization_code");
		expect(tokenRequest.get("code")).toBe("auth-code-1");
		expect(tokenRequest.get("code_verifier")).toBeTruthy();
		expect(tokenRequest.get("redirect_uri")).toContain("/callback");
		// Same-origin server-URL fallback resource is stripped (TUI parity), so a
		// gateway that rejects self-referential audiences keeps working.
		expect(tokenRequest.get("resource")).toBeNull();

		expect(harness.reloads).toBe(1);
	});

	it("resolves endpoints from a 401 challenge when no metadata is published", async () => {
		const provider = startProvider({ metadata: false, challenge: true });
		providers.push(provider);
		const harness = await createHarness({
			"challenge-server": { type: "http", url: provider.serverUrl },
		});

		const started = await harness.service.startFlow({ name: "challenge-server" });
		const auth = new URL(started.authorizationUrl);
		expect(auth.origin).toBe(provider.origin);
		expect(auth.searchParams.get("scope")).toBe("mcp.read");
		expect(auth.searchParams.get("client_id")).toBe("test-client");

		expect(await completeBrowserCallback(started.authorizationUrl, "auth-code-2")).toBe(200);
		expect(await settled(harness.service, started.flowId)).toMatchObject({ status: "success" });
		expect(harness.storage.get(mcpOAuthCredentialId(provider.serverUrl))).toMatchObject({
			type: "oauth",
			access: "access-token-value",
		});
	});

	it("cancel aborts a pending flow and never lets the late failure overwrite it", async () => {
		const provider = startProvider();
		providers.push(provider);
		const harness = await createHarness({
			"oauth-server": { type: "http", url: provider.serverUrl },
		});

		const started = await harness.service.startFlow({ name: "oauth-server" });
		const cancelled = harness.service.cancel({ flowId: started.flowId });
		expect(cancelled).toMatchObject({ ok: true, status: "error", cancelled: true });
		expect(cancelled.error).toBeTruthy();

		// The abort settles the login promise; the status must stay cancelled
		// rather than turning into the internal abort reason.
		await Bun.sleep(50);
		expect(harness.service.status({ flowId: started.flowId })).toMatchObject({
			status: "error",
			cancelled: true,
		});
		expect(harness.storage.get(mcpOAuthCredentialId(provider.serverUrl))).toBeUndefined();
		expect(harness.reloads).toBe(0);
	});

	it("a rejected token exchange lands as an error and stores nothing", async () => {
		const provider = startProvider({ tokenStatus: 400 });
		providers.push(provider);
		const harness = await createHarness({
			"oauth-server": { type: "http", url: provider.serverUrl },
		});

		const started = await harness.service.startFlow({ name: "oauth-server" });
		expect(await completeBrowserCallback(started.authorizationUrl, "auth-code-3")).toBe(200);

		const failed = await settled(harness.service, started.flowId);
		expect(failed.status).toBe("error");
		expect(failed.cancelled).toBeUndefined();
		expect(failed.error).toContain("Token exchange failed");
		expect(harness.storage.get(mcpOAuthCredentialId(provider.serverUrl))).toBeUndefined();
		expect(harness.reloads).toBe(0);
	});

	it("rejects unknown, stdio, and no-auth servers without leaving a pending flow", async () => {
		const provider = startProvider({ metadata: false, allowAnonymous: true });
		providers.push(provider);
		const harness = await createHarness({
			"stdio-server": { type: "stdio", command: "node", args: ["server.js"] },
			"open-server": { type: "http", url: provider.serverUrl },
		});

		await expect(harness.service.startFlow({ name: "missing" })).rejects.toThrow(
			'MCP server "missing" is not configured',
		);
		await expect(harness.service.startFlow({ name: "stdio-server" })).rejects.toThrow(/http or sse server/);
		await expect(harness.service.startFlow({ name: "open-server" })).rejects.toThrow(
			/accepted an unauthenticated connection/,
		);
		// A failed start reports its reason instead of minting an unqueryable id.
		expect(() => harness.service.status({ flowId: "not-a-flow" })).toThrow("Unknown MCP OAuth flow");
	});
});
