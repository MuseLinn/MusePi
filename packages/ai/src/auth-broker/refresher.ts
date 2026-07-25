/**
 * Background OAuth refresh loop for the auth-broker server.
 *
 * Iterates active OAuth credentials at `refreshIntervalMs` cadence, refreshing
 * any whose `expires - Date.now() < refreshSkewMs`. On definitive failure
 * (invalid_grant, etc.), disables the credential.
 */

import { isDefinitiveOAuthFailure } from "./error.ts";
import type { BrokerStore, RefresherSchedule } from "./types.ts";
import { DEFAULT_REFRESH_INTERVAL_MS, DEFAULT_REFRESH_SKEW_MS } from "./types.ts";

export interface AuthBrokerRefresherOptions {
	storage: BrokerStore;
	refreshIntervalMs?: number;
	refreshSkewMs?: number;
}

export class AuthBrokerRefresher {
	#storage: BrokerStore;
	#intervalMs: number;
	#skewMs: number;
	#timer: ReturnType<typeof setInterval> | undefined;
	#running = false;

	constructor(opts: AuthBrokerRefresherOptions) {
		this.#storage = opts.storage;
		this.#intervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
		this.#skewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
	}

	getSchedule(): RefresherSchedule {
		return {
			enabled: this.#running,
			intervalMs: this.#intervalMs,
			skewMs: this.#skewMs,
			nextSweepAt: this.#running ? Date.now() + this.#intervalMs : 0,
		};
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		void this.#tick();
		this.#timer = setInterval(() => void this.#tick(), this.#intervalMs);
	}

	stop(): void {
		this.#running = false;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	async #tick(): Promise<void> {
		if (!this.#running) return;
		const cutoff = Date.now() + this.#skewMs;

		const snapshot = await this.#storage.exportSnapshot();
		const targets = snapshot.credentials.filter(
			(c) => c.type === "oauth" && c.expires !== null && c.expires <= cutoff,
		);

		await Promise.allSettled(targets.map((c) => this.#refreshOne(c.id)));
	}

	async #refreshOne(id: number): Promise<void> {
		try {
			await this.#storage.forceRefreshCredentialById(id);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (isDefinitiveOAuthFailure(errorMsg)) {
				this.#storage.disableCredentialById(id, `refresh-failed: ${errorMsg.slice(0, 200)}`);
			}
		}
	}
}
