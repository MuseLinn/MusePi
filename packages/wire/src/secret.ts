/**
 * Agent-secret wire contract (daemon ↔ GUI).
 *
 * Values travel in exactly one direction: GUI → daemon on `secret.answer` /
 * `secret.set`. No result, push or list shape ever carries a value.
 *
 * Scope is the authorization half: `"all"` means every session, a directory
 * list means only sessions whose working directory sits at or under one of
 * those roots. The GUI never sends a path — it asks for `"workspace"` and the
 * daemon resolves it from the pending request's session.
 */

export type SecretScope = "all" | string[];

/** What the user picked in the card: every session, or the asking workspace. */
export type SecretScopeChoice = "all" | "workspace";

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
	/** Omitted keeps the stored scope (or `"all"` for a new entry). */
	scope?: SecretScopeChoice;
}

export interface SecretSetResult {
	entry: SecretEntryView;
}

/** Widen a stored secret to every session; the only scope edit the page makes. */
export interface SecretUpdateParams {
	name: string;
	scope: "all";
}

export interface SecretUpdateResult {
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
	/** `fill` asks for a value; `allow` asks to extend an existing entry's scope. */
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
	/** `save` records this scope; `allow` ignores it and uses the request's workspace. */
	scope?: SecretScopeChoice;
	/** Optional when request ids are already unique across live sessions. */
	sessionId?: string;
}

export interface SecretAnswerResult {
	ok: true;
}
