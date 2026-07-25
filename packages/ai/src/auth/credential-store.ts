import { ModelsError } from "./resolve.ts";
import type { Credential, CredentialInfo, CredentialStore, StoredCredentialInfo } from "./types.ts";

/**
 * Default in-memory credential store. Apps inject persistent stores.
 * Keyed by `Provider.id`, one credential per provider; see `CredentialStore`.
 * Writes are serialized per provider through a promise chain.
 */
export class InMemoryCredentialStore implements CredentialStore {
	private credentials = new Map<string, Credential>();
	private chains = new Map<string, Promise<unknown>>();

	/** Serialize tasks per provider id. */
	private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const next = (async () => {
			await previous.catch(() => {});
			return task();
		})();
		this.chains.set(
			providerId,
			next.catch(() => {}),
		);
		return next;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.credentials.get(providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.enqueue(providerId, async () => {
			const current = this.credentials.get(providerId);
			const next = await fn(current);
			if (next !== undefined) this.credentials.set(providerId, next);
			return next ?? current;
		});
	}

	delete(providerId: string): Promise<void> {
		return this.enqueue(providerId, async () => {
			this.credentials.delete(providerId);
		});
	}

	async listCredentials(providerId?: string): Promise<StoredCredentialInfo[]> {
		const entries = [...this.credentials.entries()]
			.filter(([pid]) => !providerId || pid === providerId)
			.map(([pid, credential]) => this.#credentialToInfo(pid, credential));
		if (entries.length === 0) return [];
		return entries;
	}

	async removeCredential(id: number): Promise<number[]> {
		// In-memory store has no persistent IDs; treat as "remove all for the
		// single credential" — callers should use delete(providerId) instead.
		if (id === 0) {
			this.credentials.clear();
			return [];
		}
		// Try to match by iterating all entries (id is meaningless in memory,
		// but try to find a match by index).
		const entries = [...this.credentials.entries()];
		const match = entries[id - 1];
		if (match) {
			this.credentials.delete(match[0]);
			return [];
		}
		return [];
	}

	async updateRemark(_id: number, _remark: string): Promise<void> {
		throw new ModelsError("auth", "InMemoryCredentialStore does not support remarks");
	}

	async setActiveCredential(providerId: string, _credentialId: number): Promise<void> {
		// Single-credential store: the only credential is always active.
		if (!this.credentials.has(providerId)) {
			throw new ModelsError("auth", `No credential for provider ${providerId}`);
		}
	}

	async listCredentialBlocks(_credentialIds: readonly number[]): Promise<
		Array<{
			credentialId: number;
			providerKey: string;
			blockScope: string;
			blockedUntilMs: number;
			updatedAt: number;
		}>
	> {
		return [];
	}

	#credentialToInfo(providerId: string, credential: Credential): StoredCredentialInfo {
		const info: StoredCredentialInfo = { id: 0, providerId, type: credential.type };
		if (credential.type === "oauth") {
			info.email = credential.email as string | undefined;
			info.accountId = credential.accountId as string | undefined;
		}
		return info;
	}
}
