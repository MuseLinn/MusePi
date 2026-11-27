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

/** How a saved value reaches the agent: a bash environment variable, or a
 *  private file whose path it is told. `file` values are never exported. */
export type SecretDelivery = "env" | "file";

/** What the user picked in the card: every session, or the asking workspace. */
export type SecretScopeChoice = "all" | "workspace";

/**
 * What kind of credential an entry holds.
 *
 * The distinction is not cosmetic: a `secret` reaches the agent (as an env var
 * or a private file), while a `login` never does — the agent asks for its
 * fields to be typed into a browser form and the store types them. Keeping
 * them one type with no delivery would let a password be exported by mistake.
 */
export type SecretKind = "secret" | "login";

/** The non-secret half of a saved login, shown in lists and on cards. */
export interface SecretLoginView {
	/** Registrable site, e.g. `example.com`. */
	site: string;
	/** Hosts the sign-in page was seen on. */
	hosts: string[];
	/** Fill only on `hosts`, never elsewhere on the site. */
	exactHost: boolean;
	username: string;
	/** A TOTP setup key is stored, so the one-time code can be typed too. */
	hasTotp: boolean;
}

/** Metadata the settings page and `secret.list` can show. */
export interface SecretEntryView {
	name: string;
	purpose: string;
	scope: SecretScope;
	/** `secret` for a value the agent uses; `login` for a sign-in it only fills. */
	kind: SecretKind;
	/** Present exactly when `kind` is `login`. */
	login?: SecretLoginView;
	delivery: SecretDelivery;
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
	/** How the master key is stored: a plain key file, or wrapped by a passphrase. */
	protectedBy?: "key-file" | "passphrase";
	/** True when a passphrase is required and this process has not unlocked the store. */
	locked?: boolean;
	reason?: "missing-passphrase" | "wrong-passphrase" | "passphrase-source";
	/**
	 * The connector token store, which follows the same passphrase as the vault.
	 * A locked vault leaves connector tokens unreadable, so the page can say the
	 * protection covers both instead of implying it covers only one.
	 */
	connectors?: {
		protectedBy: "key-file" | "passphrase";
		locked: boolean;
	};
}

/** Set, unlock, or remove the optional passphrase protection. */
export interface SecretPassphraseParams {
	passphrase: string;
}

/** Replace the passphrase that wraps the master key; the old one proves the change. */
export interface SecretRephraseParams {
	current: string;
	next: string;
}

export interface SecretListResult {
	entries: SecretEntryView[];
	count: number;
}

/** One MCP server's permission to read vault entries. */
export interface McpGrantView {
	server: string;
	/** Fingerprint of the endpoint the user approved; a changed endpoint does not inherit it. */
	target: string;
	keys: string[];
}

export interface SecretMcpGrantsResult {
	servers: McpGrantView[];
}

/** Replace one server's key list; an empty list revokes the server. */
export interface SecretSetMcpGrantParams {
	server: string;
	target: string;
	keys: string[];
}

/** The fields a saved login stores besides its password. */
export interface SecretLoginInput {
	site: string;
	hosts?: string[];
	exactHost?: boolean;
	username: string;
	/** A `otpauth://` URI or a bare base32 setup key. Its code is typed, never returned. */
	totp?: string;
}

export interface SecretSetParams {
	name: string;
	value: string;
	purpose?: string;
	/** Omitted keeps the stored scope (or `"all"` for a new entry). */
	scope?: SecretScopeChoice;
	/** Omitted keeps the stored delivery (or `"env"` for a new entry). */
	delivery?: SecretDelivery;
	/** `login` entries carry `login` and ignore `delivery`. */
	kind?: SecretKind;
	login?: SecretLoginInput;
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
	/** `fill` asks for a value; `allow` extends scope; `login` asks for a sign-in. */
	kind: "fill" | "allow" | "login";
	delivery: SecretDelivery;
	/** For `login`: the site the agent is on, so the card can prefill it. */
	site?: string;
	/** Saved entries the user may pick instead of typing a new value. */
	alternatives?: SecretAlternativeView[];
}

/** One reusable entry a card offers under "Use a saved one". Never a value. */
export interface SecretAlternativeView {
	name: string;
	purpose: string;
	/** For a login: its site. */
	site?: string;
	username?: string;
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
	/** `save` records this delivery; `allow` keeps the entry's own. */
	delivery?: SecretDelivery;
	/** For a login card: the sign-in the form collected. */
	login?: SecretLoginInput;
	/** With `allow`: the saved entry the user picked instead of typing a value. */
	picked?: string;
	/** Optional when request ids are already unique across live sessions. */
	sessionId?: string;
}

export interface SecretAnswerResult {
	ok: true;
}

/**
 * A `connector_catalog` action `request`, pushed while the tool call waits.
 *
 * The card decides only whether to connect: enabling runs the same
 * `connectors.connect` the settings page uses, inside the parked tool call, so
 * a card can never put the session in a state the UI could not reach.
 */
export interface ConnectorRequestPayload {
	requestId: string;
	/** Catalog id, exactly as the catalog reports it. */
	id: string;
	name: string;
	/** Why the agent wants it, in its own words. */
	purpose: string;
	authMode: "oauth" | "none" | "token";
}

/** Settlement broadcast so other cards clear after the first answer. */
export interface ConnectorRequestEndPayload {
	requestId: string;
}

export interface ConnectorRequestAnswerParams {
	requestId: string;
	decision: "connect" | "decline";
	/** Optional when request ids are already unique across live sessions. */
	sessionId?: string;
}

export interface ConnectorRequestAnswerResult {
	ok: true;
}
