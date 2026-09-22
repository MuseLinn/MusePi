import { describe, expect, it } from "bun:test";
import { buildDaemonTurnIndex } from "./server";

/** session.turns (M1.11 全量轮次索引): one ~120B record per turn start over
 *  the FULL materialized snapshot, so the GUI's TurnRail covers turns the
 *  tail window never loaded. The turn-start predicate MUST stay in sync with
 *  client-core round-collapse.ts isTurnStart (user prompt OR displayed
 *  advisor note) — these cases pin that contract on the daemon side. */
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
		const entries = [
			{
				id: "1",
				timestamp: "t1",
				type: "custom_message",
				customType: "advisor",
				display: true,
				content: "建议先跑测试",
			},
			{ id: "2", timestamp: "t2", type: "message", message: { role: "assistant", content: "ok" } },
		];
		const turns = buildDaemonTurnIndex(entries);
		expect(turns).toHaveLength(1);
		expect(turns[0].kind).toBe("advisor");
		expect(turns[0].summary).toBe("建议先跑测试");
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
			line two ${"x".repeat(200)}`;
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
				content: [{ type: "text", text: "顾问内容" }],
			},
		];
		const turns = buildDaemonTurnIndex(entries);
		expect(turns[0].summary).toBe(longText.replace(/\s+/g, " ").trim().slice(0, 90));
		expect(turns[1].summary).toBe("顾问内容");
	});

	it("tolerates malformed entries", () => {
		expect(buildDaemonTurnIndex([null, undefined, 42, { type: "message" }])).toHaveLength(0);
	});
});
