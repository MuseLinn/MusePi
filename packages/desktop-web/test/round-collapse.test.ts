import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { buildRoundFolds, formatRoundDuration, isInsideFold } from "../src/components/transcript/round-collapse";

/** Completed-round fold contract: rounds with a frozen duration fold their
 *  working span (tools/commands) behind a header, the live tail stays
 *  expanded, counts are per-round, and the duration formats hh:mm:ss. */
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

const DURATIONS = new Map<number, number>([
	[3, 125_000],
	[4, 125_000],
	[5, 3_660_000],
	[6, 3_660_000],
]);

describe("buildRoundFolds", () => {
	it("folds a completed round's working span, leaving the final reply outside", () => {
		const entries = [user(1), bash(2), toolResult(3), assistant(4, 2), user(5), assistant(6)];
		const folds = buildRoundFolds(entries, DURATIONS);
		expect(folds).toHaveLength(1);
		const f = folds[0]!;
		expect(f.startIdx).toBe(0);
		expect(f.finalIdx).toBe(3);
		expect(f.durationMs).toBe(125_000);
		expect(f.toolCount).toBe(2);
		expect(f.commandCount).toBe(1);
		expect(isInsideFold(folds, 1)).toBe(true);
		expect(isInsideFold(folds, 2)).toBe(true);
		expect(isInsideFold(folds, 3)).toBe(false); // final reply stays visible
	});

	it("never folds the live tail (last complete round stays expanded)", () => {
		const entries = [user(1), bash(2), assistant(3, 1), user(4), bash(5), assistant(6, 3)]; // timestamps 3 and 6
		const folds = buildRoundFolds(entries, DURATIONS);
		expect(folds).toHaveLength(1);
		expect(folds[0]!.startIdx).toBe(0);
	});

	it("counts tools and commands per round only inside its span", () => {
		const entries = [user(1), bash(2), assistant(3, 4), user(4), assistant(5)];
		const folds = buildRoundFolds(entries, DURATIONS);
		expect(folds[0]!.toolCount).toBe(4);
		expect(folds[0]!.commandCount).toBe(1);
	});

	it("skips rounds with no working span and work without a user message", () => {
		const noWork = [user(1), assistant(2)];
		expect(buildRoundFolds(noWork, DURATIONS)).toHaveLength(0);
		const orphanWork = [bash(1), assistant(2)];
		expect(buildRoundFolds(orphanWork, DURATIONS)).toHaveLength(0);
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
		const folds = buildRoundFolds(entries, DURATIONS);
		expect(folds).toHaveLength(1);
		const f = folds[0]!;
		expect(f.filesChanged).toBe(2); // a.ts + b.ts; the errored c.ts counts neither
		expect(f.added).toBe(3);
		expect(f.removed).toBe(2);
		expect(f.userId).toBe("u1"); // the revert anchor is the round's user message
	});

	it("reports zero changes for rounds that edited nothing — the header omits the chip", () => {
		// trailing no-work round = the live tail, so the first round folds
		const entries = [user(1), bash(2), toolResult(3), assistant(4, 1), user(5), assistant(6)];
		const folds = buildRoundFolds(entries, DURATIONS);
		expect(folds).toHaveLength(1);
		const f = folds[0]!;
		expect(f.filesChanged).toBe(0);
		expect(f.added).toBe(0);
		expect(f.removed).toBe(0);
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
		// trailing no-work round = the live tail, so the sneaky round folds
		const folds = buildRoundFolds([user(1), sneaky, assistant(4, 1), user(5), assistant(6)], DURATIONS);
		expect(folds).toHaveLength(1);
		expect(folds[0]!.filesChanged).toBe(0);
	});

	it("formats durations as mm:ss and hh:mm:ss", () => {
		expect(formatRoundDuration(125_000)).toBe("02:05");
		expect(formatRoundDuration(3_660_000)).toBe("1:01:00");
	});
});
