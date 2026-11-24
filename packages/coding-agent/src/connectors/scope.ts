/**
 * Connector scopes for agent definitions.
 *
 * A subagent's `tools:` list names exact tools, which cannot express "only the
 * Notion connector": the tool list a connector mounts is not known until it
 * connects, and it grows when the vendor adds a tool. `connectors:` names the
 * catalog ids instead, and the scope resolves to the prefix the connector's
 * tools are minted under.
 *
 * Resolution happens against the live tool set rather than a stored pattern,
 * so a connector that has not connected yet contributes nothing instead of
 * granting a prefix that would match a future tool the user never approved.
 */
import { CONNECTOR_SERVER_PREFIX } from "./types";

/** Prefix every tool of one connector is minted under, before sanitization. */
export function connectorServerNameForScope(id: string): string {
	return `${CONNECTOR_SERVER_PREFIX}${id}`;
}

/**
 * Whether a minted tool name belongs to one connector.
 *
 * The name is `mcp__<sanitized server>_<sanitized tool>`; comparing against
 * `<sanitized server>_` rather than a bare prefix keeps `connector_notion`
 * from claiming `connector_notioncal`'s tools.
 */
export function toolBelongsToConnector(toolName: string, sanitizedServerName: string): boolean {
	return toolName.startsWith(`mcp__${sanitizedServerName}_`);
}

/**
 * Keep the tool names that belong to any of the given connectors.
 *
 * An empty scope is not "no restriction": callers decide that before calling,
 * because an agent that names no connector should keep whatever its `tools`
 * list already granted.
 */
export function toolsForConnectorScopes(
	toolNames: readonly string[],
	sanitizedServerNames: readonly string[],
): string[] {
	if (sanitizedServerNames.length === 0) return [];
	return toolNames.filter(name => sanitizedServerNames.some(server => toolBelongsToConnector(name, server)));
}
