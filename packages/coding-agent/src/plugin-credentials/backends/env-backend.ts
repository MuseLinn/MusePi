/**
 * Environment-variable backend (priority 50).
 *
 * Read-only lookup of credentials injected via env vars — typical for CI
 * runners, containers, and read-only filesystems where the encrypted file
 * backend would refuse to persist. Format:
 *
 *   MUSPI_PLUGIN_CRED_<PLUGIN_ID>[__<SCOPE>][__<NAME>] = <value>
 *
 * The plugin id, scope, and name are uppercased and non-alphanumerics are
 * mapped to underscores. Examples:
 *   MUSPI_PLUGIN_CRED_GITHUB_MCP                  -> github-mcp::default
 *   MUSPI_PLUGIN_CRED_GITHUB_MCP__WORKSPACE_WS_1  -> github-mcp::workspace:ws-1
 *   MUSPI_PLUGIN_CRED_NOTION__TEAM_A              -> notion-mcp::default::team-a
 *
 * Set/delete are accepted but only mutate the in-memory overlay layer so a
 * single process can short-circuit the env var on next read; they do NOT write
 * to process.env (that would be a side effect on the whole process tree).
 */

import type { PluginCredentialId, StoredPluginCredential } from "../types.ts";
import type { PluginCredentialBackend } from "./types.ts";

const PREFIX = "MUSPI_PLUGIN_CRED_";
const DELIMITER = "__";

export class EnvBackend implements PluginCredentialBackend {
	readonly name = "env";
	readonly priority = 50;

	private overlay: Map<string, StoredPluginCredential> = new Map();

	async isAvailable(): Promise<boolean> {
		// Always "available" in concept — empty results when no env vars are set.
		return true;
	}

	async get(id: PluginCredentialId): Promise<StoredPluginCredential | null> {
		const key = encodeKey(id);
		const overlayHit = this.overlay.get(key);
		if (overlayHit) return overlayHit;
		const value = process.env?.[key];
		if (value === undefined) return null;
		return { value, tokenType: "Bearer" };
	}

	async set(id: PluginCredentialId, credential: StoredPluginCredential): Promise<void> {
		this.overlay.set(encodeKey(id), credential);
	}

	async delete(id: PluginCredentialId): Promise<boolean> {
		return this.overlay.delete(encodeKey(id));
	}

	async list(filter?: Partial<PluginCredentialId>): Promise<PluginCredentialId[]> {
		const env = process.env ?? {};
		const ids: PluginCredentialId[] = [];
		for (const key of Object.keys(env)) {
			if (!key.startsWith(PREFIX)) continue;
			const decoded = decodeKey(key);
			if (!decoded) continue;
			ids.push(decoded);
		}
		for (const key of this.overlay.keys()) {
			const decoded = decodeKey(key);
			if (decoded && !ids.some(existing => pluginIdsEqual(existing, decoded))) {
				ids.push(decoded);
			}
		}
		if (!filter) return ids;
		return ids.filter(id => {
			if (filter.pluginId && id.pluginId !== filter.pluginId) return false;
			if (filter.scope !== undefined && id.scope !== filter.scope) return false;
			if (filter.name !== undefined && id.name !== filter.name) return false;
			return true;
		});
	}

	/** Drop overlay entries; tests use this to start clean. */
	reset(): void {
		this.overlay.clear();
	}
}

function encodeKey(id: PluginCredentialId): string {
	const parts = [sanitize(id.pluginId)];
	if (id.scope) parts.push(sanitize(id.scope));
	if (id.name) parts.push(sanitize(id.name));
	return `${PREFIX}${parts.join(DELIMITER)}`;
}

function decodeKey(envKey: string): PluginCredentialId | null {
	const tail = envKey.slice(PREFIX.length);
	if (!tail) return null;
	const parts = tail.split(DELIMITER).map(segment => desanitize(segment));
	const [pluginId, scope, name] = parts;
	if (!pluginId) return null;
	const id: PluginCredentialId = { pluginId };
	if (scope) id.scope = scope;
	if (name) id.name = name;
	return id;
}

function sanitize(value: string): string {
	return value.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

function desanitize(value: string): string {
	return value.toLowerCase();
}

function pluginIdsEqual(a: PluginCredentialId, b: PluginCredentialId): boolean {
	return a.pluginId === b.pluginId && (a.scope ?? "") === (b.scope ?? "") && (a.name ?? "") === (b.name ?? "");
}
