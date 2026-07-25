/**
 * Wire types shared between the auth-broker server and clients.
 *
 * The broker holds OAuth refresh tokens and exposes a redacted snapshot;
 * clients receive access tokens with `refresh = REMOTE_REFRESH_SENTINEL`
 * and call back to the broker when a new access token is needed.
 */

/** Sentinel value replacing real OAuth refresh tokens in broker snapshots. */
export const REMOTE_REFRESH_SENTINEL = "__remote__" as const;

/** GET /v1/healthz response body. */
export interface HealthzResponse {
	ok: boolean;
	version?: string;
}

export interface RefresherSchedule {
	enabled: boolean;
	intervalMs: number;
	skewMs: number;
	nextSweepAt: number;
}

/** One credential entry in a broker snapshot. */
export type SnapshotEntry = {
	id: number;
	provider: string;
	type: "api_key" | "oauth";
	remark: string | null;
	email: string | null;
	orgId: string | null;
	orgName: string | null;
	accountId: string | null;
	identityKey: string | null;
	access: string | null;
	expires: number | null;
	disabledCause: string | null;
	createdAt: number;
	updatedAt: number;
	active: boolean;
};

/** GET /v1/snapshot response body. */
export interface SnapshotResponse {
	generation: number;
	generatedAt: number;
	serverNowMs: number;
	refresher: RefresherSchedule;
	credentials: SnapshotEntry[];
}

/** GET /v1/usage response body. */
export interface UsageResponse {
	generatedAt: number;
	reports: UsageReport[];
}

export interface UsageReport {
	credential: { provider: string; id: number };
	limits: UsageLimit[];
}

export interface UsageLimit {
	id: string;
	used: number;
	limit: number;
	resetsAt: number;
}

/** POST /v1/credential/:id/refresh response body. */
export interface CredentialRefreshResponse {
	entry: SnapshotEntry;
}

/** POST /v1/credential/:id/disable request body. */
export interface CredentialDisableRequest {
	cause: string;
}

/** POST /v1/credential/:id/disable response body. */
export interface CredentialDisableResponse {
	ok: boolean;
}

/** POST /v1/credential/:id/block request body. */
export interface CredentialBlockRequest {
	providerKey: string;
	blockScope: string;
	blockedUntilMs: number;
}

/** POST /v1/credential/:id/block response body. */
export interface CredentialBlockResponse {
	ok: boolean;
}

/** DELETE /v1/credential/:id/blocks response body. */
export interface CredentialBlocksDeleteResponse {
	ok: boolean;
}

/** POST /v1/usage/stale response body. */
export interface UsageStaleResponse {
	ok: boolean;
}

/** POST /v1/credential request body. */
export interface CredentialUploadRequest {
	provider: string;
	credential: {
		type: "oauth";
		access: string;
		refresh: string;
		expires: number;
		[key: string]: unknown;
	};
}

/** POST /v1/credential response body. */
export interface CredentialUploadResponse {
	entries: SnapshotEntry[];
}

/** SSE event kinds. */
export type SnapshotStreamEventKind = "snapshot" | "entry" | "removed";

/** Initial frame emitted on connect. */
export interface SnapshotStreamSnapshotEvent extends SnapshotResponse {
	kind: "snapshot";
}

/** Single credential added/changed. */
export interface SnapshotStreamEntryEvent {
	kind: "entry";
	entry: SnapshotEntry;
	generation: number;
}

/** Single credential disabled/deleted. */
export interface SnapshotStreamRemovedEvent {
	kind: "removed";
	id: number;
	generation: number;
}

/** Discriminated union of every event the SSE stream emits. */
export type SnapshotStreamEvent = SnapshotStreamSnapshotEvent | SnapshotStreamEntryEvent | SnapshotStreamRemovedEvent;

/** Default bearer-protected route prefix. */
export const AUTH_BROKER_API_PREFIX = "/v1";

/** Default port when none is configured. Loopback-only. */
export const DEFAULT_AUTH_BROKER_BIND = "127.0.0.1:8765";

/** Refresh skew — refresh credentials this close to expiry. */
export const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;

/** Default broker refresh-loop cadence. */
export const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

/** Default freshness window for the encrypted local cache. */
export const DEFAULT_SNAPSHOT_CACHE_TTL_MS = 60 * 60_000;

/** Keepalive cadence for SSE comment frames. */
export const DEFAULT_STREAM_KEEPALIVE_MS = 20_000;

/**
 * The interface the broker server wraps for credential operations.
 * Extends storage ops with snapshot export, OAuth refresh, usage, and blocks.
 */
export interface BrokerStore {
	readonly generation: number;
	onGenerationBump(cb: () => void): () => void;

	exportSnapshot(): Promise<SnapshotResponse>;
	upsertCredentialForProvider(
		provider: string,
		credential: {
			type: "oauth";
			access: string;
			refresh: string;
			expires: number;
			[key: string]: unknown;
		},
	): Promise<SnapshotEntry[]>;
	disableCredentialById(id: number, cause: string): Promise<boolean>;
	updateRemarkById(id: number, remark: string): void;
	forceRefreshCredentialById(id: number): Promise<SnapshotEntry>;
	fetchUsageReports(): UsageReport[];
	invalidateUsageCache(): void;
	getCredentialBlock(credentialId: number, providerKey: string, blockScope: string): number | undefined;
	upsertCredentialBlock(credentialId: number, providerKey: string, blockScope: string, blockedUntilMs: number): void;
	deleteCredentialBlocks(credentialId: number): void;
	close(): void;
}
