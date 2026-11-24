/**
 * Encrypted per-profile secret store.
 *
 * One JSON file holds a small AES-256-GCM envelope per id; the key is derived
 * with HKDF from a per-profile master key, so a copied store file alone is not
 * usable. Callers name the directory (connector secrets and collab tunnel
 * tokens each get their own id namespace in the same envelope).
 *
 * Decrypt failure is not data loss: the file is left untouched and the caller
 * sees "no usable secret", which sends the user back to the form. The
 * alternative — deleting an unreadable vault — turns a machine move into a
 * silent wipe of every credential.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@musepi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";

const DEFAULT_STORE_FILE = "secrets.json";
const DEFAULT_MASTER_KEY_FILE = ".master.key";
const DEFAULT_WRAPPED_KEY_FILE = ".master.key.wrapped";
const ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/**
 * On-disk domain separation. Kept literal (not derived from the store
 * directory) so existing connector vaults keep decrypting after the store was
 * extracted from the connector module.
 */
const AAD_PREFIX = "connector";
const HKDF_INFO = "musepi-connector-secret";

interface SecretEnvelope {
	iv: string;
	tag: string;
	ct: string;
}

interface SecretsFile {
	version: 1;
	entries: Record<string, SecretEnvelope>;
}

const fileLocks = new Map<string, Promise<unknown>>();

export interface EncryptedStore {
	/** Directory holding the store file and the master key. */
	dir: string;
	file: string;
	masterKeyFile: string;
	/** Passphrase-wrapped master key; present means the store is protected by a passphrase. */
	wrappedKeyFile: string;
	/** Optional environment override for the master key (hex or base64, 32 bytes). */
	masterKeyEnv?: string;
}

export function encryptedStore(
	dir: string,
	options: { file?: string; masterKeyFile?: string; wrappedKeyFile?: string; masterKeyEnv?: string } = {},
): EncryptedStore {
	return {
		dir,
		file: path.join(dir, options.file ?? DEFAULT_STORE_FILE),
		masterKeyFile: path.join(dir, options.masterKeyFile ?? DEFAULT_MASTER_KEY_FILE),
		wrappedKeyFile: path.join(dir, options.wrappedKeyFile ?? DEFAULT_WRAPPED_KEY_FILE),
		...(options.masterKeyEnv ? { masterKeyEnv: options.masterKeyEnv } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvKey(store: EncryptedStore): Buffer | undefined {
	const name = store.masterKeyEnv;
	if (!name) return undefined;
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
	if (decoded.length !== KEY_BYTES) {
		logger.warn(`${name} must decode to ${KEY_BYTES} bytes; ignoring it`);
		return undefined;
	}
	return decoded;
}

const WRAPPED_KEY_VERSION = 1;
const KDF = { name: "scrypt", N: 1 << 15, r: 8, p: 1 } as const;
const SALT_BYTES = 16;
const WRAPPED_KEY_AAD = Buffer.from("musepi-agent-master-key v1", "utf8");
export const MASTER_KEY_PASSPHRASE_ENV = "MUSEPI_AGENT_SECRET_PASSPHRASE";
export const MASTER_KEY_PASSPHRASE_FILE_ENV = "MUSEPI_AGENT_SECRET_PASSPHRASE_FILE";
export const MIN_MASTER_KEY_PASSPHRASE = 8;
export const MAX_MASTER_KEY_PASSPHRASE = 1024;

export type MasterKeyLockReason = "missing-passphrase" | "wrong-passphrase" | "passphrase-source";

/** The store's key exists but the passphrase that unlocks it is missing or wrong. */
export class SecretStoreLockedError extends Error {
	readonly code = "secrets/locked";

	constructor(
		readonly reason: MasterKeyLockReason,
		message: string,
	) {
		super(message);
		this.name = "SecretStoreLockedError";
	}
}

interface WrappedMasterKey {
	version: 1;
	encrypted: true;
	kdf: { name: string; N: number; r: number; p: number };
	salt: string;
	iv: string;
	tag: string;
	ciphertext: string;
}

export type MasterKeyState =
	| { mode: "plain"; protectedBy: "key-file"; locked: false }
	| {
			mode: "passphrase";
			protectedBy: "passphrase";
			locked: boolean;
			unlocked: boolean;
			reason?: MasterKeyLockReason;
	  };

/** Master keys unlocked by a passphrase in this process, keyed by wrapped-key path. */
const unlockedKeys = new Map<string, Buffer>();

/** Test-only: forget every passphrase-unlocked key. */
export function clearUnlockedMasterKeysForTests(): void {
	unlockedKeys.clear();
}

export function cleanMasterKeyPassphrase(value: unknown): string {
	if (typeof value !== "string") throw new Error("Type the passphrase first");
	if (value.length < MIN_MASTER_KEY_PASSPHRASE) {
		throw new Error(`A passphrase has at least ${MIN_MASTER_KEY_PASSPHRASE} characters`);
	}
	if (value.length > MAX_MASTER_KEY_PASSPHRASE) {
		throw new Error(`A passphrase has at most ${MAX_MASTER_KEY_PASSPHRASE} characters`);
	}
	return value;
}

/** Unattended starts may carry the passphrase in an environment variable or a file. */
function passphraseFromEnvironment(): { passphrase?: string; error?: string } {
	const direct = process.env[MASTER_KEY_PASSPHRASE_ENV]?.trim();
	if (direct) return { passphrase: direct };
	const file = process.env[MASTER_KEY_PASSPHRASE_FILE_ENV]?.trim();
	if (!file) return {};
	try {
		// A trailing newline from an editor is not part of the passphrase.
		const passphrase = fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
		if (passphrase === "") return { error: `${MASTER_KEY_PASSPHRASE_FILE_ENV} names a file with no passphrase` };
		return { passphrase };
	} catch (error) {
		return {
			error: `${MASTER_KEY_PASSPHRASE_FILE_ENV} could not be read: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

function deriveKek(passphrase: string, salt: Buffer): Buffer {
	return scryptSync(Buffer.from(passphrase, "utf8"), salt, KEY_BYTES, {
		N: KDF.N,
		r: KDF.r,
		p: KDF.p,
		maxmem: 256 * 1024 * 1024,
	});
}

function wrapMasterKey(key: Buffer, passphrase: string): WrappedMasterKey {
	const salt = randomBytes(SALT_BYTES);
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", deriveKek(passphrase, salt), iv);
	cipher.setAAD(WRAPPED_KEY_AAD);
	const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
	return {
		version: WRAPPED_KEY_VERSION,
		encrypted: true,
		kdf: { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p },
		salt: salt.toString("base64"),
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	};
}

function unwrapMasterKey(envelope: WrappedMasterKey, passphrase: string): Buffer {
	if (
		envelope.version !== WRAPPED_KEY_VERSION ||
		envelope.encrypted !== true ||
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
	let key: Buffer;
	try {
		const salt = Buffer.from(envelope.salt, "base64");
		const iv = Buffer.from(envelope.iv, "base64");
		const tag = Buffer.from(envelope.tag, "base64");
		const ciphertext = Buffer.from(envelope.ciphertext, "base64");
		if (
			salt.length !== SALT_BYTES ||
			iv.length !== IV_BYTES ||
			tag.length !== TAG_BYTES ||
			ciphertext.length !== KEY_BYTES
		) {
			throw new Error("invalid wrapped key");
		}
		const decipher = createDecipheriv("aes-256-gcm", deriveKek(passphrase, salt), iv);
		decipher.setAAD(WRAPPED_KEY_AAD);
		decipher.setAuthTag(tag);
		key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch {
		throw new SecretStoreLockedError(
			"wrong-passphrase",
			"The passphrase did not unlock the secret store, or its key file is damaged.",
		);
	}
	if (key.length !== KEY_BYTES) {
		throw new SecretStoreLockedError("wrong-passphrase", "The wrapped master key has the wrong length.");
	}
	return key;
}

async function readWrappedKey(store: EncryptedStore): Promise<WrappedMasterKey | "malformed" | undefined> {
	let text: string;
	try {
		text = await fs.promises.readFile(store.wrappedKeyFile, "utf8");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		logger.warn("Wrapped secret master key could not be read", { path: store.wrappedKeyFile });
		return "malformed";
	}
	try {
		const raw: unknown = JSON.parse(text);
		if (!isRecord(raw) || raw.version !== WRAPPED_KEY_VERSION || raw.encrypted !== true) return "malformed";
		return raw as unknown as WrappedMasterKey;
	} catch {
		return "malformed";
	}
}

/** Whether the store is protected by a passphrase, and whether this process can read it. */
export async function masterKeyState(store: EncryptedStore): Promise<MasterKeyState> {
	const wrapped = await readWrappedKey(store);
	if (wrapped === undefined) return { mode: "plain", protectedBy: "key-file", locked: false };
	if (unlockedKeys.has(store.wrappedKeyFile)) {
		return { mode: "passphrase", protectedBy: "passphrase", locked: false, unlocked: true };
	}
	const fromEnv = passphraseFromEnvironment();
	if (fromEnv.error) {
		return {
			mode: "passphrase",
			protectedBy: "passphrase",
			locked: true,
			unlocked: false,
			reason: "passphrase-source",
		};
	}
	if (!fromEnv.passphrase) {
		return {
			mode: "passphrase",
			protectedBy: "passphrase",
			locked: true,
			unlocked: false,
			reason: "missing-passphrase",
		};
	}
	if (wrapped === "malformed") {
		return {
			mode: "passphrase",
			protectedBy: "passphrase",
			locked: true,
			unlocked: false,
			reason: "wrong-passphrase",
		};
	}
	try {
		unlockedKeys.set(store.wrappedKeyFile, unwrapMasterKey(wrapped, fromEnv.passphrase));
		return { mode: "passphrase", protectedBy: "passphrase", locked: false, unlocked: true };
	} catch {
		return {
			mode: "passphrase",
			protectedBy: "passphrase",
			locked: true,
			unlocked: false,
			reason: "wrong-passphrase",
		};
	}
}

/** Unlock a passphrase-protected store for this process; the plain key is not written. */
export async function unlockMasterKey(store: EncryptedStore, passphrase: unknown): Promise<void> {
	const secret = cleanMasterKeyPassphrase(passphrase);
	const wrapped = await readWrappedKey(store);
	if (wrapped === undefined) throw new Error("The secret store is not protected by a passphrase.");
	if (wrapped === "malformed") throw new Error("The wrapped master key is damaged.");
	unlockedKeys.set(store.wrappedKeyFile, unwrapMasterKey(wrapped, secret));
}

/** Wrap the current plain master key under a passphrase, then remove the plain key file. */
export async function encryptMasterKey(store: EncryptedStore, passphrase: unknown): Promise<void> {
	if ((await readWrappedKey(store)) !== undefined)
		throw new Error("The secret store is already protected by a passphrase.");
	const secret = cleanMasterKeyPassphrase(passphrase);
	const key = await readOrCreateMasterKey(store);
	await fs.promises.mkdir(store.dir, { recursive: true });
	await writeFileAtomically(store.wrappedKeyFile, `${JSON.stringify(wrapMasterKey(key, secret), null, 2)}\n`, 0o600);
	await fs.promises.rm(store.masterKeyFile, { force: true });
	unlockedKeys.set(store.wrappedKeyFile, key);
}

/** Remove the passphrase protection after proving it; the plain key file returns. */
export async function decryptMasterKey(store: EncryptedStore, passphrase: unknown): Promise<void> {
	const secret = cleanMasterKeyPassphrase(passphrase);
	const wrapped = await readWrappedKey(store);
	if (wrapped === undefined) throw new Error("The secret store is not protected by a passphrase.");
	if (wrapped === "malformed") throw new Error("The wrapped master key is damaged.");
	const key = unwrapMasterKey(wrapped, secret);
	await writeMasterKeyFile(store, key);
	await fs.promises.rm(store.wrappedKeyFile, { force: true });
	unlockedKeys.delete(store.wrappedKeyFile);
}

/**
 * Replace the passphrase that wraps the same master key. The plain key never
 * touches the disk here: removing the old passphrase and adding a new one in
 * two calls would leave it unprotected if the second call never ran.
 */
export async function rephraseMasterKey(store: EncryptedStore, current: unknown, next: unknown): Promise<void> {
	const wrapped = await readWrappedKey(store);
	if (wrapped === undefined) throw new Error("The secret store is not protected by a passphrase.");
	if (wrapped === "malformed") throw new Error("The wrapped master key is damaged.");
	const key = unwrapMasterKey(wrapped, cleanMasterKeyPassphrase(current));
	const passphrase = cleanMasterKeyPassphrase(next);
	await writeFileAtomically(
		store.wrappedKeyFile,
		`${JSON.stringify(wrapMasterKey(key, passphrase), null, 2)}\n`,
		0o600,
	);
	unlockedKeys.set(store.wrappedKeyFile, key);
}

async function writeMasterKeyFile(store: EncryptedStore, key: Buffer): Promise<void> {
	await fs.promises.mkdir(path.dirname(store.masterKeyFile), { recursive: true });
	const temp = `${store.masterKeyFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		const handle = await fs.promises.open(temp, "wx", 0o600);
		try {
			await handle.writeFile(key);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.promises.chmod(temp, 0o600).catch(() => {});
		await fs.promises.rename(temp, store.masterKeyFile);
	} catch (error) {
		await fs.promises.rm(temp, { force: true }).catch(() => {});
		throw error;
	}
}

async function readOrCreateMasterKey(store: EncryptedStore): Promise<Buffer> {
	const unlocked = unlockedKeys.get(store.wrappedKeyFile);
	if (unlocked) return unlocked;
	const override = parseEnvKey(store);
	if (override) return override;
	const wrapped = await readWrappedKey(store);
	if (wrapped !== undefined) {
		if (wrapped === "malformed") {
			throw new SecretStoreLockedError(
				"wrong-passphrase",
				"The wrapped master key is damaged. Repair it in Settings → Vault.",
			);
		}
		const fromEnv = passphraseFromEnvironment();
		if (fromEnv.error) throw new SecretStoreLockedError("passphrase-source", fromEnv.error);
		if (!fromEnv.passphrase) {
			throw new SecretStoreLockedError(
				"missing-passphrase",
				"The secret store is locked. Unlock it in Settings → Vault, or set MUSEPI_AGENT_SECRET_PASSPHRASE_FILE.",
			);
		}
		const key = unwrapMasterKey(wrapped, fromEnv.passphrase);
		unlockedKeys.set(store.wrappedKeyFile, key);
		return key;
	}
	try {
		const existing = await fs.promises.readFile(store.masterKeyFile);
		if (existing.length === KEY_BYTES) return existing;
		logger.warn("Secret master key has the wrong length; refusing to replace it", { path: store.masterKeyFile });
		throw new Error("secret master key is invalid");
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	await fs.promises.mkdir(path.dirname(store.masterKeyFile), { recursive: true });
	const key = randomBytes(KEY_BYTES);
	try {
		const handle = await fs.promises.open(store.masterKeyFile, "wx", 0o600);
		try {
			await handle.writeFile(key);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.promises.chmod(store.masterKeyFile, 0o600).catch(() => {});
		return key;
	} catch (error) {
		if (!isRecord(error) || error.code !== "EEXIST") throw error;
		const existing = await fs.promises.readFile(store.masterKeyFile);
		if (existing.length === KEY_BYTES) return existing;
		throw new Error("secret master key is invalid");
	}
}

function deriveKey(masterKey: Buffer, id: string): Buffer {
	const salt = Buffer.from(id, "utf8");
	const info = Buffer.from(HKDF_INFO, "utf8");
	return Buffer.from(hkdfSync("sha256", masterKey, salt, info, KEY_BYTES));
}

function encryptValue(value: string, key: Buffer, id: string): SecretEnvelope {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(`${AAD_PREFIX}:${id}`, "utf8"));
	const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	return {
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		ct: ct.toString("base64"),
	};
}

function decryptValue(envelope: SecretEnvelope, key: Buffer, id: string): string {
	const iv = Buffer.from(envelope.iv, "base64");
	const tag = Buffer.from(envelope.tag, "base64");
	const ct = Buffer.from(envelope.ct, "base64");
	if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("invalid envelope");
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAAD(Buffer.from(`${AAD_PREFIX}:${id}`, "utf8"));
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

async function readFile(store: EncryptedStore): Promise<SecretsFile> {
	let text: string;
	try {
		text = await fs.promises.readFile(store.file, "utf8");
	} catch (error) {
		if (isEnoent(error)) return { version: ENVELOPE_VERSION, entries: {} };
		throw error;
	}
	try {
		const raw: unknown = JSON.parse(text);
		if (!isRecord(raw) || raw.version !== ENVELOPE_VERSION || !isRecord(raw.entries)) {
			logger.warn("Secret store file has an unsupported shape", { path: store.file });
			return { version: ENVELOPE_VERSION, entries: {} };
		}
		const entries: Record<string, SecretEnvelope> = {};
		for (const [id, envelope] of Object.entries(raw.entries)) {
			if (
				isRecord(envelope) &&
				typeof envelope.iv === "string" &&
				typeof envelope.tag === "string" &&
				typeof envelope.ct === "string"
			) {
				entries[id] = { iv: envelope.iv, tag: envelope.tag, ct: envelope.ct };
			}
		}
		return { version: ENVELOPE_VERSION, entries };
	} catch (error) {
		logger.warn("Secret store file is not valid JSON", {
			path: store.file,
			error: error instanceof Error ? error.message : String(error),
		});
		return { version: ENVELOPE_VERSION, entries: {} };
	}
}

async function writeFile(store: EncryptedStore, file: SecretsFile): Promise<void> {
	await fs.promises.mkdir(path.dirname(store.file), { recursive: true });
	await writeFileAtomically(store.file, `${JSON.stringify(file, null, 2)}\n`);
}

async function withLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
	const previous = fileLocks.get(filePath) ?? Promise.resolve();
	const run = previous.then(action, action);
	fileLocks.set(
		filePath,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	try {
		return await run;
	} finally {
		if (fileLocks.get(filePath) === run) fileLocks.delete(filePath);
	}
}

/** Decrypt one entry's values. Undefined means "no usable secret". */
export async function readSecret(store: EncryptedStore, id: string): Promise<Record<string, string> | undefined> {
	const file = await readFile(store);
	const envelope = file.entries[id];
	if (!envelope) return undefined;
	try {
		const plain = decryptValue(envelope, deriveKey(await readOrCreateMasterKey(store), id), id);
		const parsed: unknown = JSON.parse(plain);
		if (!isRecord(parsed)) return undefined;
		const values: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string" && value.length > 0) values[key] = value;
		}
		return Object.keys(values).length > 0 ? values : undefined;
	} catch (error) {
		logger.warn("Secret could not be decrypted; keeping the file untouched", {
			id,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/** One value from an entry, without callers re-implementing the envelope shape. */
export async function readSecretValue(store: EncryptedStore, id: string, key: string): Promise<string | undefined> {
	return (await readSecret(store, id))?.[key];
}

/** Ids that currently hold an envelope (no decryption, cheap for discovery). */
export async function listSecretIds(store: EncryptedStore): Promise<string[]> {
	return Object.keys((await readFile(store)).entries).sort();
}

/**
 * Merge new values into one entry. Empty strings keep the stored value, which
 * is what a credential form sends for an already-configured password.
 */
export async function mergeSecret(store: EncryptedStore, id: string, values: Record<string, string>): Promise<void> {
	await withLock(store.file, async () => {
		const previous = (await readSecret(store, id)) ?? {};
		const merged: Record<string, string> = { ...previous };
		for (const [key, value] of Object.entries(values)) {
			if (value.length === 0) continue;
			merged[key] = value;
		}
		const masterKey = await readOrCreateMasterKey(store);
		const file = await readFile(store);
		file.entries[id] = encryptValue(JSON.stringify(merged), deriveKey(masterKey, id), id);
		await writeFile(store, file);
	});
}

/** Remove one entry. */
export async function deleteSecret(store: EncryptedStore, id: string): Promise<void> {
	await withLock(store.file, async () => {
		const file = await readFile(store);
		if (!(id in file.entries)) return;
		delete file.entries[id];
		await writeFile(store, file);
	});
}

/** Whether every required field already has a stored value. */
export async function hasSecret(store: EncryptedStore, id: string, requiredKeys: readonly string[]): Promise<boolean> {
	const values = await readSecret(store, id);
	if (!values) return requiredKeys.length === 0;
	return requiredKeys.every(key => (values[key]?.length ?? 0) > 0);
}
