/**
 * Concrete {@link BrokerStore} implementation wrapping a
 * {@link SqliteCredentialStore} with snapshot export, OAuth refresh
 * delegation, and generation-change notification.
 */

import type { SqliteCredentialStore } from "../auth/sqlite-credential-store.ts";
import type { OAuthCredential } from "../auth/types.ts";
import type { BrokerStore, SnapshotEntry, SnapshotResponse, UsageReport } from "./types.ts";
import { DEFAULT_REFRESH_INTERVAL_MS, DEFAULT_REFRESH_SKEW_MS } from "./types.ts";
export type RefreshOAuthFn = (
	id: number,
	credential: OAuthCredential,
	signal?: AbortSignal,
) => Promise<OAuthCredential>;

export interface SqliteBrokerStoreOptions {
	store: SqliteCredentialStore;
	refreshOAuth?: RefreshOAuthFn;
	refreshIntervalMs?: number;
	refreshSkewMs?: number;
}

export class SqliteBrokerStore implements BrokerStore {
	#gen = 0;
	#genListeners = new Set<() => void>();
	#store: SqliteCredentialStore;
	#refreshOAuth?: RefreshOAuthFn;
	#refreshIntervalMs: number;
	#refreshSkewMs: number;

	constructor(opts: SqliteBrokerStoreOptions) {
		this.#store = opts.store;
		this.#refreshOAuth = opts.refreshOAuth;
		this.#refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
		this.#refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
	}

	get generation(): number {
		return this.#gen;
	}

	onGenerationBump(cb: () => void): () => void {
		this.#genListeners.add(cb);
		return () => this.#genListeners.delete(cb);
	}

	#bump(): void {
		this.#gen++;
		for (const cb of this.#genListeners) {
			try {
				cb();
			} catch {
				// ignore
			}
		}
	}

	async exportSnapshot(): Promise<SnapshotResponse> {
		const rows = await this.#store.listCredentials();
		const credentials: SnapshotEntry[] = rows.map((r) => ({
			id: r.id,
			provider: r.providerId,
			type: r.type === "oauth" ? "oauth" : "api_key",
			remark: r.remark ?? null,
			email: r.email ?? null,
			orgId: r.orgId ?? null,
			orgName: r.orgName ?? null,
			accountId: r.accountId ?? null,
			identityKey: null,
			access: null,
			expires: null,
			disabledCause: null,
			createdAt: 0,
			updatedAt: 0,
			active: true,
		}));

		const now = Date.now();
		return {
			generation: this.generation,
			generatedAt: now,
			serverNowMs: now,
			refresher: {
				enabled: this.#refreshOAuth !== undefined,
				intervalMs: this.#refreshIntervalMs,
				skewMs: this.#refreshSkewMs,
				nextSweepAt: now + this.#refreshIntervalMs,
			},
			credentials,
		};
	}

	async upsertCredentialForProvider(
		provider: string,
		body: {
			type: "oauth";
			access: string;
			refresh: string;
			expires: number;
			[key: string]: unknown;
		},
	): Promise<SnapshotEntry[]> {
		const credential: OAuthCredential = {
			type: "oauth",
			access: body.access,
			refresh: body.refresh,
			expires: body.expires,
			email: body.email as string | undefined,
			accountId: body.accountId as string | undefined,
			orgId: body.orgId as string | undefined,
			orgName: body.orgName as string | undefined,
		};
		await this.#store.modify(provider, async () => credential);
		this.#bump();
		return this.#store.listCredentials(provider).then((r) =>
			r.map(
				(e) =>
					({
						id: e.id,
						provider: e.providerId,
						type: "oauth",
						remark: e.remark ?? null,
						email: e.email ?? null,
						orgId: e.orgId ?? null,
						orgName: e.orgName ?? null,
						accountId: e.accountId ?? null,
						identityKey: null,
						access: body.access ?? null,
						expires: body.expires ?? null,
						disabledCause: null,
						createdAt: 0,
						updatedAt: 0,
						active: true,
					}) satisfies SnapshotEntry,
			),
		);
	}

	async disableCredentialById(id: number, _cause: string): Promise<boolean> {
		const remaining = await this.#store.removeCredential(id);
		if (remaining.length === 0) return false;
		this.#bump();
		return true;
	}

	updateRemarkById(id: number, remark: string): void {
		this.#store.updateRemark(id, remark);
		this.#bump();
	}

	async forceRefreshCredentialById(id: number): Promise<SnapshotEntry> {
		if (!this.#refreshOAuth) throw new Error("OAuth refresh not configured");

		const all = await this.#store.listCredentials();
		const target = all.find((e) => e.id === id);
		if (!target) throw new Error(`No credential with id=${id}`);

		const current = await this.#store.read(target.providerId);
		if (!current || current.type !== "oauth") throw new Error(`Credential ${id} is not OAuth`);

		const refreshed = await this.#refreshOAuth(id, current as OAuthCredential);
		await this.#store.modify(target.providerId, async () => refreshed);
		this.#bump();

		return this.exportSnapshot().then((s) => {
			const entry = s.credentials.find((e) => e.id === id);
			if (!entry) throw new Error(`Credential ${id} disappeared after refresh`);
			return entry;
		});
	}

	fetchUsageReports(): UsageReport[] {
		return [];
	}

	invalidateUsageCache(): void {
		// No-op.
	}

	getCredentialBlock(credentialId: number, providerKey: string, blockScope: string): number | undefined {
		return this.#store.getCredentialBlock(credentialId, providerKey, blockScope);
	}

	upsertCredentialBlock(credentialId: number, providerKey: string, blockScope: string, blockedUntilMs: number): void {
		this.#store.upsertCredentialBlock(credentialId, providerKey, blockScope, blockedUntilMs);
		this.#bump();
	}

	deleteCredentialBlocks(credentialId: number): void {
		this.#store.deleteCredentialBlocks(credentialId);
		this.#bump();
	}

	close(): void {
		this.#store.close();
	}
}
