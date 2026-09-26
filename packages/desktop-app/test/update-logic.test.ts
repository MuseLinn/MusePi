import { describe, expect, test } from "bun:test";
// update-logic.cjs lives outside tsconfig include (electron/) and has no
// types — same convention as the daemon.cjs test imports.
import {
	classifyUpdateError,
	isNetworkError,
	nextPollDelayMs,
	UPDATE_POLL_BASE_MS,
	UPDATE_POLL_JITTER,
	UPDATE_POLL_MAX_MS,
	// @ts-expect-error — untyped CJS module (electron/, outside tsconfig include)
} from "../electron/update-logic.cjs";

/**
 * Updater pure-logic contracts:
 *
 *  - classifyUpdateError: every raw updater failure maps to a stable
 *    semantic kind ({check|download|install} × {network|other}) — the UI
 *    copy keys off the kind, so an unstable enum would ship raw English
 *    diagnostics as the user-facing message.
 *  - nextPollDelayMs: failure ×2 backoff capped at 6h with ±20% jitter —
 *    a wrong cap or missing jitter would hammer a flapping feed forever or
 *    schedule checks at deterministic, thundering-herd times.
 */
describe("classifyUpdateError", () => {
	test("maps each operation to its base kind on a non-network error", () => {
		for (const op of ["check", "download", "install"] as const) {
			const out = classifyUpdateError(op, new Error("something exploded"));
			expect(out.kind).toBe(op);
			expect(out.message).toBe("something exploded");
		}
	});

	test("tags socket-level codes as network failures for each operation", () => {
		for (const op of ["check", "download", "install"] as const) {
			// electron-updater flattens Chromium/Node socket codes into the
			// message text (no err.code) — the classifier must read it.
			const out = classifyUpdateError(op, new Error("Request failed: ETIMEDOUT"));
			expect(out.kind).toBe(`${op}-network`);
		}
		expect(classifyUpdateError("download", new Error("getaddrinfo ENOTFOUND github.com")).kind).toBe(
			"download-network",
		);
		expect(classifyUpdateError("check", new Error("fetch failed")).kind).toBe("check-network");
	});

	test("carries the raw message as technicalDetails only for Error inputs", () => {
		const err = new Error("signature verification failed");
		const out = classifyUpdateError("install", err);
		expect(out.technicalDetails).toContain("signature verification failed");
		// A bare string failure has no stack to fold in.
		expect(classifyUpdateError("check", "404 not found").technicalDetails).toBeUndefined();
	});

	test("falls back to the check operation for an unknown op and survives junk errors", () => {
		expect(classifyUpdateError("bogus" as "check", new Error("x")).kind).toBe("check");
		expect(classifyUpdateError("check", undefined).message.length).toBeGreaterThan(0);
	});
});

describe("isNetworkError", () => {
	test("matches common socket codes and connection wording", () => {
		for (const msg of [
			"ERR_CONNECTION_RESET",
			"ECONNREFUSED 127.0.0.1:443",
			"network changed mid-download",
			"socket hang up",
			"Request timed out after 30000ms",
		]) {
			expect(isNetworkError(msg)).toBe(true);
		}
	});

	test("does not tag local validation failures as network", () => {
		expect(isNetworkError("signature verification failed")).toBe(false);
		expect(isNetworkError("")).toBe(false);
	});
});

describe("nextPollDelayMs", () => {
	const BASE = UPDATE_POLL_BASE_MS;
	const MAX = UPDATE_POLL_MAX_MS;

	test("success (0 failures) schedules the base interval, jittered ±20%", () => {
		expect(nextPollDelayMs(0, { random: () => 0 })).toBe(Math.round(BASE * (1 - UPDATE_POLL_JITTER)));
		expect(nextPollDelayMs(0, { random: () => 1 })).toBe(Math.round(BASE * (1 + UPDATE_POLL_JITTER)));
		expect(nextPollDelayMs(0, { random: () => 0.5 })).toBe(BASE);
	});

	test("consecutive failures double the delay up to the 6h cap", () => {
		const mid = (f: number): number => nextPollDelayMs(f, { random: () => 0.5 });
		expect(mid(1)).toBe(BASE * 2);
		expect(mid(2)).toBe(BASE * 4);
		// 8h would exceed the 6h cap: the delay clamps to 6h and the positive
		// jitter side clamps to the cap too (dsh schedule parity), so mid sits
		// at 0.9 × 6h.
		expect(mid(3)).toBe(Math.round(MAX * 0.9));
		expect(mid(4)).toBe(Math.round(MAX * 0.9));
		expect(mid(9)).toBe(Math.round(MAX * 0.9));
	});

	test("jitter stays inside ±20% and never exceeds the cap upward", () => {
		for (let failures = 1; failures <= 6; failures++) {
			const low = nextPollDelayMs(failures, { random: () => 0 });
			const high = nextPollDelayMs(failures, { random: () => 1 });
			const delay = Math.min(MAX, BASE * 2 ** failures);
			expect(low).toBe(Math.round(delay * (1 - UPDATE_POLL_JITTER)));
			expect(high).toBeLessThanOrEqual(MAX);
		}
	});

	test("rejects negative garbage failure counts back to the base interval", () => {
		expect(nextPollDelayMs(-3, { random: () => 0.5 })).toBe(BASE);
	});
});
