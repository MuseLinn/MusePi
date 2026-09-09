/**
 * Plugin credential manager — single source plugins talk to.
 *
 * Selects the highest-priority backend that returns `isAvailable() === true`
 * and delegates. Tries to set on the chosen backend; on write failure, falls
 * back to the next-highest available backend so a read-only mount never traps
 * the user behind a write error.
 *
 * Singleton (`getPluginCredentialManager`) carries the standard lazy-init
 * pattern used elsewhere in this package (`getSecretPlaceholderKey`,
 * `getActiveProfile`, …). `resetPluginCredentialManager` exists for tests.
 */

import type { PluginCredentialId, StoredPluginCredential } from "../types.ts";
import { EnvBackend } from "./env-backend.ts";
import { InMemoryBackend } from "./in-memory.ts";
import { SecureStorageBackend, type SecureStorageOptions } from "./secure-storage.ts";
import type { PluginCredentialBackend, PluginCredentialHealthIssue, PluginCredentialHealthStatus } from "./types.ts";

export interface PluginCredentialManagerOptions {
	/** Override the default secure-storage paths (used by tests + portable installs). */
	secureStorage?: SecureStorageOptions;
	/** Inject custom backends (default: [SecureStorageBackend, EnvBackend, InMemoryBackend]). */
	backends?: PluginCredentialBackend[];
}

export class PluginCredentialManager {
	private readonly backends: PluginCredentialBackend[];

	constructor(options: PluginCredentialManagerOptions = {}) {
		this.backends = options.backends ?? [
			new SecureStorageBackend(options.secureStorage),
			new EnvBackend(),
			new InMemoryBackend(),
		];
	}

	async get(id: PluginCredentialId): Promise<StoredPluginCredential | null> {
		const ordered = [...this.backends].sort((a, b) => b.priority - a.priority);
		for (const backend of ordered) {
			if (!(await backend.isAvailable())) continue;
			const result = await backend.get(id);
			if (result !== null) return result;
		}
		return null;
	}

	/**
	 * Persist on the highest-priority available backend. Falls back to lower
	 * tiers if the chosen one refuses to write (e.g. read-only mount) — the
	 * `InMemoryBackend` at priority 10 always succeeds.
	 */
	async set(id: PluginCredentialId, credential: StoredPluginCredential): Promise<void> {
		const ordered = [...this.backends].sort((a, b) => b.priority - a.priority);
		let lastError: unknown;
		for (const backend of ordered) {
			if (!(await backend.isAvailable())) continue;
			try {
				await backend.set(id, credential);
				return;
			} catch (err) {
				lastError = err;
			}
		}
		throw new Error(
			`No plugin credential backend accepted the write${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
		);
	}

	/**
	 * Remove from every backend holding a copy of this id, returning true if
	 * any of them had it. Multi-backend delete keeps overrides (env + file)
	 * from shadowing after the user explicitly clears.
	 */
	async delete(id: PluginCredentialId): Promise<boolean> {
		let deleted = false;
		for (const backend of this.backends) {
			if (!(await backend.isAvailable())) continue;
			try {
				if (await backend.delete(id)) deleted = true;
			} catch {
				// Skip the failing backend; others can still satisfy the request.
			}
		}
		return deleted;
	}

	async list(filter?: Partial<PluginCredentialId>): Promise<PluginCredentialId[]> {
		const seen = new Set<string>();
		const result: PluginCredentialId[] = [];
		const ordered = [...this.backends].sort((a, b) => b.priority - a.priority);
		for (const backend of ordered) {
			if (!(await backend.isAvailable())) continue;
			try {
				const ids = await backend.list(filter);
				for (const id of ids) {
					const key = JSON.stringify(id);
					if (seen.has(key)) continue;
					seen.add(key);
					result.push(id);
				}
			} catch {
				// Backend list failure is not fatal for a multi-backend aggregate.
			}
		}
		return result;
	}

	/**
	 * Aggregate health snapshot across backends. Surfaces secure-storage
	 * corruption so plugins can warn before failing their first call, and
	 * reports when no backend is selectable at all (e.g. all `isAvailable`
	 * false in a strict sandbox).
	 */
	async health(): Promise<PluginCredentialHealthStatus> {
		const issues: PluginCredentialHealthIssue[] = [];
		const ordered = [...this.backends].sort((a, b) => b.priority - a.priority);
		let anyAvailable = false;
		for (const backend of ordered) {
			if (!(await backend.isAvailable())) continue;
			anyAvailable = true;
			if (backend instanceof SecureStorageBackend) {
				const sub = await backend.health();
				issues.push(...sub.issues);
			}
		}
		if (!anyAvailable) {
			issues.push({
				type: "no_backends",
				message: "No plugin credential backend reported as available.",
			});
		}
		return { healthy: issues.length === 0, issues };
	}
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let singleton: PluginCredentialManager | null = null;
let singletonOptions: PluginCredentialManagerOptions | undefined;

export function getPluginCredentialManager(options?: PluginCredentialManagerOptions): PluginCredentialManager {
	if (!singleton) {
		singleton = new PluginCredentialManager(options);
		singletonOptions = options;
	} else if (options && options !== singletonOptions) {
		// Re-create only when callers pass a different options object — keeps
		// tests cheap while still letting production opt into custom configs.
		singleton = new PluginCredentialManager(options);
		singletonOptions = options;
	}
	return singleton;
}

export function resetPluginCredentialManager(): void {
	singleton = null;
	singletonOptions = undefined;
}
