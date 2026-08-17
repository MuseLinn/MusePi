/**
 * Golden-vector compatibility tests for the collab wire formats.
 *
 * Guarantee: old guests connecting to new hosts (and vice versa) keep working
 * byte-for-byte. These pin the three formats:
 *
 * 1. `link` — deterministic: fixed inputs must produce identical bytes.
 * 2. `envelope` — deterministic: fixed inputs must produce identical bytes.
 * 3. `seal` — AES-GCM with a fresh random IV per call, so byte-identity is
 *    impossible; instead we pin the STRUCTURE (IV prefix + tag tail, total
 *    length for a known plaintext) and round-trip decrypt.
 *
 * Any future format drift (version bytes, header reorder, key-size change)
 * fails these tests.
 */
import { describe, expect, it } from "bun:test";
import {
	decodeBase64Url,
	encodeBase64Url,
	formatCollabLink,
	generateRoomId,
	importRoomKey,
	normalizeRelayOrigin,
	open,
	packEnvelope,
	parseCollabLink,
	seal,
	unpackEnvelope,
} from "../src/index.ts";

// ── link: deterministic golden ──────────────────────────────────────────────

const KEY32 = new Uint8Array(32);
for (let i = 0; i < 32; i++) KEY32[i] = i + 1; // 01..20
const TOKEN16 = new Uint8Array(16);
for (let i = 0; i < 16; i++) TOKEN16[i] = 0x41 + i; // A..P

describe("link format golden vectors", () => {
	it("view link on default relay collapses to <roomId>.<key>", () => {
		const link = formatCollabLink("wss://my.omp.sh", "abcdefghij0123456789", KEY32);
		expect(link).toBe("abcdefghij0123456789.AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA");
	});

	it("full link appends write token", () => {
		const link = formatCollabLink("wss://my.omp.sh", "abcdefghij0123456789", KEY32, TOKEN16);
		expect(link).toBe("abcdefghij0123456789.AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyBBQkNERUZHSElKS0xNTk9Q");
	});

	it("non-default wss relay drops the scheme", () => {
		const link = formatCollabLink("wss://relay.example.com:8443", "abcdefghij0123456789", KEY32);
		expect(link).toBe("relay.example.com:8443/r/abcdefghij0123456789.AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA");
	});

	it("parseCollabLink round-trips every accepted form", () => {
		const full = formatCollabLink("wss://my.omp.sh", "abcdefghij0123456789", KEY32, TOKEN16);
		const parsed = parseCollabLink(full);
		expect("error" in parsed).toBe(false);
		if ("error" in parsed) return;
		expect(parsed.roomId).toBe("abcdefghij0123456789");
		expect(parsed.wsUrl).toBe("wss://my.omp.sh/r/abcdefghij0123456789");
		expect(encodeBase64Url(parsed.key)).toBe(encodeBase64Url(KEY32));
		expect(parsed.writeToken && encodeBase64Url(parsed.writeToken)).toBe(encodeBase64Url(TOKEN16));

		// scheme-less host form
		const schemeLess = parseCollabLink(
			"relay.example.com/r/abcdefghij0123456789.AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
		);
		expect("error" in schemeLess).toBe(false);

		// legacy # form
		const legacy = parseCollabLink(
			"wss://relay.example.com/r/abcdefghij0123456789#AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
		);
		expect("error" in legacy).toBe(false);
	});

	it("rejects short keys", () => {
		const parsed = parseCollabLink("abcdefghij0123456789.AQID");
		expect("error" in parsed).toBe(true);
	});
});

// ── envelope: deterministic golden ──────────────────────────────────────────

describe("envelope golden vectors", () => {
	it("packs [4B BE peerId][payload]", () => {
		const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const packed = packEnvelope(0x0000002a, payload);
		expect([...packed]).toEqual([0x00, 0x00, 0x00, 0x2a, 0xde, 0xad, 0xbe, 0xef]);
	});

	it("unpacks what packEnvelope produced and rejects truncation", () => {
		const packed = packEnvelope(7, new Uint8Array([1, 2, 3]));
		const unpacked = unpackEnvelope(packed);
		expect(unpacked?.peerId).toBe(7);
		expect([...(unpacked?.payload ?? [])]).toEqual([1, 2, 3]);
		expect(unpackEnvelope(new Uint8Array([0, 0]))).toBeNull();
	});
});

// ── seal: structural golden + round-trip ────────────────────────────────────

describe("seal structural format", () => {
	const FRAME = { t: "welcome", proto: 1, hello: "世界" } as const;

	it("produces [12B IV][ciphertext+tag] and round-trips", async () => {
		const key = await importRoomKey(KEY32);
		const sealed = await seal(key, FRAME);
		expect(sealed.byteLength).toBe(12 + 42 + 16); // 12 IV + 42B UTF-8 plaintext + 16B tag
		const opened = await open<typeof FRAME>(key, sealed);
		expect(opened).toEqual(FRAME);
	});

	it("two seals of the same frame differ (fresh IV) but both open", async () => {
		const key = await importRoomKey(KEY32);
		const a = await seal(key, FRAME);
		const b = await seal(key, FRAME);
		expect([...a.subarray(0, 12)]).not.toEqual([...b.subarray(0, 12)]);
		expect(a.byteLength).toBe(b.byteLength);
		expect(await open<typeof FRAME>(key, a)).toEqual(FRAME);
		expect(await open<typeof FRAME>(key, b)).toEqual(FRAME);
	});

	it("fails on tampered ciphertext", async () => {
		const key = await importRoomKey(KEY32);
		const sealed = await seal(key, FRAME);
		sealed[sealed.byteLength - 1]! ^= 0xff;
		await expect(open<typeof FRAME>(key, sealed)).rejects.toThrow();
	});
});

// ── base64url + room id ─────────────────────────────────────────────────────

describe("base64url helpers", () => {
	it("round-trips arbitrary bytes", () => {
		const bytes = new Uint8Array([0x00, 0xfb, 0xff, 0x80, 0x3e]);
		expect([...decodeBase64Url(encodeBase64Url(bytes))!]).toEqual([...bytes]);
	});

	it("generateRoomId is 10+ chars base64url", () => {
		const id = generateRoomId();
		expect(id.length).toBeGreaterThanOrEqual(10);
		expect(/^[A-Za-z0-9_-]+$/.test(id)).toBe(true);
	});
});

// ── relay origin allowlist: plaintext ws to private hosts only ─────────────

describe("normalizeRelayOrigin plaintext policy", () => {
	it("allows ws:// to localhost", () => {
		const r = normalizeRelayOrigin("ws://localhost:7654");
		expect("error" in r ? r.error : r.origin).toBe("ws://localhost:7654");
	});

	it("allows ws:// to private IPv4 (LAN shares)", () => {
		for (const host of ["192.168.1.5", "10.0.0.8", "172.16.5.9", "172.31.255.1", "169.254.10.10"]) {
			const r = normalizeRelayOrigin(`ws://${host}:7654`);
			expect("error" in r ? r.error : r.origin).toBe(`ws://${host}:7654`);
		}
	});

	it("rejects ws:// to public hosts", () => {
		for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "192.169.0.1"]) {
			const r = normalizeRelayOrigin(`ws://${host}`);
			expect("error" in r ? r.error : null).toContain("wss");
		}
	});

	it("formats and parses a LAN share link round-trip", () => {
		const key = new Uint8Array(32).fill(7);
		const link = formatCollabLink("ws://192.168.1.5:7654", "roomid123456", key);
		expect(link).toMatch(/^ws:\/\/192\.168\.1\.5:7654\/r\/roomid123456\.[A-Za-z0-9_-]+$/);
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe("ws://192.168.1.5:7654/r/roomid123456");
	});
});
