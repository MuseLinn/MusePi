import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { buildTurnIndex, TURN_SUMMARY_MAX } from "./turn-index";

const base = { parentId: null, timestamp: "0" };
let seq = 0;
function entry(overrides: object): SessionEntry {
	return { ...base, id: `e${++seq}`, ...overrides } as unknown as SessionEntry;
}
const userMsg = (text: string): SessionEntry =>
	entry({ type: "message", message: { role: "user", content: text, timestamp: 1 } });
const assistantText = (text: string): SessionEntry =>
	entry({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } });

describe("buildTurnIndex", () => {
	test("one item per user message, in order, with absolute indices", () => {
		const entries = [
			userMsg("first prompt"),
			assistantText("ok"),
			entry({ type: "custom_message", customType: "notice", content: "x", display: true }),
			userMsg("second prompt"),
			assistantText("done"),
		];
		const idx = buildTurnIndex(entries);
		expect(idx).toHaveLength(2);
		expect(idx[0]).toMatchObject({ startIdx: 0, summary: "first prompt" });
		expect(idx[1]).toMatchObject({ startIdx: 3, summary: "second prompt" });
		expect(idx[0]!.entryId).toBe(entries[0]!.id);
		expect(idx[0]!.timestamp).toBe(entries[0]!.timestamp);
	});

	test("multi-block content joins text blocks; whitespace collapses; 90-char cap", () => {
		const long = "word ".repeat(40).trim(); // 199 chars
		const entries = [
			userMsg("a"),
			assistantText("x"),
			entry({
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "line one\n" },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
						{ type: "text", text: "  line   two  " },
					],
					timestamp: 1,
				},
			}),
			userMsg(long),
		];
		const idx = buildTurnIndex(entries);
		expect(idx).toHaveLength(3);
		expect(idx[1]!.summary).toBe("line one line two");
		expect(idx[2]!.summary).toHaveLength(TURN_SUMMARY_MAX);
		// 5-char "word " × 18 = exactly 90 chars — the cap cuts mid-run.
		expect(idx[2]!.summary).toBe("word ".repeat(18));
	});

	test("displayed advisor note starts its own turn (isTurnStart parity)", () => {
		const entries = [
			userMsg("prompt"),
			assistantText("working"),
			entry({ type: "custom_message", customType: "advisor", content: "先修崩溃再优化", display: true }),
			assistantText("fixed"),
			// Not displayed → NOT a turn start.
			entry({ type: "custom_message", customType: "advisor", content: "hidden", display: false }),
			userMsg("next prompt"),
		];
		const idx = buildTurnIndex(entries);
		expect(idx).toHaveLength(3);
		expect(idx[1]).toMatchObject({ startIdx: 2, kind: "advisor", summary: "先修崩溃再优化" });
		expect(idx[0]!.kind).toBe("user");
		expect(idx[2]!.kind).toBe("user");
	});

	test("advisor content array joins text blocks; image-only falls back empty", () => {
		const entries = [
			entry({
				type: "custom_message",
				customType: "advisor",
				content: [{ type: "text", text: "part one " }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "part two" }],
				display: true,
			}),
			entry({ type: "custom_message", customType: "advisor", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], display: true }),
		];
		const idx = buildTurnIndex(entries);
		expect(idx[0]!.summary).toBe("part one part two");
		expect(idx[1]!.summary).toBe("");
	});

	test("empty / no-user sessions yield an empty index", () => {
		expect(buildTurnIndex([])).toEqual([]);
		expect(buildTurnIndex([assistantText("hi"), assistantText("again")])).toEqual([]);
	});

	test("canvas parity: index count matches active-path user messages", () => {
		const entries = [userMsg("q1"), assistantText("a1"), userMsg("q2"), assistantText("a2"), userMsg("q3")];
		expect(buildTurnIndex(entries)).toHaveLength(3);
		expect(buildTurnIndex(entries).map(t => t.startIdx)).toEqual([0, 2, 4]);
	});
});
