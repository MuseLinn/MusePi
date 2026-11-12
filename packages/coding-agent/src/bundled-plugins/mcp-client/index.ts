import type { ExtensionAPI } from "../../extensibility/extensions/types";
import type { MCPServerConfig } from "../../mcp/types";

/**
 * One MCP server, declared by ONE preset row.
 *
 * dsh's `@deepseek-ai/dsh-mcp-client` is a plugin whose row config names a
 * server (`serverName`, transport, command/url). This is the same contract on
 * MusePi's registration seam: the preset decides which servers belong to the
 * session, and Builtin-tool discovery is not widened globally. A preset-scoped
 * server therefore travels with the preset — switching presets disconnects it,
 * and there is no `mcp.json` edit to forget.
 *
 * The row is inert without `serverName` so an accidental ambient mount cannot
 * invent a server; a row with a name but missing transport fields fails its
 * mount with the reason instead of half-connecting.
 */

export const name = "musepi-mcp-client";
export const inject = [] as const;
export const provide = [] as const;

interface RowConfig {
	serverName?: unknown;
	transport?: unknown;
	command?: unknown;
	args?: unknown;
	env?: unknown;
	cwd?: unknown;
	url?: unknown;
	headers?: unknown;
	timeout?: unknown;
	enabled?: unknown;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function jsonObject(value: unknown, field: string): Record<string, string> | undefined {
	const raw = text(value);
	if (raw === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${field} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${field} must be a JSON object`);
	}
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(parsed)) {
		if (typeof entry !== "string") throw new Error(`${field}.${key} must be a string`);
		out[key] = entry;
	}
	return out;
}

function jsonArray(value: unknown, field: string): string[] | undefined {
	const raw = text(value);
	if (raw === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${field} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== "string")) {
		throw new Error(`${field} must be a JSON array of strings`);
	}
	return parsed as string[];
}

/** Build the manager's config from the row, or null when the row is inert. */
export function serverConfigFromRow(config: RowConfig): { serverName: string; config: MCPServerConfig } | null {
	const serverName = text(config.serverName);
	if (serverName === "") return null;
	if (config.enabled === false) return null;

	const transport = config.transport === "http" || config.transport === "sse" ? config.transport : "stdio";
	const timeout = typeof config.timeout === "number" && config.timeout > 0 ? config.timeout : undefined;

	if (transport === "stdio") {
		const command = text(config.command);
		if (command === "") throw new Error(`MCP server "${serverName}": command is required for stdio`);
		const args = jsonArray(config.args, "args");
		const env = jsonObject(config.env, "env");
		const cwd = text(config.cwd);
		return {
			serverName,
			config: {
				type: "stdio",
				command,
				...(args ? { args } : {}),
				...(env ? { env } : {}),
				...(cwd ? { cwd } : {}),
				...(timeout !== undefined ? { timeout } : {}),
			},
		};
	}

	const url = text(config.url);
	if (url === "") throw new Error(`MCP server "${serverName}": url is required for ${transport}`);
	const headers = jsonObject(config.headers, "headers");
	return {
		serverName,
		config: {
			type: transport,
			url,
			...(headers ? { headers } : {}),
			...(timeout !== undefined ? { timeout } : {}),
		},
	};
}

// The second parameter is what makes the row's `config` reach this plugin:
// `mountPlugin` reads a row's config only for an `apply` that declares it (or a
// module `Config`), and hands it over as this argument. `ctx.config` is the
// per-extension settings store — the right source for an ambient plugin, not
// for a preset row.
export function apply(ctx: ExtensionAPI, rowConfig?: RowConfig): void {
	ctx.setLabel("MCP 服务器");
	// MCP registration is SESSION-scoped (ExtensionContext), not instance-scoped:
	// the server belongs to the session that joined this preset, so the handler
	// is the only correct place to connect it. The runner releases everything it
	// owns on session shutdown. A repeated `session_start` (branch/switch)
	// re-registers the identical config as a no-op inside the registry.
	ctx.on("session_start", async (_event, session) => {
		const all = rowConfig ?? ((await ctx.config.getAll()) as RowConfig);
		const server = serverConfigFromRow(all);
		if (server === null) return;
		await session.registerMcpServer(server.serverName, server.config);
	});
}
