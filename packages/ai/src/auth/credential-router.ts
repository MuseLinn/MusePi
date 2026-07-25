import type { Credential, CredentialInfo, CredentialStore, StoredCredentialInfo } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
//  Credential selection strategy
// ─────────────────────────────────────────────────────────────────────────────

export interface CredentialRouterOptions {
	/**
	 * A stable session identifier for session-sticky credential pinning.
	 * When set, the same session always starts with the same credential
	 * (deterministic hash-based selection). When absent, round-robin is used.
	 */
	sessionId?: string;

	/**
	 * Duration in ms after which a session-pinned credential may be re-evaluated
	 * (e.g., to rotate away from a rate-limited credential). Default: 5 minutes.
	 */
	sessionStickinessWindowMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CredentialRouter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `CredentialStore` wrapper that adds credential selection strategy:
 * session-sticky pinning, round-robin distribution, and in-memory + persistent
 * rate-limit blocking.
 *
 * Delegates all persistence to the inner store; `read()` is the only method
 * that differs from pass-through.  On the first `read()` for a provider the
 * router hydrates its in-memory block list from the inner store's persistent
 * `listCredentialBlocks`, so rate-limit blocks survive process restarts.
 */
export class CredentialRouter implements CredentialStore {
	readonly #inner: CredentialStore;

	/** provider:credential-type → Map<credentialId, blockedUntilMs> (in-memory) */
	readonly #credentialBackoff = new Map<string, Map<number, number>>();

	/** Set of provider keys whose persistent blocks have been loaded this run. */
	readonly #hydratedProviderKeys = new Set<string>();

	/** provider:credential-type → current round-robin index */
	readonly #roundRobinIndex = new Map<string, number>();

	#sessionId: string | undefined;
	#sessionStickinessWindowMs: number;

	constructor(inner: CredentialStore, options: CredentialRouterOptions = {}) {
		this.#inner = inner;
		this.#sessionId = options.sessionId;
		this.#sessionStickinessWindowMs = options.sessionStickinessWindowMs ?? 5 * 60_000;
	}

	setSessionId(sessionId: string | undefined): void {
		this.#sessionId = sessionId;
	}

	// ─────────────────────────────────────────────────────────────────────────
	//  Delegated methods
	// ─────────────────────────────────────────────────────────────────────────

	list(): Promise<readonly CredentialInfo[]> {
		return this.#inner.list();
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.#inner.modify(providerId, fn);
	}

	async delete(providerId: string): Promise<void> {
		await this.#inner.delete(providerId);
		this.#clearBackoffForProvider(providerId);
	}

	listCredentials(providerId?: string): Promise<StoredCredentialInfo[]> {
		return this.#inner.listCredentials(providerId);
	}

	removeCredential(id: number): Promise<number[]> {
		return this.#inner.removeCredential(id);
	}

	updateRemark(id: number, remark: string): Promise<void> {
		return this.#inner.updateRemark(id, remark);
	}

	setActiveCredential(providerId: string, credentialId: number): Promise<void> {
		return this.#inner.setActiveCredential(providerId, credentialId);
	}

	// ─────────────────────────────────────────────────────────────────────────
	//  Read with multi-credential selection
	// ─────────────────────────────────────────────────────────────────────────

	async read(providerId: string): Promise<Credential | undefined> {
		await this.#hydrateBlocksForProvider(providerId);

		const allInfo = await this.#inner.listCredentials(providerId);
		if (allInfo.length === 0) return undefined;

		if (allInfo.length === 1) {
			const cred = await this.#inner.read(providerId);
			if (!cred) return undefined;
			if (this.#isBlocked(providerId, allInfo[0]!.id)) return undefined;
			return cred;
		}

		const selected = this.#pickCredential(providerId, allInfo);
		if (!selected) return undefined;

		try {
			await this.#inner.setActiveCredential(providerId, selected.id);
		} catch {
			// removed concurrently
		}
		return this.#inner.read(providerId);
	}

	// ─────────────────────────────────────────────────────────────────────────
	//  Block management (persisted to inner store when available)
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Mark a credential as temporarily blocked.  Persists to the inner store's
	 * `upsertCredentialBlock` when available, so blocks survive restarts.
	 */
	blockCredential(credentialId: number, providerId: string, blockedUntilMs: number): void {
		const key = this.#providerKey(providerId);
		let map = this.#credentialBackoff.get(key);
		if (!map) {
			map = new Map();
			this.#credentialBackoff.set(key, map);
		}
		map.set(credentialId, blockedUntilMs);

		// Persist if the inner store supports it.
		if ("upsertCredentialBlock" in this.#inner) {
			const upsert = (
				this.#inner as unknown as { upsertCredentialBlock: (id: number, k: string, s: string, ms: number) => void }
			).upsertCredentialBlock;
			if (upsert) {
				upsert.call(this.#inner, credentialId, key, "", blockedUntilMs);
			}
		}
	}

	unblockCredential(credentialId: number, providerId: string): void {
		const key = this.#providerKey(providerId);
		const map = this.#credentialBackoff.get(key);
		if (!map) return;
		map.delete(credentialId);
		if (map.size === 0) this.#credentialBackoff.delete(key);
	}

	isCredentialBlocked(credentialId: number, providerId: string): boolean {
		return this.#isBlocked(providerId, credentialId);
	}

	// ─────────────────────────────────────────────────────────────────────────
	//  Internal helpers
	// ─────────────────────────────────────────────────────────────────────────

	#providerKey(providerId: string): string {
		return providerId;
	}

	/** Hydrate in-memory blocks from the inner store's persistent blocks. */
	async #hydrateBlocksForProvider(providerId: string): Promise<void> {
		const key = this.#providerKey(providerId);
		if (this.#hydratedProviderKeys.has(key)) return;
		this.#hydratedProviderKeys.add(key);

		// Fetch all credentials for this provider so we can map by credentialId.
		const allInfo = await this.#inner.listCredentials(providerId);
		if (allInfo.length === 0) return;
		const ids = allInfo.map((info) => info.id);

		const blocks = await this.#inner.listCredentialBlocks?.(ids);
		if (!blocks || blocks.length === 0) return;

		let map = this.#credentialBackoff.get(key);
		if (!map) {
			map = new Map();
			this.#credentialBackoff.set(key, map);
		}
		for (const block of blocks) {
			const existing = map.get(block.credentialId);
			if (existing === undefined || block.blockedUntilMs > existing) {
				map.set(block.credentialId, block.blockedUntilMs);
			}
		}
	}

	#isBlocked(providerId: string, credentialId: number): boolean {
		const now = Date.now();
		const key = this.#providerKey(providerId);
		const map = this.#credentialBackoff.get(key);
		if (!map) return false;
		const until = map.get(credentialId);
		if (until !== undefined && until > now) return true;
		if (until !== undefined && until <= now) {
			map.delete(credentialId);
			if (map.size === 0) this.#credentialBackoff.delete(key);
		}
		return false;
	}

	#pickCredential(providerId: string, infos: StoredCredentialInfo[]): StoredCredentialInfo | undefined {
		const available = infos.filter((info) => !this.#isBlocked(providerId, info.id));
		if (available.length === 0) return undefined;

		const key = this.#providerKey(providerId);

		if (this.#sessionId) {
			// Session-sticky: deterministic hash of sessionId → credential index.
			const stickyKey = `${key}:${this.#sessionId}`;
			const hashedIndex = this.#hashString(stickyKey) % available.length;
			const candidate = available[hashedIndex];
			if (candidate && !this.#isBlocked(providerId, candidate.id)) {
				return candidate;
			}
			// Sticky credential is blocked — fall through to round-robin.
		}

		// Round-robin: advance the index and pick.
		const current = this.#roundRobinIndex.get(key) ?? -1;
		const next = (current + 1) % available.length;
		this.#roundRobinIndex.set(key, next);

		return available[next]!;
	}

	/** DJB2 string hash for deterministic session-to-credential binding. */
	#hashString(str: string): number {
		let hash = 5381;
		for (let i = 0; i < str.length; i++) {
			hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
		}
		return Math.abs(hash);
	}

	#clearBackoffForProvider(providerId: string): void {
		const key = this.#providerKey(providerId);
		this.#credentialBackoff.delete(key);
		this.#hydratedProviderKeys.delete(key);
		this.#roundRobinIndex.delete(key);
	}

	close(): void {
		this.#credentialBackoff.clear();
		this.#hydratedProviderKeys.clear();
		this.#roundRobinIndex.clear();
	}
}
