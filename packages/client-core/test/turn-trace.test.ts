import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { buildTurnTrace } from "../src/components/transcript/turn-trace";

const base = { parentId: null, timestamp: "0" };
let seq = 0;
const withId = (overrides: object): SessionEntry =>
	({ ...base, id: `t${++seq}`, ...overrides }) as unknown as SessionEntry;

const usage = (input: number, output: number, cost: number) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { total: cost },
});

const user = (ts: number): SessionEntry =>
	withId({ type: "message", message: { role: "user", content: "go", timestamp: ts } });

const model = (ts: number, opts: { duration?: number; usage?: ReturnType<typeof usage> } = {}): SessionEntry =>
	withId({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			model: "test/model",
			usage: opts.usage ?? usage(100, 20, 0.01),
			stopReason: "stop",
			timestamp: ts,
			...(opts.duration === undefined ? {} : { duration: opts.duration }),
		},
	});

const call = (ts: number, id: string, name = "bash"): SessionEntry =>
	withId({
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }], timestamp: ts },
	});

const result = (
	ts: number,
	id: string,
	opts: { durationMs?: number; isError?: boolean; name?: string } = {},
): SessionEntry =>
	withId({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: opts.name ?? "bash",
			content: [{ type: "text", text: "out" }],
			isError: opts.isError ?? false,
			...(opts.durationMs === undefined ? {} : { durationMs: opts.durationMs }),
			timestamp: ts,
		},
	});

describe("buildTurnTrace", () => {
	it("returns null when the turn has no rows", () => {
		expect(buildTurnTrace([user(1_000)], 0, 0)).toBeNull();
	});

	it("puts a model step and a tool step on one time axis", () => {
		const entries = [
			user(1_000),
			model(2_000, { duration: 800 }),
			call(2_800, "c1"),
			result(5_800, "c1", { durationMs: 3_000 }),
			model(6_000, { duration: 500 }),
		];
		const trace = buildTurnTrace(entries, 0, entries.length - 1)!;
		// Every assistant message is one provider round, so the tool-call-only
		// message is a step of its own: model, model, tool, model.
		expect(trace.steps.map(s => s.kind)).toEqual(["model", "model", "tool", "model"]);
		const tool = trace.steps[2]!;
		expect(tool.label).toBe("bash");
		expect(tool.durationMs).toBe(3_000);
		// The axis starts at the turn-start user message, not the first step.
		expect(trace.startedAt).toBe(1_000);
		expect(tool.offsetPct).toBeGreaterThan(0);
		expect(tool.offsetPct).toBeLessThan(100);
	});

	it("marks a failed call and keeps its status", () => {
		const entries = [user(0), call(1_000, "c1"), result(2_000, "c1", { durationMs: 900, isError: true })];
		const trace = buildTurnTrace(entries, 0, entries.length - 1)!;
		// steps: the call's own model round, then the tool result.
		const tool = trace.steps.find(step => step.kind === "tool")!;
		expect(tool.status).toBe("error");
		expect(trace.totals.failed).toBe(1);
	});

	it("reports unknown timing as unknown instead of zero", () => {
		// A journal from before tool timing existed: the step is placed at its
		// timestamp but has no width, and the totals say how many were untimed.
		const entries = [user(0), call(1_000, "c1"), result(2_000, "c1", {})];
		const trace = buildTurnTrace(entries, 0, entries.length - 1)!;
		const tool = trace.steps.find(step => step.kind === "tool")!;
		expect(tool.durationMs).toBeUndefined();
		expect(trace.totals.untimedSteps).toBe(2);
		expect(trace.totals.toolMs).toBe(0);
	});

	it("sums tool time and model time separately", () => {
		const entries = [
			user(0),
			model(1_000, { duration: 700 }),
			call(2_000, "c1"),
			result(4_000, "c1", { durationMs: 2_000 }),
			call(4_100, "c2"),
			result(4_600, "c2", { durationMs: 500 }),
			model(5_000, { duration: 300 }),
		];
		const trace = buildTurnTrace(entries, 0, entries.length - 1)!;
		expect(trace.totals.toolMs).toBe(2_500);
		expect(trace.totals.modelMs).toBe(1_000);
	});

	it("sums tokens and cost across the turn's model calls", () => {
		const entries = [
			user(0),
			model(1_000, { usage: usage(1_000, 200, 0.02) }),
			model(2_000, { usage: usage(500, 100, 0.01) }),
		];
		const trace = buildTurnTrace(entries, 0, entries.length - 1)!;
		expect(trace.totals.input).toBe(1_500);
		expect(trace.totals.output).toBe(300);
		expect(trace.totals.cost).toBeCloseTo(0.03, 6);
	});

	it("keeps every step inside the 0-100 axis", () => {
		const entries = [
			user(0),
			model(1_000, { duration: 10_000 }),
			call(1_000, "c1"),
			result(20_000, "c1", { durationMs: 19_000 }),
		];
		const trace = buildTurnTrace(entries, 0, entries.length - 1)!;
		for (const step of trace.steps) {
			expect(step.offsetPct).toBeGreaterThanOrEqual(0);
			expect(step.offsetPct + step.widthPct).toBeLessThanOrEqual(100.001);
		}
	});

	it("gives an untimed step a visible sliver so it is not invisible", () => {
		const entries = [user(0), call(1_000, "c1"), result(2_000, "c1", {})];
		const trace = buildTurnTrace(entries, 0, entries.length - 1)!;
		const tool = trace.steps.find(step => step.kind === "tool")!;
		expect(tool.widthPct).toBeGreaterThan(0);
	});
});

describe("delegated members of a task call", () => {
	const taskResult = (details: unknown): SessionEntry =>
		withId({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "task",
				content: [{ type: "text", text: "spawned" }],
				details,
				isError: false,
				startedAt: 1_000,
				durationMs: 5_000,
				timestamp: 6_000,
			},
		});

	it("shows each member with its own duration, tokens and outcome", () => {
		const entries = [
			user(0),
			call(1_000, "c1", "task"),
			taskResult({
				results: [
					{ id: "m1", agent: "reviewer", description: "审查改动", durationMs: 3_000, tokens: 12_000, exitCode: 0 },
					{ id: "m2", agent: "researcher", lastIntent: "查资料", durationMs: 2_000, tokens: 5_000, exitCode: 1 },
				],
			}),
		];
		const trace = buildTurnTrace(entries, 0, entries.length - 1)!;
		const task = trace.steps.find(step => step.kind === "tool")!;
		expect(task.children?.map(child => child.label)).toEqual(["reviewer", "researcher"]);
		expect(task.children?.[0]?.durationMs).toBe(3_000);
		expect(task.children?.[0]?.tokens).toBe(12_000);
		expect(task.children?.[1]?.status).toBe("error");
		expect(task.children?.[1]?.detail).toBe("查资料");
	});

	it("leaves a plain tool call without children", () => {
		const entries = [user(0), call(1_000, "c1"), result(2_000, "c1", { durationMs: 500 })];
		const trace = buildTurnTrace(entries, 0, entries.length - 1)!;
		expect(trace.steps.find(step => step.kind === "tool")?.children).toBeUndefined();
	});

	it("ignores a malformed task payload instead of dropping the row", () => {
		const entries = [user(0), call(1_000, "c1", "task"), taskResult({ results: "nope" })];
		const trace = buildTurnTrace(entries, 0, entries.length - 1)!;
		const task = trace.steps.find(step => step.kind === "tool")!;
		expect(task.children).toBeUndefined();
		expect(task.label).toBe("task");
	});
});
