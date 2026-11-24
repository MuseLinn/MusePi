import { describe, expect, it } from "bun:test";
import type { SessionEntry, WireUsage } from "@musepi/pi-wire";
import type { SessionStats } from "../src/session/agent-session-types";
import {
	contextUsageProjectionDefinition,
	type ProjectionSampleSource,
	SessionProjectionRegistry,
} from "../src/session/session-projections";

const usage = (input: number, output: number, cacheRead = 0): WireUsage => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + output + cacheRead,
	cost: { total: 0.01 },
});

function assistant(timestamp: number, u: WireUsage): SessionEntry {
	return {
		type: "message",
		id: `assistant:${timestamp}`,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			model: "m",
			provider: "prov",
			usage: u,
			stopReason: "stop",
			content: [],
			timestamp,
		},
	} as unknown as SessionEntry;
}

function stats(overrides: Partial<SessionStats> = {}): SessionStats {
	return {
		sessionFile: undefined,
		sessionId: "s",
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		tokens: { input: 500, output: 250, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 750 },
		premiumRequests: 0,
		cost: 0.25,
		contextUsage: { tokens: 500, contextWindow: 10_000, percent: 5 },
		...overrides,
	};
}

const source = (value: SessionStats): ProjectionSampleSource => ({
	model: () => ({ provider: "prov", id: "m", contextWindow: 10_000 }),
	sessionStats: () => value,
});

describe("contextUsage projection", () => {
	it("folds assistant settlements and replaces a retried timestamp", () => {
		const registry = new SessionProjectionRegistry();
		registry.register(contextUsageProjectionDefinition);
		registry.seed("s", { entries: [assistant(1, usage(100, 10))] });
		const baseline = registry.snapshot("s")!;
		const value = baseline.values.contextUsage as {
			model: string;
			tokens: number;
			usage: { input: number; output: number; totalTokens: number; cost: number };
		};
		expect(value.model).toBe("prov/m");
		// Prompt-side occupancy: input + cache traffic; output is not pressure.
		expect(value.tokens).toBe(100);
		expect(value.usage.input).toBe(100);
		expect(value.usage.output).toBe(10);

		const changes = registry.applyEvent("s", {
			type: "message_end",
			message: {
				role: "assistant",
				model: "m",
				provider: "prov",
				usage: usage(100, 10),
				stopReason: "stop",
				content: [],
				timestamp: 1,
			},
		} as never);
		// Same timestamp re-emit: no double count, no view change.
		expect(changes).toEqual([]);
		const after = registry.snapshot("s")!.values.contextUsage as { usage: { totalTokens: number } };
		expect(after.usage.totalTokens).toBe(110);
	});

	it("samples the live stats at a turn boundary", () => {
		let current = stats();
		const liveSource: ProjectionSampleSource = {
			model: () => ({ provider: "prov", id: "m", contextWindow: 10_000 }),
			sessionStats: () => current,
		};
		const registry = new SessionProjectionRegistry();
		registry.register(contextUsageProjectionDefinition);
		registry.seed("s", { entries: [assistant(1, usage(100, 10))], source: liveSource });
		const baseline = registry.snapshot("s")!.values.contextUsage as { tokens: number; usage: { cost: number } };
		expect(baseline.tokens).toBe(500);
		expect(baseline.usage.cost).toBe(0.25);

		current = stats({
			contextUsage: { tokens: 800, contextWindow: 10_000, percent: 8 },
			tokens: { input: 800, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1100 },
			cost: 0.5,
		});
		const changes = registry.applyEvent("s", { type: "turn_end" } as never);
		expect(changes.length).toBeGreaterThan(0);
		expect(registry.snapshot("s")!.values.contextUsage).toMatchObject({ tokens: 800, usage: { cost: 0.5 } });
	});
});
