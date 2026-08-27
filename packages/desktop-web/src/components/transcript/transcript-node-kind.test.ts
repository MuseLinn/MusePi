import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { transcriptNodeKind } from "./Transcript";

/** Minimal EntryBase fields shared by every SessionEntry. */
const base = { id: "e1", parentId: null, timestamp: "0" };

/** message fixture: only `entry.type` + `entry.message.role` matter for the
 *  dispatch key; other WireMessage fields are irrelevant to this contract. */
const msg = (message: object): SessionEntry =>
	({ ...base, type: "message", message }) as unknown as SessionEntry;

/** transcript.node seat 派发键 → entry 的确定性映射 (DSH entryKey 类比)。
 *  每条断言证明一个可观察契约:给定 wire entry,kind 是稳定派发字符串。 */
describe("transcriptNodeKind dispatch", () => {
	test("message entries dispatch by role", () => {
		expect(transcriptNodeKind(msg({ role: "user", content: "hi", timestamp: 1 }))).toBe("message:user");
		expect(transcriptNodeKind(msg({ role: "assistant", content: "ok", timestamp: 1 }))).toBe("message:assistant");
		expect(transcriptNodeKind(msg({ role: "toolResult", toolCallId: "c1", content: [], isError: false, timestamp: 1 }))).toBe(
			"message:tool_result",
		);
		expect(
			transcriptNodeKind(msg({ role: "bashExecution", command: "ls", output: "out", exitCode: 0, timestamp: 1 })),
		).toBe("message:bash_execution");
	});

	test("custom_message entries dispatch by customType", () => {
		expect(
			transcriptNodeKind({ ...base, type: "custom_message", customType: "advisor", content: "x", display: true } as SessionEntry),
		).toBe("custom_message:advisor");
		expect(
			transcriptNodeKind({ ...base, type: "custom_message", customType: "irc:incoming", content: "x", display: true } as SessionEntry),
		).toBe("custom_message:irc:incoming");
	});

	test("non-message entry types dispatch on their own discriminant", () => {
		expect(
			transcriptNodeKind({ ...base, type: "compaction", summary: "s", firstKeptEntryId: "e0", tokensBefore: 10 } as SessionEntry),
		).toBe("compaction");
		expect(
			transcriptNodeKind({ ...base, type: "branch_summary", fromId: "e0", summary: "s" } as SessionEntry),
		).toBe("branch_summary");
		expect(
			transcriptNodeKind({ ...base, type: "model_change", model: "x/y" } as SessionEntry),
		).toBe("model_change");
		expect(
			transcriptNodeKind({ ...base, type: "thinking_level_change", thinkingLevel: "high" } as SessionEntry),
		).toBe("thinking_level_change");
	});
});
