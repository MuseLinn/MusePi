import { describe, expect, test } from "bun:test";
import { connectionPresentation } from "../src/lib/connection/presentation";

/**
 * The one mapping every connection surface reads.
 *
 * These assertions are the contract, not the implementation: a deliberate
 * disconnect must never read as a failure, an attempt in flight must never
 * read as failed, and a managed process that died must not send the user
 * looking for a network problem.
 */

describe("connection presentation", () => {
	test("a live connection wins over a stale error", () => {
		const shown = connectionPresentation({ connected: true, lastError: "connection refused" });
		expect(shown).toEqual({
			phase: "connected",
			labelKey: "settings.connectionStatusConnected",
			tone: "ok",
		});
	});

	test("a managed process that died asks for a step, not a retry", () => {
		// A tunnel or WSL daemon that failed is the user's next action; calling it
		// "failed" beside a healthy network sends them to the wrong fix.
		expect(connectionPresentation({ connected: false, managed: "failed" })).toEqual({
			phase: "attention",
			labelKey: "settings.connectionNeedsAttention",
			tone: "warn",
		});
	});

	test("an attempt in flight is connecting, never failed", () => {
		expect(connectionPresentation({ connected: false, connecting: true }).phase).toBe("connecting");
		expect(connectionPresentation({ connected: false, managed: "starting" }).phase).toBe("connecting");
		// A stale error from the previous attempt must not outrank the new one.
		expect(connectionPresentation({ connected: false, connecting: true, lastError: "timed out" }).phase).toBe(
			"connecting",
		);
	});

	test("a recorded error is failed", () => {
		expect(connectionPresentation({ connected: false, lastError: "refused" })).toEqual({
			phase: "failed",
			labelKey: "settings.connectionStatusFailed",
			tone: "error",
		});
	});

	test("nothing recorded is neutral, so a deliberate disconnect is not an error", () => {
		expect(connectionPresentation({ connected: false })).toEqual({
			phase: "idle",
			labelKey: "settings.connectionStatusUnknown",
			tone: "neutral",
		});
	});
});
