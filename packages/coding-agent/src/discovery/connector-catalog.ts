/**
 * Connector Catalog MCP provider.
 *
 * Loads enabled catalog entries as MCP servers so the existing discovery,
 * manager, OAuth, and session-selection paths treat a connector exactly like a
 * configured server. The provider owns no connection state: enablement comes
 * from the connector state file, and health comes from the manager.
 *
 * Priority 40: above standalone project `mcp.json` (5) so a connector remains
 * visible if the two disagree, below tool-specific plugin providers so a user
 * plugin can still override a same-named server.
 */
import { logger } from "@musepi/pi-utils";
import { registerProvider } from "../capability";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { LoadContext, LoadResult } from "../capability/types";
import { loadConnectorCatalog } from "../connectors/catalog";
import { projectConnectorServers } from "../connectors/runtime";
import { readConnectorSecrets } from "../connectors/secrets";
import { readConnectorState } from "../connectors/state";

const PROVIDER_ID = "connector-catalog";
const DISPLAY_NAME = "Connector Catalog";

async function load(_ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	try {
		const [catalog, state] = await Promise.all([loadConnectorCatalog(), readConnectorState()]);
		const secrets: Record<string, Record<string, string> | undefined> = {};
		await Promise.all(
			catalog.entries.map(async entry => {
				if (state.connectors[entry.id]?.enabled === true && entry.auth.mode === "token") {
					secrets[entry.id] = await readConnectorSecrets(entry.id);
				}
			}),
		);
		return {
			items: projectConnectorServers(catalog.entries, state, secrets),
			warnings: catalog.warnings.length > 0 ? catalog.warnings : undefined,
		};
	} catch (error) {
		// A broken catalog must not take down every other MCP source.
		const message = error instanceof Error ? error.message : String(error);
		logger.warn("Connector catalog failed to load", { error: message });
		return { items: [], warnings: [`connector catalog: ${message}`] };
	}
}

registerProvider(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load enabled connectors from the local catalog and package directories",
	priority: 40,
	load,
});
