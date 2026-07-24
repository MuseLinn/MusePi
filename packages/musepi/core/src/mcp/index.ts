// MusePi MCP — public surface (pure core, zero host imports).

export {
	bridgeMcpServerTools,
	mcpToolName,
	mcpToolResultToText,
	resolveMcpServers,
	sanitizeMcpNamePart,
} from "./bridge.ts";
export type { BridgedMcpTool, McpServerSettingsEntry, ResolvedMcpServers } from "./bridge.ts";
export { McpClient } from "./client.ts";
export type { McpClientOptions } from "./client.ts";
export { JsonRpcPeer } from "./json-rpc.ts";
export type { JsonRpcPeerOptions, McpTransport } from "./json-rpc.ts";
export { McpRegistry } from "./registry.ts";
export type { McpRegistryOptions } from "./registry.ts";
export { HttpMcpTransport } from "./transport-http.ts";
export type { HttpTransportOptions } from "./transport-http.ts";
export { mcpNodeSpawn, StdioMcpTransport } from "./transport-stdio.ts";
export type { McpSpawnedProcess, McpSpawnFn, StdioTransportOptions } from "./transport-stdio.ts";
export { MCP_PROTOCOL_VERSION } from "./types.ts";
export type {
	McpCallToolResult,
	McpConnectionStatus,
	McpContentItem,
	McpHttpServerConfig,
	McpInitializeResult,
	McpJsonRpcError,
	McpJsonRpcMessage,
	McpJsonRpcNotification,
	McpJsonRpcRequest,
	McpJsonRpcResponse,
	McpServerStatusInfo,
	McpStdioServerConfig,
	McpTool,
	McpToolsListResult,
	ResolvedMcpServer,
} from "./types.ts";
