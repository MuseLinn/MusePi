/**
 * One master key for every encrypted store in a profile.
 *
 * MusePi keeps three encrypted stores: connector tokens, MCP OAuth grants, and
 * the agent secret vault. Each grew its own key file, so a passphrase could
 * only protect whichever one implemented it — the vault — while connector
 * tokens and OAuth refresh tokens stayed on plain key files the user believed
 * were covered.
 *
 * This module owns the key itself. The stores keep their own envelope formats
 * and their own directories; they only ask here for the 32 bytes to derive
 * from. That keeps the migration free: a store's existing file still decrypts,
 * because the key bytes are unchanged when the shared key is adopted from it.
 *
 * Precedence is deliberate, highest first:
 *
 * 1. `MUSEPI_MASTER_KEY` / `MUSEPI_MASTER_KEY_FILE` — one value for a managed
 *    deployment that must not touch the disk.
 * 2. The legacy per-store key the caller already had (`<dir>/.master.key` or
 *    `<dir>/mcp-oauth.key`). Adopting it is what makes this a no-op migration.
 * 3. `<agentDir>/.master.key` — the shared key, created on first use.
 *
 * A store that opens before the shared key exists adopts its own key, and the
 * shared key is created from it, so every later store lands on the same bytes.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const UNIFIED_KEY_FILE = ".master.key";
const UNIFIED_WRAPPED_KEY_FILE = ".master.key.wrapped";
const UNIFIED_KEY_ENV = "MUSEPI_MASTER_KEY";
const UNIFIED_KEY_FILE_ENV = "MUSEPI_MASTER_KEY_FILE";
const PASSPHRASE_ENV = "MUSEPI_AGENT_SECRET_PASSPHRASE";
const PASSPHRASE_FILE_ENV = "MUSEPI_AGENT_SECRET_PASSPHRASE_FILE";
const MIN_PASSPHRASE = 8;
const MAX_PASSPHRASE = 1024;
const WRAPPED_VERSION = 1;
const KDF = { name: "scrypt", N: 1 << 15, r: 8, p: 1 } as const;
const WRAPPED_AAD = Buffer.from("musepi-agent-master-key v1", "utf8");

/** The store a caller is asking for, used only to find its own legacy key. */
export interface UnifiedKeyRequest {
	/** The agent directory (a profile's config root plus `agent`). */
	agentDir: string;
	/**
	 * Where this store's own key lives today, relative to `agentDir` — for
	 * example `connectors/.master.key`. Absent for the store that owns the
	 * shared key itself.
	 */
	legacyKeyPath?: string;
	/** Environment override this store honoured before the merge. */
	legacyKeyEnv?: string;
}

export type MasterKeyMode = "plain" | "passphrase";

export interface UnifiedKeyState {
	mode: MasterKeyMode;
	locked: boolean;
	reason?: "missing-passphrase" | "wrong-passphrase" | "passphrase-source";
}

export class UnifiedKeyLockedError extends Error {
	readonly code = "secrets/locked";

	constructor(
		readonly reason: NonNullable<UnifiedKeyState["reason"]>,
		message: string,
	) {
		super(message);
		this.name = "UnifiedKeyLockedError";
	}
}

/** Keys unlocked by a passphrase in this process, keyed by agent dir. */
const unlockedKeys = new Map<string, Buffer>();

/** Test-only: forget every passphrase-unlocked key. */
export function clearUnifiedKeysForTests(): void {
	unlockedKeys.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeEnvKey(name: string): Buffer | undefined {
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
	return decoded.length === KEY_BYTES ? decoded : undefined;
}

function isValidKey(buffer: Buffer): boolean {
	return buffer.length === KEY_BYTES;
}

/** Read a raw key file, or undefined when it is missing or malformed. */
function readKeyFile(file: string): Buffer | undefined {
	try {
		const value = fs.readFileSync(file);
		return isValidKey(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Write a key file owner-only, refusing to replace a differently-sized one. */
function writeKeyFile(file: string, key: Buffer): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	const fd = fs.openSync(temp, "wx", 0o600);
	try {
		fs.writeFileSync(fd, key);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.chmodSync(temp, 0o600);
	} catch {
		// Windows has no POSIX mode; the ACL inherited from the directory applies.
	}
	fs.renameSync(temp, file);
}

export function unifiedKeyPath(agentDir: string): string {
	return path.join(agentDir, UNIFIED_KEY_FILE);
}

export function unifiedWrappedKeyPath(agentDir: string): string {
	return path.join(agentDir, UNIFIED_WRAPPED_KEY_FILE);
}

interface WrappedKey {
	version: 1;
	encrypted: true;
	kdf: { name: string; N: number; r: number; p: number };
	salt: string;
	iv: string;
	tag: string;
	ciphertext: string;
}

function readWrappedKey(agentDir: string): WrappedKey | "malformed" | undefined {
	let text: string;
	try {
		text = fs.readFileSync(unifiedWrappedKeyPath(agentDir), "utf8");
	} catch {
		return undefined;
	}
	try {
		const raw: unknown = JSON.parse(text);
		if (!isRecord(raw) || raw.version !== WRAPPED_VERSION || raw.encrypted !== true) return "malformed";
		return raw as unknown as WrappedKey;
	} catch {
		return "malformed";
	}
}

function passphraseFromEnvironment(): { passphrase?: string; error?: string } {
	const direct = process.env[PASSPHRASE_ENV]?.trim();
	if (direct) return { passphrase: direct };
	const file = process.env[PASSPHRASE_FILE_ENV]?.trim();
	if (!file) return {};
	try {
		const passphrase = fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
		if (passphrase === "") return { error: `${PASSPHRASE_FILE_ENV} names a file with no passphrase` };
		return { passphrase };
	} catch (error) {
		return {
			error: `${PASSPHRASE_FILE_ENV} could not be read: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function cleanPassphrase(value: unknown): string {
	if (typeof value !== "string") throw new Error("Type the passphrase first");
	if (value.length < MIN_PASSPHRASE) throw new Error(`A passphrase has at least ${MIN_PASSPHRASE} characters`);
	if (value.length > MAX_PASSPHRASE) throw new Error(`A passphrase has at most ${MAX_PASSPHRASE} characters`);
	return value;
}

function deriveKek(passphrase: string, salt: Buffer): Buffer {
	return scryptSync(Buffer.from(passphrase, "utf8"), salt, KEY_BYTES, {
		N: KDF.N,
		r: KDF.r,
		p: KDF.p,
		maxmem: 256 * 1024 * 1024,
	});
}

function wrapKey(key: Buffer, passphrase: string): WrappedKey {
	const salt = randomBytes(SALT_BYTES);
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", deriveKek(passphrase, salt), iv);
	cipher.setAAD(WRAPPED_AAD);
	const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
	return {
		version: WRAPPED_VERSION,
		encrypted: true,
		kdf: { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p },
		salt: salt.toString("base64"),
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	};
}

function unwrapKey(envelope: WrappedKey, passphrase: string): Buffer {
	if (
		envelope.kdf?.name !== KDF.name ||
		envelope.kdf.r !== KDF.r ||
		envelope.kdf.p !== KDF.p ||
		!Number.isInteger(envelope.kdf.N) ||
		envelope.kdf.N < 1 << 14 ||
		envelope.kdf.N > 1 << 17 ||
		(envelope.kdf.N & (envelope.kdf.N - 1)) !== 0
	) {
		throw new Error("The wrapped master key uses key settings this build does not accept");
	}
	try {
		const salt = Buffer.from(envelope.salt, "base64");
		const iv = Buffer.from(envelope.iv, "base64");
		const tag = Buffer.from(envelope.tag, "base64");
		const ciphertext = Buffer.from(envelope.ciphertext, "base64");
		if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
			throw new Error("invalid wrapped key");
		}
		if (!isValidKey(ciphertext)) throw new Error("invalid wrapped key");
		const decipher = createDecipheriv("aes-256-gcm", deriveKek(passphrase, salt), iv);
		decipher.setAAD(WRAPPED_AAD);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch {
		throw new UnifiedKeyLockedError(
			"wrong-passphrase",
			"The passphrase did not unlock the secret store, or its key file is damaged.",
		);
	}
}

/**
 * How the shared key is stored, and whether this process can read it.
 *
 * A wrapped key means the store is passphrase-protected; the passphrase may
 * still arrive from the environment, which is how an unattended start works.
 */
export function unifiedKeyState(agentDir: string): UnifiedKeyState {
	const wrapped = readWrappedKey(agentDir);
	if (wrapped === undefined) return { mode: "plain", locked: false };
	if (unlockedKeys.has(agentDir)) return { mode: "passphrase", locked: false };
	const fromEnv = passphraseFromEnvironment();
	if (fromEnv.error) return { mode: "passphrase", locked: true, reason: "passphrase-source" };
	if (!fromEnv.passphrase) return { mode: "passphrase", locked: true, reason: "missing-passphrase" };
	if (wrapped === "malformed") return { mode: "passphrase", locked: true, reason: "wrong-passphrase" };
	try {
		unlockedKeys.set(agentDir, unwrapKey(wrapped, fromEnv.passphrase));
		return { mode: "passphrase", locked: false };
	} catch {
		return { mode: "passphrase", locked: true, reason: "wrong-passphrase" };
	}
}

/**
 * The 32 bytes every store derives from.
 *
 * Throws {@link UnifiedKeyLockedError} while a passphrase-protected key is
 * unreadable; callers treat that as "no usable secret", never as data loss.
 */
export function readMasterKey(request: UnifiedKeyRequest): Buffer {
	const { agentDir } = request;
	const unlocked = unlockedKeys.get(agentDir);
	if (unlocked) return unlocked;

	const fromEnvFile = process.env[UNIFIED_KEY_FILE_ENV]?.trim();
	if (fromEnvFile) {
		const key = readKeyFile(fromEnvFile);
		if (key) return key;
	}
	const fromEnv = decodeEnvKey(UNIFIED_KEY_ENV);
	if (fromEnv) return fromEnv;

	const wrapped = readWrappedKey(agentDir);
	if (wrapped !== undefined) {
		if (wrapped === "malformed") {
			throw new UnifiedKeyLockedError(
				"wrong-passphrase",
				"The wrapped master key is damaged. Repair it in Settings → Vault.",
			);
		}
		const fromEnvironment = passphraseFromEnvironment();
		if (fromEnvironment.error) throw new UnifiedKeyLockedError("passphrase-source", fromEnvironment.error);
		if (!fromEnvironment.passphrase) {
			throw new UnifiedKeyLockedError(
				"missing-passphrase",
				"The secret store is locked. Unlock it in Settings → Vault, or set MUSEPI_AGENT_SECRET_PASSPHRASE_FILE.",
			);
		}
		const key = unwrapKey(wrapped, fromEnvironment.passphrase);
		unlockedKeys.set(agentDir, key);
		return key;
	}

	const shared = readKeyFile(unifiedKeyPath(agentDir));
	if (shared) return shared;

	// This store has its own key from before the merge: adopt it into the shared
	// slot so every other store lands on the same bytes. Nothing re-encrypts.
	if (request.legacyKeyEnv) {
		const legacyEnv = decodeEnvKey(request.legacyKeyEnv);
		if (legacyEnv) {
			writeKeyFile(unifiedKeyPath(agentDir), legacyEnv);
			return legacyEnv;
		}
	}
	if (request.legacyKeyPath) {
		const legacy = readKeyFile(path.join(agentDir, request.legacyKeyPath));
		if (legacy) {
			writeKeyFile(unifiedKeyPath(agentDir), legacy);
			return legacy;
		}
	}

	// Nothing exists yet: create the shared key. A concurrent creator wins and
	// its bytes are used, so two stores opening at once agree.
	const key = randomBytes(KEY_BYTES);
	try {
		writeKeyFile(unifiedKeyPath(agentDir), key);
		return key;
	} catch (error) {
		const existing = readKeyFile(unifiedKeyPath(agentDir));
		if (existing) return existing;
		throw error;
	}
}

/** Wrap the shared key under `passphrase` and remove the plain key file. */
export function wrapMasterKey(agentDir: string, passphrase: unknown): void {
	if (readWrappedKey(agentDir) !== undefined) return;
	const secret = cleanPassphrase(passphrase);
	const key = readMasterKey({ agentDir });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(unifiedWrappedKeyPath(agentDir), `${JSON.stringify(wrapKey(key, secret), null, 2)}\n`, {
		mode: 0o600,
	});
	fs.rmSync(unifiedKeyPath(agentDir), { force: true });
	unlockedKeys.set(agentDir, key);
}

/** Prove `passphrase` and restore the plain key file. */
export function unwrapMasterKeyToFile(agentDir: string, passphrase: unknown): void {
	const secret = cleanPassphrase(passphrase);
	const wrapped = readWrappedKey(agentDir);
	if (wrapped === undefined) return;
	if (wrapped === "malformed") throw new Error("The wrapped master key is damaged.");
	const key = unwrapKey(wrapped, secret);
	writeKeyFile(unifiedKeyPath(agentDir), key);
	fs.rmSync(unifiedWrappedKeyPath(agentDir), { force: true });
	unlockedKeys.delete(agentDir);
}

/** Unlock a passphrase-protected key for this process; nothing is written. */
export function unlockMasterKeyInMemory(agentDir: string, passphrase: unknown): void {
	const secret = cleanPassphrase(passphrase);
	const wrapped = readWrappedKey(agentDir);
	if (wrapped === undefined) return;
	if (wrapped === "malformed") throw new Error("The wrapped master key is damaged.");
	unlockedKeys.set(agentDir, unwrapKey(wrapped, secret));
}

/**
 * Whether two stores in this profile share one master key.
 *
 * When they do, a passphrase operation must run once, not once per store: the
 * second call would be proving a passphrase the first call just replaced.
 */
export function sharesMasterKey(agentDir: string, ...stores: Array<{ sharedKeyAgentDir?: string }>): boolean {
	return stores.length > 0 && stores.every(store => store.sharedKeyAgentDir === agentDir);
}

/** Re-wrap the same key under a new passphrase; no ciphertext is rewritten. */
export function rewrapMasterKey(agentDir: string, current: unknown, next: unknown): void {
	const wrapped = readWrappedKey(agentDir);
	if (wrapped === undefined) return;
	if (wrapped === "malformed") throw new Error("The wrapped master key is damaged.");
	const key = unwrapKey(wrapped, cleanPassphrase(current));
	fs.writeFileSync(
		unifiedWrappedKeyPath(agentDir),
		`${JSON.stringify(wrapKey(key, cleanPassphrase(next)), null, 2)}\n`,
		{
			mode: 0o600,
		},
	);
	unlockedKeys.set(agentDir, key);
}
