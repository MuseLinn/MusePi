import { describe, expect, test } from "bun:test";
import { buildTrajectory } from "../src/components/trajectory-data";

// Presentation contract for the 01a13e95 map bug (2026-10-15): an advisor
// card mid-chain must NOT fork the map. Advisor opens a turn (isTurnStart:
// user message OR display advisor note) but stays an ordinary chain member,
// so a linear history renders as Turn 1/2/3/4 on one lane — never as
// sibling "3-1/3-2" lanes. Entries below are shaped like the daemon's
// chain-faithful view projection (direct parents, view key space).
describe("trajectory advisor chain (no phantom fork)", () => {
	function incidentEntries(): unknown[] {
		const e = (id: string, parentId: string | null, type: string, extra: Record<string, unknown>, ts: string) => ({
			id,
			parentId,
			timestamp: ts,
			type,
			...extra,
		});
		return [
			e(
				"user:1000",
				null,
				"message",
				{ message: { role: "user", content: "first question" } },
				"2026-10-15T08:03:00.000Z",
			),
			e(
				"assistant:1001",
				"user:1000",
				"message",
				{
					message: {
						role: "assistant",
						content: [{ type: "text", text: "answer one" }],
					},
				},
				"2026-10-15T08:03:46.000Z",
			),
			e(
				"user:1002",
				"assistant:1001",
				"message",
				{ message: { role: "user", content: "second question" } },
				"2026-10-15T08:04:19.000Z",
			),
			e(
				"assistant:1003",
				"user:1002",
				"message",
				{
					message: {
						role: "assistant",
						content: [{ type: "text", text: "answer two" }],
					},
				},
				"2026-10-15T08:05:03.000Z",
			),
			e(
				"custom_message:1004",
				"assistant:1003",
				"custom_message",
				{
					customType: "advisor",
					display: true,
					content: "<advisory>model-facing</advisory>",
					details: { notes: [{ note: "capability list note" }] },
				},
				"2026-10-15T08:05:03.627Z",
			),
			e(
				"assistant:1005",
				"custom_message:1004",
				"message",
				{
					message: {
						role: "assistant",
						content: [{ type: "text", text: "follow-up" }],
					},
				},
				"2026-10-15T08:05:49.000Z",
			),
			e("thinking_level_change:1006", "assistant:1005", "thinking_level_change", {}, "2026-10-15T15:43:30.000Z"),
			e(
				"user:1007",
				"thinking_level_change:1006",
				"message",
				{ message: { role: "user", content: "third question" } },
				"2026-10-15T15:43:30.000Z",
			),
			e(
				"assistant:1008",
				"user:1007",
				"message",
				{
					message: {
						role: "assistant",
						content: [{ type: "text", text: "answer three" }],
					},
				},
				"2026-10-15T15:43:54.000Z",
			),
		];
	}

	test("linear history with mid-chain advisor renders Turn 1-4 on one lane", () => {
		const entries = incidentEntries();
		const ids = new Set(entries.map(e => (e as { id: string }).id));
		const { events } = buildTrajectory(entries, ids);
		const heads = events.filter(e => e.kind === "user" || e.kind === "advisor");
		expect(heads.map(e => e.pathTurnLabel)).toEqual(["1", "2", "3", "4"]);
		// No sibling suffixes: a single turn-start per parent never numbers.
		for (const e of events) {
			if (e.pathTurnLabel !== undefined) expect(e.pathTurnLabel).not.toContain("-");
		}
		// The advisor turn rides the main lane, not a branch lane.
		const advisor = events.find(e => e.kind === "advisor");
		expect(advisor).toBeDefined();
		expect(advisor?.branch).toBeUndefined();
		const user3 = heads[3];
		expect(user3?.branch).toBeUndefined();
	});
});
