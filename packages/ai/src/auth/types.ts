import type { ProviderEnv, ProviderHeaders } from "../types.ts";

/**
 * Request auth for a single model request. If a value cannot be expressed as
 * `apiKey`, `headers`, or `baseUrl`, it is provider config, not auth.
 */
export interface ModelAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
}

/**
 * Stored api-key credential. `env` holds provider-scoped environment/config
 * values such as Cloudflare account/gateway ids.
 */
export interface ApiKeyCredential {
	type: "api_key";
	key?: string;
	env?: ProviderEnv;
}

/** OAuth token data returned by extension compatibility flows. */
export interface OAuthCredentials {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
}

/** Stored canonical OAuth credential. */
export interface OAuthCredential extends OAuthCredentials {
	type: "oauth";
}

/** One type-tagged credential per provider — the shape of today's auth.json. */
export type Credential = ApiKeyCredential | OAuthCredential;

/** Non-secret credential metadata for account/status enumeration. */
export interface CredentialInfo {
	providerId: string;
	type: Credential["type"];
	/**
	 * Database row id. Undefined for legacy single-credential stores or
	 * ambient-only providers.
	 */
	id?: number;
	/** User-editable label for distinguishing API keys. */
	remark?: string;
	/** OAuth email, when known from the identity provider. */
	email?: string;
	/** Organization/workspace id, when scoped (Anthropic, ChatGPT multi-sub). */
	orgId?: string;
	/** Human-readable organization label. */
	orgName?: string;
	/** OAuth account id from the identity provider. */
	accountId?: string;
}

/**
 * Full metadata about one stored credential row, as returned by
 * {@link CredentialStore.listCredentials}. Includes the credential's
 * internal storage id, identity metadata, and user-editable remark.
 */
export interface StoredCredentialInfo {
	id: number;
	providerId: string;
	type: Credential["type"];
	remark?: string;
	email?: string;
	orgId?: string;
	orgName?: string;
	accountId?: string;
}

/**
 * App-owned credential storage, keyed by `Provider.id`. Supports multiple
 * credentials per provider for round-robin, usage-based ranking, and
 * session-sticky credential selection.
 *
 * The four contract methods (`read`, `list`, `modify`, `delete`) operate on
 * the **active** credential for a provider — the one selected by
 * session-sticky or round-robin logic. Store implementations that need
 * multi-credential management implement the additional methods below.
 *
 * `Models.getAuth()` calls `read(providerId)` to obtain the credential to
 * use for an outbound API request. Implementations that return different
 * credentials per session or per call are responsible for their own selection
 * strategy (round-robin, usage ranking, etc.).
 *
 * Error semantics: `read` resolves `undefined` for missing entries. Methods
 * reject only on storage failure; `Models` wraps such rejections in
 * `ModelsError` with code "auth". Best-effort stores that serve an in-memory
 * view and record persistence errors internally (like coding-agent's
 * AuthStorage) are valid implementations.
 */
export interface CredentialStore {
	/**
	 * Read the stored credential, possibly expired. Display/status use;
	 * resolved request auth comes from `Models.getAuth()`.
	 *
	 * For multi-credential stores, returns the **active** credential for the
	 * provider — the one selected by the store's credential-selection
	 * strategy (session stickiness, round-robin, usage ranking).
	 */
	read(providerId: string): Promise<Credential | undefined>;

	/**
	 * List stored credential metadata without resolving or exposing secrets.
	 * Implementations must not execute configured API-key commands while listing.
	 *
	 * For multi-credential stores, returns one entry per stored credential,
	 * including the augmented `CredentialInfo` fields (`id`, `remark`, etc.).
	 */
	list(): Promise<readonly CredentialInfo[]>;

	/**
	 * Serialized write — the only write path. `fn` sees the current credential
	 * because correct writes (refresh, login-during-refresh) depend on it;
	 * return the new credential, or undefined to leave the entry unchanged.
	 * Mutual exclusion per provider id, cross-process too where the backing
	 * store supports it (e.g. a file lock). Resolves with the post-write
	 * credential. Rejections from `fn` propagate.
	 *
	 * For multi-credential stores, operates on the **active** credential for
	 * the provider (the one `read()` would return).
	 */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined>;

	/** Remove a credential (logout). Implementations serialize this against `modify`. */
	delete(providerId: string): Promise<void>;

	// ─────────────────────────────────────────────────────────────────────
	// Multi-credential management methods
	// (optional — throw "not supported" on single-credential stores)
	// ─────────────────────────────────────────────────────────────────────

	/**
	 * List full metadata for one or all providers' stored credentials.
	 * Unlike `list()`, returns the full `StoredCredentialInfo` for each row,
	 * suitable for rendering an account picker.
	 *
	 * Resolves with an empty array when no credentials are stored. Rejects on
	 * storage failure. Implementations that don't support multi-credential
	 * storage may throw `ModelsError` with code "auth".
	 */
	listCredentials(providerId?: string): Promise<StoredCredentialInfo[]>;

	/**
	 * Remove one stored credential by its storage id. Used for per-account
	 * logout from multi-credential stores. Single-credential stores should
	 * delegate to `delete(providerId)`.
	 * Resolves with the remaining credential ids for the provider, or an
	 * empty array when none remain.
	 */
	removeCredential(id: number): Promise<number[]>;

	/**
	 * Set a user-editable label on a stored credential. The remark is
	 * displayed in account selectors and debug panels.
	 */
	updateRemark(id: number, remark: string): Promise<void>;

	/**
	 * Set a user-editable label on a stored credential. The remark is
	 * displayed in account selectors and debug panels.
	 */
	updateRemark(id: number, remark: string): Promise<void>;

	/**
	 * Set which stored credential is the **active** one for a provider.
	 * Subsequent `read(providerId)` calls return this credential.
	 * The credential must exist in the store.
	 */
	setActiveCredential(providerId: string, credentialId: number): Promise<void>;

	/**
	 * List non-expired credential blocks for the given credential ids.
	 * Results are used by credential routers to skip rate-limited credentials
	 * across process restarts. Optional — stores that don't support
	 * persistent blocks may return an empty array.
	 */
	listCredentialBlocks?(credentialIds: readonly number[]): Promise<
		Array<{
			credentialId: number;
			providerKey: string;
			blockScope: string;
			blockedUntilMs: number;
			updatedAt: number;
		}>
	>;
}

/** Environment access for auth resolution. Injectable for tests and browsers. */
export interface AuthContext {
	env(name: string): Promise<string | undefined>;
	/** Check whether a file exists. Supports a leading `~`. Always false in browsers. */
	fileExists(path: string): Promise<boolean>;
}

/** Result of resolving auth for a model. */
export interface AuthResult {
	auth: ModelAuth;
	/** Provider-scoped environment/config values resolved from credentials and ambient context. */
	env?: ProviderEnv;
	/** Human-readable label for status UI: "ANTHROPIC_API_KEY", "OAuth", "~/.aws/credentials". */
	source?: string;
}

export interface AuthCheck {
	source?: string;
	type: "api_key" | "oauth";
}

export type AuthType = "api_key" | "oauth";

/**
 * Prompt shown to the user during login. `signal` lets the flow cancel a
 * pending prompt when an out-of-band event resolves the step, e.g. a
 * `manual_code` prompt raced against a callback server, aborted when the
 * callback wins.
 */
export type AuthPrompt = { signal?: AbortSignal } & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
	| { type: "manual_code"; message: string; placeholder?: string }
);

export interface AuthInfoLink {
	url: string;
	label?: string;
}

export type AuthEvent =
	| { type: "info"; message: string; links?: readonly AuthInfoLink[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

/**
 * Login interaction callbacks serving both api-key and OAuth flows.
 *
 * `prompt()` returns the entered/selected string (`select` returns the option
 * id). Rejects on cancel/abort. `signal` aborts the whole login flow;
 * per-prompt cancellation uses `AuthPrompt.signal`.
 */
export interface AuthInteraction {
	signal?: AbortSignal;

	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
}

/**
 * Api-key auth: stored key/provider env plus ambient sources (env vars, AWS
 * profiles, ADC files). Ambient-only providers omit `login`.
 */
export interface ApiKeyAuth {
	/** Display name, e.g. "Anthropic API key". */
	name: string;

	/** Interactive setup (prompt for key/provider env). Absent = ambient-only. */
	login?(interaction: AuthInteraction): Promise<ApiKeyCredential>;

	/**
	 * Optional side-effect-free availability check. Use this when `resolve()` may
	 * execute commands or perform other request-time work. Missing means Models
	 * checks availability by resolving auth.
	 */
	check?(input: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthCheck | undefined>;

	/**
	 * Resolve auth from the stored credential and/or ambient sources, merging
	 * per field (`credential.key ?? env("...")`, `credential.env?.NAME ?? env("...")`).
	 * undefined = not configured. Resolution is provider-scoped; model-specific
	 * endpoint preparation happens after auth has been resolved.
	 */
	resolve(input: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthResult | undefined>;
}

/**
 * OAuth auth. The `refresh`/`toAuth` split lets `Models` own the locked
 * refresh pattern: `refresh` produces a credential, `toAuth` derives request
 * auth from whatever credential ends up stored.
 */
export interface OAuthAuth {
	/** Display name, e.g. "Anthropic (Claude Pro/Max)". */
	name: string;

	/** Selector label for the subscription login option, e.g. "Sign in with SuperGrok or X Premium". */
	loginLabel?: string;

	login(interaction: AuthInteraction): Promise<OAuthCredential>;

	/**
	 * Exchange the refresh token. Network call; throws on failure
	 * (invalid_grant etc.). `Models` runs this under the store lock.
	 */
	refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;

	/**
	 * Side-effect-free derivation of request auth from a valid credential.
	 * Covers per-credential baseUrl (GitHub Copilot). Async so lazy wrappers
	 * can load the implementation on first use.
	 */
	toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

/**
 * Provider auth. At least one of `apiKey`/`oauth` must be present: even
 * ambient-credential providers and keyless local servers provide `apiKey`
 * auth whose `resolve()` reports whether the provider is configured.
 */
export interface ProviderAuth {
	apiKey?: ApiKeyAuth;
	oauth?: OAuthAuth;
}
