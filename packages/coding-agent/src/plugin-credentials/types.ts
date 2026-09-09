/**
 * Plugin Credential Types
 *
 * Identifier format: `{pluginId}[{scope}][{name}]` joined by `::` so URL/path
 * characters in plugin IDs cannot clash with the delimiter. Examples:
 *   - github-mcp::default
 *   - muse-tasks::workspace:ws-123
 *   - notion-mcp::default::team-a
 *
 * Scope is optional and free-form (e.g. `workspace:<id>` or `profile:<id>`);
 * name is an opaque disambiguator for plugins that hold multiple credentials
 * (e.g. several GitHub orgs).
 */

/** A single credential entry persisted by a plugin backend. */
export interface StoredPluginCredential {
	/** Primary secret — bearer token, API key, or OAuth access token. */
	value: string;
	/** OAuth refresh token, if applicable. */
	refreshToken?: string;
	/** OAuth expiration (Unix epoch ms); used to pre-empt 401s on reuse. */
	expiresAt?: number;
	/** OAuth client ID for token refresh flows that need it. */
	clientId?: string;
	/** OAuth client secret (Google token refresh, etc.). */
	clientSecret?: string;
	/** Token type, e.g. "Bearer"; defaults to "Bearer" at consumer sites. */
	tokenType?: string;
	/** Free-form plugin-defined metadata (org id, account id, …). */
	metadata?: Record<string, string>;
}

/** Identifies one credential slot owned by one plugin. */
export interface PluginCredentialId {
	/** Plugin / MCP server identifier, e.g. "github-mcp". */
	pluginId: string;
	/** Optional scope, e.g. workspace id or profile id. */
	scope?: string;
	/** Optional disambiguator (e.g. multi-account plugins). */
	name?: string;
}

const DELIMITER = "::";

/** Serialize a {@link PluginCredentialId} into a stable store key. */
export function pluginCredentialIdToAccount(id: PluginCredentialId): string {
	const parts: string[] = [id.pluginId];
	if (id.scope) parts.push(id.scope);
	if (id.name) parts.push(id.name);
	return parts.join(DELIMITER);
}

/** Inverse of {@link pluginCredentialIdToAccount}. Returns null on bad input. */
export function accountToPluginCredentialId(account: string): PluginCredentialId | null {
	const parts = account.split(DELIMITER);
	if (parts.length < 1 || parts.length > 3) return null;
	const [pluginId, scope, name] = parts;
	if (!pluginId) return null;
	const result: PluginCredentialId = { pluginId };
	if (scope) result.scope = scope;
	if (name) result.name = name;
	return result;
}
