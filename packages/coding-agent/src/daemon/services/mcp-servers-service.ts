/**
 * McpServersService — user-level MCP connector configuration.
 *
 * `ConnectorService` answers "which servers may this session use" from the
 * running connection manager; this answers the other half the integrations
 * page needs: "which connectors are configured on this machine", with the
 * ability to add and remove one. The store is the user-scope
 * `<agentDir>/mcp.json` that the discovery layer and `/mcp add` already share,
 * so an install here is an ordinary connector configuration, not a second
 * registry.
 *
 * Capability seam (M2-2.4):
 * - Input: RPC `mcp.servers.list`, `mcp.servers.add`, `mcp.servers.remove`.
 * - Output: server summaries (name, transport, url/command, auth kind) and
 *   the applied name. `headers` are never returned: a token-typed connector
 *   keeps its token in this file, and the wire must not echo it back.
 * - Lifecycle: no cached state. Every call reads or writes the file through
 *   `mcp/config-writer`, whose per-file lock plus atomic rename serialize
 *   concurrent writers and keep unrelated entries intact. `probe` is the one
 *   live action: it performs a handshake on a config that never joins a
 *   session and releases the transport, so it leaves no server mounted.
 *   A probe may carry the form fields (`url`/`command`/…) or only `name`;
 *   the by-name form resolves an installed connector, injects its stored
 *   credentials through the live manager, and then hands it to the same
 *   handshake. Neither form returns headers, tokens, or credential ids.
 * - Conflict: none with ConnectorService — that reads the live manager, this
 *   owns the user-scope file.
 */

import * as path from "node:path";
import { type MCPProbeResult, probeServer } from "../../mcp/client";
import { addMCPServer, readMCPConfigFile, removeMCPServer, validateServerName } from "../../mcp/config-writer";
import type { MCPAuthConfig, MCPConfigFile, MCPServerConfig } from "../../mcp/types";
import type { DaemonService } from "./types";

/** One configured connector, safe to render and safe to put on the wire. */
export interface McpServerSummary {
	name: string;
	transport: "stdio" | "http" | "sse";
	url?: string;
	command?: string;
	auth?: MCPAuthConfig["type"];
	enabled?: boolean;
}

/** Live manager slice a by-name probe needs: the preserved config plus the
 *  same credential/OAuth injection a real connection performs. */
export interface MCPProbeManager {
	/** Config as discovered (pre-auth), or undefined for an unknown name. */
	getServerConfig(name: string): MCPServerConfig | undefined;
	/** Inject stored tokens/OAuth into a copy of the config. */
	prepareConfig(config: MCPServerConfig): Promise<MCPServerConfig>;
}

export interface McpServersServiceDeps {
	/** Absolute path of the user-scope config the service owns. */
	userConfigPath(): string;
	/** Reconcile live MCP managers after a write. Best-effort: an install
	 *  still succeeded even if a running server could not be restarted. */
	reloadConnectors?(): Promise<unknown>;
	/** cwd a by-name probe is attributed to: explicit `cwd`, else the
	 *  session's, else the daemon default. Undefined cannot resolve a manager. */
	probeCwd?(request: { sessionId?: string; cwd?: string }): string | undefined;
	/** Live cwd-scoped manager. Absent means no session ever created one for
	 *  that workspace, so stored credentials cannot be resolved. */
	probeManager?(cwd: string): MCPProbeManager | undefined;
}

/** Longest URL/command/argument accepted from a client; well above real use. */
const MAX_FIELD_LENGTH = 8192;
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Single-line text with no control characters — a header/command/arg boundary. */
function cleanField(value: string, label: string): string {
	if (value.length > MAX_FIELD_LENGTH) throw new Error(`${label} is too long`);
	if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must not contain control characters`);
	return value;
}

function validateUrl(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error("url must be a non-empty string");
	const url = cleanField(value.trim(), "url");
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("url must be a valid absolute URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("url must use http or https");
	return url;
}

function validateCommand(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error("command must be a non-empty string");
	return cleanField(value.trim(), "command");
}

function validateArgs(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new Error("args must be an array of strings");
	return value.map((arg, index) => {
		if (typeof arg !== "string") throw new Error(`args[${index}] must be a string`);
		return cleanField(arg, `args[${index}]`);
	});
}

function validateHeaders(value: unknown): Record<string, string> | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) throw new Error("headers must be an object of string values");
	const headers: Record<string, string> = {};
	for (const [name, raw] of Object.entries(value)) {
		if (!HTTP_TOKEN.test(name)) throw new Error(`headers["${name}"] is not a valid HTTP header name`);
		if (typeof raw !== "string") throw new Error(`headers["${name}"] must be a string`);
		headers[name] = cleanField(raw, `headers["${name}"]`);
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function validateAuth(value: unknown): MCPAuthConfig | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) throw new Error("auth must be an object");
	const type = value.type;
	if (type !== "oauth" && type !== "apikey") throw new Error('auth.type must be "oauth" or "apikey"');
	const auth: MCPAuthConfig = { type };
	if (value.credentialId !== undefined) {
		if (typeof value.credentialId !== "string" || value.credentialId.length === 0) {
			throw new Error("auth.credentialId must be a non-empty string");
		}
		auth.credentialId = cleanField(value.credentialId, "auth.credentialId");
	}
	return auth;
}

function transportOf(config: MCPServerConfig): McpServerSummary["transport"] {
	if (config.type === "sse") return "sse";
	if (config.type === "http") return "http";
	if ("url" in config && config.url) return "http";
	return "stdio";
}

/** Project a stored config onto the wire summary — headers/tokens stay on disk. */
function summarize(name: string, config: MCPServerConfig): McpServerSummary {
	const summary: McpServerSummary = { name, transport: transportOf(config) };
	if ("url" in config && config.url) summary.url = config.url;
	if ("command" in config && config.command) summary.command = config.command;
	if (config.auth) summary.auth = config.auth.type;
	if (config.enabled === false) summary.enabled = false;
	return summary;
}

export class McpServersService implements DaemonService {
	readonly key = "mcpServers";
	readonly routes = {
		"mcp.servers.list": "list",
		"mcp.servers.add": "add",
		"mcp.servers.remove": "remove",
		"mcp.servers.probe": "probe",
	} as const;

	readonly #deps: McpServersServiceDeps;

	constructor(deps: McpServersServiceDeps) {
		this.#deps = deps;
	}

	/** Resolve the owned file and reject a relative path before any read/write. */
	#configPath(): string {
		const filePath = this.#deps.userConfigPath();
		if (!path.isAbsolute(filePath)) throw new Error("user mcp.json path must be absolute");
		return filePath;
	}

	async #read(): Promise<MCPConfigFile> {
		let config: MCPConfigFile;
		try {
			config = await readMCPConfigFile(this.#configPath());
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid user mcp.json: ${detail}`);
		}
		// `readMCPConfigFile` parses JSON; a syntactically valid file can still
		// carry the wrong shape. Validate the one field this service owns so a
		// hand-edited array (or a string) fails with a reason instead of a
		// property-access crash.
		if (typeof config !== "object" || config === null || Array.isArray(config)) {
			throw new Error("Invalid user mcp.json: top level must be an object");
		}
		const servers = config.mcpServers;
		if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
			throw new Error('Invalid user mcp.json: "mcpServers" must be an object');
		}
		for (const [name, server] of Object.entries(servers ?? {})) {
			if (typeof server !== "object" || server === null || Array.isArray(server)) {
				throw new Error(`Invalid user mcp.json: server "${name}" must be an object`);
			}
		}
		return config;
	}

	/** Configured connectors, sorted by name. No token/header ever crosses the wire. */
	async list(): Promise<{ servers: McpServerSummary[] }> {
		const config = await this.#read();
		const servers = Object.entries(config.mcpServers ?? {})
			.map(([name, server]) => summarize(name, server))
			.sort((a, b) => a.name.localeCompare(b.name));
		return { servers };
	}

	/**
	 * Add one user-scope connector. Existing entries are preserved (the writer
	 * does a locked read-modify-write); a same-name entry is an error rather
	 * than a silent overwrite, so an install cannot replace a hand-edited
	 * configuration without the user removing it first.
	 */
	async add(params: {
		name?: unknown;
		url?: unknown;
		command?: unknown;
		args?: unknown;
		headers?: unknown;
		auth?: unknown;
	}): Promise<{ ok: true; name: string }> {
		const { name, config } = this.#configFrom(params);
		await addMCPServer(this.#configPath(), name, config);
		await this.#reloadConnectors();
		return { ok: true, name };
	}

	/**
	 * Test one connector config without mounting it.
	 *
	 * Two forms. With `url`/`command` it accepts the same shape as {@link add}
	 * and rejects the same inputs, so a probe can never bless a config the
	 * install would refuse. With only `name` it resolves an installed
	 * connector: the user `mcp.json` entry first, then the live manager's
	 * discovered config (catalog and project entries live only there), injects
	 * stored credentials through `prepareConfig`, and connects with the result.
	 * A missing manager is a stated failure — probing without credentials
	 * would report a handshake error the configured connector does not have.
	 *
	 * A real handshake follows either way: tools/resources/prompts are read and
	 * the transport is released. Failures come back as `ok: false` with the
	 * reason — never a throw — so the surface can show "why" beside the row.
	 */
	async probe(params: {
		name?: unknown;
		url?: unknown;
		command?: unknown;
		args?: unknown;
		headers?: unknown;
		auth?: unknown;
		cwd?: unknown;
		sessionId?: unknown;
	}): Promise<MCPProbeResult> {
		const hasUrl = params?.url !== undefined && params.url !== null;
		const hasCommand = params?.command !== undefined && params?.command !== null;
		if (!hasUrl && !hasCommand) return this.#probeConfigured(params);

		let built: { name: string; config: MCPServerConfig };
		try {
			built = this.#configFrom(params);
		} catch (error) {
			const name = typeof params?.name === "string" ? params.name.trim() : "";
			return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		return probeServer(built.name, built.config);
	}

	/** By-name probe: resolve the installed config, then delegate the live half. */
	async #probeConfigured(params: { name?: unknown; cwd?: unknown; sessionId?: unknown }): Promise<MCPProbeResult> {
		const name = typeof params?.name === "string" ? params.name.trim() : "";
		const nameError = validateServerName(name);
		if (nameError) return { name, ok: false, error: nameError };

		let stored: MCPServerConfig | undefined;
		try {
			stored = (await this.#read()).mcpServers?.[name];
		} catch (error) {
			return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
		}

		const cwd = this.#deps.probeCwd?.({
			sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
			cwd: typeof params.cwd === "string" ? params.cwd : undefined,
		});
		const manager = cwd ? this.#deps.probeManager?.(cwd) : undefined;
		const config = stored ?? manager?.getServerConfig(name);
		if (!config) {
			return {
				name,
				ok: false,
				error: `MCP server "${name}" is not configured${cwd ? ` for ${cwd}` : ""}`,
			};
		}
		if (!manager) {
			return {
				name,
				ok: false,
				error: `MCP credentials are unavailable: no live MCP manager for ${cwd ?? "this workspace"}. Open a session there before testing.`,
			};
		}
		try {
			return await probeServer(name, await manager.prepareConfig(config));
		} catch (error) {
			return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Shared input contract of `add` and the form half of `probe`; the only
	 *  place either validates a client-supplied config. */
	#configFrom(params: {
		name?: unknown;
		url?: unknown;
		command?: unknown;
		args?: unknown;
		headers?: unknown;
		auth?: unknown;
	}): { name: string; config: MCPServerConfig } {
		const name = typeof params?.name === "string" ? params.name.trim() : "";
		const nameError = validateServerName(name);
		if (nameError) throw new Error(nameError);

		const hasUrl = params?.url !== undefined && params.url !== null;
		const hasCommand = params?.command !== undefined && params?.command !== null;
		if (hasUrl === hasCommand) throw new Error('exactly one of "url" or "command" is required');

		const common = { auth: validateAuth(params?.auth) };
		const config: MCPServerConfig = hasUrl
			? { type: "http", url: validateUrl(params.url), headers: validateHeaders(params?.headers), ...common }
			: {
					type: "stdio",
					command: validateCommand(params.command),
					args: validateArgs(params?.args),
					...common,
				};
		return { name, config };
	}

	/** Remove one user-scope connector by name; other entries stay untouched. */
	async remove(params: { name?: unknown }): Promise<{ ok: true; name: string }> {
		const name = typeof params?.name === "string" ? params.name.trim() : "";
		const nameError = validateServerName(name);
		if (nameError) throw new Error(nameError);
		await removeMCPServer(this.#configPath(), name);
		await this.#reloadConnectors();
		return { ok: true, name };
	}

	async #reloadConnectors(): Promise<void> {
		try {
			await this.#deps.reloadConnectors?.();
		} catch {
			// The config write is the install's authority; a manager that could
			// not restart will pick the change up on the next daemon start.
		}
	}
}
