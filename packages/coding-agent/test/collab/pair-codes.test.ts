import { describe, expect, test } from "bun:test";
import { PAIR_CODE_TTL_MS, PairCodes } from "@musepi/pi-coding-agent/collab/pair-codes";

/**
 * Pair codes are the no-camera way into a LAN share: the desktop shows six
 * digits, the phone trades them for the share's link. The dialog renders those
 * digits on screen, so the security of the flow rests on two properties that a
 * refactor could quietly drop — each is a named failure mode below.
 */
describe("PairCodes", () => {
	test("a code resolves once and is then dead", () => {
		const codes = new PairCodes();
		const link = "https://192.168.1.5:7655/#wss://192.168.1.5:7655/r/room.key";
		const { code } = codes.mint(link);

		expect(codes.spend(code)).toBe(link);
		// Replay must fail: anyone who photographed the screen could otherwise
		// keep reconnecting with the same digits for the rest of the TTL.
		expect(codes.spend(code)).toBe(null);
	});

	test("an expired code never resolves", () => {
		const codes = new PairCodes();
		const mintedAt = 1_000_000;
		const { code } = codes.mint("https://host/#link", mintedAt);

		expect(codes.spend(code, mintedAt + PAIR_CODE_TTL_MS - 1)).toBe("https://host/#link");
	});

	test("spending after the TTL is refused", () => {
		const codes = new PairCodes();
		const mintedAt = 1_000_000;
		const { code } = codes.mint("https://host/#link", mintedAt);

		expect(codes.spend(code, mintedAt + PAIR_CODE_TTL_MS + 1)).toBe(null);
	});

	test("minting prunes codes that expired unused", () => {
		const codes = new PairCodes();
		const mintedAt = 1_000_000;
		codes.mint("https://old/#link", mintedAt);
		expect(codes.size).toBe(1);

		codes.mint("https://new/#link", mintedAt + PAIR_CODE_TTL_MS + 1);
		// The stale code is gone, so only the fresh one is live.
		expect(codes.size).toBe(1);
	});

	test("codes are distinct while several are live", () => {
		const codes = new PairCodes();
		const seen = new Set<string>();
		for (let i = 0; i < 20; i++) seen.add(codes.mint("https://host/#link").code);

		expect(seen.size).toBe(20);
		expect(codes.size).toBe(20);
	});

	test("clear() forgets every code — a stopped share has nothing to resolve to", () => {
		const codes = new PairCodes();
		const { code } = codes.mint("https://host/#link");

		codes.clear();

		expect(codes.spend(code)).toBe(null);
		expect(codes.size).toBe(0);
	});

	test("unknown codes resolve to null rather than throwing", () => {
		expect(new PairCodes().spend("000000")).toBe(null);
	});
});
