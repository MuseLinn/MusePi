/**
 * Agent-secret wire contract (daemon ↔ GUI).
 *
 * Values travel in exactly one direction: GUI → daemon on `secret.answer` /
 * `secret.set`. No result, push or list shape ever carries a value. P0 scope
 * is `"all"`; workspace/bot variants extend the union later.
 */

export type SecretScope = "all";

/** Metadata the settings page and `secret.list` can show. */
export interface SecretEntryView {
	name: string;
	purpose: string;
	scope: SecretScope;
	/** Epoch ms. */
	createdAt: number;
	/** Epoch ms. */
	updatedAt: number;
	/** Epoch ms; absent until the value was first injected into a bash call. */
	lastUsedAt?: number;
}

export interface SecretStatus {
	mode: "encrypted";
	count: number;
}

export interface SecretListResult {
	entries: SecretEntryView[];
	count: number;
}

export interface SecretSetParams {
	name: string;
	value: string;
	purpose?: string;
	scope?: SecretScope;
}

export interface SecretSetResult {
	entry: SecretEntryView;
}

export interface SecretDeleteParams {
	name: string;
}

export interface SecretDeleteResult {
	ok: true;
}

/** Push while a `request_secret` tool call is parked on user input. */
export interface SecretRequestPayload {
	requestId: string;
	name: string;
	purpose: string;
	kind: "fill" | "allow";
}

/** Settlement broadcast so other cards clear after the first answer. */
export interface SecretRequestEndPayload {
	requestId: string;
}

export interface SecretAnswerParams {
	requestId: string;
	action: "save" | "allow" | "cancel";
	/** Required for `save`; never echoed back. */
	value?: string;
	scope?: SecretScope;
	/** Optional when request ids are already unique across live sessions. */
	sessionId?: string;
}

export interface SecretAnswerResult {
	ok: true;
}
