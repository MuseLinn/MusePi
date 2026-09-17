import { describe, expect, test } from "bun:test";
import { type IdleCandidate, idleDisposePlan, isLiveSessionBusy } from "../../src/daemon/server";

/**
 * Issue #16 — background sessions were disposed mid-turn. The scanner closed
 * anything whose `lastActivity` was older than 30 minutes regardless of what it
 * was doing, so a Goal-mode session left running after switching GUI sessions
 * died with `session_exit reason=dispose pendingToolCalls=1` and no auto-resume.
 *
 * `lastActivity` only tracks USER interaction (send/subscribe). A long bash run
 * or an autonomous Goal round is real work with no user interaction at all, so
 * the timeout — not the activity clock — is what has to know about "busy".
 */

const TIMEOUT = 30 * 60 * 1000;
const NOW = 1_000_000;

/** A session the user has not touched for `ageMs`. */
function idle(ageMs: number, extra: Partial<IdleCandidate> = {}): IdleCandidate {
	return { lastActivity: NOW - ageMs, ...extra };
}

describe("isLiveSessionBusy", () => {
	test("a session streaming a reply is busy", () => {
		expect(isLiveSessionBusy(idle(TIMEOUT * 2, { agentSession: { isStreaming: true } }))).toBe(true);
	});

	test("a compacting session is busy", () => {
		expect(isLiveSessionBusy(idle(TIMEOUT * 2, { agentSession: { isCompacting: true } }))).toBe(true);
	});

	test("a session with a tool still running is busy even when not streaming", () => {
		// The exact state #16 reported: pendingToolCalls=1, no active stream.
		expect(
			isLiveSessionBusy(idle(TIMEOUT * 2, { agentSession: { isStreaming: false }, activeToolCalls: { size: 1 } })),
		).toBe(true);
	});

	test("a quiet session is not busy", () => {
		expect(isLiveSessionBusy(idle(TIMEOUT * 2))).toBe(false);
		expect(isLiveSessionBusy(idle(TIMEOUT * 2, { activeToolCalls: { size: 0 } }))).toBe(false);
	});
});

describe("idleDisposePlan", () => {
	test("an idle session past the timeout is closed", () => {
		const plan = idleDisposePlan([["a", idle(TIMEOUT + 1)]], NOW);
		expect(plan).toEqual(["a"]);
	});

	test("an idle session inside the timeout is kept", () => {
		expect(idleDisposePlan([["a", idle(TIMEOUT - 1)]], NOW)).toEqual([]);
	});

	test("a session running a tool is never closed by the timeout", () => {
		// Regression: this is the 30-minute Goal-mode kill.
		const plan = idleDisposePlan([["a", idle(TIMEOUT * 4, { activeToolCalls: { size: 1 } })]], NOW);
		expect(plan).toEqual([]);
	});

	test("a streaming session is never closed by the timeout", () => {
		const plan = idleDisposePlan([["a", idle(TIMEOUT * 4, { agentSession: { isStreaming: true } })]], NOW);
		expect(plan).toEqual([]);
	});

	test("the LRU cap closes the OLDEST idle sessions only", () => {
		const sessions: [string, IdleCandidate][] = [
			["old", idle(10_000)],
			["older", idle(20_000)],
			["oldest", idle(30_000)],
			["fresh", idle(1_000)],
		];
		const plan = idleDisposePlan(sessions, NOW, TIMEOUT, 2);
		expect(plan).toEqual(["oldest", "older"]);
	});

	test("the LRU cap never evicts a working session", () => {
		// 3 sessions, cap 1: the only idle one goes, even though it is the
		// most recently touched — the two busy ones are untouchable.
		const sessions: [string, IdleCandidate][] = [
			["busy-old", idle(90_000, { activeToolCalls: { size: 2 } })],
			["busy-oldest", idle(120_000, { agentSession: { isStreaming: true } })],
			["idle-fresh", idle(1_000)],
		];
		expect(idleDisposePlan(sessions, NOW, TIMEOUT, 1)).toEqual(["idle-fresh"]);
	});

	test("every session busy => nothing is disposable", () => {
		const sessions: [string, IdleCandidate][] = [
			["a", idle(TIMEOUT * 9, { activeToolCalls: { size: 1 } })],
			["b", idle(TIMEOUT * 9, { agentSession: { isStreaming: true } })],
		];
		expect(idleDisposePlan(sessions, NOW, TIMEOUT, 1)).toEqual([]);
	});

	test("timeout victims are not double-counted when applying the LRU cap", () => {
		// 'stale' is already closed by the timeout, so the LRU pass sees only
		// two survivors — with a cap of 2 nothing else should be evicted.
		const sessions: [string, IdleCandidate][] = [
			["stale", idle(TIMEOUT + 1)],
			["keep-a", idle(1_000)],
			["keep-b", idle(2_000)],
		];
		expect(idleDisposePlan(sessions, NOW, TIMEOUT, 2)).toEqual(["stale"]);
	});
});
