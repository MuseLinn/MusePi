import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { artifactRowSet, buildRoundFolds, buildToolRuns, isInsideFold } from "./round-collapse";

/** Minimal EntryBase fields shared by every SessionEntry. */
const base = { parentId: null, timestamp: "0" };

let seq = 0;
function withId(overrides: object): SessionEntry {
	return { ...base, id: `e${++seq}`, ...overrides } as unknown as SessionEntry;
}

const userMsg = (text = "hi"): SessionEntry =>
	withId({ type: "message", message: { role: "user", content: text, timestamp: 1 } });

const assistantText = (text = "ok"): SessionEntry =>
	withId({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } });

const assistantToolCall = (id: string, name = "read"): SessionEntry =>
	withId({
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }], timestamp: 1 },
	});

const toolResult = (toolCallId: string, toolName = "read"): SessionEntry =>
	withId({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text: "out" }],
			isError: false,
			timestamp: 1,
		},
	});

const custom = (customType: string): SessionEntry =>
	withId({ type: "custom_message", customType, content: "x", display: true });

const browserResult = (toolCallId: string, operations: unknown[], isError = false): SessionEntry =>
	withId({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "browser",
			content: [{ type: "text", text: isError ? "failed" : "ok" }],
			details: { action: "run", name: "main", url: "https://example.com", operations },
			isError,
			timestamp: 1,
		},
	});

describe("buildRoundFolds tail/hook exemption (design doc §C)", () => {
	test("tail rows stay visible while the fold is closed", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1"),
			toolResult("c1"),
			custom("retry_failure"),
			assistantText("done"),
		];
		const folds = buildRoundFolds(entries, false);
		expect(folds).toHaveLength(1);
		// The retry_failure entry (index 3) is inside the span but exempt.
		expect(folds[0]!.exempt).toContain(3);
		expect(isInsideFold(folds, 3)).toBe(false);
		// Process rows still fold.
		expect(isInsideFold(folds, 1)).toBe(true);
		expect(isInsideFold(folds, 2)).toBe(true);
		// The reply never folds.
		expect(isInsideFold(folds, 4)).toBe(false);
	});

	test("hook rows stay visible while the fold is closed", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1"),
			toolResult("c1"),
			custom("hook:lint-check"),
			custom("hook"),
			assistantText("done"),
		];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.exempt).toContain(3);
		expect(folds[0]!.exempt).toContain(4);
		expect(isInsideFold(folds, 3)).toBe(false);
		expect(isInsideFold(folds, 4)).toBe(false);
	});

	test("unrelated custom rows are NOT exempt", () => {
		const entries = [userMsg(), assistantToolCall("c1"), toolResult("c1"), custom("advisor"), assistantText("done")];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.exempt).not.toContain(3);
	});

	test("in-flight round never folds (existing behavior preserved)", () => {
		const entries = [userMsg(), assistantToolCall("c1"), toolResult("c1"), assistantText("streaming…")];
		expect(buildRoundFolds(entries, true)).toHaveLength(0);
		expect(buildRoundFolds(entries, false)).toHaveLength(1);
	});
});

describe("buildRoundFolds output exemption (artifact cards and produced pictures)", () => {
	/** A tool result carrying `details` (image generators keep the picture in
	 *  `details.images`, out of model context). */
	const richResult = (toolCallId: string, toolName: string, extra: { details?: unknown; isError?: boolean } = {}) =>
		withId({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text: "out" }],
				isError: extra.isError ?? false,
				...(extra.details !== undefined ? { details: extra.details } : {}),
				timestamp: 1,
			},
		});

	const imageDetails = { provider: "agnes", images: [{ data: "Zm9v", mimeType: "image/png" }] };

	test("an artifact card (board) keeps its row visible while the fold is closed", () => {
		const entries = [userMsg(), assistantToolCall("c1", "board"), richResult("c1", "board"), assistantText("done")];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.exempt).toContain(1);
		expect(isInsideFold(folds, 1)).toBe(false);
	});

	test("a generated picture keeps the row that produced it visible", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1", "generate_image"),
			richResult("c1", "generate_image", { details: imageDetails }),
			assistantText("here it is"),
		];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.exempt).toContain(1);
		expect(isInsideFold(folds, 1)).toBe(false);
	});

	test("a content image block keeps its row visible too (read image / inspect_image)", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1", "read"),
			withId({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "read",
					content: [
						{ type: "text", text: "Read image file [image/png]" },
						{ type: "image", data: "Zm9v", mimeType: "image/png" },
					],
					isError: false,
					timestamp: 1,
				},
			}),
			assistantText("done"),
		];
		const folds = buildRoundFolds(entries, false);
		expect(isInsideFold(folds, 1)).toBe(false);
	});

	test("an ERRORED generating call stays visible: the failure outranks the output rule", () => {
		// This used to fold, on the reasoning that a failed generator produced no
		// picture, so there was nothing to keep. That rule decides what counts as
		// OUTPUT; a failure is EVIDENCE, and hiding it leaves a tidy header with
		// no way to learn that the image never arrived. ToolView renders a proper
		// error card for it (`tv-card--error`), so the row is not a broken frame.
		const entries = [
			userMsg(),
			assistantToolCall("c1", "generate_image"),
			richResult("c1", "generate_image", { details: imageDetails, isError: true }),
			assistantText("failed"),
		];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.exempt).toContain(1);
		expect(isInsideFold(folds, 1)).toBe(false);
		expect(folds[0]!.failedCount).toBe(1);
	});

	test("a plain text result still folds (the exemption is not every tool row)", () => {
		const entries = [userMsg(), assistantToolCall("c1"), toolResult("c1"), assistantText("done")];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.exempt).not.toContain(1);
		expect(isInsideFold(folds, 1)).toBe(true);
	});
});

const bash = (): SessionEntry =>
	withId({
		type: "message",
		message: { role: "bashExecution", command: "ls", content: [], timestamp: 1 },
	});

const thinkingOnly = (): SessionEntry =>
	withId({
		type: "message",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], timestamp: 1 },
	});

describe("buildToolRuns (工具调用汇总, Kimi parity)", () => {
	test("a settled stretch of consecutive tool rows groups into one run with category counts", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1", "read"),
			toolResult("c1", "read"),
			assistantToolCall("c2", "grep"),
			toolResult("c2", "grep"),
			assistantToolCall("c3", "edit"),
			toolResult("c3", "edit"),
			bash(),
			assistantText("done"),
		];
		const runs = buildToolRuns(entries, false);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.headIdx).toBe(1);
		expect(runs[0]!.idxs).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(runs[0]!.reads).toBe(2);
		expect(runs[0]!.edits).toBe(1);
		expect(runs[0]!.commands).toBe(1);
		expect(runs[0]!.other).toBe(0);
	});

	test("the run key is the head entry's id — stable across history prepends", () => {
		const entries = [userMsg(), assistantToolCall("c1"), toolResult("c1"), assistantToolCall("c2"), toolResult("c2")];
		const runs = buildToolRuns(entries, false);
		expect(runs[0]!.key).toBe(entries[1]!.id);
	});

	test("a lone tool call is not summarized — a summary line would only add noise", () => {
		const entries = [userMsg(), assistantToolCall("c1"), toolResult("c1"), assistantText("done")];
		expect(buildToolRuns(entries, false)).toHaveLength(0);
	});

	test("text replies, thinking rows and user messages break a run", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1"),
			toolResult("c1", "read"),
			assistantToolCall("c2"),
			toolResult("c2", "grep"),
			assistantText("interim answer"),
			bash(),
			assistantToolCall("c3"),
			toolResult("c3", "read"),
			assistantText("done"),
		];
		const runs = buildToolRuns(entries, false);
		expect(runs).toHaveLength(2);
		expect(runs[0]!.idxs).toEqual([1, 2, 3, 4]);
		expect(runs[1]!.idxs).toEqual([6, 7, 8]);
	});

	test("while streaming, the run extending to the last entry stays live (spinner is the progress)", () => {
		const entries = [userMsg(), assistantToolCall("c1"), toolResult("c1"), assistantToolCall("c2"), toolResult("c2")];
		expect(buildToolRuns(entries, true)).toHaveLength(0);
		// Once the turn ends the same rows summarize — 开 × 回合结束.
		expect(buildToolRuns(entries, false)).toHaveLength(1);
	});

	test("while streaming, SETTLED earlier runs still summarize (回答过程中已完成的汇总)", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1"),
			toolResult("c1"),
			assistantToolCall("c2"),
			toolResult("c2"),
			assistantText("interim"),
			assistantToolCall("c3"),
			toolResult("c3"),
		];
		const runs = buildToolRuns(entries, true);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.idxs).toEqual([1, 2, 3, 4]);
		// The live tail run renders 现状 until it settles.
		expect(runs[0]!.idxs).not.toContain(6);
		expect(runs[0]!.idxs).not.toContain(7);
	});

	test("xd:// extension dispatches count as plugin actions, not file edits", () => {
		const dispatch = (id: string, tool: string): SessionEntry =>
			withId({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: id,
					toolName: "write",
					content: [{ type: "text", text: "{}" }],
					details: { xdev: { mode: "execute", tool, args: {} } },
					isError: false,
					timestamp: 1,
				},
			});
		const entries = [
			userMsg(),
			assistantToolCall("c1", "write"),
			dispatch("c1", "extension_load"),
			assistantToolCall("c2", "write"),
			dispatch("c2", "extension_validate"),
			assistantText("done"),
		];
		const run = buildToolRuns(entries, false)[0]!;
		expect(run.plugins).toBe(2);
		expect(run.edits).toBe(0);
	});

	test("an xd:// device read counts as the tool it ran, not as a file read", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1", "write"),
			withId({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "write",
					content: [{ type: "text", text: "{}" }],
					details: { xdev: { mode: "execute", tool: "inspect_image", args: {} } },
					isError: false,
					timestamp: 1,
				},
			}),
			assistantToolCall("c2", "write"),
			withId({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c2",
					toolName: "write",
					content: [{ type: "text", text: "{}" }],
					details: { xdev: { mode: "execute", tool: "web_search", args: {} } },
					isError: false,
					timestamp: 1,
				},
			}),
			assistantText("done"),
		];
		const run = buildToolRuns(entries, false)[0]!;
		expect(run.reads).toBe(2);
		expect(run.edits).toBe(0);
	});

	test("error results still count — the action happened even when it failed", () => {
		const fail = withId({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "edit",
				content: [{ type: "text", text: "err" }],
				isError: true,
				timestamp: 1,
			},
		});
		const entries = [
			userMsg(),
			assistantToolCall("c1", "edit"),
			fail,
			assistantToolCall("c2", "read"),
			toolResult("c2", "read"),
		];
		const runs = buildToolRuns(entries, false);
		expect(runs[0]!.edits).toBe(1);
		expect(runs[0]!.reads).toBe(1);
	});

	test("browser calls summarize pages and operations, with equivalent recovered retries excluded from failures", () => {
		const entries = [
			userMsg(),
			assistantToolCall("b1", "browser"),
			browserResult(
				"b1",
				[
					{ id: "1", action: "observe", status: "completed", startedAt: 1, elementCount: 4 },
					{ id: "2", action: "click", status: "failed", startedAt: 2, target: "#go" },
				],
				true,
			),
			assistantToolCall("b2", "browser"),
			browserResult("b2", [{ id: "3", action: "click", status: "completed", startedAt: 3, target: "#go" }]),
			assistantText("done"),
		];

		const run = buildToolRuns(entries, false)[0]!;
		expect(run.other).toBe(0);
		expect(run.browser?.calls).toBe(2);
		expect(run.browser?.pages).toBe(1);
		expect(run.browser?.actions.click).toEqual({ count: 1, failed: 0 });
		expect(run.browser?.recoveredFailures).toBe(1);
		expect(run.browser?.residualFailures).toBe(0);
	});
});

describe("notify_user progress updates", () => {
	const progressCall = (id: string): SessionEntry =>
		withId({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id, name: "notify_user", arguments: { title: "t", message: "m" } }],
				timestamp: 1,
			},
		});

	test("the carrier survives a closed fold and is not counted as tool work", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1"),
			toolResult("c1"),
			progressCall("n1"),
			toolResult("n1", "notify_user"),
			assistantText("done"),
		];
		const folds = buildRoundFolds(entries, false);
		expect(folds).toHaveLength(1);
		expect(folds[0]!.exempt).toContain(3);
		expect(isInsideFold(folds, 3)).toBe(false);
		expect(folds[0]!.toolCount).toBe(1);
	});

	test("a progress update breaks tool runs instead of joining a summary", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1"),
			toolResult("c1"),
			assistantToolCall("c2"),
			toolResult("c2"),
			progressCall("n1"),
			toolResult("n1", "notify_user"),
			assistantToolCall("c3"),
			toolResult("c3"),
			assistantToolCall("c4"),
			toolResult("c4"),
			assistantText("done"),
		];
		const runs = buildToolRuns(entries, false);
		expect(runs.map(run => run.headIdx)).toEqual([1, 7]);
		for (const run of runs) expect(run.idxs).not.toContain(5);
	});
});

describe("artifactRowSet (one deliverable predicate for both collapses)", () => {
	test("marks the row that carries an artifact tool call, result or not", () => {
		// The card renders on the CALL row, so the predicate must not wait for a
		// matching result row: a widget whose result lands in a custom entry (or
		// whose card streams in before the result) still counts as output.
		const entries = [userMsg(), assistantToolCall("w1", "widget"), assistantText("card above")];
		expect([...artifactRowSet(entries)]).toEqual([1]);
	});

	test("marks a row whose successful result produced a picture", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1", "generate_image"),
			withId({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "generate_image",
					content: [{ type: "text", text: "ok" }],
					details: { images: [{ data: "Zm9v", mimeType: "image/png" }] },
					isError: false,
					timestamp: 1,
				},
			}),
		];
		expect([...artifactRowSet(entries)]).toEqual([1]);
	});

	test("leaves process rows and errored artifacts out", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1", "read"),
			toolResult("c1", "read"),
			assistantToolCall("w1", "widget"),
			withId({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "w1",
					toolName: "widget",
					content: [{ type: "text", text: "bad spec" }],
					isError: true,
					timestamp: 1,
				},
			}),
		];
		expect(artifactRowSet(entries).has(1)).toBe(false);
	});
});

describe("buildToolRuns subagent boundary (Kimi Code client parity)", () => {
	test("a task call/result never joins a run and splits it in two", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1", "read"),
			toolResult("c1", "read"),
			assistantToolCall("c2", "grep"),
			toolResult("c2", "grep"),
			assistantToolCall("t1", "task"),
			toolResult("t1", "task"),
			assistantToolCall("c3", "read"),
			toolResult("c3", "read"),
			assistantToolCall("c4", "grep"),
			toolResult("c4", "grep"),
			assistantText("done"),
		];
		const runs = buildToolRuns(entries, false);
		expect(runs.map(run => run.headIdx)).toEqual([1, 7]);
		for (const run of runs) {
			expect(run.idxs).not.toContain(5);
			expect(run.idxs).not.toContain(6);
		}
	});
});

describe("buildRoundFolds web and subagent segments", () => {
	test("web research counts apart from codebase exploration", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1", "read"),
			toolResult("c1", "read"),
			assistantToolCall("c2", "fetch"),
			toolResult("c2", "fetch"),
			assistantText("done"),
		];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]?.exploreCount).toBe(1);
		expect(folds[0]?.webCount).toBe(1);
	});

	test("subagent results are counted on the fold header", () => {
		const entries = [userMsg(), assistantToolCall("t1", "task"), toolResult("t1", "task"), assistantText("done")];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]?.subagentCount).toBe(1);
	});
});

describe("buildToolRuns artifact boundary (deliverables are not process)", () => {
	test("a widget call/result ends the run instead of joining it", () => {
		const entries = [
			userMsg(),
			assistantToolCall("r1", "read"),
			toolResult("r1", "read"),
			assistantToolCall("g1", "grep"),
			toolResult("g1", "grep"),
			assistantToolCall("w1", "widget"),
			toolResult("w1", "widget"),
			assistantToolCall("r2", "read"),
			toolResult("r2", "read"),
			assistantToolCall("g2", "grep"),
			toolResult("g2", "grep"),
			assistantText("done"),
		];
		const runs = buildToolRuns(entries, false);
		expect(runs.map(run => run.headIdx)).toEqual([1, 7]);
		for (const run of runs) {
			expect(run.idxs).not.toContain(5);
			expect(run.idxs).not.toContain(6);
		}
	});
});

describe("failure exemption (a failed call never hides behind the fold)", () => {
	const failedResult = (toolCallId: string, toolName = "bash"): SessionEntry =>
		withId({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text: "exit 1" }],
				isError: true,
				timestamp: 1,
			},
		});

	test("the failed call's row and its result stay visible while the fold is closed", () => {
		const entries = [userMsg(), assistantToolCall("c1"), failedResult("c1"), assistantText("it broke")];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.exempt).toContain(1);
		expect(folds[0]!.exempt).toContain(2);
		expect(isInsideFold(folds, 1)).toBe(false);
		expect(isInsideFold(folds, 2)).toBe(false);
	});

	test("a successful sibling in the same round still folds", () => {
		const entries = [
			userMsg(),
			assistantToolCall("ok1"),
			toolResult("ok1"),
			assistantToolCall("bad1"),
			failedResult("bad1"),
			assistantText("done"),
		];
		const folds = buildRoundFolds(entries, false);
		expect(isInsideFold(folds, 1)).toBe(true);
		expect(isInsideFold(folds, 3)).toBe(false);
	});

	test("a failed bash execution stays visible", () => {
		const exited: SessionEntry = withId({
			type: "message",
			message: {
				role: "bashExecution",
				command: "false",
				output: "",
				exitCode: 1,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
		});
		const entries = [userMsg(), exited, assistantText("done")];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.exempt).toContain(1);
	});

	test("counts the failures so the header can say so", () => {
		const entries = [userMsg(), assistantToolCall("c1"), failedResult("c1"), assistantText("done")];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.failedCount).toBe(1);
	});

	test("a summary counts the failure and names it instead of averaging it away", () => {
		// The action still counts (it happened) — but a run that absorbed a
		// failure without saying so would turn a broken step into a tidy line.
		const entries = [
			userMsg(),
			assistantToolCall("ok1"),
			toolResult("ok1"),
			assistantToolCall("bad1"),
			failedResult("bad1"),
			assistantToolCall("ok2"),
			toolResult("ok2"),
			assistantText("done"),
		];
		const runs = buildToolRuns(entries, false);
		expect(runs.length).toBe(1);
		expect(runs[0]!.failed).toBe(1);
		// All three calls still count toward the run.
		expect(runs[0]!.idxs.length).toBe(6);
	});
});

describe("tool time inside a round", () => {
	const timed = (toolCallId: string, durationMs: number | undefined, toolName = "bash"): SessionEntry =>
		withId({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text: "ok" }],
				isError: false,
				...(durationMs === undefined ? {} : { durationMs }),
				timestamp: 1,
			},
		});

	test("sums the durations the rows recorded", () => {
		const entries = [
			userMsg(),
			assistantToolCall("a"),
			timed("a", 1_200),
			assistantToolCall("b"),
			timed("b", 300),
			assistantText("done"),
		];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.toolMs).toBe(1_500);
	});

	test("treats a missing duration as unknown, never as zero", () => {
		// A journal written before timing existed must not drag the total down
		// as if that call had taken no time.
		const entries = [
			userMsg(),
			assistantToolCall("a"),
			timed("a", 1_200),
			assistantToolCall("b"),
			timed("b", undefined),
			assistantText("done"),
		];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.toolMs).toBe(1_200);
	});

	test("reports zero when nothing was timed at all", () => {
		const entries = [userMsg(), assistantToolCall("a"), timed("a", undefined), assistantText("done")];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.toolMs).toBe(0);
	});
});
