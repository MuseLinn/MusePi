import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ModelsError } from "./resolve.ts";
import type {
	ApiKeyCredential,
	Credential,
	CredentialInfo,
	CredentialStore,
	OAuthCredential,
	StoredCredentialInfo,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
//  Identity key helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Trimmed, lowercased email for identity key derivation. */
function normalizeStoredEmail(email: string | null | undefined): string | null {
	const normalized = email?.trim().toLowerCase();
	return normalized && normalized.length > 0 ? normalized : null;
}

/** Trimmed account/org/project id for identity key derivation. */
function normalizeStoredAccountId(id: string | null | undefined): string | null {
	const normalized = id?.trim();
	return normalized && normalized.length > 0 ? normalized : null;
}

/**
 * Decode a JWT payload without verification. Returns the decoded JSON object
 * or null on parse failure. Accepts both base64url and base64 padding.
 * Never throws — invalid tokens yield null.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		// Base64url-decode the JWT payload segment (no signature verification).
		const decoded = Buffer.from(parts[1]!, "base64url").toString("utf-8");
		return JSON.parse(decoded) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Extract identity tokens from a credential's OAuth fields.
 * Also decodes the OAuth access token JWT to recover identity fields
 * (email, account_id, org_id) that may not be present in the top-level
 * credential data — mirroring OMP's `extractOAuthTokenIdentifiers`.
 */
function extractCredentialFieldIdentifiers(credential: OAuthCredential): string[] {
	const identifiers = new Set<string>();

	// Top-level credential fields.
	const accountId = normalizeStoredAccountId(credential.accountId as string | undefined);
	if (accountId) identifiers.add(`account:${accountId}`);
	const email = normalizeStoredEmail(credential.email as string | undefined);
	if (email) identifiers.add(`email:${email}`);
	const orgId = normalizeStoredAccountId(credential.orgId as string | undefined);
	if (orgId) identifiers.add(`org:${orgId}`);
	const projectId = normalizeStoredAccountId((credential as Record<string, unknown>).projectId as string | undefined);
	if (projectId) identifiers.add(`project:${projectId}`);

	// JWT payload decode: the access token may carry identity claims not
	// stored in the credential's top-level fields.
	const access = credential.access as string | undefined;
	if (access) {
		const payload = decodeJwtPayload(access);
		if (payload) {
			const jwtEmail =
				normalizeStoredEmail(payload.email as string | undefined) ??
				normalizeStoredEmail(
					typeof payload["https://api.openai.com/profile"] === "object" &&
						payload["https://api.openai.com/profile"] !== null
						? ((payload["https://api.openai.com/profile"] as Record<string, unknown>).email as string | undefined)
						: undefined,
				);
			if (jwtEmail) identifiers.add(`email:${jwtEmail}`);

			const jwtAccountId = normalizeStoredAccountId(
				(payload.account_id as string | undefined) ?? (payload.accountId as string | undefined),
			);
			if (jwtAccountId) identifiers.add(`account:${jwtAccountId}`);

			const jwtOrgId = normalizeStoredAccountId(
				(payload.org_id as string | undefined) ?? (payload.orgId as string | undefined),
			);
			if (jwtOrgId) identifiers.add(`org:${jwtOrgId}`);
		}
	}

	return [...identifiers];
}

/** Deterministic identity key for deduplication. API keys return null. */
function resolveCredentialIdentityKey(credential: Credential): string | null {
	if (credential.type === "api_key") return null;
	const identifiers = extractCredentialFieldIdentifiers(credential);
	return identifiers.length > 0 ? identifiers.sort().join("|") : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS auth_credentials (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	provider TEXT NOT NULL,
	credential_type TEXT NOT NULL,
	data TEXT NOT NULL,
	identity_key TEXT,
	remark TEXT DEFAULT '',
	active INTEGER NOT NULL DEFAULT 0,
	disabled_cause TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_credentials_provider ON auth_credentials(provider, disabled_cause);
CREATE INDEX IF NOT EXISTS idx_auth_provider_identity ON auth_credentials(provider, identity_key) WHERE identity_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS cache (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);

CREATE TABLE IF NOT EXISTS auth_credential_blocks (
	credential_id INTEGER NOT NULL,
	provider_key TEXT NOT NULL,
	block_scope TEXT NOT NULL DEFAULT '',
	blocked_until_ms INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (credential_id, provider_key, block_scope)
);

CREATE INDEX IF NOT EXISTS idx_auth_credential_blocks_expires ON auth_credential_blocks(blocked_until_ms);

CREATE TABLE IF NOT EXISTS auth_credential_refresh_leases (
	credential_id INTEGER PRIMARY KEY,
	owner TEXT NOT NULL,
	expires_at_ms INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_credential_refresh_leases_expires ON auth_credential_refresh_leases(expires_at_ms);
`;

interface AuthCredentialRow {
	id: number;
	provider: string;
	credential_type: "api_key" | "oauth";
	data: string;
	identity_key: string | null;
	remark: string;
	active: number;
	disabled_cause: string | null;
	created_at: number;
	updated_at: number;
}

function deserializeCredential(row: AuthCredentialRow): Credential {
	const parsed = JSON.parse(row.data) as Record<string, unknown>;
	if (row.credential_type === "api_key") {
		return { type: "api_key", ...parsed } as ApiKeyCredential;
	}
	return { type: "oauth", ...parsed } as OAuthCredential;
}

function serializeCredentialForStore(credential: Credential): {
	type: string;
	data: string;
	identityKey: string | null;
} {
	const { type, ...rest } = credential;
	return {
		type,
		data: JSON.stringify(rest),
		identityKey: resolveCredentialIdentityKey(credential),
	};
}

function rowToInfo(row: AuthCredentialRow): StoredCredentialInfo {
	const info: StoredCredentialInfo = {
		id: row.id,
		providerId: row.provider,
		type: row.credential_type,
	};
	if (row.remark) info.remark = row.remark;
	if (row.credential_type === "oauth") {
		const parsed = JSON.parse(row.data) as Record<string, unknown>;
		if (typeof parsed.email === "string") info.email = parsed.email;
		if (typeof parsed.accountId === "string") info.accountId = parsed.accountId;
		if (typeof parsed.orgId === "string") info.orgId = parsed.orgId;
		if (typeof parsed.orgName === "string") info.orgName = parsed.orgName;
	}
	return info;
}

// ─────────────────────────────────────────────────────────────────────────────
// SqliteCredentialStore
// ─────────────────────────────────────────────────────────────────────────────

export class SqliteCredentialStore implements CredentialStore {
	readonly #db: DatabaseSync;
	#closed = false;

	constructor(dbPath: string) {
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		this.#db = new DatabaseSync(dbPath);
		try {
			this.#db.exec("PRAGMA busy_timeout = 5000");
		} catch {
			// Older Node versions may not support this pragma.
		}
		this.#db.exec("PRAGMA journal_mode=WAL");
		this.#db.exec("PRAGMA synchronous=NORMAL");
		this.#db.exec(SCHEMA_SQL);
	}

	// ─────────────────────────────────────────────────────────────────────────
	//  Active credential selection (contract methods)
	// ─────────────────────────────────────────────────────────────────────────

	async read(providerId: string): Promise<Credential | undefined> {
		const row = this.#getActiveRow(providerId);
		return row ? deserializeCredential(row) : undefined;
	}

	/** Return one entry per distinct (provider, credential_type) combination. */
	async list(): Promise<readonly CredentialInfo[]> {
		const rows = this.#db
			.prepare(
				"SELECT provider, credential_type FROM auth_credentials WHERE disabled_cause IS NULL GROUP BY provider, credential_type ORDER BY provider",
			)
			.all() as Pick<AuthCredentialRow, "provider" | "credential_type">[];
		return rows.map((r) => ({ providerId: r.provider, type: r.credential_type }));
	}

	/**
	 * Modify the active credential for a provider.
	 *
	 * Insert path: when no active credential exists and `fn` returns one,
	 * deduplicates by identity key — if a credential with the same identity
	 * key already exists (e.g. re-login), the existing row is updated with
	 * new token data and re-activated.
	 *
	 * Update path: when an active credential exists and `fn` returns a new
	 * value, updates the active row in place (OAuth refresh).
	 */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const currentRow = this.#getActiveRow(providerId);
		const current = currentRow ? deserializeCredential(currentRow) : undefined;
		return fn(current).then((next) => {
			if (next === undefined) return current;

			const { type, data, identityKey } = serializeCredentialForStore(next);

			if (currentRow) {
				// Update in-place on the active row.
				this.#db
					.prepare(
						`UPDATE auth_credentials SET credential_type = ?, data = ?, identity_key = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
					)
					.run(type, data, identityKey, currentRow.id);
				return next;
			}

			// No active credential: dedup by identity key before inserting.
			if (identityKey) {
				const existing = this.#db
					.prepare(
						"SELECT id FROM auth_credentials WHERE provider = ? AND identity_key = ? AND disabled_cause IS NULL LIMIT 1",
					)
					.get(providerId, identityKey) as { id: number } | undefined;
				if (existing) {
					// Re-activate and update data.
					this.#db
						.prepare(
							`UPDATE auth_credentials SET credential_type = ?, data = ?, active = 1, disabled_cause = NULL, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
						)
						.run(type, data, existing.id);
					// Deactivate stale credentials with the same identity key.
					this.#db
						.prepare(
							"UPDATE auth_credentials SET active = 0 WHERE provider = ? AND identity_key = ? AND id != ? AND disabled_cause IS NULL",
						)
						.run(providerId, identityKey, existing.id);
					return next;
				}
			}

			// Fresh insert.
			const result = this.#db
				.prepare(
					`INSERT INTO auth_credentials (provider, credential_type, data, identity_key, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ${SQLITE_NOW_EPOCH}, ${SQLITE_NOW_EPOCH}) RETURNING id`,
				)
				.get(providerId, type, data, identityKey) as { id: number } | undefined;
			if (result) return next;
			return next;
		});
	}

	/** Mark all non-disabled credentials for a provider as disabled (logout all accounts). */
	async delete(providerId: string): Promise<void> {
		this.#db
			.prepare(
				`UPDATE auth_credentials SET disabled_cause = 'deleted', updated_at = ${SQLITE_NOW_EPOCH} WHERE provider = ? AND disabled_cause IS NULL`,
			)
			.run(providerId);
	}

	// ─────────────────────────────────────────────────────────────────────────
	//  Multi-credential management methods
	// ─────────────────────────────────────────────────────────────────────────

	async listCredentials(providerId?: string): Promise<StoredCredentialInfo[]> {
		const rows: AuthCredentialRow[] = providerId
			? (this.#db
					.prepare(
						"SELECT id, provider, credential_type, data, identity_key, remark, active, disabled_cause, created_at, updated_at FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY id ASC",
					)
					.all(providerId) as unknown as AuthCredentialRow[])
			: (this.#db
					.prepare(
						"SELECT id, provider, credential_type, data, identity_key, remark, active, disabled_cause, created_at, updated_at FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY provider ASC, id ASC",
					)
					.all() as unknown as AuthCredentialRow[]);
		return rows.map(rowToInfo);
	}

	/** Soft-delete one credential by id. Returns remaining credential ids for the same provider. */
	async removeCredential(id: number): Promise<number[]> {
		const row = this.#db
			.prepare("SELECT provider FROM auth_credentials WHERE id = ? AND disabled_cause IS NULL")
			.get(id) as { provider: string } | undefined;
		if (!row) return [];

		this.#db
			.prepare(
				`UPDATE auth_credentials SET disabled_cause = 'removed', updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ? AND disabled_cause IS NULL`,
			)
			.run(id);

		const remaining = this.#db
			.prepare("SELECT id FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY id ASC")
			.all(row.provider) as unknown as { id: number }[];
		return remaining.map((r) => r.id);
	}

	async updateRemark(id: number, remark: string): Promise<void> {
		this.#db
			.prepare(`UPDATE auth_credentials SET remark = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`)
			.run(remark, id);
	}

	async setActiveCredential(providerId: string, credentialId: number): Promise<void> {
		this.#db
			.prepare("UPDATE auth_credentials SET active = 0 WHERE provider = ? AND disabled_cause IS NULL")
			.run(providerId);
		const result = this.#db
			.prepare("UPDATE auth_credentials SET active = 1 WHERE id = ? AND provider = ? AND disabled_cause IS NULL")
			.run(credentialId, providerId);
		if (result.changes === 0) {
			throw new ModelsError("auth", `Credential ${credentialId} not found for provider ${providerId}`);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	//  Persistent credential blocks (rate-limit backoff, persisted across restarts)
	// ─────────────────────────────────────────────────────────────────────────

	/** Blocked-until ms for a (credential, providerKey, scope) triple, or undefined. */
	getCredentialBlock(credentialId: number, providerKey: string, blockScope: string): number | undefined {
		const row = this.#db
			.prepare(
				"SELECT blocked_until_ms FROM auth_credential_blocks WHERE credential_id = ? AND provider_key = ? AND block_scope = ? AND blocked_until_ms > CAST(strftime('%s','now') AS INTEGER) * 1000",
			)
			.get(credentialId, providerKey, blockScope) as { blocked_until_ms: number } | undefined;
		return row?.blocked_until_ms;
	}

	/** Upsert with MAX semantics: keep the later blocked_until_ms on conflict. */
	upsertCredentialBlock(credentialId: number, providerKey: string, blockScope: string, blockedUntilMs: number): void {
		this.#db
			.prepare(
				`INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at)
				VALUES (?, ?, ?, ?, ${SQLITE_NOW_EPOCH})
				ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET
					blocked_until_ms = MAX(blocked_until_ms, excluded.blocked_until_ms),
					updated_at = excluded.updated_at`,
			)
			.run(credentialId, providerKey, blockScope, blockedUntilMs);
	}

	/** Drop all block rows for a credential. */
	deleteCredentialBlocks(credentialId: number): void {
		this.#db.prepare("DELETE FROM auth_credential_blocks WHERE credential_id = ?").run(credentialId);
	}

	/** Prune rows with blocked_until_ms <= nowMs. */
	cleanExpiredCredentialBlocks(nowMs: number): void {
		this.#db.prepare("DELETE FROM auth_credential_blocks WHERE blocked_until_ms <= ?").run(nowMs);
	}

	/** List non-expired blocks for the given credential ids. */
	async listCredentialBlocks(credentialIds: readonly number[]): Promise<
		Array<{
			credentialId: number;
			providerKey: string;
			blockScope: string;
			blockedUntilMs: number;
			updatedAt: number;
		}>
	> {
		if (credentialIds.length === 0) return [];
		const placeholders = credentialIds.map(() => "?").join(",");
		const rows = this.#db
			.prepare(
				`SELECT credential_id, provider_key, block_scope, blocked_until_ms, updated_at FROM auth_credential_blocks WHERE credential_id IN (${placeholders}) AND blocked_until_ms > CAST(strftime('%s','now') AS INTEGER) * 1000 ORDER BY provider_key ASC, block_scope ASC`,
			)
			.all(...credentialIds) as Array<{
			credential_id: number;
			provider_key: string;
			block_scope: string;
			blocked_until_ms: number;
			updated_at: number;
		}>;
		return rows.map((r) => ({
			credentialId: r.credential_id,
			providerKey: r.provider_key,
			blockScope: r.block_scope,
			blockedUntilMs: r.blocked_until_ms,
			updatedAt: r.updated_at,
		}));
	}

	// ─────────────────────────────────────────────────────────────────────────
	//  OAuth refresh lease fencing (CAS-style, prevents concurrent refresh)
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Try to acquire a refresh lease for a credential. Returns true if the
	 * lease was acquired (or no previous lease exists / previous lease expired).
	 */
	tryAcquireCredentialRefreshLease(credentialId: number, owner: string, expiresAtMs: number): boolean {
		const result = this.#db
			.prepare(
				`INSERT INTO auth_credential_refresh_leases (credential_id, owner, expires_at_ms, updated_at)
				VALUES (?, ?, ?, ${SQLITE_NOW_EPOCH})
				ON CONFLICT(credential_id) DO UPDATE SET
					owner = excluded.owner,
					expires_at_ms = excluded.expires_at_ms,
					updated_at = excluded.updated_at
				WHERE auth_credential_refresh_leases.expires_at_ms <= ?`,
			)
			.run(credentialId, owner, expiresAtMs, Date.now());
		return result.changes > 0;
	}

	getCredentialRefreshLeaseExpiresAt(credentialId: number): number | undefined {
		const row = this.#db
			.prepare("SELECT expires_at_ms FROM auth_credential_refresh_leases WHERE credential_id = ?")
			.get(credentialId) as { expires_at_ms: number } | undefined;
		return row?.expires_at_ms;
	}

	releaseCredentialRefreshLease(credentialId: number, owner: string): void {
		this.#db
			.prepare("DELETE FROM auth_credential_refresh_leases WHERE credential_id = ? AND owner = ?")
			.run(credentialId, owner);
	}

	renewCredentialRefreshLease(credentialId: number, owner: string, expiresAtMs: number): boolean {
		const result = this.#db
			.prepare(
				`UPDATE auth_credential_refresh_leases SET expires_at_ms = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE credential_id = ? AND owner = ?`,
			)
			.run(expiresAtMs, credentialId, owner);
		return result.changes > 0;
	}

	// ─────────────────────────────────────────────────────────────────────────
	//  Cache operations
	// ─────────────────────────────────────────────────────────────────────────

	getCache(key: string): string | null {
		const row = this.#db
			.prepare(`SELECT value FROM cache WHERE key = ? AND expires_at > ${SQLITE_NOW_EPOCH}`)
			.get(key) as { value: string } | undefined;
		return row?.value ?? null;
	}

	setCache(key: string, value: string, expiresAt: number): void {
		this.#db
			.prepare(
				"INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
			)
			.run(key, value, expiresAt);
	}

	deleteCachePrefix(prefix: string): void {
		this.#db.prepare("DELETE FROM cache WHERE substr(key, 1, ?) = ?").run(prefix.length, prefix);
	}

	cleanExpiredCache(): void {
		this.#db.prepare(`DELETE FROM cache WHERE expires_at <= ${SQLITE_NOW_EPOCH}`).run();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}

	// ─────────────────────────────────────────────────────────────────────────
	//  Internal helpers
	// ─────────────────────────────────────────────────────────────────────────

	#getActiveRow(providerId: string): AuthCredentialRow | undefined {
		const active = this.#db
			.prepare(
				"SELECT id, provider, credential_type, data, identity_key, remark, active, disabled_cause, created_at, updated_at FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL AND active = 1 ORDER BY id ASC LIMIT 1",
			)
			.get(providerId) as AuthCredentialRow | undefined;
		if (active) return active;

		return this.#db
			.prepare(
				"SELECT id, provider, credential_type, data, identity_key, remark, active, disabled_cause, created_at, updated_at FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY updated_at DESC LIMIT 1",
			)
			.get(providerId) as AuthCredentialRow | undefined;
	}
}
