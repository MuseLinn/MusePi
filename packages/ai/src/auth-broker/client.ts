/**
 * HTTP client for the auth-broker server.
 *
 * Used by RemoteAuthCredentialStore for snapshot pulls and by
 * health checks. All endpoints except `/v1/healthz` require a bearer token.
 */

import type { z } from "zod";
import type {
	CredentialBlockRequest,
	CredentialBlockResponse,
	CredentialBlocksDeleteResponse,
	CredentialDisableResponse,
	CredentialRefreshResponse,
	CredentialUploadRequest,
	CredentialUploadResponse,
	HealthzResponse,
	SnapshotResponse,
	SnapshotStreamEvent,
	UsageResponse,
	UsageStaleResponse,
} from "./types.ts";
import {
	credentialBlockResponseSchema,
	credentialBlocksDeleteResponseSchema,
	credentialDisableResponseSchema,
	credentialRefreshResponseSchema,
	credentialUploadResponseSchema,
	healthzResponseSchema,
	snapshotResponseSchema,
	snapshotStreamEventSchema,
	usageResponseSchema,
	usageStaleResponseSchema,
} from "./wire-schemas.ts";

export interface AuthBrokerClientOptions {
	baseUrl: string;
	token: string;
	fetchImpl?: typeof fetch;
	maxRetries?: number;
}

export class AuthBrokerClient {
	readonly #baseUrl: string;
	readonly #token: string;
	readonly #fetch: typeof fetch;
	readonly #maxRetries: number;

	constructor(opts: AuthBrokerClientOptions) {
		this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
		this.#token = opts.token;
		this.#fetch = opts.fetchImpl ?? globalThis.fetch;
		this.#maxRetries = opts.maxRetries ?? 1;
	}

	async healthz(signal?: AbortSignal): Promise<HealthzResponse> {
		return this.#request("GET", "/v1/healthz", { schema: healthzResponseSchema, signal, noAuth: true });
	}

	async fetchSnapshot(opts?: {
		generation?: number;
		waitMs?: number;
		signal?: AbortSignal;
	}): Promise<{ status: 200 | 304; snapshot?: SnapshotResponse; generation: number }> {
		const params = new URLSearchParams();
		if (opts?.generation !== undefined) params.set("generation", String(opts.generation));
		if (opts?.waitMs) params.set("wait", String(opts.waitMs));
		const qs = params.toString();
		const response = await this.#raw("GET", `/v1/snapshot${qs ? `?${qs}` : ""}`, { signal: opts?.signal });
		const etag = Number(response.headers.get("etag") ?? "0");

		if (response.status === 304) {
			return { status: 304, generation: etag };
		}

		const body = snapshotResponseSchema.parse(await response.json());
		return { status: 200, snapshot: body, generation: body.generation };
	}

	async *openSnapshotStream(signal?: AbortSignal): AsyncGenerator<SnapshotStreamEvent> {
		const response = await this.#raw("GET", "/v1/snapshot/stream", { signal });

		if (response.status === 404) {
			throw Object.assign(new Error("SSE streaming not supported by this broker"), { status: 404 });
		}

		if (!response.body) throw new Error("No response body for SSE stream");

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let currentEvent = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (line.startsWith(":")) continue;
					if (line.startsWith("event: ")) {
						currentEvent = line.slice(7);
					} else if (line.startsWith("data: ")) {
						const data = line.slice(6);
						if (currentEvent === "snapshot" || currentEvent === "entry" || currentEvent === "removed") {
							try {
								const parsed = JSON.parse(data);
								const validated = snapshotStreamEventSchema.parse(parsed);
								yield validated;
							} catch {
								// skip malformed events
							}
						}
						currentEvent = "";
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	async fetchUsage(signal?: AbortSignal): Promise<UsageResponse> {
		return this.#request("GET", "/v1/usage", { schema: usageResponseSchema, signal });
	}

	async notifyUsageStale(signal?: AbortSignal): Promise<UsageStaleResponse> {
		return this.#request("POST", "/v1/usage/stale", { schema: usageStaleResponseSchema, signal });
	}

	async refreshCredential(id: number, signal?: AbortSignal): Promise<CredentialRefreshResponse> {
		return this.#request("POST", `/v1/credential/${id}/refresh`, {
			schema: credentialRefreshResponseSchema,
			signal,
		});
	}

	async disableCredential(id: number, cause: string, signal?: AbortSignal): Promise<CredentialDisableResponse> {
		return this.#request("POST", `/v1/credential/${id}/disable`, {
			body: { cause },
			schema: credentialDisableResponseSchema,
			signal,
		});
	}

	async updateRemark(id: number, remark: string, signal?: AbortSignal): Promise<void> {
		await this.#request("PATCH", `/v1/credential/${id}/remark`, {
			body: { remark },
			signal,
		});
	}

	async uploadCredential(
		provider: string,
		credential: CredentialUploadRequest["credential"],
		signal?: AbortSignal,
	): Promise<CredentialUploadResponse> {
		return this.#request("POST", "/v1/credential", {
			body: { provider, credential } satisfies CredentialUploadRequest,
			schema: credentialUploadResponseSchema,
			signal,
		});
	}

	async upsertCredentialBlock(
		id: number,
		block: CredentialBlockRequest,
		signal?: AbortSignal,
	): Promise<CredentialBlockResponse> {
		return this.#request("POST", `/v1/credential/${id}/block`, {
			body: block,
			schema: credentialBlockResponseSchema,
			signal,
		});
	}

	async deleteCredentialBlocks(id: number, signal?: AbortSignal): Promise<CredentialBlocksDeleteResponse> {
		return this.#request("DELETE", `/v1/credential/${id}/blocks`, {
			schema: credentialBlocksDeleteResponseSchema,
			signal,
		});
	}

	// ─── Internal HTTP helpers ─────────────────────────────────────────

	async #request<T>(
		method: string,
		path: string,
		opts: {
			body?: unknown;
			schema?: z.ZodType<T>;
			signal?: AbortSignal;
			noAuth?: boolean;
		},
	): Promise<T> {
		const response = await this.#raw(method, path, {
			body: opts.body ? JSON.stringify(opts.body) : undefined,
			signal: opts.signal,
			noAuth: opts.noAuth,
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw Object.assign(new Error(`Auth-broker error ${response.status}: ${text.slice(0, 200)}`), {
				status: response.status,
			});
		}

		const json = await response.json();
		if (opts.schema) return opts.schema.parse(json);
		return json as T;
	}

	async #raw(
		method: string,
		path: string,
		opts?: { body?: string; signal?: AbortSignal; noAuth?: boolean },
	): Promise<Response> {
		const url = `${this.#baseUrl}${path}`;
		const headers: Record<string, string> = {};
		if (!opts?.noAuth) {
			headers.Authorization = `Bearer ${this.#token}`;
		}
		if (opts?.body) {
			headers["Content-Type"] = "application/json";
		}

		let lastError: Error | undefined;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
			try {
				const response = await this.#fetch(url, {
					method,
					headers,
					body: opts?.body,
					signal: opts?.signal,
				});
				return response;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				if (opts?.signal?.aborted) throw lastError;
				if (attempt < this.#maxRetries) {
					await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
				}
			}
		}

		throw lastError!;
	}
}
