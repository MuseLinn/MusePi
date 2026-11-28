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
import type {
	SecretDelivery,
	SecretEntryView,
	SecretKind,
	SecretLoginInput,
	SecretLoginView,
	SecretScope,
	SecretStatus,
} from "@musepi/pi-wire";
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
import { parseTotpKey, totpCode } from "./totp";

export type { SecretDelivery, SecretEntryView, SecretKind, SecretLoginView, SecretScope, SecretStatus };

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
/** A login's TOTP setup key, in the same envelope as its password. */
const TOTP_KEY = "totp";

/** Merge a login's non-secret half, keeping what the form left blank. */
function normalizeLogin(
	input: { site?: string; hosts?: string[]; exactHost?: boolean; username?: string } | undefined,
	previous: SecretLoginView | undefined,
	hasTotp: string | undefined,
): SecretLoginView {
	const site =
		typeof input?.site === "string" && input.site.trim() !== ""
			? input.site.trim().toLowerCase()
			: (previous?.site ?? "");
	const hosts = Array.isArray(input?.hosts)
		? [
				...new Set(
					input.hosts
						.filter(host => typeof host === "string" && host.trim() !== "")
						.map(host => host.trim().toLowerCase()),
				),
			]
		: (previous?.hosts ?? []);
	return {
		site,
		hosts,
		exactHost: typeof input?.exactHost === "boolean" ? input.exactHost : (previous?.exactHost ?? false),
		username:
			typeof input?.username === "string" && input.username !== "" ? input.username : (previous?.username ?? ""),
		// A blank TOTP field keeps the stored key: the form cannot show what it
		// already holds, and clearing it would silently stop codes working.
		hasTotp: typeof hasTotp === "string" && hasTotp.trim() !== "" ? true : (previous?.hasTotp ?? false),
	};
}

interface SecretMetadata {
	version: 1;
	entries: Record<
		string,
		{
			purpose: string;
			scope: SecretScope;
			kind: SecretKind;
			/** Present exactly when `kind` is `login`; the password stays in the envelope. */
			login?: SecretLoginView;
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

/** A stored login's non-secret half; a malformed record yields a fillable empty site. */
function parseStoredLogin(login: unknown): SecretLoginView {
	if (!isRecord(login)) return { site: "", hosts: [], exactHost: false, username: "", hasTotp: false };
	const hosts = Array.isArray(login.hosts)
		? login.hosts
				.filter((host): host is string => typeof host === "string" && host.trim() !== "")
				.map(host => host.trim())
		: [];
	return {
		site: typeof login.site === "string" ? login.site.trim().toLowerCase() : "",
		hosts: [...new Set(hosts.map(host => host.toLowerCase()))],
		exactHost: login.exactHost === true,
		username: typeof login.username === "string" ? login.username : "",
		hasTotp: login.hasTotp === true,
	};
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
				const kind: SecretKind = value.kind === "login" ? "login" : "secret";
				entries[name] = {
					purpose: typeof value.purpose === "string" ? value.purpose : "",
					scope: parseStoredSecretScope(value.scope),
					kind,
					...(kind === "login" ? { login: parseStoredLogin(value.login) } : {}),
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

	/** Decrypted value, or undefined when the entry is missing, unreadable, or a login. */
	async getValue(name: string): Promise<string | undefined> {
		// A saved login's password is not a value the agent may use: it belongs to
		// a browser form, and `loginCredentials` is the only reader.
		const entry = await this.getEntry(name);
		if (entry?.kind === "login") return undefined;
		const values = await readSecret(this.#values, name);
		return values?.[VALUE_KEY];
	}

	async set(
		name: string,
		value: string,
		purpose?: string,
		scope?: unknown,
		delivery?: unknown,
		identity?: { kind?: SecretKind; login?: SecretLoginInput },
	): Promise<SecretEntryView> {
		validateSecretName(name);
		validateSecretValue(value);
		return await withWriteLock(this.metadataFile, async () => {
			const metadata = await this.#readMetadata();
			const previous = metadata.entries[name];
			const now = Date.now();
			const kind: SecretKind = identity?.kind === "login" || previous?.kind === "login" ? "login" : "secret";
			// A login never leaves the store as a value: no env var, no file. Its
			// delivery is normalized to `env` only to keep one field non-optional;
			// `getValue` refuses to hand a login out, which is what enforces it.
			const login =
				kind === "login" ? normalizeLogin(identity?.login, previous?.login, identity?.login?.totp) : undefined;
			const next = {
				purpose: typeof purpose === "string" ? purpose : (previous?.purpose ?? ""),
				// Replacing a value must not widen an entry the user narrowed.
				scope: normalizeSecretScope(scope, previous?.scope ?? "all"),
				kind,
				...(login ? { login } : {}),
				delivery: kind === "login" ? "env" : normalizeSecretDelivery(delivery, previous?.delivery ?? "env"),
				createdAt: previous?.createdAt ?? now,
				updatedAt: now,
				...(previous?.lastUsedAt !== undefined ? { lastUsedAt: previous.lastUsedAt } : {}),
			};
			// A login's password and its TOTP key ride in the same envelope, so a
			// single read gets both and the whole record is one atomic write.
			const entryValues: Record<string, string> = { [VALUE_KEY]: value };
			if (kind === "login" && typeof identity?.login?.totp === "string" && identity.login.totp.trim() !== "") {
				entryValues[TOTP_KEY] = identity.login.totp.trim();
			}
			await mergeSecret(this.#values, name, entryValues);
			metadata.entries[name] = next;
			await this.#writeMetadata(metadata);
			if (next.kind === "login") await this.removeDeliveryFile(name);
			else if (next.delivery === "file") await this.#writeDeliveryFile(name, value);
			else await this.removeDeliveryFile(name);
			return this.#toView(name, next);
		});
	}

	/**
	 * The password and TOTP key of one saved login, for the browser tool to type.
	 *
	 * Refuses anything that is not a `login` entry: a plain secret's value must
	 * never travel this path, because this one hands the value to a caller
	 * rather than placing it in a child process's environment.
	 */
	async loginCredentials(name: string): Promise<{ password: string; totp?: string } | undefined> {
		validateSecretName(name);
		const entry = await this.getEntry(name);
		if (entry?.kind !== "login") return undefined;
		const values = await readSecret(this.#values, name);
		const password = values?.[VALUE_KEY];
		if (password === undefined) return undefined;
		const totp = values?.[TOTP_KEY];
		return { password, ...(totp ? { totp } : {}) };
	}

	/**
	 * Everything one login needs to fill a form: username, password, and a
	 * current one-time code when a TOTP key is stored.
	 *
	 * The codes are computed here, in the daemon's process, and handed to the
	 * browser tool that will type them. Neither the password nor a code ever
	 * travels back through a tool result.
	 */
	async loginFill(
		name: string,
		now: number = Date.now(),
	): Promise<{ username: string; password: string; code?: string } | undefined> {
		const entry = await this.getEntry(name);
		if (entry?.kind !== "login") return undefined;
		const credentials = await this.loginCredentials(name);
		if (!credentials) return undefined;
		let code: string | undefined;
		if (credentials.totp) {
			try {
				code = totpCode(parseTotpKey(credentials.totp), now);
			} catch (error) {
				// A malformed setup key means no code, not a failed sign-in: the form
				// can still take the password and the person finishes the step.
				logger.warn("Stored 2FA setup key could not be read", {
					name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return {
			username: entry.login?.username ?? "",
			password: credentials.password,
			...(code ? { code } : {}),
		};
	}

	/** Saved logins whose site or host matches `host`, narrowest-first. */ async loginsForHost(
		host: string,
	): Promise<SecretEntryView[]> {
		const target = host.trim().toLowerCase();
		if (target === "") return [];
		const entries = await this.list();
		const matches = entries.filter(entry => {
			if (entry.kind !== "login" || !entry.login) return false;
			const { site, hosts, exactHost } = entry.login;
			// `exactHost` is the user saying "only on these hosts": a bare site
			// match must not widen it back to the whole site.
			if (hosts.includes(target)) return true;
			return !exactHost && site !== "" && (target === site || target.endsWith(`.${site}`));
		});
		return matches;
	}

	/** Rewrite a `file` delivery's working copy from the stored value; idempotent. */
	async materializeFile(name: string): Promise<void> {
		validateSecretName(name);
		// A login never has a delivery file; `getValue` already returns nothing.
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
			// A login has no value to export; skipping it here keeps passwords out
			// of every bash environment and every redaction list.
			if (entry.kind === "login") continue;
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
			kind: entry.kind,
			...(entry.login ? { login: { ...entry.login } } : {}),
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
 * What the card must collect. `fill` asks for a value; `allow` extends an
 * existing entry's scope; `login` asks for a website sign-in (site, username,
 * password and optionally a 2FA setup key) that the agent will only ever fill,
 * never read.
 */
export type AgentSecretRequestKind = "fill" | "allow" | "login";

/** Tool → UI request. Carries no value and no request id; the host assigns one. */
export interface AgentSecretRequest {
	name: string;
	purpose: string;
	/** For `login`: the page the agent is on, so the card can prefill its site. */
	site?: string;
	/** For `login`: the asking session's current URL, shown as the form it saves. */
	url?: string;
	kind: AgentSecretRequestKind;
	/** Proposed delivery for a new save; a stored entry keeps its own. */
	delivery?: SecretDelivery;
	/** The asking session's working directory; `allow` extends the scope to it. */
	workspace?: string;
	/**
	 * Entries the user may reuse instead of retyping a value.
	 *
	 * Only names and the non-secret half: a card shows what exists so a person
	 * who already saved this credential can pick it. Picking one resolves the
	 * request as `allow`, so the tool receives it under its own name and no
	 * value is ever copied between entries.
	 */
	alternatives?: AgentSecretAlternative[];
}

/** One reusable entry offered on a card. */
export interface AgentSecretAlternative {
	name: string;
	purpose: string;
	/** For a login: its site, so the picker can show what it is for. */
	site?: string;
	username?: string;
	/** Why it is offered: same value type, or the same site for a login. */
	reason: "same-site" | "available";
}

/**
 * UI → tool decision. The host persists `save` itself, so the value never
 * travels back through the tool, its result, or the transcript.
 */
export interface AgentSecretAnswer {
	action: "save" | "allow" | "cancel";
	/**
	 * The saved entry the user picked instead of typing a value.
	 *
	 * Present with `allow`: the tool is then told to use that name, and the
	 * daemon extends its scope to the asking workspace. No value is copied, so
	 * the picked entry keeps its own name and its own audit trail.
	 */
	picked?: string;
}

/** Duck-typed extension of the host UI context used by the daemon bridge. */
export interface AgentSecretUIContext {
	requestSecret?(request: AgentSecretRequest): Promise<AgentSecretAnswer | undefined>;
}
