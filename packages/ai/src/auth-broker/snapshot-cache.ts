/**
 * AES-256-GCM encrypted local cache for auth-broker snapshots.
 */

import { randomBytes, webcrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { SnapshotResponse } from "./types.ts";

const subtle = webcrypto.subtle;

const MAGIC = new Uint8Array([0x4d, 0x55, 0x53, 0x50]);
const VERSION = 1;
const HEADER_LENGTH = 17;
const IV_LENGTH = 12;
const AES_KEY_LENGTH = 256;

export interface ReadCacheOptions {
	path: string;
	token: string;
	url: string;
	ttlMs: number;
	now?: () => number;
}

export async function readAuthBrokerSnapshotCache(opts: ReadCacheOptions): Promise<SnapshotResponse | null> {
	if (opts.ttlMs <= 0) return null;

	let data: Buffer;
	try {
		data = readFileSync(opts.path);
	} catch {
		return null;
	}

	if (data.byteLength < HEADER_LENGTH) return null;
	for (let i = 0; i < MAGIC.byteLength; i++) {
		if (data[i] !== MAGIC[i]) return null;
	}
	if (data[4] !== VERSION) return null;

	const iv = data.subarray(5, 17);
	const ciphertext = data.subarray(HEADER_LENGTH);

	const plaintext = await decrypt(ciphertext, opts.token, opts.url, iv);
	if (plaintext === null) return null;

	try {
		const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as SnapshotResponse;
		const now = opts.now?.() ?? Date.now();
		if (now - parsed.generatedAt > opts.ttlMs) return null;
		return parsed;
	} catch {
		return null;
	}
}

export interface WriteCacheOptions {
	path: string;
	token: string;
	url: string;
}

export async function writeAuthBrokerSnapshotCache(snapshot: SnapshotResponse, opts: WriteCacheOptions): Promise<void> {
	try {
		const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
		const iv = randomBytes(IV_LENGTH);
		const ciphertext = await encrypt(plaintext, opts.token, opts.url, iv);
		const buf = Buffer.alloc(HEADER_LENGTH + ciphertext.byteLength);
		buf.set(MAGIC, 0);
		buf[4] = VERSION;
		buf.set(iv, 5);
		buf.set(new Uint8Array(ciphertext), HEADER_LENGTH);

		const dir = path.dirname(opts.path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}

		const tmp = `${opts.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		writeFileSync(tmp, buf, { mode: 0o600 });
		try {
			unlinkSync(opts.path);
		} catch {
			/* ok */
		}
		renameSync(tmp, opts.path);
	} catch {
		// best-effort
	}
}

// ─── Crypto helpers ─────────────────────────────────────────────────────────

async function deriveKey(token: string, usage: ("encrypt" | "decrypt")[]): Promise<webcrypto.CryptoKey> {
	const hash = await subtle.digest("SHA-256", new TextEncoder().encode(token));
	return subtle.importKey("raw", hash, { name: "AES-GCM", length: AES_KEY_LENGTH }, false, usage);
}

async function encrypt(plaintext: Uint8Array, token: string, url: string, iv: Uint8Array): Promise<ArrayBuffer> {
	const key = await deriveKey(token, ["encrypt"]);
	const aad = new TextEncoder().encode(url);
	return subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, plaintext);
}

async function decrypt(
	ciphertext: Uint8Array,
	token: string,
	url: string,
	iv: Uint8Array,
): Promise<ArrayBuffer | null> {
	try {
		const key = await deriveKey(token, ["decrypt"]);
		const aad = new TextEncoder().encode(url);
		return subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, ciphertext);
	} catch {
		return null;
	}
}
