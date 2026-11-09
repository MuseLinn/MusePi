/**
 * `connector_catalog` tool — let the model see which connectors this machine
 * offers before recommending one.
 *
 * Read-only on purpose. Enabling a connector changes what tools the session
 * mounts and may start a browser OAuth flow, both of which need a user
 * decision; the model's job is discovery and a precise recommendation, not a
 * silent install. The tool therefore returns display metadata plus enablement,
 * and never a token, header, or client secret.
 */
import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import type { ToolExample } from "@musepi/pi-ai";
import { loadConnectorCatalog } from "../connectors/catalog";
import { readConnectorState } from "../connectors/state";
import type { ConnectorCatalogEntry, ConnectorStateFile } from "../connectors/types";
import connectorCatalogDescription from "../prompts/tools/connector-catalog.md" with { type: "text" };

const MAX_LISTED = 50;

const connectorCatalogSchema = type({
	action: type('"list" | "search" | "detail"').describe("operation to apply"),
	"query?": type("string").describe("case-insensitive text for action=search (id, name, description, category)"),
	"id?": type("string").describe("connector id for action=detail, exactly as list reports it"),
});
type ConnectorCatalogParams = typeof connectorCatalogSchema.infer;

export interface ConnectorCatalogToolDetails {
	action: string;
	count: number;
	/** Rows returned for list/search, without URLs or credentials. */
	connectors?: Array<{ id: string; name: string; enabled: boolean }>;
	/** The connector `detail` addressed. */
	connector?: { id: string; name: string; enabled: boolean; authMode: "oauth" | "none" | "token" };
}

function isEnabled(id: string, state: ConnectorStateFile): boolean {
	return state.connectors[id]?.enabled === true;
}

function summarize(entry: ConnectorCatalogEntry, state: ConnectorStateFile): string {
	const parts = [`- ${entry.id} — ${entry.name}`];
	if (entry.description) parts.push(`: ${entry.description}`);
	parts.push(` [${entry.auth.mode}; ${isEnabled(entry.id, state) ? "enabled" : "not enabled"}]`);
	if (entry.category) parts.push(` {${entry.category}}`);
	return parts.join("");
}

function filter(entries: readonly ConnectorCatalogEntry[], query: string): ConnectorCatalogEntry[] {
	const needle = query.toLowerCase();
	return entries.filter(entry =>
		`${entry.id}\n${entry.name}\n${entry.description}\n${entry.category ?? ""}`.toLowerCase().includes(needle),
	);
}

export class ConnectorCatalogTool implements AgentTool<typeof connectorCatalogSchema, ConnectorCatalogToolDetails> {
	readonly name = "connector_catalog";
	readonly label = "Connector Catalog";
	readonly strict = true;
	readonly approval = "read" as const;
	readonly description = connectorCatalogDescription;
	readonly parameters = connectorCatalogSchema;
	readonly examples: readonly ToolExample<ConnectorCatalogParams>[] = [
		{ caption: "See which connectors are available", call: { action: "list" } },
		{ caption: "Find a connector for meetings", call: { action: "search", query: "meeting" } },
		{ caption: "Read one connector's setup", call: { action: "detail", id: "tmeet" } },
	];

	async execute(
		_toolCallId: string,
		params: ConnectorCatalogParams,
	): Promise<AgentToolResult<ConnectorCatalogToolDetails>> {
		const [catalog, state] = await Promise.all([loadConnectorCatalog(), readConnectorState()]);

		if (params.action === "detail") {
			const id = params.id?.trim();
			if (!id) throw new Error("detail requires id");
			const entry = catalog.entries.find(candidate => candidate.id === id);
			if (!entry) throw new Error(`unknown connector: ${id}`);
			const lines = [`${entry.name} (${entry.id})`, entry.description || "(no description)"];
			if (entry.cli) {
				lines.push(`kind: cli`);
			} else if (entry.server?.type === "stdio") {
				lines.push(`server: stdio ${entry.server.command}`);
			} else if (entry.server) {
				lines.push(`server: ${entry.server.type} ${entry.server.url}`);
			}
			lines.push(`auth: ${entry.auth.mode}`);
			lines.push(`enabled: ${isEnabled(entry.id, state) ? "yes" : "no"}`);
			if (entry.category) lines.push(`category: ${entry.category}`);
			if (entry.docsUrl) lines.push(`docs: ${entry.docsUrl}`);
			if (entry.examples?.length) {
				lines.push("examples:");
				for (const example of entry.examples) lines.push(`- ${example}`);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					action: params.action,
					count: 1,
					connector: {
						id: entry.id,
						name: entry.name,
						enabled: isEnabled(entry.id, state),
						authMode: entry.auth.mode,
					},
				},
			};
		}

		const query = params.query?.trim() ?? "";
		if (params.action === "search" && !query) throw new Error("search requires query");
		const matched = params.action === "search" ? filter(catalog.entries, query) : catalog.entries;
		const shown = matched.slice(0, MAX_LISTED);
		const lines =
			shown.length > 0
				? shown.map(entry => summarize(entry, state))
				: ["No connectors found. Add a catalog index or package directory to the connectors folder."];
		if (matched.length > shown.length) {
			lines.push(`… ${matched.length - shown.length} more; narrow the query or use detail by id.`);
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				action: params.action,
				count: matched.length,
				connectors: shown.map(entry => ({ id: entry.id, name: entry.name, enabled: isEnabled(entry.id, state) })),
			},
		};
	}
}
