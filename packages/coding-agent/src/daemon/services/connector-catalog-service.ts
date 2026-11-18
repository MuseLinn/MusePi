/**
 * ConnectorCatalogService — catalog discovery and enablement.
 *
 * `ConnectorService` answers "which servers may this session use"; this answers
 * the other half the connectors page needs: "which connectors exist, and which
 * are enabled". Enablement is a single boolean in the connector state file; the
 * provider turns it into an MCP server, and the existing manager owns auth,
 * connection, and health.
 *
 * Capability seam (connector catalog):
 * - Name/namespace: daemon RPC `connectors.catalog.*`, `connectors.connect`
 *   / `disconnect` / `setEnabled`, and `connectors.token.save`.
 * - Inputs/outputs: catalog entries with display metadata and a live status
 *   derived from `connectorsSnapshotForCwd`; no headers, token values, or
 *   credential ids ever cross the wire. Token presence is reported as a
 *   boolean (`tokenSet`) and the form schema, never the values.
 * - Lifecycle: no owned connection state. Every mutation writes the state file
 *   (or the encrypted secret store) and reloads the manager; reads re-scan the
 *   catalog behind a 5s cache.
 * - Enable/disable: `connect` and `setEnabled(true)` enable; `disconnect` and
 *   `setEnabled(false)` disable and delete the stored token. Session selection
 *   stays in ConnectorService.
 * - Conflicts: route names are distinct from `connectors.list/setSelected`.
 *   Catalog ids are namespaced as `connector:<id>` at the MCP layer.
 * - Inspection: this header plus `docs/connectors.md`.
 */

import { randomUUID } from "node:crypto";
import { clearConnectorCatalogCache, loadConnectorCatalog } from "../../connectors/catalog";
import {
	checkCliVersion,
	installCliConnector,
	killCliProcess,
	resolveCliCommand,
	runCliLogout,
	runCliStatus,
	startCliAuth,
} from "../../connectors/cli";
import { collectImportCandidates, importConnectors } from "../../connectors/import";
import {
	deleteConnectorSecrets,
	hasConnectorSecrets,
	mergeConnectorSecrets,
	readConnectorSecrets,
} from "../../connectors/secrets";
import { readConnectorState, setConnectorEnabled } from "../../connectors/state";
import {
	CONNECTOR_ID_PATTERN,
	type ConnectorAuthMode,
	type ConnectorCatalogEntry,
	type ConnectorCliSpec,
	type ConnectorTokenSchema,
	connectorCliFingerprint,
	connectorCommandFingerprint,
	connectorServerName,
} from "../../connectors/types";
import type { ConnectorServerInfo } from "../session-host";
import type { DaemonService } from "./types";

const MAX_TOKEN_VALUE_LENGTH = 8_192;

/** One catalog row safe to render: no static headers, no token values. */
export interface ConnectorCatalogItem {
	id: string;
	name: string;
	description: string;
	/** Chinese one-liner for a Chinese UI; absent when the source has none. */
	descriptionZh?: string;
	/** Two or three sentences for the expanded card. */
	details?: string;
	detailsZh?: string;
	/** Promoted to the page's opening section. */
	featured?: boolean;
	/** How far the sign-in walk was verified for this row. */
	verified?: "oauth" | "none" | "token" | "needs-app";
	category?: string;
	icon?: string;
	docsUrl?: string;
	examples?: string[];
	version?: string;
	kind: "mcp" | "cli";
	/** Managed CLI entries whose spec declares an authorization step. */
	cliAuth: boolean;
	server?: { transport: "http" | "sse" | "stdio"; url?: string; command?: string };
	authMode: ConnectorAuthMode;
	/** Token connectors: the form schema; values never leave the daemon. */
	tokenSchema?: ConnectorTokenSchema;
	/** Token connectors: every required field already has a stored value. */
	tokenSet: boolean;
	enabled: boolean;
	status: "connected" | "connecting" | "disconnected";
	sourceKind: ConnectorCatalogEntry["sourceKind"];
}

export interface ConnectorCatalogServiceDeps {
	cwd(): string;
	/** Live MCP manager snapshot for a cwd (manager is the status authority). */
	connectorsSnapshotForCwd(cwd: string): Promise<{ servers: ConnectorServerInfo[] }>;
	/** Reconcile cached managers after enablement changes. */
	reloadConnectors(): Promise<unknown>;
}

export interface ConnectorConnectResult {
	ok: boolean;
	id: string;
	name: string;
	serverName: string;
	needsAuth: boolean;
	/** Token connector without its required values: show the form instead. */
	needsTokenConfig?: boolean;
	/** Local process waiting for the user's explicit approval. */
	needsApproval?: boolean;
	command?: string;
	args?: string[];
	envKeys?: string[];
	/** CLI connector waiting for its auth flow. */
	needsCliAuth?: boolean;
	flowId?: string;
	authorizationUrl?: string;
	userCode?: string;
	/** CLI commands shown in the approval panel. */
	installCommand?: string;
	authCommand?: string;
	status: ConnectorCatalogItem["status"];
}

function requireId(params: { id?: unknown }): string {
	const id = typeof params?.id === "string" ? params.id.trim() : "";
	if (!id) throw new Error("id required");
	if (!CONNECTOR_ID_PATTERN.test(id)) throw new Error(`invalid connector id: ${id}`);
	return id;
}

function requiredTokenKeys(entry: ConnectorCatalogEntry): string[] {
	return (entry.tokenSchema?.fields ?? []).filter(field => field.required).map(field => field.key);
}

async function commandAvailable(command: string): Promise<boolean> {
	if (command.includes("/") || command.includes("\\")) return Bun.file(command).exists();
	return Bun.which(command) !== null;
}

/**
 * Whether the entry's credential fields are filled.
 *
 * A token connector needs its token; an OAuth connector that names an OAuth
 * client needs that client's id and secret, because a vendor with no
 * registration endpoint cannot complete a sign-in without them.
 */
/** Whether a pasted personal access token answers this row on its own. */
async function hasPastedToken(entry: ConnectorCatalogEntry): Promise<boolean> {
	const pat = entry.tokenSchema?.personalAccessToken;
	if (!pat) return false;
	const stored = (await readConnectorSecrets(entry.id)) ?? {};
	return (stored[pat.field]?.length ?? 0) > 0;
}

async function tokenReady(entry: ConnectorCatalogEntry): Promise<boolean> {
	if (entry.auth.mode === "oauth") {
		const client = entry.tokenSchema?.oauthClient;
		const pat = entry.tokenSchema?.personalAccessToken;
		if (!client && !pat) return true;
		const stored = (await readConnectorSecrets(entry.id)) ?? {};
		// A pasted token is a complete alternative to the browser sign-in, so
		// it satisfies the row on its own.
		if (pat && (stored[pat.field]?.length ?? 0) > 0) return true;
		// A pinned client id lets the row sign in on its own; a pasted token
		// stays optional in that case.
		if (entry.oauth?.clientId) return true;
		if (!client) return false;
		return (stored[client.clientIdField]?.length ?? 0) > 0 && (stored[client.clientSecretField]?.length ?? 0) > 0;
	}
	if (entry.auth.mode !== "token") return true;
	if (!entry.tokenSchema) return false;
	return hasConnectorSecrets(entry.id, requiredTokenKeys(entry));
}

async function toItem(
	entry: ConnectorCatalogEntry,
	enabled: boolean,
	status: ConnectorCatalogItem["status"],
): Promise<ConnectorCatalogItem> {
	const item: ConnectorCatalogItem = {
		id: entry.id,
		name: entry.name,
		description: entry.description,
		kind: entry.cli ? "cli" : "mcp",
		cliAuth: Boolean(entry.cli?.auth),
		...(entry.server
			? {
					server:
						entry.server.type === "stdio"
							? { transport: "stdio" as const, command: entry.server.command }
							: { transport: entry.server.type, url: entry.server.url },
				}
			: {}),
		authMode: entry.auth.mode,
		tokenSet: await tokenReady(entry),
		enabled,
		status,
		sourceKind: entry.sourceKind,
	};
	if (entry.descriptionZh) item.descriptionZh = entry.descriptionZh;
	if (entry.details) item.details = entry.details;
	if (entry.detailsZh) item.detailsZh = entry.detailsZh;
	if (entry.featured === true) item.featured = true;
	if (entry.verified) item.verified = entry.verified;
	if (entry.category) item.category = entry.category;
	if (entry.icon) item.icon = entry.icon;
	if (entry.docsUrl) item.docsUrl = entry.docsUrl;
	if (entry.examples) item.examples = entry.examples;
	if (entry.version) item.version = entry.version;
	if (entry.tokenSchema) item.tokenSchema = entry.tokenSchema;
	return item;
}

interface CliAuthFlow {
	flowId: string;
	connectorId: string;
	spec: ConnectorCliSpec;
	process: Awaited<ReturnType<typeof startCliAuth>>["process"];
	startedAt: number;
	authorizationUrl?: string;
	userCode?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ConnectorCatalogService implements DaemonService {
	readonly key = "connectorCatalog";
	readonly routes = {
		"connectors.catalog.list": "list",
		"connectors.catalog.detail": "detail",
		"connectors.catalog.refresh": "refresh",
		"connectors.connect": "connect",
		"connectors.disconnect": "disconnect",
		"connectors.setEnabled": "setEnabled",
		"connectors.token.save": "saveToken",
		"connectors.cli.status": "cliStatus",
		"connectors.cli.cancel": "cliCancel",
		"connectors.import.scan": "importScan",
		"connectors.import.apply": "importApply",
	} as const;

	readonly #deps: ConnectorCatalogServiceDeps;
	readonly #cliFlows = new Map<string, CliAuthFlow>();

	constructor(deps: ConnectorCatalogServiceDeps) {
		this.#deps = deps;
	}

	async #statuses(): Promise<Map<string, ConnectorCatalogItem["status"]>> {
		const statuses = new Map<string, ConnectorCatalogItem["status"]>();
		try {
			const snapshot = await this.#deps.connectorsSnapshotForCwd(this.#deps.cwd());
			for (const server of snapshot.servers) statuses.set(server.name, server.status);
		} catch {
			// A manager that cannot start is not a catalog failure; every entry
			// reports disconnected until the next call.
		}
		return statuses;
	}

	statusOf(id: string, statuses: Map<string, ConnectorCatalogItem["status"]>): ConnectorCatalogItem["status"] {
		return statuses.get(connectorServerName(id)) ?? "disconnected";
	}

	/** Catalog rows plus enablement, token readiness and live status. */
	async list(params: { query?: unknown } = {}): Promise<{ connectors: ConnectorCatalogItem[]; warnings: string[] }> {
		const [catalog, state, statuses] = await Promise.all([
			loadConnectorCatalog(),
			readConnectorState(),
			this.#statuses(),
		]);
		const query = typeof params?.query === "string" ? params.query.trim().toLowerCase() : "";
		const rows: ConnectorCatalogItem[] = [];
		for (const entry of catalog.entries) {
			if (query) {
				const haystack = `${entry.id}\n${entry.name}\n${entry.description}\n${entry.category ?? ""}`.toLowerCase();
				if (!haystack.includes(query)) continue;
			}
			const enabled = state.connectors[entry.id]?.enabled === true;
			rows.push(await toItem(entry, enabled, enabled ? this.statusOf(entry.id, statuses) : "disconnected"));
		}
		return { connectors: rows, warnings: catalog.warnings };
	}

	/** One entry, including its OAuth hints and token form schema. */
	async detail(params: { id?: unknown }): Promise<{
		connector: ConnectorCatalogItem;
		oauth?: ConnectorCatalogEntry["oauth"];
	}> {
		const id = requireId(params);
		const [catalog, state, statuses] = await Promise.all([
			loadConnectorCatalog(),
			readConnectorState(),
			this.#statuses(),
		]);
		const entry = catalog.entries.find(candidate => candidate.id === id);
		if (!entry) throw new Error(`unknown connector: ${id}`);
		const enabled = state.connectors[id]?.enabled === true;
		return {
			connector: await toItem(entry, enabled, enabled ? this.statusOf(id, statuses) : "disconnected"),
			...(entry.oauth ? { oauth: entry.oauth } : {}),
		};
	}

	/** Re-scan every source; returns the new size and source warnings. */
	async refresh(): Promise<{ count: number; warnings: string[] }> {
		clearConnectorCatalogCache();
		// A user who presses refresh is asking for the current index, not the
		// copy that is still within its cache window.
		const catalog = await loadConnectorCatalog({ refresh: true });
		return { count: catalog.entries.length, warnings: catalog.warnings };
	}

	/**
	 * Enable one connector. `needsAuth` tells the client whether to open the
	 * existing `mcp.oauth.start` flow; `needsTokenConfig` tells it to show the
	 * token form instead. The catalog never starts OAuth itself because that
	 * requires a user decision.
	 */
	async connect(params: { id?: unknown; approve?: unknown }): Promise<ConnectorConnectResult> {
		const id = requireId(params);
		const catalog = await loadConnectorCatalog();
		const entry = catalog.entries.find(candidate => candidate.id === id);
		if (!entry) throw new Error(`unknown connector: ${id}`);
		if (entry.cli) return this.#connectCli(entry, params);
		if (!entry.server) throw new Error(`connector has no server: ${id}`);
		const needsCredential =
			entry.auth.mode === "token" ||
			entry.tokenSchema?.oauthClient !== undefined ||
			entry.tokenSchema?.personalAccessToken !== undefined;
		if (needsCredential && !(await tokenReady(entry))) {
			return {
				ok: false,
				id,
				name: entry.name,
				serverName: connectorServerName(id),
				needsAuth: false,
				needsTokenConfig: true,
				status: "disconnected",
			};
		}
		if (entry.server.type === "stdio") {
			if (entry.auth.mode === "oauth") throw new Error("stdio connectors cannot use OAuth");
			if (params.approve !== true) {
				return {
					ok: false,
					id,
					name: entry.name,
					serverName: connectorServerName(id),
					needsAuth: false,
					needsApproval: true,
					command: entry.server.command,
					...(entry.server.args ? { args: entry.server.args } : {}),
					...(entry.server.env ? { envKeys: Object.keys(entry.server.env) } : {}),
					status: "disconnected",
				};
			}
			if (!(await commandAvailable(entry.server.command))) {
				throw new Error(`command not found: ${entry.server.command}`);
			}
			await setConnectorEnabled(id, true, undefined, {
				approvedCommand: connectorCommandFingerprint(entry.server),
			});
		} else {
			await setConnectorEnabled(id, true);
		}
		await this.#reload();
		const status = this.statusOf(id, await this.#statuses());
		return {
			ok: true,
			id,
			name: entry.name,
			serverName: connectorServerName(id),
			// A pasted token answers the row on its own, so a browser sign-in
			// after it would be a second, unneeded step. An OAuth row with no
			// token still needs one.
			needsAuth: entry.auth.mode === "oauth" && !(await hasPastedToken(entry)),
			status,
		};
	}

	/** Disable one connector, delete its token, and drop it from discovery. */
	async disconnect(params: { id?: unknown }): Promise<{ ok: true; id: string; enabled: false }> {
		const id = requireId(params);
		const catalog = await loadConnectorCatalog();
		const entry = catalog.entries.find(candidate => candidate.id === id);
		for (const flow of [...this.#cliFlows.values()]) {
			if (flow.connectorId !== id) continue;
			killCliProcess(flow.process);
			this.#cliFlows.delete(flow.flowId);
		}
		if (entry?.cli) {
			try {
				await runCliLogout(entry.cli);
			} catch {
				// The package may already be gone; disabling the connector is the
				// authority and the next login will recreate the auth state.
			}
		}
		await setConnectorEnabled(id, false);
		await deleteConnectorSecrets(id);
		await this.#reload();
		return { ok: true, id, enabled: false };
	}

	/** Explicit toggle used by the settings list. */
	async setEnabled(params: {
		id?: unknown;
		enabled?: unknown;
		approve?: unknown;
	}): Promise<ConnectorConnectResult | { ok: true; id: string; enabled: false }> {
		if (typeof params?.enabled !== "boolean") throw new Error("enabled must be a boolean");
		if (params.enabled) return this.connect(params);
		const result = await this.disconnect(params);
		return { ok: true, id: result.id, enabled: false };
	}

	/**
	 * Store Token form values. Empty strings keep the stored value, which is how
	 * the form resubmits an already-configured password. Values are validated
	 * against the declared schema and never returned.
	 */
	async saveToken(params: { id?: unknown; values?: unknown }): Promise<{ ok: true; id: string; tokenSet: true }> {
		const id = requireId(params);
		if (!isRecord(params.values)) throw new Error("values must be an object");
		const catalog = await loadConnectorCatalog();
		const entry = catalog.entries.find(candidate => candidate.id === id);
		if (!entry) throw new Error(`unknown connector: ${id}`);
		const schema = entry.tokenSchema;
		const isOAuthClient = entry.auth.mode === "oauth" && schema?.oauthClient !== undefined;
		const hasPat = schema?.personalAccessToken !== undefined;
		if ((entry.auth.mode !== "token" && !isOAuthClient && !hasPat) || !schema) {
			throw new Error(`connector ${id} does not use a token`);
		}

		const allowed = new Set(schema.fields.map(field => field.key));
		if (schema.personalAccessToken) allowed.add(schema.personalAccessToken.field);
		const values: Record<string, string> = {};
		for (const [key, value] of Object.entries(params.values)) {
			if (!allowed.has(key)) throw new Error(`unknown token field: ${key}`);
			if (typeof value !== "string") throw new Error(`token field ${key} must be a string`);
			if (value.length > MAX_TOKEN_VALUE_LENGTH) throw new Error(`token field ${key} is too long`);
			values[key] = value;
		}
		await mergeConnectorSecrets(id, values);
		if (!(await tokenReady(entry))) {
			const stored = (await readConnectorSecrets(id)) ?? {};
			const client = schema.oauthClient;
			const pat = schema.personalAccessToken;
			const missing = client
				? [
						...(pat && (stored[pat.field]?.length ?? 0) > 0 ? [] : [pat?.field].filter((k): k is string => !!k)),
						client.clientIdField,
						client.clientSecretField,
					].filter(key => (stored[key]?.length ?? 0) === 0)
				: requiredTokenKeys(entry).filter(key => (stored[key]?.length ?? 0) === 0);
			throw new Error(`missing required token fields: ${missing.join(", ")}`);
		}
		return { ok: true, id, tokenSet: true };
	}

	async #connectCli(entry: ConnectorCatalogEntry, params: { approve?: unknown }): Promise<ConnectorConnectResult> {
		const spec = entry.cli;
		if (!spec) throw new Error(`connector has no CLI spec: ${entry.id}`);
		const fingerprint = connectorCliFingerprint(spec);
		if (params.approve !== true) {
			return {
				ok: false,
				id: entry.id,
				name: entry.name,
				serverName: connectorServerName(entry.id),
				needsAuth: false,
				needsApproval: true,
				...(resolveCliCommand(spec.init) ? { installCommand: resolveCliCommand(spec.init) } : {}),
				...(resolveCliCommand(spec.auth) ? { authCommand: resolveCliCommand(spec.auth) } : {}),
				status: "disconnected",
			};
		}

		let version = await checkCliVersion(spec);
		if (!version.installed) {
			const install = await installCliConnector(spec);
			if (!install.ok) {
				throw new Error(
					`CLI install failed: ${(install.stderr || install.stdout || "unknown error").slice(0, 300)}`,
				);
			}
			version = await checkCliVersion(spec);
		}
		if (!version.installed) throw new Error(`CLI is not available: ${version.error ?? "version check failed"}`);
		if (version.needsUpgrade) {
			throw new Error(
				`CLI version too low: ${version.version ?? "unknown"} < ${spec.versionCheck?.minVersion ?? "?"}`,
			);
		}

		const authCommand = resolveCliCommand(spec.auth);
		if (!authCommand) {
			await setConnectorEnabled(entry.id, true, undefined, { approvedCli: fingerprint });
			await this.#reload();
			return {
				ok: true,
				id: entry.id,
				name: entry.name,
				serverName: connectorServerName(entry.id),
				needsAuth: false,
				status: "connected",
			};
		}

		for (const flow of this.#cliFlows.values()) {
			if (flow.connectorId !== entry.id) continue;
			killCliProcess(flow.process);
			this.#cliFlows.delete(flow.flowId);
		}
		const auth = await startCliAuth(spec);
		const flowId = randomUUID();
		this.#cliFlows.set(flowId, {
			flowId,
			connectorId: entry.id,
			spec,
			process: auth.process,
			startedAt: Date.now(),
			...(auth.authorizationUrl ? { authorizationUrl: auth.authorizationUrl } : {}),
			...(auth.userCode ? { userCode: auth.userCode } : {}),
		});
		return {
			ok: false,
			id: entry.id,
			name: entry.name,
			serverName: connectorServerName(entry.id),
			needsAuth: false,
			needsCliAuth: true,
			flowId,
			...(auth.authorizationUrl ? { authorizationUrl: auth.authorizationUrl } : {}),
			...(auth.userCode ? { userCode: auth.userCode } : {}),
			status: "connecting",
		};
	}

	/** Poll one CLI auth flow; the GUI calls this until success/error. */
	async cliStatus(params: { flowId?: unknown }): Promise<{
		flowId: string;
		connectorId: string;
		status: "pending" | "success" | "error";
		error?: string;
		raw?: string;
	}> {
		const flowId = typeof params?.flowId === "string" ? params.flowId.trim() : "";
		if (!flowId) throw new Error("flowId required");
		const flow = this.#cliFlows.get(flowId);
		if (!flow) throw new Error(`unknown CLI auth flow: ${flowId}`);
		const status = await runCliStatus(flow.spec);
		if (status.loggedIn) {
			killCliProcess(flow.process);
			this.#cliFlows.delete(flowId);
			await setConnectorEnabled(flow.connectorId, true, undefined, {
				approvedCli: connectorCliFingerprint(flow.spec),
			});
			await this.#reload();
			return { flowId, connectorId: flow.connectorId, status: "success" };
		}
		if (Date.now() - flow.startedAt > 5 * 60_000) {
			killCliProcess(flow.process);
			this.#cliFlows.delete(flowId);
			return { flowId, connectorId: flow.connectorId, status: "error", error: "CLI authorization timed out" };
		}
		return { flowId, connectorId: flow.connectorId, status: "pending", raw: status.raw };
	}

	/**
	 * Servers the other agents on this machine already have configured.
	 *
	 * Only names and endpoint shapes cross the wire. A credential the other
	 * agent stored in plain text is listed by field name; its value stays in
	 * the daemon until the user picks the row.
	 */
	async importScan(params: { cwd?: unknown } = {}): Promise<{
		candidates: Array<{
			source: string;
			name: string;
			transport: "http" | "sse" | "stdio";
			url?: string;
			command?: string;
			secretFields: string[];
		}>;
	}> {
		const cwd = typeof params?.cwd === "string" && params.cwd.length > 0 ? params.cwd : this.#deps.cwd();
		const candidates = await collectImportCandidates(cwd);
		return {
			candidates: candidates.map(candidate => ({
				source: candidate.source,
				name: candidate.name,
				transport: candidate.transport,
				...(candidate.url ? { url: candidate.url } : {}),
				...(candidate.command ? { command: candidate.command } : {}),
				secretFields: candidate.secretFields,
			})),
		};
	}

	/**
	 * Import the picked servers into the user's own catalog.
	 *
	 * A plain-text credential moves into the encrypted secret store and the
	 * entry keeps only a reference to it. The imported entry starts disabled:
	 * a local command still needs the user's approval before it runs here.
	 */
	async importApply(params: { items?: unknown } = {}): Promise<{ imported: string[]; skipped: string[] }> {
		const items = Array.isArray(params?.items) ? params.items : [];
		const picked = items
			.filter(
				(item): item is { source: string; name: string } =>
					typeof item === "object" && item !== null && typeof (item as { source?: unknown }).source === "string",
			)
			.map(item => ({ source: item.source, name: String((item as { name?: unknown }).name ?? "") }));
		if (picked.length === 0) throw new Error("no connectors selected");
		const result = await importConnectors(picked, { cwd: this.#deps.cwd() });
		clearConnectorCatalogCache();
		await this.#reload();
		return result;
	}

	/** Cancel one CLI auth flow and stop its auth process. */
	cliCancel(params: { flowId?: unknown }): { ok: true } {
		const flowId = typeof params?.flowId === "string" ? params.flowId.trim() : "";
		if (!flowId) throw new Error("flowId required");
		const flow = this.#cliFlows.get(flowId);
		if (flow) {
			killCliProcess(flow.process);
			this.#cliFlows.delete(flowId);
		}
		return { ok: true };
	}

	async #reload(): Promise<void> {
		try {
			await this.#deps.reloadConnectors();
		} catch {
			// Enablement is persisted; a manager that cannot restart picks the
			// change up on the next daemon start.
		}
	}
}
