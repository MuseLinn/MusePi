// MusePi snapcompact — host seam tests (musepi/snapcompact/native.ts).
// 覆盖：策略门控（default → undefined，snapcompact → 完整 CompactionResult）、
// CompactionEntry.details 的 archive 往返（findPreviousArchive）、
// registerNativeHandler 与 ExtensionRunner emit 的集成。

import { mergeMusepiSettings, type SnapArchiveState } from "@musepi/core";
import { describe, expect, test } from "vitest";
import type { CompactionPreparation } from "../src/core/compaction/index.ts";
import type { SessionBeforeCompactEvent } from "../src/core/extensions/index.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import {
	findPreviousArchive,
	handleMusepiSnapcompact,
	initMusepiSnapcompact,
} from "../src/musepi/snapcompact/native.ts";

function settingsWith(strategy: "default" | "snapcompact"): SettingsManager {
	return { getMusepi: () => mergeMusepiSettings({ compaction: { strategy } }) } as SettingsManager;
}

function assistantMessage(
	text: string,
	toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>,
) {
	return {
		role: "assistant" as const,
		content: [
			{ type: "text" as const, text },
			...(toolCalls ?? []).map((call) => ({
				type: "toolCall" as const,
				id: call.id,
				name: call.name,
				arguments: call.args,
			})),
		],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "entry-keep-1",
		messagesToSummarize: [
			{
				role: "user",
				content: [{ type: "text", text: "Refactor src/app/main.ts and keep the tests green" }],
				timestamp: Date.now(),
			},
			assistantMessage("On it.", [{ id: "c1", name: "edit", args: { path: "src/app/main.ts" } }]),
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "edit",
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/app/main.ts." }],
				details: {},
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "user",
				content: [{ type: "text", text: "The migration task is still unfinished." }],
				timestamp: Date.now(),
			},
		],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 123_456,
		fileOps: {
			read: new Set(["src/app/main.ts"]),
			written: new Set<string>(),
			edited: new Set(["src/app/main.ts"]),
		},
		settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
	};
}

function eventOf(prep: CompactionPreparation, branchEntries: unknown[] = []): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		preparation: prep,
		branchEntries: branchEntries as never,
		customInstructions: undefined,
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	} as SessionBeforeCompactEvent;
}

describe("handleMusepiSnapcompact", () => {
	test("default strategy returns undefined (pi behavior untouched)", () => {
		expect(handleMusepiSnapcompact(eventOf(preparation()), settingsWith("default"))).toBeUndefined();
	});

	test("snapcompact strategy returns a full CompactionResult with persisted archive", () => {
		const result = handleMusepiSnapcompact(eventOf(preparation()), settingsWith("snapcompact"));
		expect(result?.compaction).toBeDefined();
		const compaction = result!.compaction!;
		expect(compaction.firstKeptEntryId).toBe("entry-keep-1");
		expect(compaction.tokensBefore).toBe(123_456);
		expect(compaction.usage).toBeUndefined(); // 无 LLM 调用
		expect(compaction.summary).toContain("src/app/main.ts");
		expect(compaction.summary).toContain("migration task is still unfinished");
		expect(compaction.summary).toContain("<files>");
		expect(compaction.summary).toContain("src/app/main.ts (RW)");
		const details = compaction.details as {
			readFiles: string[];
			modifiedFiles: string[];
			snapcompact: SnapArchiveState;
		};
		expect(details.modifiedFiles).toEqual(["src/app/main.ts"]);
		expect(details.snapcompact.version).toBe(1);
		expect(details.snapcompact.text.length).toBeGreaterThan(0);
	});
});

describe("findPreviousArchive", () => {
	const archive: SnapArchiveState = { text: "ARCHIVED SOURCE", truncatedChars: 42, version: 1 };

	test("reads the archive from the latest compaction entry details", () => {
		const entries = [
			{ type: "message" },
			{ type: "compaction", summary: "s", details: { readFiles: [], modifiedFiles: [], snapcompact: archive } },
			{ type: "message" },
		];
		expect(findPreviousArchive(entries)).toEqual(archive);
	});

	test("returns undefined when the latest compaction was not snapcompact", () => {
		const entries = [
			{ type: "compaction", summary: "old", details: { snapcompact: archive } },
			{ type: "compaction", summary: "newer", details: { readFiles: [] } },
		];
		expect(findPreviousArchive(entries)).toBeUndefined();
	});

	test("second pass unfolds the archive from branch entries", () => {
		const prep = preparation();
		const first = handleMusepiSnapcompact(eventOf(prep), settingsWith("snapcompact"))!.compaction!;
		const branch = [{ type: "compaction", summary: first.summary, details: first.details }, { type: "message" }];
		const second = handleMusepiSnapcompact(eventOf(prep, branch), settingsWith("snapcompact"))!.compaction!;
		const secondDetails = second.details as { snapcompact: SnapArchiveState };
		const firstDetails = first.details as { snapcompact: SnapArchiveState };
		expect(secondDetails.snapcompact.text).toContain(firstDetails.snapcompact.text.slice(0, 60));
	});
});

describe("ExtensionRunner integration", () => {
	test("registerNativeHandler makes hasHandlers true and emit returns the compaction", async () => {
		const runner = new ExtensionRunner([], {} as never, process.cwd(), {} as never, {} as never);
		initMusepiSnapcompact(settingsWith("snapcompact"), runner);
		expect(runner.hasHandlers("session_before_compact")).toBe(true);
		const result = (await runner.emit(eventOf(preparation()) as never)) as { compaction?: unknown };
		expect(result?.compaction).toBeDefined();
	});

	test("default strategy emits undefined compaction through the runner", async () => {
		const runner = new ExtensionRunner([], {} as never, process.cwd(), {} as never, {} as never);
		initMusepiSnapcompact(settingsWith("default"), runner);
		const result = (await runner.emit(eventOf(preparation()) as never)) as { compaction?: unknown } | undefined;
		expect(result?.compaction).toBeUndefined();
	});
});
