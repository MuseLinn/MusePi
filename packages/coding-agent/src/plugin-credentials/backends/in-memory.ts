/**
 * In-memory backend (priority 10).
 *
 * Lowest-priority fallback: used when the encrypted file refuses to write
 * (read-only mount, blocked filesystem call) and no env var supplies the
 * credential. Honors writes within the process — useful for tests, single-
 * invocation containers, and sandboxed previews — but loses data on restart.
 */

import type { PluginCredentialId, StoredPluginCredential } from "../types.ts";
import { pluginCredentialIdToAccount } from "../types.ts";
import type { PluginCredentialBackend } from "./types.ts";

export class InMemoryBackend implements PluginCredentialBackend {
	readonly name = "in-memory";
	readonly priority = 10;

	private readonly store: Map<string, StoredPluginCredential> = new Map();

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async get(id: PluginCredentialId): Promise<StoredPluginCredential | null> {
		return this.store.get(pluginCredentialIdToAccount(id)) ?? null;
	}

	async set(id: PluginCredentialId, credential: StoredPluginCredential): Promise<void> {
		this.store.set(pluginCredentialIdToAccount(id), credential);
	}

	async delete(id: PluginCredentialId): Promise<boolean> {
		return this.store.delete(pluginCredentialIdToAccount(id));
	}

	async list(filter?: Partial<PluginCredentialId>): Promise<PluginCredentialId[]> {
		const { accountToPluginCredentialId } = await import("../types.ts");
		const ids = Array.from(this.store.keys())
			.map(accountToPluginCredentialId)
			.filter((id): id is PluginCredentialId => id !== null);
		if (!filter) return ids;
		return ids.filter(id => {
			if (filter.pluginId && id.pluginId !== filter.pluginId) return false;
			if (filter.scope !== undefined && id.scope !== filter.scope) return false;
			if (filter.name !== undefined && id.name !== filter.name) return false;
			return true;
		});
	}

	reset(): void {
		this.store.clear();
	}
}
