// ============================================================
// MusePi MCP — shared types (pure, host-agnostic).
//
// Model Context Protocol (spec 2025-03-26): JSON-RPC 2.0 over stdio
// (newline-delimited JSON) or streamable HTTP. This feature speaks the
// client side of the tools surface: initialize handshake, tools/list
// (paginated), tools/call, plus the notifications a server may push.
// ============================================================

// ── JSON-RPC 2.0 ─────────────────────────────────────────────

export interface McpJsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: unknown;
}

export interface McpJsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface McpJsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface McpJsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: McpJsonRpcError;
}

export type McpJsonRpcMessage = McpJsonRpcRequest | McpJsonRpcNotification | McpJsonRpcResponse;

// ── MCP entities ─────────────────────────────────────────────

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface McpToolsListResult {
	tools?: McpTool[];
	nextCursor?: string;
}

export interface McpContentItem {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	uri?: string;
	resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
	[key: string]: unknown;
}

export interface McpCallToolResult {
	content?: McpContentItem[];
	structuredContent?: unknown;
	isError?: boolean;
	[key: string]: unknown;
}

export interface McpInitializeResult {
	protocolVersion?: string;
	capabilities?: Record<string, unknown>;
	serverInfo?: { name?: string; version?: string };
}

/** Protocol revision MusePi asks for; servers may answer with an older one. */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

// ── Server configuration ─────────────────────────────────────

/** stdio server: spawned as a child process speaking JSONL over stdin/stdout. */
export interface McpStdioServerConfig {
	transport: "stdio";
	name: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

/** Streamable-HTTP server: POST JSON-RPC to a single endpoint. */
export interface McpHttpServerConfig {
	transport: "http";
	name: string;
	url: string;
	headers?: Record<string, string>;
}

export type ResolvedMcpServer = McpStdioServerConfig | McpHttpServerConfig;

// ── Status ───────────────────────────────────────────────────

export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface McpServerStatusInfo {
	name: string;
	transport: "stdio" | "http";
	/** Where it connects to (command line or URL). */
	endpoint: string;
	status: McpConnectionStatus;
	/** Last connection/init error, sticky until a successful connect. */
	lastError?: string;
	toolCount: number;
	uptimeMs?: number;
}
