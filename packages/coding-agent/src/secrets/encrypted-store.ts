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

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@musepi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";

const DEFAULT_STORE_FILE = "secrets.json";
const DEFAULT_MASTER_KEY_FILE = ".master.key";
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
	/** Optional environment override for the master key (hex or base64, 32 bytes). */
	masterKeyEnv?: string;
}

export function encryptedStore(
	dir: string,
	options: { file?: string; masterKeyFile?: string; masterKeyEnv?: string } = {},
): EncryptedStore {
	return {
		dir,
		file: path.join(dir, options.file ?? DEFAULT_STORE_FILE),
		masterKeyFile: path.join(dir, options.masterKeyFile ?? DEFAULT_MASTER_KEY_FILE),
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

async function readOrCreateMasterKey(store: EncryptedStore): Promise<Buffer> {
	const override = parseEnvKey(store);
	if (override) return override;
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
