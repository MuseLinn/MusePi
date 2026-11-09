/**
 * Encrypted connector secrets.
 *
 * Token connectors keep their values here, never in the catalog, state file, or
 * MCP config. One file per profile holds a small AES-256-GCM envelope per
 * connector; the key is derived with HKDF from a per-profile master key, so a
 * copied secrets file alone is not usable.
 *
 * Decrypt failure is not data loss: the file is left untouched and the
 * connector reports "missing token", which sends the user back to the form.
 * The alternative — deleting an unreadable vault — turns a machine move into a
 * silent wipe of every connector credential.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@musepi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import { CONNECTOR_DIR_NAME } from "./types";

const MASTER_KEY_FILE = ".master.key";
const SECRETS_FILE = "secrets.json";
const ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MASTER_KEY_ENV = "MUSEPI_CONNECTOR_MASTER_KEY";

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

export function connectorSecretsPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, CONNECTOR_DIR_NAME, SECRETS_FILE);
}

export function connectorMasterKeyPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, CONNECTOR_DIR_NAME, MASTER_KEY_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvKey(): Buffer | undefined {
	const raw = process.env[MASTER_KEY_ENV]?.trim();
	if (!raw) return undefined;
	const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
	if (decoded.length !== KEY_BYTES) {
		logger.warn(`${MASTER_KEY_ENV} must decode to ${KEY_BYTES} bytes; ignoring it`);
		return undefined;
	}
	return decoded;
}

async function readOrCreateMasterKey(agentDir: string): Promise<Buffer> {
	const override = parseEnvKey();
	if (override) return override;
	const filePath = connectorMasterKeyPath(agentDir);
	try {
		const existing = await fs.promises.readFile(filePath);
		if (existing.length === KEY_BYTES) return existing;
		logger.warn("Connector master key has the wrong length; refusing to replace it", { path: filePath });
		throw new Error("connector master key is invalid");
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const key = randomBytes(KEY_BYTES);
	try {
		const handle = await fs.promises.open(filePath, "wx", 0o600);
		try {
			await handle.writeFile(key);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.promises.chmod(filePath, 0o600).catch(() => {});
		return key;
	} catch (error) {
		if (!isRecord(error) || error.code !== "EEXIST") throw error;
		const existing = await fs.promises.readFile(filePath);
		if (existing.length === KEY_BYTES) return existing;
		throw new Error("connector master key is invalid");
	}
}

function deriveKey(masterKey: Buffer, id: string): Buffer {
	const salt = Buffer.from(id, "utf8");
	const info = Buffer.from("musepi-connector-secret", "utf8");
	return Buffer.from(hkdfSync("sha256", masterKey, salt, info, KEY_BYTES));
}

function encryptValue(value: string, key: Buffer, id: string): SecretEnvelope {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(`connector:${id}`, "utf8"));
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
	decipher.setAAD(Buffer.from(`connector:${id}`, "utf8"));
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

async function readFile(filePath: string): Promise<SecretsFile> {
	let text: string;
	try {
		text = await fs.promises.readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return { version: ENVELOPE_VERSION, entries: {} };
		throw error;
	}
	try {
		const raw: unknown = JSON.parse(text);
		if (!isRecord(raw) || raw.version !== ENVELOPE_VERSION || !isRecord(raw.entries)) {
			logger.warn("Connector secrets file has an unsupported shape", { path: filePath });
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
		logger.warn("Connector secrets file is not valid JSON", {
			path: filePath,
			error: error instanceof Error ? error.message : String(error),
		});
		return { version: ENVELOPE_VERSION, entries: {} };
	}
}

async function writeFile(filePath: string, file: SecretsFile): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await writeFileAtomically(filePath, `${JSON.stringify(file, null, 2)}\n`);
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

/** Decrypt one connector's values. Undefined means "no usable secret". */
export async function readConnectorSecrets(
	id: string,
	agentDir: string = getAgentDir(),
): Promise<Record<string, string> | undefined> {
	const filePath = connectorSecretsPath(agentDir);
	const file = await readFile(filePath);
	const envelope = file.entries[id];
	if (!envelope) return undefined;
	try {
		const plain = decryptValue(envelope, deriveKey(await readOrCreateMasterKey(agentDir), id), id);
		const parsed: unknown = JSON.parse(plain);
		if (!isRecord(parsed)) return undefined;
		const values: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string" && value.length > 0) values[key] = value;
		}
		return Object.keys(values).length > 0 ? values : undefined;
	} catch (error) {
		logger.warn("Connector secret could not be decrypted; keeping the file untouched", {
			id,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Merge new values into one connector's secret. Empty strings keep the stored
 * value, which is what the Token form sends for an already-configured password.
 */
export async function mergeConnectorSecrets(
	id: string,
	values: Record<string, string>,
	agentDir: string = getAgentDir(),
): Promise<void> {
	const filePath = connectorSecretsPath(agentDir);
	await withLock(filePath, async () => {
		const previous = (await readConnectorSecrets(id, agentDir)) ?? {};
		const merged: Record<string, string> = { ...previous };
		for (const [key, value] of Object.entries(values)) {
			if (value.length === 0) continue;
			merged[key] = value;
		}
		const masterKey = await readOrCreateMasterKey(agentDir);
		const file = await readFile(filePath);
		file.entries[id] = encryptValue(JSON.stringify(merged), deriveKey(masterKey, id), id);
		await writeFile(filePath, file);
	});
}

/** Remove one connector's secret. */
export async function deleteConnectorSecrets(id: string, agentDir: string = getAgentDir()): Promise<void> {
	const filePath = connectorSecretsPath(agentDir);
	await withLock(filePath, async () => {
		const file = await readFile(filePath);
		if (!(id in file.entries)) return;
		delete file.entries[id];
		await writeFile(filePath, file);
	});
}

/** Whether every required field already has a stored value. */
export async function hasConnectorSecrets(
	id: string,
	requiredKeys: readonly string[],
	agentDir: string = getAgentDir(),
): Promise<boolean> {
	const values = await readConnectorSecrets(id, agentDir);
	if (!values) return requiredKeys.length === 0;
	return requiredKeys.every(key => (values[key]?.length ?? 0) > 0);
}
