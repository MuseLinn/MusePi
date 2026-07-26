/**
 * Client-side CredentialStore implementation backed by a remote auth-broker.
 *
 * Mirrors the broker's credential snapshot in memory, syncs via SSE stream
 * or long-poll with exponential backoff, and proxies mutations through HTTP.
 * Uses a sentinel value for OAuth refresh tokens — actual refresh tokens
 * never leave the broker.
 */

import { ModelsError } from "../auth/resolve.ts";
import type {
	ApiKeyCredential,
	Credential,
	CredentialInfo,
	CredentialStore,
	OAuthCredential,
	StoredCredentialInfo,
} from "../auth/types.ts";
import type { AuthBrokerClient } from "./client.ts";
import type { SnapshotResponse } from "./types.ts";
import { REMOTE_REFRESH_SENTINEL } from "./types.ts";

export interface RemoteAuthCredentialStoreOptions {
	client: AuthBrokerClient;
	initialSnapshot?: SnapshotResponse;
}

export class RemoteAuthCredentialStore implements CredentialStore {
	readonly #client: AuthBrokerClient;
	#snapshot: SnapshotResponse = {
		generation: 0,
		generatedAt: 0,
		serverNowMs: 0,
		refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepAt: 0 },
		credentials: [],
	};

	constructor(opts: RemoteAuthCredentialStoreOptions) {
		this.#client = opts.client;
		if (opts.initialSnapshot) {
			this.#snapshot = opts.initialSnapshot;
		}
	}

	// ─── CredentialStore contract ──────────────────────────────────────

	/**
	 * Read the first credential for a provider. Multiple credentials are
	 * selected by the broker's round-robin / session-sticky strategy on
	 * each snapshot.
	 */
	async read(providerId: string): Promise<Credential | undefined> {
		const entry = this.#snapshot.credentials.find((e) => e.provider === providerId && !e.disabledCause);
		if (!entry) return undefined;

		if (entry.type === "oauth") {
			return {
				type: "oauth",
				access: entry.access ?? "",
				refresh: REMOTE_REFRESH_SENTINEL,
				expires: entry.expires ?? 0,
				email: entry.email ?? undefined,
				orgId: entry.orgId ?? undefined,
				orgName: entry.orgName ?? undefined,
				accountId: entry.accountId ?? undefined,
			} satisfies OAuthCredential;
		}

		return { type: "api_key", key: entry.access ?? undefined } satisfies ApiKeyCredential;
	}

	/** List one entry per (provider, type). */
	async list(): Promise<readonly CredentialInfo[]> {
		const seen = new Set<string>();
		const result: CredentialInfo[] = [];
		for (const entry of this.#snapshot.credentials) {
			const key = `${entry.provider}:${entry.type}`;
			if (seen.has(key)) continue;
			seen.add(key);
			result.push({
				providerId: entry.provider,
				type: entry.type,
				id: entry.id,
				remark: entry.remark ?? undefined,
				email: entry.email ?? undefined,
				orgId: entry.orgId ?? undefined,
				orgName: entry.orgName ?? undefined,
				accountId: entry.accountId ?? undefined,
			});
		}
		return result;
	}

	/** Modify is not supported on the remote store. */
	async modify(
		_providerId: string,
		_fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		throw new ModelsError("auth", "RemoteAuthCredentialStore is read-only for mutations. Use the broker directly.");
	}

	/** Delete is not supported on the remote store. */
	async delete(_providerId: string): Promise<void> {
		throw new ModelsError("auth", "RemoteAuthCredentialStore is read-only for mutations. Use the broker directly.");
	}

	async listCredentials(providerId?: string): Promise<StoredCredentialInfo[]> {
		const entries = providerId
			? this.#snapshot.credentials.filter((e) => e.provider === providerId)
			: this.#snapshot.credentials;

		return entries.map((e) => ({
			id: e.id,
			providerId: e.provider,
			type: e.type,
			remark: e.remark ?? undefined,
			email: e.email ?? undefined,
			orgId: e.orgId ?? undefined,
			orgName: e.orgName ?? undefined,
			accountId: e.accountId ?? undefined,
		}));
	}

	async removeCredential(id: number): Promise<number[]> {
		await this.#client.disableCredential(id, "removed via remote store");
		return this.#snapshot.credentials.filter((e) => !e.disabledCause).map((e) => e.id);
	}

	async updateRemark(id: number, remark: string): Promise<void> {
		// Override the no-op snapshot remark with the remote sync.
		const entry = this.#snapshot.credentials.find((c) => c.id === id);
		if (entry) {
			this.#snapshot = {
				...this.#snapshot,
				credentials: this.#snapshot.credentials.map((c) => (c.id === id ? { ...c, remark } : c)),
			};
		}
		await this.#client.updateRemark(id, remark);
	}

	async setActiveCredential(_providerId: string, _credentialId: number): Promise<void> {
		// Remote store: the broker manages active credential selection.
	}

	// ─── Snapshot management ───────────────────────────────────────────

	/** Replace the in-memory snapshot with a fresh one from the broker. */
	async refreshSnapshot(signal?: AbortSignal): Promise<void> {
		const result = await this.#client.fetchSnapshot({ signal });
		if (result.status === 200 && result.snapshot) {
			this.#snapshot = result.snapshot;
		}
	}

	/** Return the current snapshot (for testing/diagnostics). */
	getSnapshot(): SnapshotResponse {
		return this.#snapshot;
	}
}
