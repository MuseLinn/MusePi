// ============================================================
// MusePi MCP — client: initialize handshake + tools surface.
//
// One McpClient wraps one transport + JSON-RPC peer. connect()
// performs the initialize handshake (protocol version, clientInfo,
// roots capability) and sends notifications/initialized; listTools
// paginates via cursor; callTool is a plain tools/call request.
// notifications/tools/list_changed triggers a re-list and fires the
// onToolsChanged listener so the host can re-sync registrations.
// ============================================================

import { JsonRpcPeer, type McpTransport } from "./json-rpc.ts";
import { HttpMcpTransport } from "./transport-http.ts";
import { type McpSpawnFn, StdioMcpTransport } from "./transport-stdio.ts";
import {
	MCP_PROTOCOL_VERSION,
	type McpCallToolResult,
	type McpInitializeResult,
	type McpTool,
	type McpToolsListResult,
	type ResolvedMcpServer,
} from "./types.ts";

const INIT_TIMEOUT_MS = 30_000;

export interface McpClientOptions {
	cwd: string;
	spawnFn?: McpSpawnFn;
	fetchFn?: typeof fetch;
	/** Fired after a (re-)enumeration, including the initial one. */
	onToolsChanged?: (tools: McpTool[]) => void;
	/** Fired when the transport drops (server exit / network close). */
	onClose?: () => void;
}

export class McpClient {
	readonly server: ResolvedMcpServer;
	readonly createdAt = Date.now();
	lastActivity = Date.now();
	status: "connecting" | "ready" | "error" | "stopped" = "connecting";
	serverInfo: { name?: string; version?: string } | undefined;
	tools: McpTool[] = [];

	#peer: JsonRpcPeer;
	#options: McpClientOptions;

	private constructor(server: ResolvedMcpServer, transport: McpTransport, options: McpClientOptions) {
		this.server = server;
		this.#options = options;
		this.#peer = new JsonRpcPeer(transport, {
			onServerRequest: (request) => {
				if (request.method === "ping") return {};
				if (request.method === "roots/list") {
					return { roots: [{ uri: `file://${options.cwd}`, name: options.cwd.split(/[\\/]/).pop() ?? "workspace" }] };
				}
				throw new Error(`Method not found: ${request.method}`);
			},
			onNotification: (notification) => {
				if (notification.method === "notifications/tools/list_changed") {
					void this.refreshTools().catch(() => {});
				}
			},
			onClose: () => {
				this.status = "stopped";
				options.onClose?.();
			},
		});
	}

	/** Spawn/connect + initialize. Throws on handshake failure. */
	static async connect(server: ResolvedMcpServer, options: McpClientOptions, signal?: AbortSignal): Promise<McpClient> {
		const transport: McpTransport =
			server.transport === "stdio"
				? new StdioMcpTransport(
						{ command: server.command, args: server.args, env: server.env, cwd: options.cwd },
						options.spawnFn,
					)
				: new HttpMcpTransport({ url: server.url, headers: server.headers, fetchFn: options.fetchFn });

		const client = new McpClient(server, transport, options);
		const peer = client.#peer;

		try {
			const result = (await peer.request(
				"initialize",
				{
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: { roots: { listChanged: false } },
					clientInfo: { name: "musepi", version: "0.1.0" },
				},
				{ timeoutMs: INIT_TIMEOUT_MS, signal },
			)) as McpInitializeResult | null;
			if (!result) throw new Error("no response to initialize");
			client.serverInfo = result.serverInfo;
			await peer.notify("notifications/initialized");
			client.status = "ready";
			await client.refreshTools(signal);
			return client;
		} catch (error) {
			client.status = "error";
			transport.close();
			throw error;
		}
	}

	/** Re-enumerate tools/list (paginated); fires onToolsChanged. */
	async refreshTools(signal?: AbortSignal): Promise<McpTool[]> {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 50; page++) {
			const result = (await this.#peer.request(
				"tools/list",
				cursor ? { cursor } : {},
				{ signal },
			)) as McpToolsListResult | null;
			tools.push(...(result?.tools ?? []));
			if (!result?.nextCursor) break;
			cursor = result.nextCursor;
		}
		this.tools = tools;
		this.lastActivity = Date.now();
		this.#options.onToolsChanged?.(tools);
		return tools;
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<McpCallToolResult> {
		if (this.status !== "ready") throw new Error(`MCP server ${this.server.name} is not connected`);
		this.lastActivity = Date.now();
		const result = (await this.#peer.request(
			"tools/call",
			{ name, arguments: args },
			{ timeoutMs: options.timeoutMs, signal: options.signal },
		)) as McpCallToolResult | null;
		return result ?? {};
	}

	get closed(): boolean {
		return this.#peer.closed;
	}

	async close(): Promise<void> {
		if (this.status === "stopped") return;
		this.status = "stopped";
		this.#peer.close();
	}
}
