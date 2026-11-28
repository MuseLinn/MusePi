/**
 * One-time codes for a saved login's 2FA.
 *
 * The store keeps the setup key (an `otpauth://` URI or a bare base32 secret)
 * inside the login's encrypted envelope. The code is computed here and typed
 * into the page; it is never returned to the agent.
 *
 * RFC 6238: HMAC over the 30-second counter, SHA-1 by default, six digits, and
 * the last used counter is not tracked — a code is valid for its window, and
 * a login form accepts the same code once.
 */

import { createHmac } from "node:crypto";

const DEFAULT_PERIOD = 30;
const DEFAULT_DIGITS = 6;

function base32Decode(secret: string): Buffer {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const clean = secret.toUpperCase().replace(/[\s=-]/g, "");
	if (clean.length === 0) return Buffer.alloc(0);
	const bytes: number[] = [];
	let bits = 0;
	let value = 0;
	for (const char of clean) {
		const index = alphabet.indexOf(char);
		if (index < 0) throw new Error("A 2FA setup key uses letters A-Z and digits 2-7");
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(bytes);
}

export interface TotpKey {
	secret: Buffer;
	digits: number;
	period: number;
	algorithm: "sha1" | "sha256" | "sha512";
}

/** Parse an `otpauth://totp/...` URI or a bare base32 setup key. */
export function parseTotpKey(raw: string): TotpKey {
	const text = raw.trim();
	if (text.toLowerCase().startsWith("otpauth://")) {
		const url = new URL(text);
		if (url.host.toLowerCase() !== "totp") {
			throw new Error("Only time-based (TOTP) setup keys are supported");
		}
		const secret = url.searchParams.get("secret");
		if (!secret) throw new Error("The 2FA setup link has no secret");
		const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
		const digits = Number(url.searchParams.get("digits") ?? DEFAULT_DIGITS);
		const period = Number(url.searchParams.get("period") ?? DEFAULT_PERIOD);
		return {
			secret: base32Decode(secret),
			digits: Number.isInteger(digits) && digits >= 6 && digits <= 8 ? digits : DEFAULT_DIGITS,
			period: Number.isFinite(period) && period > 0 ? period : DEFAULT_PERIOD,
			algorithm: algorithm === "sha256" ? "sha256" : algorithm === "sha512" ? "sha512" : "sha1",
		};
	}
	return { secret: base32Decode(text), digits: DEFAULT_DIGITS, period: DEFAULT_PERIOD, algorithm: "sha1" };
}

/** The code for `at` (epoch ms), padded to the key's digit count. */
export function totpCode(key: TotpKey, at: number = Date.now()): string {
	const counter = Math.floor(at / 1000 / key.period);
	const buffer = Buffer.alloc(8);
	buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
	buffer.writeUInt32BE(counter % 2 ** 32, 4);
	const digest = createHmac(key.algorithm, key.secret).update(buffer).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const binary =
		((digest[offset] & 0x7f) << 24) |
		((digest[offset + 1] & 0xff) << 16) |
		((digest[offset + 2] & 0xff) << 8) |
		(digest[offset + 3] & 0xff);
	return String(binary % 10 ** key.digits).padStart(key.digits, "0");
}
