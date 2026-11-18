/**
 * Import MCP servers from the agents already installed on this machine.
 *
 * The discovery layer already reads every agent's MCP configuration — Cursor,
 * VS Code, Claude, Codex, Kimi Code and the rest. That makes the servers
 * visible to a session, but it does not make them connectors: a discovered
 * server is read-only, cannot be enabled per profile, and has no place to keep
 * a credential that another agent wrote in plain text.
 *
 * This module turns a discovered server into a connector the user owns:
 *
 * - The endpoint becomes a catalog entry in `connectors/custom.json`, so the
 *   Connectors page lists it next to everything else.
 * - A credential the other agent stored in plain text — an `env` value, an
 *   `Authorization` header — is moved into the encrypted connector secret
 *   store and replaced by a reference. The plaintext does not survive the
 *   import; leaving it in a config file we do not own would keep it readable
 *   to every other tool on the machine.
 *
 * Importing is a copy, not a link: the source file is never written to, and
 * removing the connector later does not change the other agent's config.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@musepi/pi-utils";
import { loadCapability } from "../capability";
import { type MCPServer, mcpCapability } from "../capability/mcp";
// The providers that read the other agents live here; importing it registers
// them, which is what makes their servers visible here.
import "../discovery/builtin";
import { mergeConnectorSecrets } from "./secrets";
import { CONNECTOR_DIR_NAME, CONNECTOR_ID_PATTERN, type ConnectorCatalogEntry } from "./types";

/** File under the agent dir holding the user's own catalog entries. */
export const CONNECTOR_CUSTOM_FILE = "custom.json";

/** One server another agent has configured, ready to be picked. */
export interface ImportCandidate {
	/** Where it came from: the discovery provider id, e.g. `cursor`. */
	source: string;
	/** The other agent's name for it. */
	name: string;
	/** A name that is unique in our catalog. */
	id: string;
	transport: "http" | "sse" | "stdio";
	url?: string;
	command?: string;
	args?: string[];
	/** Names of the credential fields, never their values. */
	secretFields: string[];
	/** The plain-text credential values found in the source config. */
	secretValues: Record<string, string>;
	/** Non-secret headers the other agent declared. */
	headers: Record<string, string>;
}

/** The header names that carry a credential. */
const CREDENTIAL_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"api-key",
	"x-auth-token",
	"x-github-token",
	"x-access-token",
]);

/**
 * Environment variable names that carry a credential rather than
 * configuration. A name that says what it is — `TOKEN`, `API_KEY`,
 * `PASSWORD`, `SECRET` — is treated as one; the rest stay in the entry.
 */
const CREDENTIAL_ENV_NAMES = /(token|api[_-]?key|secret|password|credential)/i;

/** Absolute path of the user's own connector catalog. */
export function connectorCustomPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, CONNECTOR_DIR_NAME, CONNECTOR_CUSTOM_FILE);
}

/**
 * A catalog id derived from a name, unique against the ids already taken.
 * The name is lowercased and slugified; a leading digit gains a prefix so the
 * id stays a valid server-name suffix.
 */
export function importConnectorId(name: string, taken: Iterable<string>): string {
	const takenSet = new Set(taken);
	const base =
		name
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.replace(/^(\d)/, "c-$1")
			.slice(0, 48) || "imported";
	let id = base;
	let counter = 2;
	while (takenSet.has(id)) {
		id = `${base}-${counter}`;
		counter += 1;
	}
	return id;
}

/**
 * Collect the MCP servers every discovery provider finds.
 *
 * The provider ids come from the discovery layer, so the list stays in step
 * with it: a new agent that registers a provider appears here without a
 * change to this file.
 */
export async function collectImportCandidates(cwd: string = process.cwd()): Promise<ImportCandidate[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd });
	const candidates: ImportCandidate[] = [];
	for (const server of result.items ?? []) {
		const transport = server.transport ?? (server.command ? "stdio" : "http");
		if (transport !== "http" && transport !== "sse" && transport !== "stdio") continue;
		const source = server._source?.provider ?? "unknown";
		// A connector we already own is not an import candidate.
		if (source === "connector-catalog") continue;
		const secretValues: Record<string, string> = {};
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(server.headers ?? {})) {
			if (CREDENTIAL_HEADERS.has(name.toLowerCase())) {
				secretValues[`header:${name.toLowerCase()}`] = value;
			} else {
				headers[name] = value;
			}
		}
		// An env value is only a credential when the server reads it as one.
		// The discovery layer expands a server's whole environment, and most
		// of it is ordinary configuration — `CODEX_HOME`, `JAVA_HOME`, a
		// trusted-path list — which belongs in the entry, not in the secret
		// store. Only the names a server documents as its token are moved.
		for (const [name, value] of Object.entries(server.env ?? {})) {
			if (!CREDENTIAL_ENV_NAMES.test(name)) continue;
			secretValues[`env:${name}`] = value;
		}
		candidates.push({
			source,
			name: server.name,
			id: server.name,
			transport,
			...(server.url ? { url: server.url } : {}),
			...(server.command ? { command: server.command } : {}),
			...(server.args ? { args: server.args } : {}),
			secretFields: Object.keys(secretValues),
			secretValues,
			headers,
		});
	}
	return candidates;
}

/** Build the catalog entry one imported server becomes. */
function entryFor(candidate: ImportCandidate, id: string): ConnectorCatalogEntry {
	const hasSecret = Object.keys(candidate.secretValues).length > 0;
	const entry: ConnectorCatalogEntry = {
		id,
		name: candidate.name,
		description: `Imported from ${candidate.source}.`,
		auth: { mode: hasSecret ? "token" : "none" },
		source: connectorCustomPath(),
		sourceKind: "index",
	};
	if (candidate.transport === "stdio") {
		entry.server = {
			type: "stdio",
			command: candidate.command ?? "",
			...(candidate.args ? { args: candidate.args } : {}),
		};
	} else {
		entry.server = {
			type: candidate.transport,
			url: candidate.url ?? "",
			...(Object.keys(candidate.headers).length > 0 ? { headers: candidate.headers } : {}),
		};
	}
	if (hasSecret) {
		// The form mirrors what was imported, so the user can see and replace
		// every field that was carried over.
		entry.tokenSchema = {
			title: `Connect ${candidate.name}`,
			fields: Object.keys(candidate.secretValues).map(key => ({
				key,
				label: key.replace(/^(header|env):/, ""),
				type: "password" as const,
				required: true,
			})),
			...(candidate.transport === "stdio"
				? {}
				: {
						header: {
							name: "Authorization",
							template: "Bearer ${value}",
						},
					}),
		};
	}
	return entry;
}

/**
 * Import the picked servers.
 *
 * Each candidate becomes one catalog entry in `connectors/custom.json`, and
 * its plain-text credential is written to the encrypted secret store. The
 * entry is left disabled: a process from another agent still has to be
 * approved before it runs here.
 */
export async function importConnectors(
	picked: ReadonlyArray<{ source: string; name: string }>,
	options: { cwd?: string; agentDir?: string } = {},
): Promise<{ imported: string[]; skipped: string[] }> {
	const agentDir = options.agentDir ?? getAgentDir();
	const candidates = await collectImportCandidates(options.cwd ?? process.cwd());
	const wanted = new Set(picked.map(item => `${item.source}:${item.name}`));

	const existing = await readCustomEntries(agentDir);
	const byId = new Map(existing.map(entry => [entry.id, entry]));
	const taken = new Set(byId.keys());
	const imported: string[] = [];
	const skipped: string[] = [];

	for (const candidate of candidates) {
		if (!wanted.has(`${candidate.source}:${candidate.name}`)) continue;
		const id = importConnectorId(candidate.name, taken);
		if (!CONNECTOR_ID_PATTERN.test(id)) {
			skipped.push(candidate.name);
			continue;
		}
		const entry = entryFor(candidate, id);
		byId.set(id, entry);
		taken.add(id);
		imported.push(id);
		if (Object.keys(candidate.secretValues).length > 0) {
			await mergeConnectorSecrets(id, candidate.secretValues, agentDir);
		}
	}

	await writeCustomEntries([...byId.values()], agentDir);
	return { imported, skipped };
}

/** Read the user's own catalog entries. */
export async function readCustomEntries(agentDir: string = getAgentDir()): Promise<ConnectorCatalogEntry[]> {
	const filePath = connectorCustomPath(agentDir);
	let text: string;
	try {
		text = await fs.promises.readFile(filePath, "utf8");
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Custom connector file could not be read", {
				path: filePath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is ConnectorCatalogEntry =>
				typeof entry === "object" && entry !== null && typeof entry.id === "string",
		);
	} catch (error) {
		logger.warn("Custom connector file is not valid JSON", {
			path: filePath,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

/** Write the user's own catalog entries. */
export async function writeCustomEntries(
	entries: readonly ConnectorCatalogEntry[],
	agentDir: string = getAgentDir(),
): Promise<void> {
	const filePath = connectorCustomPath(agentDir);
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}
