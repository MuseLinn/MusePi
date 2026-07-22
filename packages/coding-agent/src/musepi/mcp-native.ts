// ============================================================
// MusePi native MCP (Model Context Protocol) — host seam.
//
// The engine (JSON-RPC peer, stdio/HTTP transports, client, lazy
// registry, tool bridging) lives in @musepi/core/mcp with zero pi
// imports. This module owns the fork-side glue:
//   1. settings: musepi.mcp.servers (stdio {command,args,env} or
//      streamable-HTTP {url,headers}), master switch, idle reaping;
//   2. lazy connect: servers connect on the first actual tool call
//      (or /mcp reconnect), never at session start; a per-server
//      failure degrades gracefully with the server name in the error;
//   3. tool bridging: enumerated tools register dynamically as
//      `mcp_<server>_<tool>` (AgentSession.registerDynamicTools) with
//      the MCP inputSchema passed through (Type.Unsafe); results are
//      flattened to text and oversized results spill through the
//      existing truncation module; isError throws on pi's tool-error
//      channel;
//   4. W7 coordination: with musepi.toolSelect on, freshly registered
//      MCP tools join the deferred set (deferToolsViaToolSelect) so
//      they appear in the select_tools loadable list instead of the
//      top-level tools[];
//   5. permission: every MCP call runs through the shared
//      permissionManager policy chain (manual mode → approval dialog
//      in the TUI, explicit block when unattended);
//   6. /mcp command surface (list/status/reconnect) — see
//      handleMusepiMcpCommand; add/remove is editing settings.json.
//
// Tool-list cache: freshly enumerated tools are written to
// <agentDir>/mcp-tool-cache.json; on the next session the tools
// register from cache WITHOUT connecting (pure lazy), and the first
// real call re-validates against the live server.
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type BridgedMcpTool,
	bridgeMcpServerTools,
	buildTruncatedPreview,
	McpRegistry,
	mcpToolResultToText,
	resolveMcpServers,
	shouldTruncate,
	truncationPathFor,
} from "@musepi/core";
import { permissionManager } from "@musepi/core/permission/index.js";
import { Type } from "typebox";
import { getAgentDir } from "../config.ts";
import type { AgentSession } from "../core/agent-session.ts";
import type { ToolDefinition } from "../core/extensions/index.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { deferToolsViaToolSelect, undeferToolsViaToolSelect } from "./tool-select-native.ts";

// =============================================================================
// Binding (module singleton, goalManager pattern)
// =============================================================================

interface McpBinding {
	enabled: boolean;
	cwd: string;
	registry: McpRegistry;
	session: AgentSession;
	/** Bridged tools currently registered, keyed by server name. */
	registeredByServer: Map<string, BridgedMcpTool[]>;
	invalid: Array<{ name: string; reason: string }>;
	disabled: string[];
	startupDiscovery: boolean;
	cachePath: string;
	unsubToolsChanged: (() => void) | null;
}

let binding: McpBinding | null = null;

// =============================================================================
// Tool-list cache
// =============================================================================

interface McpToolCacheFile {
	version: 1;
	/** serverName → config fingerprint → bridged tools. */
	servers: Record<string, { fingerprint: string; tools: BridgedMcpTool[] }>;
}

function fingerprintOf(registry: McpRegistry, serverName: string): string {
	const status = registry.statuses().find((s) => s.name === serverName);
	return status?.endpoint ?? "";
}

function readToolCache(cachePath: string): McpToolCacheFile {
	try {
		const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as McpToolCacheFile;
		if (raw && raw.version === 1 && raw.servers && typeof raw.servers === "object") return raw;
	} catch {
		// missing/corrupt cache — treated as empty
	}
	return { version: 1, servers: {} };
}

function writeToolCache(cachePath: string, cache: McpToolCacheFile): void {
	try {
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
	} catch {
		// cache writes are best-effort — never break the session
	}
}

function persistServerTools(b: McpBinding, serverName: string, tools: BridgedMcpTool[]): void {
	const cache = readToolCache(b.cachePath);
	cache.servers[serverName] = { fingerprint: fingerprintOf(b.registry, serverName), tools };
	writeToolCache(b.cachePath, cache);
}

// =============================================================================
// Dynamic tool registration
// =============================================================================

function buildToolDefinition(b: McpBinding, tool: BridgedMcpTool): ToolDefinition {
	return {
		name: tool.name,
		label: `MCP ${tool.serverName}: ${tool.toolName}`,
		description: tool.description,
		parameters: Type.Unsafe<Record<string, unknown>>({ ...tool.inputSchema }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Permission chain first: manual mode asks (TUI dialog), unattended
			// asks degrade to an explicit NOT-executed block.
			const verdict = await permissionManager.evaluate(tool.name, params as Record<string, unknown>, b.cwd, {
				hasUI: ctx?.hasUI ?? false,
				ui: ctx?.ui,
				sessionManager: ctx?.sessionManager,
				signal,
			});
			if (verdict?.block) throw new Error(verdict.reason);

			const result = await b.registry.callTool(tool.serverName, tool.toolName, params as Record<string, unknown>, {
				signal,
			});
			const { text, isError } = mcpToolResultToText(result);
			if (isError) throw new Error(text || `MCP tool ${tool.toolName} reported an error`);
			if (shouldTruncate(text)) {
				const outputPath = truncationPathFor(os.tmpdir(), tool.name, _toolCallId);
				try {
					fs.mkdirSync(path.dirname(outputPath), { recursive: true });
					fs.writeFileSync(outputPath, text);
					return {
						content: [{ type: "text" as const, text: buildTruncatedPreview(text, outputPath) }],
						details: {},
					};
				} catch {
					// spill failed — fall through to the untruncated result
				}
			}
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	};
}

/**
 * (Re)register one server's bridged tools: replace the dynamic tool set for
 * that server, coordinate the W7 deferred set, and refresh the cache.
 */
function syncServerTools(b: McpBinding, serverName: string, tools: BridgedMcpTool[]): void {
	const previous = b.registeredByServer.get(serverName) ?? [];
	const previousNames = new Set(previous.map((t) => t.name));
	const nextNames = new Set(tools.map((t) => t.name));
	const removed = [...previousNames].filter((name) => !nextNames.has(name));

	if (removed.length > 0) {
		b.session.unregisterDynamicTools(removed);
		undeferToolsViaToolSelect(removed);
	}
	if (tools.length > 0) {
		b.session.registerDynamicTools(tools.map((tool) => buildToolDefinition(b, tool)));
		// W7: with the gate on, MCP tools join the deferred loadable set
		// instead of the top-level tools[] (dynamic registration activates
		// new tools by default — defer after registering).
		deferToolsViaToolSelect(tools.map((t) => t.name));
	}
	if (tools.length > 0) b.registeredByServer.set(serverName, tools);
	else b.registeredByServer.delete(serverName);
	persistServerTools(b, serverName, tools);
}

/** Drop every MCP tool registration (feature switched off / session end). */
function clearAllTools(b: McpBinding): void {
	const names = [...b.registeredByServer.values()].flat().map((t) => t.name);
	if (names.length > 0) {
		b.session.unregisterDynamicTools(names);
		undeferToolsViaToolSelect(names);
	}
	b.registeredByServer.clear();
}

// =============================================================================
// Session init
// =============================================================================

/**
 * Bind MCP for one session: resolve configured servers, arm lazy connect
 * + idle reaping, register cached tool lists WITHOUT connecting, and
 * (optionally) kick off background discovery. Called once per session
 * right after AgentSession construction.
 */
export function initMusepiMcp(session: AgentSession, settingsManager: SettingsManager): void {
	const config = settingsManager.getMusepi().mcp;
	const cwd = session.sessionManager.getCwd();

	binding?.unsubToolsChanged?.();
	const registry = binding?.registry ?? new McpRegistry({ cwd });
	registry.setIdleTimeout(config.idleTimeoutMs);

	const resolved = config.enabled ? resolveMcpServers(config.servers) : { servers: [], invalid: [], disabled: [] };
	registry.setServers(resolved.servers);

	binding = {
		enabled: config.enabled,
		cwd,
		registry,
		session,
		registeredByServer: new Map(),
		invalid: resolved.invalid,
		disabled: resolved.disabled,
		startupDiscovery: config.startupDiscovery,
		cachePath: path.join(getAgentDir(), "mcp-tool-cache.json"),
		unsubToolsChanged: null,
	};
	const b = binding;

	if (!config.enabled) return;

	// Live enumerations re-sync registrations (initial connect, reconnect,
	// notifications/tools/list_changed).
	b.unsubToolsChanged = registry.onToolsChanged((serverName, tools) => {
		if (binding !== b) return; // stale session
		try {
			syncServerTools(b, serverName, bridgeMcpServerTools(serverName, tools));
		} catch {
			// registration failures must not break the connection callback
		}
	});

	// Pure lazy default: register from the on-disk cache (no connection);
	// the first actual tool call connects and re-validates.
	const cache = readToolCache(b.cachePath);
	for (const server of resolved.servers) {
		const cached = cache.servers[server.name];
		if (!cached || cached.tools.length === 0) continue;
		const endpoint = fingerprintOf(registry, server.name);
		if (cached.fingerprint !== endpoint) continue; // config changed — distrust
		try {
			syncServerTools(b, server.name, cached.tools);
		} catch {
			// a poisoned cache entry must not break session init
		}
	}

	// Optional: enumerate every server in the background so its tools
	// appear without a first manual call. Fire-and-forget; failures are
	// negative-cached by the registry and surface via /mcp status.
	if (config.startupDiscovery) {
		for (const server of resolved.servers) {
			void registry.ensureConnected(server.name).catch(() => {});
		}
	}
}

/** Session-end hook: unregister tools but keep warm connections reusable. */
export function shutdownMusepiMcp(): void {
	if (!binding) return;
	binding.unsubToolsChanged?.();
	if (binding.enabled) clearAllTools(binding);
	binding = null;
}

/** Close every live MCP connection (process exit, tests). */
export async function shutdownMusepiMcpConnections(): Promise<void> {
	await binding?.registry.shutdownAll().catch(() => {});
}

// =============================================================================
// /mcp command surface
// =============================================================================

function formatUptime(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function renderStatus(b: McpBinding): string {
	const lines: string[] = [];
	const statuses = b.registry.statuses();
	if (statuses.length === 0 && b.invalid.length === 0 && b.disabled.length === 0) {
		lines.push("No MCP servers configured.");
	} else {
		for (const status of statuses) {
			const state =
				status.status === "connected"
					? `connected · ${status.toolCount} tools · up ${formatUptime(status.uptimeMs ?? 0)}`
					: status.status === "error"
						? `error: ${status.lastError ?? "unknown"}`
						: status.status;
			lines.push(`${status.name} [${status.transport}] ${state}`);
			lines.push(`  ${status.endpoint}`);
			const registered = b.registeredByServer.get(status.name) ?? [];
			if (registered.length > 0 && status.status !== "connected") {
				lines.push(`  ${registered.length} tools registered from cache (connects on first call)`);
			}
		}
		for (const entry of b.invalid) lines.push(`${entry.name}: invalid config — ${entry.reason}`);
		for (const name of b.disabled) lines.push(`${name}: disabled`);
	}
	lines.push("");
	lines.push("Add/remove servers by editing settings.json (musepi.mcp.servers), then /mcp reconnect <name>.");
	return lines.join("\n");
}

/**
 * Handle `/mcp [list|status|reconnect [name]]`. Returns the text to
 * display; reconnect is async (connect + enumerate + register).
 */
export async function handleMusepiMcpCommand(args: string): Promise<string> {
	if (!binding) return "MCP is not initialized for this session.";
	const b = binding;
	if (!b.enabled) return "MCP integration is disabled (musepi.mcp.enabled = false).";

	const [action, target] = args.trim().split(/\s+/, 2);
	switch (action ?? "") {
		case "":
		case "list":
		case "status":
			return renderStatus(b);
		case "reconnect": {
			const names = target ? [target] : b.registry.serverNames();
			if (names.length === 0) return "No MCP servers configured.";
			const lines: string[] = [];
			for (const name of names) {
				try {
					b.registry.clearFailure(name);
					const client = await b.registry.reconnect(name);
					lines.push(`${name}: connected · ${client.tools.length} tools`);
				} catch (error) {
					lines.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return lines.join("\n");
		}
		default:
			return `Unknown /mcp action "${action}". Usage: /mcp [list|status|reconnect [name]]`;
	}
}
