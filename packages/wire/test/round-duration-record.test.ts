import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "../src/index";
import { entryStartMs, isTurnStartEntry, roundDurationRecord } from "../src/index";

let seq = 0;
function msg(role: "user" | "assistant", ts: number): SessionEntry {
	return {
		type: "message",
		id: `m${++seq}`,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		message: { role, content: "x", timestamp: ts },
	} as SessionEntry;
}

function advisor(ts: number): SessionEntry {
	return {
		type: "custom_message",
		id: `a${++seq}`,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		customType: "advisor",
		content: "note",
		display: true,
	};
}

describe("isTurnStartEntry", () => {
	test("user message starts a turn; assistant/toolResult do not", () => {
		expect(isTurnStartEntry(msg("user", 1))).toBe(true);
		expect(isTurnStartEntry(msg("assistant", 1))).toBe(false);
		expect(isTurnStartEntry(undefined)).toBe(false);
	});

	test("advisor note starts a turn only when displayed", () => {
		expect(isTurnStartEntry(advisor(1))).toBe(true);
		const hidden = { ...advisor(1), display: false } as SessionEntry;
		expect(isTurnStartEntry(hidden)).toBe(false);
	});
});

describe("roundDurationRecord", () => {
	test("key = last turn-start ts, value = last entry − turn start (wire clock)", () => {
		const entries = [msg("user", 1_000), msg("assistant", 1_500), msg("assistant", 2_600)];
		expect(roundDurationRecord(entries)).toEqual({ turnStartMs: 1_000, durationMs: 1_600 });
	});

	test("advisor-spawned turn anchors at the advisor note, spanning only that turn", () => {
		const entries = [msg("user", 1_000), msg("assistant", 1_500), advisor(5_000), msg("assistant", 7_000)];
		expect(roundDurationRecord(entries)).toEqual({ turnStartMs: 5_000, durationMs: 2_000 });
	});

	test("no turn start → null; last event predating the anchor (clock skew) → null", () => {
		expect(roundDurationRecord([msg("assistant", 1_000)])).toBeNull();
		expect(roundDurationRecord([msg("user", 5_000), msg("assistant", 1_000)])).toBeNull();
	});

	test("entryStartMs reads the wire timestamp for messages, parses ISO otherwise", () => {
		expect(entryStartMs(msg("user", 42_000))).toBe(42_000);
		expect(entryStartMs(advisor(43_000))).toBe(43_000);
	});
});
