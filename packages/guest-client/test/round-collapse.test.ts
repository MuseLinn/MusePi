import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { buildRoundFolds, isInsideFold } from "../src/components/transcript/round-collapse";

/** Completed-round fold contract (openchamber projectTurnRecords parity):
 *  folds are STRUCTURAL — any round (user → its last assistant) containing
 *  tool/command work folds, including the LAST completed round; while the
 *  session is working, the in-flight round after the last user message
 *  streams live and never folds; no duration data is involved. */
function user(ts: number): SessionEntry {
	return {
		type: "message",
		id: `u${ts}`,
		parentId: null,
		timestamp: String(ts),
		message: { role: "user", content: "hi", timestamp: ts },
	} as SessionEntry;
}
function assistant(ts: number, toolCalls = 0): SessionEntry {
	const content: unknown[] = [];
	for (let i = 0; i < toolCalls; i++)
		content.push({ type: "toolCall", id: `t${ts}-${i}`, name: "bash", arguments: "{}" });
	content.push({ type: "text", text: `reply ${ts}` });
	return {
		type: "message",
		id: `a${ts}`,
		parentId: null,
		timestamp: String(ts),
		message: { role: "assistant", content, timestamp: ts },
	} as SessionEntry;
}
function bash(ts: number): SessionEntry {
	return {
		type: "message",
		id: `b${ts}`,
		parentId: null,
		timestamp: String(ts),
		message: {
			role: "bashExecution",
			command: "ls",
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: ts,
		},
	} as SessionEntry;
}
function toolResult(ts: number): SessionEntry {
	return {
		type: "message",
		id: `r${ts}`,
		parentId: null,
		timestamp: String(ts),
		message: {
			role: "toolResult",
			toolCallId: `t${ts}`,
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: ts,
		},
	} as SessionEntry;
}
function editResult(ts: number, details: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id: `e${ts}`,
		parentId: null,
		timestamp: String(ts),
		message: {
			role: "toolResult",
			toolCallId: `t${ts}`,
			toolName: "edit",
			content: [{ type: "text", text: "patched" }],
			details,
			isError: false,
			timestamp: ts,
		},
	} as SessionEntry;
}

describe("buildRoundFolds", () => {
	it("folds a completed round's working span, leaving the final reply outside", () => {
		const entries = [user(1), bash(2), toolResult(3), assistant(4, 2), user(5), assistant(6)];
		// The trailing user→assistant pair has no work between them — nothing
		// to summarize, so only the first round folds.
		const folds = buildRoundFolds(entries, false);
		expect(folds).toHaveLength(1);
		const f = folds[0]!;
		expect(f.startIdx).toBe(0);
		expect(f.finalIdx).toBe(3);
		expect(f.toolCount).toBe(2);
		expect(f.commandCount).toBe(1);
		expect(isInsideFold(folds, 1)).toBe(true);
		expect(isInsideFold(folds, 2)).toBe(true);
		expect(isInsideFold(folds, 3)).toBe(false); // final reply stays visible
	});

	it("folds a turn whose process rows land AFTER the reply (real session shape)", () => {
		// Verbatim shape of a real journal turn: user → assistant[thinking, text,
		// toolCall] → toolResult → assistant[thinking only]. Spanning only up to
		// the reply counted no work and produced NO fold, so the transcript never
		// showed a 活动 row; the reply anchor must also be the TEXT row, not the
		// trailing thinking-only one.
		const thinkingOnly: SessionEntry = {
			type: "message",
			id: "a99",
			parentId: null,
			timestamp: "99",
			message: { role: "assistant", content: [{ type: "thinking", text: "…" }], timestamp: 99 },
		} as unknown as SessionEntry;
		const entries = [user(1), assistant(2, 1), toolResult(3), thinkingOnly];
		const folds = buildRoundFolds(entries, false);
		expect(folds).toHaveLength(1);
		const f = folds[0]!;
		expect(f.startIdx).toBe(0);
		expect(f.endIdx).toBe(3);
		expect(f.finalIdx).toBe(1); // the TEXT row, not the trailing thinking row
		expect(f.headerIdx).toBe(1); // header renders on the turn's first content row
		expect(f.toolCount).toBe(1);
		expect(isInsideFold(folds, 2)).toBe(true); // toolResult folds away
		expect(isInsideFold(folds, 3)).toBe(true); // trailing thinking row too
		expect(isInsideFold(folds, 1)).toBe(false); // the reply never hides
	});

	it("folds the LAST completed round too once the session is idle", () => {
		const entries = [user(1), bash(2), assistant(3, 1), user(4), bash(5), assistant(6, 3)];
		const folds = buildRoundFolds(entries, false);
		expect(folds).toHaveLength(2);
		expect(folds[1]!.startIdx).toBe(3);
		expect(folds[1]!.finalIdx).toBe(5);
	});

	it("while working, the in-flight round after the last user message never folds", () => {
		const entries = [user(1), bash(2), assistant(3, 1), user(4), bash(5)];
		const folds = buildRoundFolds(entries, true);
		expect(folds).toHaveLength(1);
		expect(folds[0]!.startIdx).toBe(0); // only the earlier completed round
		expect(isInsideFold(folds, 4)).toBe(false); // in-flight work streams live
	});

	it("counts tools and commands per round only inside its span", () => {
		const entries = [user(1), bash(2), assistant(3, 4), user(4), assistant(5)];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.toolCount).toBe(4);
		expect(folds[0]!.commandCount).toBe(1);
	});

	it("skips rounds with no working span and work without a user message", () => {
		const noWork = [user(1), assistant(2)];
		expect(buildRoundFolds(noWork, false)).toHaveLength(0);
		const orphanWork = [bash(1), assistant(2)];
		expect(buildRoundFolds(orphanWork, false)).toHaveLength(0);
	});

	it("works on sessions with NO duration data (old snapshots fold structurally)", () => {
		// The old condition required a frozen duration per round, which old
		// sessions lack — nothing ever folded. Structural folding has no such
		// dependency.
		const entries = [user(1), bash(2), toolResult(3), assistant(4, 1), user(5), bash(6), assistant(7, 1)];
		expect(buildRoundFolds(entries, false)).toHaveLength(2);
	});

	it("aggregates per-round file changes from edit tool results (+added −removed, distinct files)", () => {
		const entries = [
			user(1),
			editResult(2, { path: "a.ts", diff: "+one\n+two\n-gone\ncontext" }),
			editResult(3, {
				perFileResults: [
					{ path: "b.ts", diff: "+x\n-y\n", isError: false },
					{ path: "c.ts", diff: null, isError: true },
				],
			}),
			assistant(4, 2),
			user(5),
			assistant(6),
		];
		const folds = buildRoundFolds(entries, false);
		expect(folds).toHaveLength(1); // trailing work-less round doesn't fold
		const f = folds[0]!;
		expect(f.filesChanged).toBe(2); // a.ts + b.ts; the errored c.ts counts neither
		expect(f.added).toBe(3);
		expect(f.removed).toBe(2);
		expect(f.userId).toBe("u1"); // the revert anchor is the round's user message
	});

	it("reports zero changes for rounds that edited nothing — the header omits the chip", () => {
		const entries = [user(1), bash(2), toolResult(3), assistant(4, 1), user(5), assistant(6)];
		const folds = buildRoundFolds(entries, false);
		expect(folds).toHaveLength(1);
		expect(folds[0]!.filesChanged).toBe(0);
		expect(folds[0]!.added).toBe(0);
		expect(folds[0]!.removed).toBe(0);
	});

	it("does not count diff stats from non-edit tools", () => {
		const sneaky: SessionEntry = {
			type: "message",
			id: "s1",
			parentId: null,
			timestamp: "2",
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				details: { path: "fake.ts", diff: "+nope\n-nope\n" },
				isError: false,
				timestamp: 2,
			},
		} as SessionEntry;
		const folds = buildRoundFolds([user(1), sneaky, assistant(4, 1), user(5), assistant(6)], false);
		expect(folds[0]!.filesChanged).toBe(0);
	});

	it("counts read/search tools as explored (openchamber 探索了代码库 segment)", () => {
		const read: SessionEntry = {
			type: "message",
			id: "rd1",
			parentId: null,
			timestamp: "2",
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp: 2,
			},
		} as SessionEntry;
		const folds = buildRoundFolds([user(1), read, assistant(3, 1), user(4), assistant(5)], false);
		expect(folds[0]!.exploreCount).toBe(1);
	});
});
