/**
 * Agent secret store: user-supplied credentials the agent can only reach as
 * `$MUSEPI_SECRET_<NAME>` (an `env` delivery) or as the path of a private
 * owner-only file (a `file` delivery). The value itself is never returned.
 *
 * Values reuse the per-profile AES-256-GCM envelope in `encrypted-store`; the
 * descriptive metadata (name, purpose, scope, timestamps) lives in a 0600
 * sidecar written atomically. There is no plaintext mode: the encrypted file
 * and the master key are the only representations of a value at rest.
 *
 * Names are the public identity and the environment-variable suffix at once,
 * so they are validated in one place and never accept lowercase or `$`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@musepi/pi-utils";
import type { SecretDelivery, SecretEntryView, SecretScope, SecretStatus } from "@musepi/pi-wire";
import { writeFileAtomically } from "../utils/atomic-file";
import {
	decryptMasterKey,
	deleteSecret as deleteEnvelope,
	encryptedStore,
	encryptMasterKey,
	masterKeyState,
	mergeSecret,
	readSecret,
	rephraseMasterKey,
	unlockMasterKey,
} from "./encrypted-store";

export type { SecretDelivery, SecretEntryView, SecretScope, SecretStatus };

export const AGENT_SECRET_DIR = "agent-secrets";
export const AGENT_SECRET_FILES_DIR = "files";
export const AGENT_SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const AGENT_SECRET_ENV_PREFIX = "MUSEPI_SECRET_";
/** The shortest value the store accepts. Values this short are redacted only
 *  where they stand alone, so a PIN is usable without redacting inside words. */
export const MIN_AGENT_SECRET_VALUE_LENGTH = 4;

const METADATA_FILE = "metadata.json";
const METADATA_VERSION = 1;
const VALUE_KEY = "value";

interface SecretMetadata {
	version: 1;
	entries: Record<
		string,
		{
			purpose: string;
			scope: SecretScope;
			delivery: SecretDelivery;
			createdAt: number;
			updatedAt: number;
			lastUsedAt?: number;
		}
	>;
}

export function validateSecretName(name: unknown): string {
	if (typeof name !== "string" || !AGENT_SECRET_NAME_RE.test(name)) {
		throw new Error("Invalid secret name: must match /^[A-Z][A-Z0-9_]{0,63}$/");
	}
	return name;
}

export function validateSecretValue(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("Secret value must not be empty");
	}
	if (value.length < MIN_AGENT_SECRET_VALUE_LENGTH) {
		throw new Error(`Secret value must be at least ${MIN_AGENT_SECRET_VALUE_LENGTH} characters`);
	}
	return value;
}

/** Delivery from a card/page value. Omitted keeps the previous delivery. */
export function normalizeSecretDelivery(delivery: unknown, fallback: SecretDelivery = "env"): SecretDelivery {
	if (delivery === "env" || delivery === "file") return delivery;
	if (delivery !== undefined && delivery !== null) {
		logger.warn("Unknown agent secret delivery; keeping the previous value", { delivery: String(delivery) });
	}
	return fallback;
}

const MAX_SCOPE_ROOTS = 32;

function scopeRoot(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed === "" || !path.isAbsolute(trimmed)) return undefined;
	return path.resolve(trimmed);
}

function uniqueScopeRoots(scope: readonly unknown[]): string[] {
	const roots = new Set<string>();
	for (const value of scope) {
		const root = scopeRoot(value);
		if (root === undefined) continue;
		roots.add(root);
		if (roots.size >= MAX_SCOPE_ROOTS) break;
	}
	return [...roots];
}

/**
 * Scope from a card/page choice. Omitted keeps `fallback`, so replacing a value
 * never widens what it was narrowed to. An unrecognized shape also keeps the
 * previous scope rather than granting every session.
 */
export function normalizeSecretScope(scope: unknown, fallback: SecretScope = "all"): SecretScope {
	if (scope === undefined || scope === null) return fallback;
	if (scope === "all") return "all";
	if (Array.isArray(scope)) return uniqueScopeRoots(scope);
	logger.warn("Unknown agent secret scope; keeping the previous value", { scope: String(scope) });
	return fallback;
}

/** Metadata read: an unrecognized stored scope narrows to nobody, never widens. */
export function parseStoredSecretScope(scope: unknown): SecretScope {
	if (scope === "all") return "all";
	if (Array.isArray(scope)) return uniqueScopeRoots(scope);
	logger.warn("Unrecognized stored agent secret scope; treating it as no workspace", {
		scope: String(scope),
	});
	return [];
}

/**
 * Whether a session working in `cwd` may use this secret. A directory scope
 * covers its own subdirectories; comparison is case-insensitive on Windows.
 */
export function secretScopeIncludes(scope: SecretScope, cwd: string): boolean {
	if (scope === "all") return true;
	if (typeof cwd !== "string" || cwd.length === 0) return false;
	const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
	const target = path.resolve(cwd);
	for (const root of scope) {
		const resolvedRoot = path.resolve(root);
		if (fold(resolvedRoot) === fold(target)) return true;
		const relative = path.relative(fold(resolvedRoot), fold(target));
		if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) return true;
	}
	return false;
}

export function agentSecretEnvName(name: string): string {
	return `${AGENT_SECRET_ENV_PREFIX}${name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyMetadata(): SecretMetadata {
	return { version: METADATA_VERSION, entries: {} };
}

const writes = new Map<string, Promise<unknown>>();

async function withWriteLock<T>(file: string, action: () => Promise<T>): Promise<T> {
	const previous = writes.get(file) ?? Promise.resolve();
	const run = previous.then(action, action);
	writes.set(
		file,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	try {
		return await run;
	} finally {
		if (writes.get(file) === run) writes.delete(file);
	}
}

export class AgentSecretStore {
	readonly agentDir: string;
	readonly dir: string;
	readonly filesDir: string;
	readonly metadataFile: string;
	readonly #values;

	constructor(agentDir: string) {
		this.agentDir = path.resolve(agentDir);
		this.dir = path.join(this.agentDir, AGENT_SECRET_DIR);
		this.filesDir = path.join(this.dir, AGENT_SECRET_FILES_DIR);
		this.metadataFile = path.join(this.dir, METADATA_FILE);
		this.#values = encryptedStore(this.dir, {
			file: "secrets.json",
			masterKeyFile: ".master.key",
			masterKeyEnv: "MUSEPI_AGENT_SECRET_KEY",
			// The vault owns the shared key: it is the store the passphrase UI
			// has always driven, and every other store adopts from it.
			sharedKeyAgentDir: this.agentDir,
		});
	}

	async #readMetadata(): Promise<SecretMetadata> {
		let text: string;
		try {
			text = await fs.promises.readFile(this.metadataFile, "utf8");
		} catch (error) {
			if (isEnoent(error)) return emptyMetadata();
			throw error;
		}
		try {
			const raw: unknown = JSON.parse(text);
			if (!isRecord(raw) || raw.version !== METADATA_VERSION || !isRecord(raw.entries)) {
				logger.warn("Agent secret metadata has an unsupported shape", { path: this.metadataFile });
				return emptyMetadata();
			}
			const entries: SecretMetadata["entries"] = {};
			for (const [name, value] of Object.entries(raw.entries)) {
				if (!AGENT_SECRET_NAME_RE.test(name) || !isRecord(value)) continue;
				if (
					typeof value.createdAt !== "number" ||
					typeof value.updatedAt !== "number" ||
					(typeof value.purpose !== "string" && value.purpose !== undefined)
				) {
					continue;
				}
				entries[name] = {
					purpose: typeof value.purpose === "string" ? value.purpose : "",
					scope: parseStoredSecretScope(value.scope),
					delivery: normalizeSecretDelivery(value.delivery, "env"),
					createdAt: value.createdAt,
					updatedAt: value.updatedAt,
					...(typeof value.lastUsedAt === "number" ? { lastUsedAt: value.lastUsedAt } : {}),
				};
			}
			return { version: METADATA_VERSION, entries };
		} catch (error) {
			logger.warn("Agent secret metadata is not valid JSON", {
				path: this.metadataFile,
				error: error instanceof Error ? error.message : String(error),
			});
			return emptyMetadata();
		}
	}

	async #writeMetadata(metadata: SecretMetadata): Promise<void> {
		await fs.promises.mkdir(this.dir, { recursive: true });
		await writeFileAtomically(this.metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, 0o600);
	}

	async list(): Promise<SecretEntryView[]> {
		const metadata = await this.#readMetadata();
		return Object.entries(metadata.entries)
			.map(([name, entry]) => this.#toView(name, entry))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	async status(): Promise<SecretStatus> {
		const state = await masterKeyState(this.#values);
		return {
			mode: "encrypted",
			count: Object.keys((await this.#readMetadata()).entries).length,
			protectedBy: state.protectedBy,
			locked: state.mode === "passphrase" ? state.locked : false,
			...(state.mode === "passphrase" && state.reason ? { reason: state.reason } : {}),
		};
	}

	/** Unlock a passphrase-protected store for this process; nothing is written to disk. */
	async unlock(passphrase: string): Promise<void> {
		await unlockMasterKey(this.#values, passphrase);
	}

	/** Protect the current key with a passphrase and remove the plain key file. */
	async encrypt(passphrase: string): Promise<void> {
		await encryptMasterKey(this.#values, passphrase);
	}

	/** Remove passphrase protection after proving it; the plain key file returns. */
	async decrypt(passphrase: string): Promise<void> {
		await decryptMasterKey(this.#values, passphrase);
	}

	/** Replace the passphrase that wraps the same master key. */
	async rephrase(current: string, next: string): Promise<void> {
		await rephraseMasterKey(this.#values, current, next);
	}

	async getEntry(name: string): Promise<SecretEntryView | undefined> {
		const metadata = await this.#readMetadata();
		const entry = metadata.entries[name];
		return entry ? this.#toView(name, entry) : undefined;
	}

	/** Decrypted value, or undefined when the entry is missing or unreadable. */
	async getValue(name: string): Promise<string | undefined> {
		const values = await readSecret(this.#values, name);
		return values?.[VALUE_KEY];
	}

	async set(
		name: string,
		value: string,
		purpose?: string,
		scope?: unknown,
		delivery?: unknown,
	): Promise<SecretEntryView> {
		validateSecretName(name);
		validateSecretValue(value);
		return await withWriteLock(this.metadataFile, async () => {
			const metadata = await this.#readMetadata();
			const previous = metadata.entries[name];
			const now = Date.now();
			const next = {
				purpose: typeof purpose === "string" ? purpose : (previous?.purpose ?? ""),
				// Replacing a value must not widen an entry the user narrowed.
				scope: normalizeSecretScope(scope, previous?.scope ?? "all"),
				delivery: normalizeSecretDelivery(delivery, previous?.delivery ?? "env"),
				createdAt: previous?.createdAt ?? now,
				updatedAt: now,
				...(previous?.lastUsedAt !== undefined ? { lastUsedAt: previous.lastUsedAt } : {}),
			};
			await mergeSecret(this.#values, name, { [VALUE_KEY]: value });
			metadata.entries[name] = next;
			await this.#writeMetadata(metadata);
			if (next.delivery === "file") await this.#writeDeliveryFile(name, value);
			else await this.removeDeliveryFile(name);
			return this.#toView(name, next);
		});
	}

	/** Rewrite a `file` delivery's working copy from the stored value; idempotent. */
	async materializeFile(name: string): Promise<void> {
		validateSecretName(name);
		const value = await this.getValue(name);
		if (value !== undefined) await this.#writeDeliveryFile(name, value);
	}

	/** The private working copy's path for a `file` delivery entry. */
	filePath(name: string): string {
		return path.join(this.filesDir, validateSecretName(name));
	}

	/** Remove a `file` working copy; idempotent. */
	async removeDeliveryFile(name: string): Promise<void> {
		await fs.promises.rm(this.filePath(name), { force: true }).catch(() => {});
	}

	async #writeDeliveryFile(name: string, value: string): Promise<void> {
		await fs.promises.mkdir(this.filesDir, { recursive: true, mode: 0o700 });
		// The umask may narrow the directory mode; restore the owner-only bits.
		await fs.promises.chmod(this.filesDir, 0o700).catch(() => {});
		await writeFileAtomically(this.filePath(name), value, 0o600);
	}

	/** Change who may use a stored value without touching the value itself. */
	async setScope(name: string, scope: SecretScope): Promise<SecretEntryView> {
		validateSecretName(name);
		return await withWriteLock(this.metadataFile, async () => {
			const metadata = await this.#readMetadata();
			const entry = metadata.entries[name];
			if (!entry) throw new Error(`Secret ${name} is not stored`);
			entry.scope = normalizeSecretScope(scope, entry.scope);
			entry.updatedAt = Date.now();
			await this.#writeMetadata(metadata);
			return this.#toView(name, entry);
		});
	}

	/** Idempotent: an unknown name is already deleted. */
	async delete(name: string): Promise<void> {
		validateSecretName(name);
		await withWriteLock(this.metadataFile, async () => {
			const metadata = await this.#readMetadata();
			if (!(name in metadata.entries)) return;
			// Metadata is the discoverability source for injection, so removing
			// it first can never leave a value reachable by a future read.
			delete metadata.entries[name];
			await this.#writeMetadata(metadata);
			await deleteEnvelope(this.#values, name);
			await this.removeDeliveryFile(name);
		});
	}

	/**
	 * Record first use in the current process without a disk write per bash
	 * call. A session that starts later sees the persisted timestamp.
	 */
	async touch(name: string, alreadyTouched?: Set<string>): Promise<void> {
		if (alreadyTouched?.has(name)) return;
		alreadyTouched?.add(name);
		await withWriteLock(this.metadataFile, async () => {
			const metadata = await this.#readMetadata();
			const entry = metadata.entries[name];
			if (!entry) return;
			entry.lastUsedAt = Date.now();
			await this.#writeMetadata(metadata);
		});
	}

	/** Every decryptable entry, for bash child environments and redaction. */
	async values(): Promise<
		Array<{ name: string; purpose: string; scope: SecretScope; delivery: SecretDelivery; value: string }>
	> {
		const metadata = await this.#readMetadata();
		const out: Array<{ name: string; purpose: string; scope: SecretScope; delivery: SecretDelivery; value: string }> =
			[];
		for (const [name, entry] of Object.entries(metadata.entries)) {
			const value = await this.getValue(name);
			if (value === undefined) {
				logger.warn("Agent secret could not be decrypted; skipping it", { name });
				continue;
			}
			out.push({
				name,
				purpose: entry.purpose,
				scope: entry.scope,
				delivery: entry.delivery,
				value,
			});
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Availability without exposing the value to the caller. */
	async available(name: string): Promise<boolean> {
		return (await this.getValue(name)) !== undefined;
	}

	#toView(name: string, entry: SecretMetadata["entries"][string]): SecretEntryView {
		return {
			name,
			purpose: entry.purpose,
			scope: entry.scope,
			delivery: entry.delivery,
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
			...(entry.lastUsedAt !== undefined ? { lastUsedAt: entry.lastUsedAt } : {}),
		};
	}
}

const stores = new Map<string, AgentSecretStore>();

/** One store per resolved agent dir, so locks are shared inside a process. */
export function getAgentSecretStore(agentDir: string): AgentSecretStore {
	const resolved = path.resolve(agentDir);
	let store = stores.get(resolved);
	if (!store) {
		store = new AgentSecretStore(resolved);
		stores.set(resolved, store);
	}
	return store;
}

/**
 * What the card must collect. `fill` is the only kind the tool sends today;
 * `allow` remains accepted at the wire level for future consent hosts.
 */
export type AgentSecretRequestKind = "fill" | "allow";

/** Tool → UI request. Carries no value and no request id; the host assigns one. */
export interface AgentSecretRequest {
	name: string;
	purpose: string;
	kind: AgentSecretRequestKind;
	/** Proposed delivery for a new save; a stored entry keeps its own. */
	delivery?: SecretDelivery;
	/** The asking session's working directory; `allow` extends the scope to it. */
	workspace?: string;
}

/**
 * UI → tool decision. The host persists `save` itself, so the value never
 * travels back through the tool, its result, or the transcript.
 */
export interface AgentSecretAnswer {
	action: "save" | "allow" | "cancel";
}

/** Duck-typed extension of the host UI context used by the daemon bridge. */
export interface AgentSecretUIContext {
	requestSecret?(request: AgentSecretRequest): Promise<AgentSecretAnswer | undefined>;
}
