import { describe, expect, it } from "bun:test";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";

describe("SessionManager usage statistics", () => {
	it("accumulates premium requests from assistant messages and task tool results", () => {
		const session = SessionManager.inMemory();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-completions",
			provider: "github-copilot",
			model: "gpt-4o",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				premiumRequests: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "task_1",
			toolName: "task",
			content: [{ type: "text", text: "task output" }],
			details: {
				usage: {
					input: 2,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					premiumRequests: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			isError: false,
			timestamp: 3,
		});

		const usage = session.getUsageStatistics();
		expect(usage.input).toBe(12);
		expect(usage.output).toBe(8);
		expect(usage.premiumRequests).toBe(3);
	});

	it("keeps orchestration usage out of ordinary input while preserving total tokens", () => {
		const session = SessionManager.inMemory();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.5",
			usage: {
				input: 0,
				output: 29,
				cacheRead: 180_224,
				cacheWrite: 0,
				totalTokens: 185_882,
				orchestration: { input: 5_629 },
				cost: { input: 5.629, output: 0, cacheRead: 0, cacheWrite: 0, total: 5.629 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		});

		const usage = session.getUsageStatistics();
		expect(usage.input).toBe(0);
		expect(usage.cacheRead).toBe(180_224);
		expect(usage.totalTokens).toBe(185_882);
		expect(usage.orchestrationInput).toBe(5_629);
		expect(usage.cost).toBeCloseTo(5.629, 8);
	});

	it("preserves fractional premium request multipliers", () => {
		const session = SessionManager.inMemory();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "haiku" }],
			api: "anthropic-messages",
			provider: "github-copilot",
			model: "claude-haiku-4.5",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				premiumRequests: 0.33,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "task_1",
			toolName: "task",
			content: [{ type: "text", text: "task output" }],
			details: {
				usage: {
					input: 2,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					premiumRequests: 3,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			isError: false,
			timestamp: 3,
		});

		const usage = session.getUsageStatistics();
		expect(usage.premiumRequests).toBeCloseTo(3.33, 8);
	});
	it("defaults premium requests to zero when usage payload omits the field", () => {
		const session = SessionManager.inMemory();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4o",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		const usage = session.getUsageStatistics();
		expect(usage.premiumRequests).toBe(0);
	});

	it("accumulates the full billed cost across turns, including cache-read cost", () => {
		// Contract: the session cost aggregate sums each turn's full `cost.total`
		// (input+output+cacheRead+cacheWrite), not a cache-excluded "new-work"
		// subset. Cache-read cost is real billed spend — the cached context is
		// re-read at the cache-read rate every turn — so it must stay in the
		// ledger that /usage, ACP usage_update, and hooks consume. Two turns with
		// nonzero cacheRead make the readings diverge: full total = 18 vs the
		// excluded subset (input+output+cacheWrite) = 8.
		const session = SessionManager.inMemory();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		for (const timestamp of [2, 3]) {
			session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4",
				usage: {
					input: 1,
					output: 2,
					cacheRead: 100,
					cacheWrite: 10,
					totalTokens: 113,
					cost: { input: 1, output: 2, cacheRead: 5, cacheWrite: 1, total: 9 },
				},
				stopReason: "stop",
				timestamp,
			});
		}

		const usage = session.getUsageStatistics();
		expect(usage.cacheRead).toBe(200);
		expect(usage.cost).toBeCloseTo(18, 8);
	});

	it("counts journaled off-transcript spend and groups it by purpose family", () => {
		const session = SessionManager.inMemory();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		// Compaction summaries are billed like any request but never appear in the
		// transcript; their spend must still reach the session totals.
		for (const [purpose, total] of [
			["compaction:remote", 2],
			["compaction:handoff", 3],
			["recap", 0.5],
		] as const) {
			session.appendModelUsage({
				purpose,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
				},
				stopReason: "stop",
			});
		}

		const usage = session.getUsageStatistics();
		expect(usage.cost).toBeCloseTo(6.5, 8);
		expect(usage.totalTokens).toBe(3 + 15 * 3);
		// `compaction:remote` and `compaction:handoff` share one family; recap is its own.
		expect(usage.offTranscriptCost).toEqual({ compaction: 5, recap: 0.5 });
	});

	it("keeps journaled spend out of the transcript entries", () => {
		const session = SessionManager.inMemory();
		session.appendModelUsage({
			purpose: "compaction:soft",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		});

		const entries = session.getEntries();
		expect(entries.map(entry => entry.type)).toEqual(["model_usage"]);
		// The model context never takes it: only `message`/`custom_message` entries
		// contribute, so a usage record cannot leak into a prompt.
		expect(session.buildSessionContext().messages).toEqual([]);
	});
});
