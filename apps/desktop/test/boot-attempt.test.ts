import { describe, expect, test } from "bun:test";
import { runBootAttempt } from "../src/lib/connection/boot-attempt";

/**
 * The boot invariant: every exit from an attempt records success or failure.
 *
 * A launch that never connected must never leave the gate deriving
 * `disconnected-by-user` — that is the round-2 defect (a throw escaped past the
 * settle call), and the reason this wrapper exists. These cases pin the three
 * ways an attempt can end, including the one that used to record nothing.
 */

const fallback = { at: "ws://127.0.0.1:8300", reason: "无法连接本地守护进程" };

describe("boot attempt settles exactly once", () => {
	test("a success is recorded with no reason", async () => {
		const outcome = await runBootAttempt(async settle => {
			settle(true, "ws://127.0.0.1:9411");
		}, fallback);
		expect(outcome).toEqual({ ok: true, at: "ws://127.0.0.1:9411", reason: null, threw: false });
	});

	test("a failure keeps the reason it was given", async () => {
		const outcome = await runBootAttempt(async settle => {
			settle(false, "ws://127.0.0.1:9411", "ECONNREFUSED");
		}, fallback);
		expect(outcome).toEqual({ ok: false, at: "ws://127.0.0.1:9411", reason: "ECONNREFUSED", threw: false });
	});

	test("a failure with no reason falls back to a sentence, never a sentinel", async () => {
		// The ordinary cold start: a closed port short-circuits before connect(),
		// so no error was captured. The row must show readable copy, not the raw
		// string "unreachable".
		const outcome = await runBootAttempt(async settle => {
			settle(false, "ws://127.0.0.1:8300");
		}, fallback);
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toBe("无法连接本地守护进程");
		expect(outcome.reason).not.toBe("unreachable");
	});

	test("a throw settles a failure instead of recording nothing", async () => {
		// This is the round-2 P1: `new URL` threw past the settle call, so
		// `lastAttemptFailed` stayed false and the gate showed a calm manager.
		const outcome = await runBootAttempt(async () => {
			throw new Error("Invalid URL");
		}, fallback);
		expect(outcome.ok).toBe(false);
		expect(outcome.threw).toBe(true);
		expect(outcome.reason).toBe("Invalid URL");
	});

	test("a throw with no message still settles a readable reason", async () => {
		const outcome = await runBootAttempt(async () => {
			throw new Error();
		}, fallback);
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toBe(fallback.reason);
	});

	test("returning without settling is a failure, not silence", async () => {
		const outcome = await runBootAttempt(async () => {
			// A path that forgot to settle must not read as "nothing happened".
		}, fallback);
		expect(outcome).toEqual({ ok: false, at: fallback.at, reason: fallback.reason, threw: false });
	});

	test("a late settlement cannot turn a success into a failure", async () => {
		const outcome = await runBootAttempt(async settle => {
			settle(true, "ws://127.0.0.1:9411");
			settle(false, "ws://127.0.0.1:9411", "late");
		}, fallback);
		expect(outcome.ok).toBe(true);
	});

	test("a throw after a success keeps the success", async () => {
		const outcome = await runBootAttempt(async settle => {
			settle(true, "ws://127.0.0.1:9411");
			throw new Error("cleanup failed");
		}, fallback);
		expect(outcome.ok).toBe(true);
		expect(outcome.reason).toBeNull();
	});
});
