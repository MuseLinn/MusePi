/**
 * AES-256-GCM sealing for collab frames. Browser-safe: WebCrypto only, no
 * Buffer, no Node globals. Works identically in Bun, Node ≥22 and browsers.
 *
 * The room key lives only in the link fragment; the relay sees opaque bytes.
 * Sealed layout: `[12B IV][ciphertext+tag]` (tag is appended by AES-GCM).
 *
 * Frames are generic: hosts seal their rich `CollabFrame`, guests seal the
 * wire `GuestFrame`. The relay only ever sees the opaque envelope.
 */
import { ROOM_KEY_BYTES, WRITE_TOKEN_BYTES } from "@musepi/pi-wire";

const AES_ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Random 32-byte room key. */
export function generateRoomKey(): Uint8Array {
	const key = new Uint8Array(ROOM_KEY_BYTES);
	crypto.getRandomValues(key);
	return key;
}

/** Random write token (write-capable links append it to the key). */
export function generateWriteToken(): Uint8Array {
	const token = new Uint8Array(WRITE_TOKEN_BYTES);
	crypto.getRandomValues(token);
	return token;
}

/** Import a raw room key for AES-GCM. Rejects wrong-length keys. */
export function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.byteLength !== ROOM_KEY_BYTES) {
		throw new Error(`Room key must be ${ROOM_KEY_BYTES} bytes, got ${raw.byteLength}`);
	}
	return crypto.subtle.importKey("raw", asStrict(raw), AES_ALGORITHM, false, ["encrypt", "decrypt"]);
}

/** Seal a frame: `[12B random IV][AES-GCM ciphertext+tag]`. Fresh IV per call. */
export async function seal<T>(key: CryptoKey, frame: T): Promise<Uint8Array> {
	const iv = new Uint8Array(IV_LENGTH);
	crypto.getRandomValues(iv);
	const plaintext = TEXT_ENCODER.encode(JSON.stringify(frame));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, plaintext));
	const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	out.set(iv, 0);
	out.set(ciphertext, IV_LENGTH);
	return out;
}

/** Inverse of {@link seal}. Throws on auth failure or malformed input. */
export async function open<T>(key: CryptoKey, data: Uint8Array): Promise<T> {
	if (data.byteLength <= IV_LENGTH) {
		throw new Error("Sealed frame too short");
	}
	const iv = asStrict(data.subarray(0, IV_LENGTH));
	const ciphertext = asStrict(data.subarray(IV_LENGTH));
	const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: AES_ALGORITHM, iv }, key, ciphertext));
	return JSON.parse(TEXT_DECODER.decode(plaintext)) as T;
}

function asStrict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes as Uint8Array<ArrayBuffer>;
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}
