/**
 * At-rest encryption for MCP OAuth credentials.
 *
 * Scope is deliberate: only providers owned by the MCP client (`mcp_oauth:` /
 * legacy `mcp_oauth_`) are encrypted here. Other provider credentials keep the
 * existing storage shape until their own migration is designed, so this change
 * cannot corrupt a shared credential row.
 *
 * The `data` column keeps a stable marker plus a SHA-256 of the plaintext, so
 * the compare-and-swap update paths still detect concurrent refreshes. The
 * ciphertext lives in the `secret` column. The key sits beside the database
 * (`mcp-oauth.key`), which keeps test databases isolated, and can be supplied
 * by `MUSEPI_MCP_OAUTH_KEY` for managed deployments.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@musepi/pi-utils";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ENV = "MUSEPI_MCP_OAUTH_KEY";
const MARKER_PREFIX = "enc:v1:";

export interface McpOAuthCipher {
	/** Stable marker + hash used in the `data` column. */
	marker(plaintext: string): string;
	/** AES-256-GCM envelope for the `secret` column. */
	encrypt(provider: string, plaintext: string): string;
	/** Undefined means "cannot decrypt"; the row must be treated as unusable. */
	decrypt(provider: string, envelope: string): string | undefined;
}

export function isMcpOAuthProvider(provider: string): boolean {
	return provider.startsWith("mcp_oauth:") || provider.startsWith("mcp_oauth_");
}

export function isEncryptedCredentialData(data: string): boolean {
	return data.startsWith(MARKER_PREFIX);
}

function readKeyFromEnv(): Buffer | undefined {
	const raw = process.env[KEY_ENV]?.trim();
	if (!raw) return undefined;
	const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
	if (decoded.length !== KEY_BYTES) {
		logger.warn(`${KEY_ENV} must decode to ${KEY_BYTES} bytes; ignoring it`);
		return undefined;
	}
	return decoded;
}

function readOrCreateKey(keyPath: string): Buffer {
	const override = readKeyFromEnv();
	if (override) return override;
	try {
		const existing = fs.readFileSync(keyPath);
		if (existing.length === KEY_BYTES) return existing;
		throw new Error(`MCP OAuth key at ${keyPath} has the wrong length`);
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") throw error;
	}
	fs.mkdirSync(path.dirname(keyPath), { recursive: true });
	const key = randomBytes(KEY_BYTES);
	try {
		const fd = fs.openSync(keyPath, "wx", 0o600);
		try {
			fs.writeFileSync(fd, key);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.chmodSync(keyPath, 0o600);
		return key;
	} catch (error) {
		if ((error as { code?: unknown }).code !== "EEXIST") throw error;
		const existing = fs.readFileSync(keyPath);
		if (existing.length === KEY_BYTES) return existing;
		throw new Error(`MCP OAuth key at ${keyPath} has the wrong length`);
	}
}

function encryptValue(value: string, key: Buffer, provider: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(`mcp-oauth|${provider}`, "utf8"));
	const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	return JSON.stringify({
		v: 1,
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		ct: ct.toString("base64"),
	});
}

function decryptValue(envelope: string, key: Buffer, provider: string): string {
	const parsed: unknown = JSON.parse(envelope);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as { v?: unknown }).v !== 1 ||
		typeof (parsed as { iv?: unknown }).iv !== "string" ||
		typeof (parsed as { tag?: unknown }).tag !== "string" ||
		typeof (parsed as { ct?: unknown }).ct !== "string"
	) {
		throw new Error("invalid MCP OAuth secret envelope");
	}
	const iv = Buffer.from((parsed as { iv: string }).iv, "base64");
	const tag = Buffer.from((parsed as { tag: string }).tag, "base64");
	const ct = Buffer.from((parsed as { ct: string }).ct, "base64");
	if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("invalid MCP OAuth secret envelope");
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAAD(Buffer.from(`mcp-oauth|${provider}`, "utf8"));
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function createMcpOAuthCipher(keyPath: string): McpOAuthCipher {
	let cachedKey: Buffer | undefined;
	const key = (): Buffer => (cachedKey ??= readOrCreateKey(keyPath));
	return {
		marker(plaintext: string): string {
			return `${MARKER_PREFIX}${createHash("sha256").update(plaintext).digest("hex")}`;
		},
		encrypt(provider: string, plaintext: string): string {
			return encryptValue(plaintext, key(), provider);
		},
		decrypt(provider: string, envelope: string): string | undefined {
			try {
				return decryptValue(envelope, key(), provider);
			} catch (error) {
				logger.warn("MCP OAuth credential could not be decrypted", {
					error: error instanceof Error ? error.message : String(error),
				});
				return undefined;
			}
		},
	};
}

/** Key file beside the database, or null for an in-memory database. */
export function mcpOAuthKeyPathForDatabase(db: { filename?: string }): string | null {
	const filename = db.filename;
	if (!filename || filename === ":memory:") return null;
	return path.join(path.dirname(filename), "mcp-oauth.key");
}
