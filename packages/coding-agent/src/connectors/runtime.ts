/**
 * Project enabled catalog entries into MCP server configs.
 *
 * This is the only bridge between the catalog and the MCP runtime. It owns the
 * `connector:` namespace, attaches the catalog as the item's source, and maps
 * OAuth hints, Token values, and local process definitions onto the fields the
 * MCP client already understands. It never persists credentials: OAuth tokens
 * live in auth storage keyed by server URL, Token values come from the
 * encrypted connector secret store, and the manager injects the resulting
 * headers or environment.
 */

import type { MCPServer } from "../capability/mcp";
import type { SourceMeta } from "../capability/types";
import {
	type ConnectorCatalogEntry,
	type ConnectorStateFile,
	connectorCommandFingerprint,
	connectorServerName,
} from "./types";

const CONNECTOR_PROVIDER_ID = "connector-catalog";
const CONNECTOR_PROVIDER_NAME = "Connector Catalog";
const DEFAULT_TOKEN_HEADER = { name: "Authorization", template: "Bearer ${value}" };

function sourceMeta(entry: ConnectorCatalogEntry): SourceMeta {
	return {
		provider: CONNECTOR_PROVIDER_ID,
		providerName: CONNECTOR_PROVIDER_NAME,
		path: entry.source,
		level: "user",
	};
}

/** Replace `${key}` placeholders; `${value}` is the first field. */
function renderToken(
	template: string,
	values: Record<string, string>,
	firstKey: string | undefined,
): string | undefined {
	let missing = false;
	const rendered = template.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_match, key: string) => {
		const value = key === "value" ? (firstKey ? values[firstKey] : undefined) : values[key];
		if (value === undefined || value.length === 0) missing = true;
		return value ?? "";
	});
	if (missing || /\$\{/.test(rendered)) return undefined;
	// A secret must never be able to terminate the header line.
	return rendered.replace(/[\r\n]/g, "");
}

/** Token fields become env values for a local MCP process. */
function tokenEnv(entry: ConnectorCatalogEntry, secret: Record<string, string>): Record<string, string> | undefined {
	if (!entry.tokenSchema) return undefined;
	const env: Record<string, string> = {};
	for (const field of entry.tokenSchema.fields) {
		const value = secret[field.key];
		if (value) env[field.key] = value;
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Convert one entry into the canonical MCP server shape. Token connectors
 * return `undefined` until their required values exist, so an unconfigured
 * server is never mounted half-authenticated. A stdio entry is only projected
 * after the user approved that exact command fingerprint.
 */
export function connectorToMCPServer(
	entry: ConnectorCatalogEntry,
	secret?: Record<string, string>,
): MCPServer | undefined {
	if (!entry.server) return undefined;
	const base = { name: connectorServerName(entry.id), enabled: true, _source: sourceMeta(entry) } as const;

	if (entry.server.type === "stdio") {
		if (entry.auth.mode === "oauth") return undefined;
		if (entry.auth.mode === "token" && !secret) return undefined;
		const server: MCPServer = {
			...base,
			transport: "stdio",
			command: entry.server.command,
			...(entry.server.args ? { args: entry.server.args } : {}),
			...(entry.server.env ? { env: { ...entry.server.env } } : {}),
			...(entry.server.cwd ? { cwd: entry.server.cwd } : {}),
			envPolicy: "literal",
		};
		const env = secret && entry.auth.mode === "token" ? tokenEnv(entry, secret) : undefined;
		if (env) server.env = { ...server.env, ...env };
		return server;
	}

	const server: MCPServer = {
		...base,
		transport: entry.server.type,
		url: entry.server.url,
	};
	if (entry.server.headers) {
		server.headers = { ...entry.server.headers };
		server.headerPolicy = "origin-locked";
	}
	if (entry.auth.mode === "oauth") {
		server.auth = {
			type: "oauth",
			...(entry.oauth?.clientId ? { clientId: entry.oauth.clientId } : {}),
			...(entry.oauth?.tokenUrl ? { tokenUrl: entry.oauth.tokenUrl } : {}),
		};
		if (entry.oauth) {
			const oauth: NonNullable<MCPServer["oauth"]> = {};
			if (entry.oauth.clientId) oauth.clientId = entry.oauth.clientId;
			if (entry.oauth.callbackPort !== undefined) oauth.callbackPort = entry.oauth.callbackPort;
			if (entry.oauth.callbackPath) oauth.callbackPath = entry.oauth.callbackPath;
			if (Object.keys(oauth).length > 0) server.oauth = oauth;
		}
	}
	if (entry.auth.mode === "token") {
		const schema = entry.tokenSchema;
		if (!schema || !secret) return undefined;
		const header = schema.header ?? DEFAULT_TOKEN_HEADER;
		const value = renderToken(header.template, secret, schema.fields[0]?.key);
		if (value === undefined) return undefined;
		server.headers = { ...server.headers, [header.name]: value };
		server.headerPolicy = "origin-locked";
	}
	return server;
}

/** A local process is mountable only with the user's exact fingerprint approval. */
export function isConnectorApproved(entry: ConnectorCatalogEntry, state: ConnectorStateFile): boolean {
	if (!entry.server || entry.server.type !== "stdio") return true;
	const approved = state.connectors[entry.id]?.approvedCommand;
	return approved !== undefined && approved === connectorCommandFingerprint(entry.server);
}

/**
 * Project every enabled entry; disabled, removed, unapproved, or unconfigured
 * entries disappear.
 */
export function projectConnectorServers(
	entries: readonly ConnectorCatalogEntry[],
	state: ConnectorStateFile,
	secrets: Readonly<Record<string, Record<string, string> | undefined>> = {},
): MCPServer[] {
	const servers: MCPServer[] = [];
	for (const entry of entries) {
		if (!entry.server) continue;
		if (state.connectors[entry.id]?.enabled !== true) continue;
		if (!isConnectorApproved(entry, state)) continue;
		const server = connectorToMCPServer(entry, secrets[entry.id]);
		if (server) servers.push(server);
	}
	return servers;
}
