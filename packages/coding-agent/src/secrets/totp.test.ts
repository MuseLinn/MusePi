import { describe, expect, it } from "bun:test";
import { parseTotpKey, totpCode } from "./totp";

/** RFC 6238 Appendix B, SHA-1, 8 digits, secret "12345678901234567890". */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const AT = (seconds: number): number => seconds * 1000;

describe("TOTP", () => {
	it("matches the RFC 6238 test vectors", () => {
		const key = parseTotpKey(`otpauth://totp/Acme:me?secret=${RFC_SECRET}&digits=8`);
		// The published values for these timestamps.
		expect(totpCode(key, AT(59))).toBe("94287082");
		expect(totpCode(key, AT(1111111109))).toBe("07081804");
		expect(totpCode(key, AT(1234567890))).toBe("89005924");
		expect(totpCode(key, AT(2000000000))).toBe("69279037");
	});

	it("produces a six-digit code by default, and the same one all window", () => {
		const key = parseTotpKey(RFC_SECRET);
		expect(key.digits).toBe(6);
		expect(key.period).toBe(30);
		const start = AT(1200);
		expect(totpCode(key, start)).toBe(totpCode(key, start + 29_999));
		// The next window rolls over.
		expect(totpCode(key, start)).not.toBe(totpCode(key, start + 30_000));
	});

	it("reads the algorithm, digits and period a setup link names", () => {
		const key = parseTotpKey(`otpauth://totp/Acme:me?secret=${RFC_SECRET}&algorithm=SHA256&digits=7&period=60`);
		expect(key).toMatchObject({ digits: 7, period: 60, algorithm: "sha256" });
	});

	it("refuses an invalid setup key instead of producing a wrong code", () => {
		// `1` and `0` are not in the base32 alphabet.
		expect(() => parseTotpKey("not-a-key!!")).toThrow(/A-Z and digits 2-7/);
		expect(() => parseTotpKey("otpauth://hotp/Acme:me?secret=GEZDGNBV")).toThrow(/time-based/);
		expect(() => parseTotpKey("otpauth://totp/Acme:me")).toThrow(/no secret/);
	});
});
