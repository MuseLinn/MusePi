/**
 * Encrypted-at-rest credential backend.
 *
 * Stores plugin credentials as a single AES-256-GCM ciphertext blob keyed by
 * a PBKDF2 derivation over an OS-native stable machine identifier. Zero npm
 * dependencies — Node `crypto` plus `os`/`fs` only, so the credential file
 * keeps working in Tauri / Electron / Bun-as-runtime environments that don't
 * always ship system keychain bindings.
 *
 * File format (all multi-byte integers are little-endian):
 *   [Header — 64 bytes]
 *   ├── Magic:    "MUSPI01\0"      (8 bytes)
 *   ├── Flags:    uint32 LE         (4 bytes, reserved; must be 0)
 *   ├── Salt:     32 bytes         (PBKDF2 salt, persistent across rewrites)
 *   ├── Reserved: 20 bytes         (zero-padded)
 *   [Encrypted Payload]
 *   ├── IV:        12 bytes        (random per write; GCM forbids reuse)
 *   ├── AuthTag:   16 bytes        (GCM authentication tag)
 *   └── Ciphertext: variable       (JSON-serialized credential store)
 *
 * Machine fingerprint sources (stable across reboots / network changes):
 *   - macOS:   IOPlatformUUID (logic board UUID; `ioreg -rd1 -c IOPlatformExpertDevice`)
 *   - Windows: HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid (set at OS install)
 *   - Linux:   /var/lib/dbus/machine-id, fallback /etc/machine-id
 *   - Fallback: <username>:<homedir> (stable enough; only triggers on
 *              sandboxed CI runners that block the platform commands above).
 *
 * Corruption policy: header magic mismatch, short file, or decrypt failure
 * deletes the file rather than trapping the user behind an undecryptable
 * blob. The next call rewrites it with a fresh salt; users will need to
 * re-authenticate plugins, but the agent never wedges.
 */

import { execSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
	accountToPluginCredentialId,
	type PluginCredentialId,
	pluginCredentialIdToAccount,
	type StoredPluginCredential,
} from "../types.ts";
import type { PluginCredentialBackend, PluginCredentialHealthStatus } from "./types.ts";

const MAGIC_BYTES = Buffer.from("MUSPI01\0");
const HEADER_SIZE = 64;
const MAGIC_SIZE = 8;
const FLAGS_SIZE = 4;
const SALT_SIZE = 32;
const IV_SIZE = 12;
const AUTH_TAG_SIZE = 16;
const KEY_SIZE = 32;
const PBKDF2_ITERATIONS = 100_000;
const KEY_DERIVATION_TAG = "musepi-plugin-credentials-v1";

interface CredentialStoreShape {
	version: 1;
	credentials: Record<string, StoredPluginCredential>;
	metadata: { createdAt: number; updatedAt: number };
}

export interface SecureStorageOptions {
	/** Override the credentials file path. Defaults to `~/.musepi/plugin-credentials.enc`. */
	filePath?: string;
	/** Override the directory the file lives in. Defaults to `~/.musepi`. */
	directory?: string;
}

/**
 * Encrypted-file backend. Default priority 100 — wins on tie because it can
 * survive process restarts and works without external services.
 */
export class SecureStorageBackend implements PluginCredentialBackend {
	readonly name = "secure-storage";
	readonly priority = 100;

	private readonly filePath: string;
	private readonly directory: string;
	private cachedStore: CredentialStoreShape | null = null;
	private encryptionKey: Buffer | null = null;
	private salt: Buffer | null = null;

	constructor(options: SecureStorageOptions = {}) {
		this.directory = options.directory ?? join(homedir(), ".musepi");
		this.filePath = options.filePath ?? join(this.directory, "plugin-credentials.enc");
	}

	async isAvailable(): Promise<boolean> {
		// Always available — `set` recreates the directory on demand. Read-only
		// mounts surface at write-time and degrade to the in-memory backend via
		// the manager's selection logic.
		return true;
	}

	async get(id: PluginCredentialId): Promise<StoredPluginCredential | null> {
		const store = await this.loadStore();
		if (!store) return null;
		const key = pluginCredentialIdToAccount(id);
		return store.credentials[key] ?? null;
	}

	async set(id: PluginCredentialId, credential: StoredPluginCredential): Promise<void> {
		let store = await this.loadStore();
		if (!store) {
			store = {
				version: 1,
				credentials: {},
				metadata: { createdAt: Date.now(), updatedAt: Date.now() },
			};
		}
		const key = pluginCredentialIdToAccount(id);
		store.credentials[key] = credential;
		store.metadata.updatedAt = Date.now();
		this.saveStoreSync(store);
	}

	async delete(id: PluginCredentialId): Promise<boolean> {
		const store = this.loadStoreSync();
		if (!store) return false;
		const key = pluginCredentialIdToAccount(id);
		if (!(key in store.credentials)) return false;
		delete store.credentials[key];
		store.metadata.updatedAt = Date.now();
		this.saveStoreSync(store);
		return true;
	}

	async list(filter?: Partial<PluginCredentialId>): Promise<PluginCredentialId[]> {
		const store = await this.loadStore();
		if (!store) return [];
		const ids = Object.keys(store.credentials)
			.map(accountToPluginCredentialId)
			.filter((id): id is PluginCredentialId => id !== null);
		if (!filter) return ids;
		return ids.filter(id => {
			if (filter.pluginId && id.pluginId !== filter.pluginId) return false;
			if (filter.scope !== undefined && id.scope !== filter.scope) return false;
			if (filter.name !== undefined && id.name !== filter.name) return false;
			return true;
		});
	}

	/** Verify the file decrypts cleanly; surfaces corruption before plugins depend on it. */
	async health(): Promise<PluginCredentialHealthStatus> {
		if (!existsSync(this.filePath)) return { healthy: true, issues: [] };
		const data = readFileSync(this.filePath);
		if (data.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) {
			return {
				healthy: false,
				issues: [
					{
						type: "file_corrupted",
						message: `Credential file is truncated (< ${HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE} bytes). Will be re-initialized on next set.`,
					},
				],
			};
		}
		if (!data.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) {
			return {
				healthy: false,
				issues: [
					{
						type: "file_corrupted",
						message: `Credential file magic mismatch. Will be re-initialized on next set.`,
					},
				],
			};
		}
		const salt = data.subarray(MAGIC_SIZE + FLAGS_SIZE, MAGIC_SIZE + FLAGS_SIZE + SALT_SIZE);
		const encrypted = data.subarray(HEADER_SIZE);
		try {
			const key = this.deriveKey(salt);
			const iv = encrypted.subarray(0, IV_SIZE);
			const tag = encrypted.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
			const ciphertext = encrypted.subarray(IV_SIZE + AUTH_TAG_SIZE);
			const decipher = createDecipheriv("aes-256-gcm", key, iv);
			decipher.setAuthTag(tag);
			Buffer.concat([decipher.update(ciphertext), decipher.final()]);
			return { healthy: true, issues: [] };
		} catch (err) {
			return {
				healthy: false,
				issues: [
					{
						type: "decryption_failed",
						message: `Credential file cannot be decrypted with this machine's fingerprint. Likely cause: filesystem copied to a new machine, or fingerprint derivation differs (e.g. macOS sandbox). File will be re-initialized on next set.`,
						error: err instanceof Error ? err.message : String(err),
					},
				],
			};
		}
	}

	/** Reset in-process caches; tests use this to force re-read after monkey-patching fs. */
	clearCache(): void {
		this.cachedStore = null;
		this.encryptionKey = null;
		this.salt = null;
	}

	private async loadStore(): Promise<CredentialStoreShape | null> {
		return this.loadStoreSync();
	}

	private loadStoreSync(): CredentialStoreShape | null {
		if (this.cachedStore) return this.cachedStore;
		if (!existsSync(this.filePath)) return null;
		let data: Buffer;
		try {
			data = readFileSync(this.filePath);
		} catch {
			return null;
		}
		if (data.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) {
			this.handleCorruptedFile();
			return null;
		}
		if (!data.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) {
			this.handleCorruptedFile();
			return null;
		}
		const salt = data.subarray(MAGIC_SIZE + FLAGS_SIZE, MAGIC_SIZE + FLAGS_SIZE + SALT_SIZE);
		this.salt = salt;
		const encrypted = data.subarray(HEADER_SIZE);
		try {
			const key = this.deriveKey(salt);
			const iv = encrypted.subarray(0, IV_SIZE);
			const tag = encrypted.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
			const ciphertext = encrypted.subarray(IV_SIZE + AUTH_TAG_SIZE);
			const decipher = createDecipheriv("aes-256-gcm", key, iv);
			decipher.setAuthTag(tag);
			const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
			const parsed = JSON.parse(plaintext.toString("utf8")) as CredentialStoreShape;
			this.cachedStore = parsed;
			return parsed;
		} catch {
			this.handleCorruptedFile();
			return null;
		}
	}

	private saveStoreSync(store: CredentialStoreShape): void {
		if (!existsSync(this.directory)) {
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		}
		const salt = this.salt ?? randomBytes(SALT_SIZE);
		this.salt = salt;
		const key = this.deriveKey(salt);
		const plaintext = Buffer.from(JSON.stringify(store), "utf8");
		const iv = randomBytes(IV_SIZE);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const tag = cipher.getAuthTag();

		const header = Buffer.alloc(HEADER_SIZE);
		MAGIC_BYTES.copy(header, 0);
		header.writeUInt32LE(0, MAGIC_SIZE);
		salt.copy(header, MAGIC_SIZE + FLAGS_SIZE);

		const fileData = Buffer.concat([header, iv, tag, ciphertext]);
		writeFileSync(this.filePath, fileData, { mode: 0o600 });
		this.cachedStore = store;
	}

	private deriveKey(salt: Buffer): Buffer {
		if (this.encryptionKey) return this.encryptionKey;
		const machineId = createHash("sha256").update(getStableMachineId()).update(KEY_DERIVATION_TAG).digest();
		this.encryptionKey = pbkdf2Sync(machineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, "sha256");
		return this.encryptionKey;
	}

	private handleCorruptedFile(): void {
		try {
			if (existsSync(this.filePath)) {
				unlinkSync(this.filePath);
			}
		} catch {
			// Best-effort: leave file in place on permission error so the user
			// can inspect or remove it manually.
		}
		this.cachedStore = null;
		this.encryptionKey = null;
		this.salt = null;
	}
}

/**
 * Stable OS-native machine identifier. Hostname-based derivation is
 * deliberately avoided — DHCP / VPN flips would orphan every stored
 * credential on the next boot.
 */
function getStableMachineId(): string {
	try {
		if (process.platform === "darwin") {
			const out = execSync("ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID", {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
			if (m?.[1]) return m[1];
		} else if (process.platform === "win32") {
			const out = execSync("reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid", {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
			if (m?.[1]) return m[1];
		} else {
			const candidates = ["/var/lib/dbus/machine-id", "/etc/machine-id"];
			for (const path of candidates) {
				if (existsSync(path)) return readFileSync(path, "utf-8").trim();
			}
		}
	} catch {
		// Platform command missing / blocked — fall through to the username-based fallback below.
	}
	return `${userInfo().username}:${homedir()}`;
}
