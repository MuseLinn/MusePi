// MusePi core — snapcompact 引擎测试。
// 覆盖：serialize（容量帽/无用结果跳过/孤儿结果/intent 注释）、
// planArchive（短历史不压/边缘逐字/超长多帧/最老丢弃）、
// snapCompact 保真（文件路径、未完成任务、错误状态、FILES 段、
// 前次 LLM 摘要折叠、再压缩展开一致性）。
import assert from "node:assert";
import { describe, it } from "node:test";
import {
	computeFileLists,
	estimateTokensFromChars,
	FRAME_CHAR_CAPACITY,
	formatFileList,
	planArchive,
	serializeConversation,
	snapCompact,
	TOOL_RESULT_MAX_CHARS,
	truncateForArchive,
	type SnapMessage,
} from "../src/snapcompact/index.ts";

function user(text: string): SnapMessage {
	return { role: "user", content: text };
}

function assistant(text: string): SnapMessage {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function toolCall(id: string, name: string, args: Record<string, unknown>, intent?: string): SnapMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args, ...(intent ? { intent } : {}) }] };
}

function toolResult(id: string, text: string, opts?: { isError?: boolean; useless?: boolean }): SnapMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text }],
		toolCallId: id,
		isError: opts?.isError,
		useless: opts?.useless,
	};
}

function emptyFileOps() {
	return { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
}

// =============================================================================
// serialize
// =============================================================================

describe("serializeConversation", () => {
	it("merges tool results into their call blocks", () => {
		const text = serializeConversation([toolCall("c1", "bash", { command: "ls" }), toolResult("c1", "file-a\nfile-b")]);
		assert.ok(text.includes("¶call:"));
		assert.ok(text.includes("bash(command=\"ls\")"));
		assert.ok(text.includes("<out>\nfile-a\nfile-b\n</out>"));
	});

	it("skips useless results together with their calls, but keeps errors", () => {
		const text = serializeConversation([
			toolCall("c1", "bash", { command: "true" }),
			toolResult("c1", "", { useless: true }),
			toolCall("c2", "bash", { command: "make" }),
			toolResult("c2", "CC main.c\nerror: boom", { isError: true, useless: true }),
		]);
		assert.ok(!text.includes('"true"'));
		assert.ok(text.includes("error: boom")); // errors are never useless
	});

	it("renders orphan results standalone", () => {
		const text = serializeConversation([toolResult("c9", "orphan output")]);
		assert.ok(text.includes("¶call:"));
		assert.ok(text.includes("orphan output"));
	});

	it("renders intent as a trailing comment and drops it from args", () => {
		const text = serializeConversation([
			toolCall("c1", "edit", { path: "a.ts", intent: "fix the bug", oldText: "x" }),
		]);
		assert.ok(text.includes("//fix the bug"));
		assert.ok(!text.includes("intent="));
	});

	it("caps long tool results head-biased, keeping the error at the tail", () => {
		const body = `${"ok line\n".repeat(4000)}FATAL: assertion failed at end`;
		const text = serializeConversation([toolCall("c1", "bash", { command: "test" }), toolResult("c1", body)]);
		assert.ok(text.includes("[…"));
		assert.ok(text.includes("FATAL: assertion failed at end")); // tail survives
		assert.ok(text.length < body.length);
	});

	it("truncateForArchive keeps head and tail with an elision marker", () => {
		const out = truncateForArchive("a".repeat(100) + "b".repeat(100), 100, 0.6);
		assert.ok(out.startsWith("a".repeat(60)));
		assert.ok(out.endsWith("b".repeat(40)));
		assert.ok(out.includes("100ch elided"));
	});
});

// =============================================================================
// planArchive (帧布局)
// =============================================================================

describe("planArchive", () => {
	it("keeps short history fully verbatim (no frames, no compression)", () => {
		const layout = planArchive("short history");
		assert.equal(layout.textHead, "short history");
		assert.equal(layout.middle, "");
		assert.equal(layout.frames.length, 0);
		assert.equal(layout.truncatedChars, 0);
		assert.equal(layout.keptText, "short history");
	});

	it("pages the middle into frames and keeps both edges verbatim", () => {
		const head = "H".repeat(100);
		const middle = "M".repeat(FRAME_CHAR_CAPACITY * 3);
		const tail = "T".repeat(100);
		const layout = planArchive(head + middle + tail, 4 * FRAME_CHAR_CAPACITY);
		// edges take one frame capacity each; the middle keeps what remains
		assert.equal(layout.textHead, head + "M".repeat(FRAME_CHAR_CAPACITY - 100));
		assert.ok(layout.textTail.endsWith(tail));
		assert.equal(layout.frames.length, 2); // 多帧（6200 chars → 2 页）
		assert.equal(layout.truncatedChars, 0);
	});

	it("drops the OLDEST middle content when over budget", () => {
		const marker = "OLDEST_PART";
		const text = marker + "x".repeat(FRAME_CHAR_CAPACITY * 10);
		const budget = 4 * FRAME_CHAR_CAPACITY;
		const layout = planArchive(text, budget);
		// 预算 4 帧：2 帧边缘 + 2 帧中部；其余从最老端丢弃
		assert.equal(layout.keptText.length, budget);
		assert.equal(layout.truncatedChars, text.length - budget);
		assert.ok(layout.keptText.startsWith(marker)); // 头边缘完整
		assert.equal(layout.keptText.endsWith("x".repeat(100)), true); // 尾边缘完整
		assert.equal(layout.frames.length, 2);
	});

	it("estimateTokensFromChars uses chars/4", () => {
		assert.equal(estimateTokensFromChars(100), 25);
		assert.equal(estimateTokensFromChars(101), 26);
	});
});

// =============================================================================
// snapCompact 保真
// =============================================================================

describe("snapCompact fidelity", () => {
	it("preserves file paths, unfinished tasks and error states", () => {
		const messages: SnapMessage[] = [
			user("Please refactor packages/musepi/core/src/snapcompact/engine.ts and finish the wiring task"),
			assistant("I'll start by reading the engine file."),
			toolCall("c1", "bash", { command: "npm test" }),
			toolResult("c1", `${"pass\n".repeat(5000)}FAIL test/snapcompact.test.ts\nError: expected 3 frames, got 2`, { isError: true }),
			user("The wiring task is still not done — frames must render before the FILES section."),
		];
		const result = snapCompact({ messages, fileOps: emptyFileOps(), archiveMaxChars: 12_000 });
		assert.ok(result.summary.includes("packages/musepi/core/src/snapcompact/engine.ts")); // 文件路径
		assert.ok(result.summary.includes("FAIL test/snapcompact.test.ts")); // 错误状态（尾部保真）
		assert.ok(result.summary.includes("wiring task is still not done")); // 未完成任务（新近用户消息）
		assert.ok(result.summary.includes("Reading guide"));
		assert.equal(result.archive.truncatedChars, 0);
	});

	it("emits a FILES section with Read/Write/RW markers", () => {
		const ops = emptyFileOps();
		ops.read.add("src/a.ts");
		ops.read.add("src/b.ts");
		ops.written.add("src/b.ts");
		ops.edited.add("src/c.ts");
		ops.read.add("https://example.com/doc"); // URL-scheme pseudo path filtered
		const { readFiles, modifiedFiles } = computeFileLists(ops);
		const list = formatFileList(readFiles, modifiedFiles, ops.read);
		assert.ok(list.includes("src/a.ts (Read)"));
		assert.ok(list.includes("src/b.ts (RW)"));
		assert.ok(list.includes("src/c.ts (Write)"));
		assert.ok(!list.includes("example.com"));

		const result = snapCompact({ messages: [user("hi")], fileOps: ops });
		assert.ok(result.summary.includes("<files>"));
		assert.deepEqual(result.readFiles, ["src/a.ts"]);
		assert.deepEqual(result.modifiedFiles, ["src/b.ts", "src/c.ts"]);
	});

	it("folds a previous LLM summary in at the archive head", () => {
		const result = snapCompact({
			messages: [user("recent work")],
			previousSummary: "Earlier we built the LSP module.",
			fileOps: emptyFileOps(),
		});
		// 前次 LLM 摘要作为 archive 源头文本排在最前，保持连续性
		assert.ok(result.summary.includes("Earlier we built the LSP module."));
		assert.ok(result.summary.indexOf("Earlier we built the LSP module.") < result.summary.indexOf("recent work"));
	});

	it("re-compaction unfolds the prior archive coherently (no duplication, truncation accumulates)", () => {
		const first = snapCompact({
			messages: [user("phase one: " + "x".repeat(30_000))],
			fileOps: emptyFileOps(),
			archiveMaxChars: 24_000,
		});
		const second = snapCompact({
			messages: [user("phase two")],
			previousSummary: undefined,
			previousArchive: first.archive,
			fileOps: emptyFileOps(),
			archiveMaxChars: 24_000,
		});
		assert.ok(second.summary.includes("phase two"));
		assert.equal(second.archive.truncatedChars >= first.archive.truncatedChars, true);
		// 第二遍的 archive 是唯一来源：phase one 的内容只出现一次（展开后重排，不重复）
		const occurrences = second.archive.text.split("phase one").length - 1;
		assert.equal(occurrences <= 1, true);
		assert.ok(second.archive.text.length <= 24_000);
	});
});
