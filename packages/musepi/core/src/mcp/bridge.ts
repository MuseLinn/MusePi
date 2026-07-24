// ============================================================
// MusePi MCP — tool bridging (pure).
//
// MCP tools become agent tools under the `mcp_<server>_<tool>`
// namespace so they can never collide with builtins or with each
// other across servers. Names are sanitized to [a-z0-9_]; collisions
// WITHIN one server (after sanitization) get a numeric suffix.
// Result conversion flattens MCP content items into plain text the
// model can read; isError is surfaced so the host can throw.
// ============================================================

import type { McpCallToolResult, McpTool, ResolvedMcpServer } from "./types.ts";

/** Sanitize one name segment to [a-z0-9_]; empty falls back to a placeholder. */
export function sanitizeMcpNamePart(value: string, fallback: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	return sanitized.length > 0 ? sanitized : fallback;
}

/** Namespaced agent tool name: `mcp_<server>_<tool>`. */
export function mcpToolName(serverName: string, toolName: string): string {
	return `mcp_${sanitizeMcpNamePart(serverName, "server")}_${sanitizeMcpNamePart(toolName, "tool")}`;
}

export interface BridgedMcpTool {
	/** Final agent-facing tool name (namespaced, collision-free). */
	name: string;
	serverName: string;
	/** Original MCP tool name (used in tools/call). */
	toolName: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/**
 * Bridge one server's tool list into agent tool descriptors. Within a
 * server, names that sanitize to the same value get `_2`, `_3`, …
 * suffixes (deterministic in list order).
 */
export function bridgeMcpServerTools(serverName: string, tools: McpTool[]): BridgedMcpTool[] {
	const used = new Set<string>();
	const out: BridgedMcpTool[] = [];
	for (const tool of tools) {
		let name = mcpToolName(serverName, tool.name);
		for (let suffix = 2; used.has(name); suffix++) name = `${mcpToolName(serverName, tool.name)}_${suffix}`;
		used.add(name);
		const inputSchema =
			tool.inputSchema && typeof tool.inputSchema === "object"
				? tool.inputSchema
				: { type: "object", properties: {} };
		const description =
			typeof tool.description === "string" && tool.description.length > 0
				? `[MCP:${serverName}] ${tool.description}`
				: `[MCP:${serverName}] ${tool.name}`;
		out.push({ name, serverName, toolName: tool.name, description, inputSchema });
	}
	return out;
}

/**
 * Flatten an MCP tools/call result into text: text items are joined;
 * images/audio/other binary items become placeholder notes; embedded
 * resources contribute their text (or a uri note). Structured content
 * with no content items is JSON-serialized.
 */
export function mcpToolResultToText(result: McpCallToolResult): { text: string; isError: boolean } {
	const parts: string[] = [];
	for (const item of result.content ?? []) {
		if (!item || typeof item !== "object") continue;
		switch (item.type) {
			case "text":
				if (typeof item.text === "string") parts.push(item.text);
				break;
			case "image":
				parts.push(`[image: ${item.mimeType ?? "unknown type"} — binary content not shown]`);
				break;
			case "audio":
				parts.push(`[audio: ${item.mimeType ?? "unknown type"} — binary content not shown]`);
				break;
			case "resource": {
				const resource = item.resource;
				if (resource && typeof resource.text === "string") parts.push(resource.text);
				else parts.push(`[resource: ${resource?.uri ?? item.uri ?? "unknown"}]`);
				break;
			}
			default:
				if (typeof item.text === "string") parts.push(item.text);
				else parts.push(`[${item.type ?? "unknown"} content item]`);
		}
	}
	if (parts.length === 0 && result.structuredContent !== undefined) {
		parts.push(JSON.stringify(result.structuredContent, null, 2));
	}
	return { text: parts.join("\n"), isError: result.isError === true };
}

// =============================================================================
// Server config resolution (settings record → typed configs + invalid notes)
// =============================================================================

export interface McpServerSettingsEntry {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	enabled?: boolean;
}

export interface ResolvedMcpServers {
	servers: ResolvedMcpServer[];
	/** Entries that could not be resolved (reported by /mcp status). */
	invalid: Array<{ name: string; reason: string }>;
	/** Names explicitly disabled via `enabled: false`. */
	disabled: string[];
}

/**
 * Resolve the settings record into typed server configs. `command`
 * selects stdio, `url` selects streamable HTTP; both or neither is
 * invalid. Unknown/mistyped fields are dropped by the settings merge
 * upstream, so this pass only validates the shape.
 */
export function resolveMcpServers(record: Record<string, McpServerSettingsEntry>): ResolvedMcpServers {
	const servers: ResolvedMcpServer[] = [];
	const invalid: Array<{ name: string; reason: string }> = [];
	const disabled: string[] = [];
	for (const [name, entry] of Object.entries(record)) {
		if (entry.enabled === false) {
			disabled.push(name);
			continue;
		}
		const hasCommand = typeof entry.command === "string" && entry.command.length > 0;
		const hasUrl = typeof entry.url === "string" && entry.url.length > 0;
		if (hasCommand && hasUrl) {
			invalid.push({ name, reason: "both command and url set — pick one transport" });
			continue;
		}
		if (hasCommand) {
			servers.push({ transport: "stdio", name, command: entry.command as string, args: entry.args, env: entry.env });
			continue;
		}
		if (hasUrl) {
			servers.push({ transport: "http", name, url: entry.url as string, headers: entry.headers });
			continue;
		}
		invalid.push({ name, reason: "neither command (stdio) nor url (http) set" });
	}
	return { servers, invalid, disabled };
}
