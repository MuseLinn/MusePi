import { describe, expect, it } from "bun:test";
import { buildDaemonTurnIndex } from "./server";

/** session.turns (M1.11 全量轮次索引): one 	120B record per turn start over
 *  the FULL materialized snapshot, so the GUI's TurnRail covers turns the
 *  tail window never loaded.
 *
 *  The turn-start rule is NOT restated here or next door: it is
 *  `isTurnStartEntry` (@musepi/pi-wire), called from session-host.ts. It used
 *  to be a hand-copied twin whose only guard was a comment, so what these
 *  cases pin is the BEHAVIOUR the copy had to preserve — a drift miscounts
 *  turns across the rail, the map and the entry-id jumps at once. */
describe("buildDaemonTurnIndex", () => {
	it("indexes user prompts and skips assistant/tool traffic", () => {
		const entries = [
			{ id: "1", timestamp: "t1", type: "message", message: { role: "user", content: "hello" } },
			{ id: "2", timestamp: "t2", type: "message", message: { role: "assistant", content: "hi" } },
			{ id: "3", timestamp: "t3", type: "message", message: { role: "user", content: "next" } },
		];
		const turns = buildDaemonTurnIndex(entries);
		expect(turns.map(t => t.kind)).toEqual(["user", "user"]);
		expect(turns.map(t => t.startIdx)).toEqual([0, 2]);
		expect(turns[0].summary).toBe("hello");
		expect(turns[0].entryId).toBe("1");
	});

	it("counts a DISPLAYED advisor note as a turn start (shared isTurnStart)", () => {
		// Real entry shape (session 01a04111, journal line 36): `content` is the
		// MODEL-FACING `<advisory>` XML; the reader-facing text is
		// details.notes[].note. summary is rendered verbatim by the TurnRail hover
		// panel, so it must be the note and never the XML.
		const entries = [
			{
				id: "1",
				timestamp: "t1",
				type: "custom_message",
				customType: "advisor",
				display: true,
				content: '<advisory severity="concern" guidance="weigh">先跑测试</advisory>',
				details: { notes: [{ note: "建议先跑测试", severity: "concern" }] },
			},
			{ id: "2", timestamp: "t2", type: "message", message: { role: "assistant", content: "ok" } },
		];
		const turns = buildDaemonTurnIndex(entries);
		expect(turns).toHaveLength(1);
		expect(turns[0].kind).toBe("advisor");
		expect(turns[0].summary).toBe("建议先跑测试");
		expect(turns[0].summary).not.toContain("advisory");
	});

	it("ignores hidden advisor notes and unrelated custom messages", () => {
		const entries = [
			{ id: "1", timestamp: "t1", type: "custom_message", customType: "advisor", display: false, content: "x" },
			{ id: "2", timestamp: "t2", type: "custom_message", customType: "hook", display: true, content: "y" },
		];
		expect(buildDaemonTurnIndex(entries)).toHaveLength(0);
	});

	it("extracts text from string or text-block content and collapses whitespace", () => {
		const longText = `line one
	t	t	tline two ${"x".repeat(200)}`;
		const entries = [
			{
				id: "1",
				timestamp: "t1",
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "image", url: "data:..." },
						{ type: "text", text: longText },
					],
				},
			},
			{
				id: "2",
				timestamp: "t2",
				type: "custom_message",
				customType: "advisor",
				display: true,
				content: "<advisory>a</advisory>",
				// Multiple notes join with "; " and blank ones drop out.
				details: { notes: [{ note: "第一条" }, { note: "   " }, { note: "第二条" }] },
			},
		];
		const turns = buildDaemonTurnIndex(entries);
		expect(turns[0].summary).toBe(longText.replace(/\s+/g, " ").trim().slice(0, 90));
		expect(turns[1].summary).toBe("第一条; 第二条");
	});

	it("leaves a note-less advisor entry empty instead of surfacing its XML", () => {
		// The pre-fix text extractor fell back to `content` for advisor entries,
		// so a note-less note put `<advisory …>` tags in the rail's hover panel.
		const turns = buildDaemonTurnIndex([
			{
				id: "1",
				timestamp: "t1",
				type: "custom_message",
				customType: "advisor",
				display: true,
				content: "<advisory>raw</advisory>",
			},
		]);
		expect(turns).toHaveLength(1);
		expect(turns[0].summary).toBe("");
	});

	it("tolerates malformed entries", () => {
		expect(buildDaemonTurnIndex([null, undefined, 42, { type: "message" }])).toHaveLength(0);
	});
});
