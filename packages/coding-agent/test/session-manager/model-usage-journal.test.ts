/**
 * Contract test for the off-transcript usage journal: a compaction attempt's
 * spend lands on a `model_usage` entry under `compaction:<method>`, and a
 * failing ledger never breaks the call it accounts for.
 */
import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@musepi/pi-ai";
import { isModelUsageLedger, journalCompaction, journalCompletion } from "../../src/session/model-usage-journal";
import type { ModelUsageRecord } from "../../src/session/session-entries";

const usage = {
	input: 100,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0.5, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.7 },
};

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "summary" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage,
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	} as AssistantMessage;
}

function ledger(): { records: ModelUsageRecord[]; appendModelUsage(record: ModelUsageRecord): string } {
	const records: ModelUsageRecord[] = [];
	return {
		records,
		appendModelUsage(record) {
			records.push(record);
			return `id-${records.length}`;
		},
	};
}

describe("model usage journal", () => {
	test("names the compaction method so remote and handoff spend stay apart", () => {
		const target = ledger();
		journalCompaction(target, "remote")!(message());
		journalCompaction(target, "handoff")!(message());
		journalCompaction(target, undefined)!(message());

		expect(target.records.map(record => record.purpose)).toEqual([
			"compaction:remote",
			"compaction:handoff",
			"compaction:unknown",
		]);
	});

	test("carries the billed usage, stop reason and duration", () => {
		const target = ledger();
		journalCompletion(target, { purpose: "compaction:soft", role: "smol" })?.(message({ duration: 1234 }));

		const [record] = target.records;
		expect(record).toMatchObject({
			purpose: "compaction:soft",
			role: "smol",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			stopReason: "stop",
			duration: 1234,
		});
		expect(record?.usage.cost.total).toBeCloseTo(0.7, 8);
	});

	test("keeps a failed attempt, with its reason", () => {
		const target = ledger();
		journalCompaction(target, "soft")!(message({ stopReason: "error", errorMessage: "overloaded_error" }));
		expect(target.records[0]).toMatchObject({ stopReason: "error", errorMessage: "overloaded_error" });
	});

	test("is undefined without a ledger, and never throws from a failing one", () => {
		expect(journalCompaction(undefined, "soft")).toBeUndefined();
		expect(isModelUsageLedger({})).toBe(false);

		const broken = {
			appendModelUsage() {
				throw new Error("disk full");
			},
		};
		expect(() => journalCompaction(broken, "soft")!(message())).not.toThrow();
	});
});
