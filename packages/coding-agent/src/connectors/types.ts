/**
 * Connector catalog types.
 *
 * A connector is a discoverable remote MCP server plus the display and auth
 * metadata the GUI needs to render it. Connectors are deliberately narrower
 * than a general plugin: only remote `http`/`sse` servers enter this catalog,
 * because stdio/CLI packages need install and process isolation that the
 * marketplace layer owns separately.
 *
 * Server names use the `connector:<id>` namespace so a catalog entry can never
 * shadow a hand-written `mcp.json` server of the same id, and `/mcp` output can
 * tell the two apart.
 */

/** Prefix that separates catalog-owned MCP servers from user-configured ones. */
export const CONNECTOR_SERVER_PREFIX = "connector:";

/** Directory (under the agent dir) holding the catalog index and package dirs. */
export const CONNECTOR_DIR_NAME = "connectors";

/** Index file a catalog source publishes. */
export const CONNECTOR_INDEX_FILE = "catalog.json";

/** Per-profile enabled state file. */
export const CONNECTOR_STATE_FILE = "state.json";

/** How the connector authenticates. */
export type ConnectorAuthMode = "oauth" | "none" | "token";

/** One secret the Token form asks for. Values never leave the main process. */
export interface ConnectorTokenField {
	key: string;
	label: string;
	type: "password" | "text";
	required?: boolean;
	placeholder?: string;
	description?: string;
}

/** Token form plus the header template the runtime injects. */
export interface ConnectorTokenSchema {
	title?: string;
	description?: string;
	docUrl?: string;
	fields: ConnectorTokenField[];
	/** Default `${value}` → `Authorization: Bearer <first field>`. */
	header?: { name: string; template: string };
}

/** One remote MCP endpoint declared by a catalog entry. */
export interface ConnectorHttpServerSpec {
	type: "http" | "sse";
	url: string;
	/** Static headers. Connector credentials never live here. */
	headers?: Record<string, string>;
}

/** One local MCP process declared by a catalog entry. */
export interface ConnectorStdioServerSpec {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export type ConnectorServerSpec = ConnectorHttpServerSpec | ConnectorStdioServerSpec;

/** Stable identity for the exact process a user approved. */
export function connectorCommandFingerprint(server: ConnectorStdioServerSpec): string {
	return Bun.hash(
		JSON.stringify({
			command: server.command,
			args: server.args ?? [],
			env: server.env ?? {},
			cwd: server.cwd ?? "",
		}),
	).toString(36);
}

/** Whether this entry is a local MCP process rather than a remote endpoint. */
export function isStdioConnector(entry: {
	server?: ConnectorServerSpec;
}): entry is { server: ConnectorStdioServerSpec } {
	return entry.server?.type === "stdio";
}

/** One CLI connector package and the commands that install, verify, and log it in. */
export type ConnectorPlatform = "darwin" | "linux" | "win32";
export type ConnectorPlatformCommand = Partial<Record<ConnectorPlatform, string>>;

export interface ConnectorCliSpec {
	runtime?: { type: string; version?: string };
	init?: ConnectorPlatformCommand;
	versionCheck?: { command?: string | ConnectorPlatformCommand; minVersion?: string };
	auth?: ConnectorPlatformCommand;
	unAuth?: ConnectorPlatformCommand;
	status?: ConnectorPlatformCommand;
	/** Success marker in the status command output (default "Logged in"). */
	statusMatch?: string;
	/** Preferred host when the auth output contains multiple URLs. */
	authUrlDomain?: string;
}

/** Stable identity for the exact CLI spec the user approved. */
export function connectorCliFingerprint(cli: ConnectorCliSpec): string {
	return Bun.hash(JSON.stringify(cli)).toString(36);
}

/** The runtime kind this entry mounts. */
export function connectorKind(entry: { server?: ConnectorServerSpec; cli?: ConnectorCliSpec }): "mcp" | "cli" {
	return entry.cli ? "cli" : "mcp";
}

/** OAuth hints a catalog may pin instead of relying on runtime discovery. */
export interface ConnectorOAuthSpec {
	clientId?: string;
	/** Authorization-server metadata endpoints, when the provider fixes them. */
	authorizationUrl?: string;
	tokenUrl?: string;
	scopes?: string;
	callbackPort?: number;
	callbackPath?: string;
}

/** One catalog entry, normalized from an index file or a package directory. */
export interface ConnectorCatalogEntry {
	id: string;
	name: string;
	description: string;
	category?: string;
	icon?: string;
	docsUrl?: string;
	examples?: string[];
	version?: string;
	/** MCP endpoint/process; absent for CLI connectors. */
	server?: ConnectorServerSpec;
	/** CLI package lifecycle; absent for MCP connectors. */
	cli?: ConnectorCliSpec;
	auth: { mode: ConnectorAuthMode };
	oauth?: ConnectorOAuthSpec;
	tokenSchema?: ConnectorTokenSchema;
	/** Absolute path of the file (or URL) that produced this entry. */
	source: string;
	/** Where the entry came from; `package` is the WorkBuddy-compatible layout. */
	sourceKind: "index" | "package" | "remote";
}

/** Persisted enablement for one connector. */
export interface ConnectorStateEntry {
	enabled: boolean;
	/** Epoch milliseconds of the last successful connect action. */
	connectedAt?: number;
	/** Exact stdio command fingerprint the user approved. */
	approvedCommand?: string;
	/** Exact CLI spec fingerprint the user approved. */
	approvedCli?: string;
}

/** Versioned state file, keyed by catalog id. */
export interface ConnectorStateFile {
	version: 1;
	connectors: Record<string, ConnectorStateEntry>;
}

/** Build the MCP server name a catalog entry owns. */
export function connectorServerName(id: string): string {
	return `${CONNECTOR_SERVER_PREFIX}${id}`;
}

/** Recover the catalog id from a `connector:` server name. */
export function connectorIdFromServerName(name: string): string | undefined {
	if (!name.startsWith(CONNECTOR_SERVER_PREFIX)) return undefined;
	const id = name.slice(CONNECTOR_SERVER_PREFIX.length);
	return id.length > 0 ? id : undefined;
}

/** Whether a server name belongs to the connector catalog namespace. */
export function isConnectorServerName(name: string): boolean {
	return connectorIdFromServerName(name) !== undefined;
}

/** Catalog ids are stable, lowercase slugs safe for tool names and file paths. */
export const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
