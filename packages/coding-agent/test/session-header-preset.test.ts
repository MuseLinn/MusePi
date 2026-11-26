import { describe, expect, it } from "bun:test";
import { type SessionHeader, sessionHeaderPreset } from "../src/session/session-entries";

/**
 * Contract: a session's preset is written as `agentPreset` and read from either
 * spelling.
 *
 * `modeId` was the old key. It reads as the approval mode (`tools.approvalMode`)
 * even though it only ever held the agent preset, so writes moved to
 * `agentPreset`. Sessions saved before that still carry `modeId`, and dropping
 * the fallback would silently resume them with no preset — the session would
 * lose its composition without any error to notice.
 */
describe("session header preset", () => {
	const base: SessionHeader = {
		type: "session",
		id: "s1",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/tmp/work",
	};

	it("reads the current field", () => {
		expect(sessionHeaderPreset({ ...base, agentPreset: "design" })).toBe("design");
	});

	it("falls back to the pre-rename field", () => {
		expect(sessionHeaderPreset({ ...base, modeId: "design" })).toBe("design");
	});

	it("prefers the current field when a header carries both", () => {
		// A rewritten session can hold both if a write raced the rewrite; the
		// current field is the one the running code maintains.
		expect(sessionHeaderPreset({ ...base, agentPreset: "review", modeId: "design" })).toBe("review");
	});

	it("returns undefined when the session has no preset", () => {
		expect(sessionHeaderPreset(base)).toBeUndefined();
		expect(sessionHeaderPreset(undefined)).toBeUndefined();
		expect(sessionHeaderPreset(null)).toBeUndefined();
	});
});
