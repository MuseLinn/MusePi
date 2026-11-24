import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnTracePanel } from "../src/components/transcript/TurnTracePanel";
import type { TurnTrace } from "../src/components/transcript/turn-trace";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const trace = (overrides: Partial<TurnTrace> = {}): TurnTrace => ({
	startedAt: 0,
	endedAt: 10_000,
	steps: [
		{
			id: "m1",
			kind: "model",
			label: "test/model",
			startedAt: 0,
			durationMs: 800,
			status: "ok",
			offsetPct: 0,
			widthPct: 8,
		},
		{
			id: "c1",
			kind: "tool",
			label: "bash",
			detail: "bun test",
			startedAt: 2_000,
			durationMs: 3_000,
			status: "error",
			offsetPct: 20,
			widthPct: 30,
		},
	],
	totals: {
		modelMs: 800,
		toolMs: 3_000,
		timedSteps: 2,
		untimedSteps: 0,
		failed: 1,
		input: 1_500,
		output: 300,
		cached: 0,
		cost: 0.03,
	},
	...overrides,
});

describe("TurnTracePanel", () => {
	it("draws one row per step with its own bar", () => {
		const html = renderToStaticMarkup(<TurnTracePanel trace={trace()} />);
		expect(html.match(/class="tr-trace-row"/g)?.length).toBe(2);
		expect(html.match(/class="tr-trace-bar"/g)?.length).toBe(2);
	});

	it("positions each bar from the step's own offset and width", () => {
		const html = renderToStaticMarkup(<TurnTracePanel trace={trace()} />);
		expect(html).toContain("inset-inline-start:20%");
		expect(html).toContain("width:30%");
	});

	it("marks a failed step in words, not only in colour", () => {
		const html = renderToStaticMarkup(<TurnTracePanel trace={trace()} />);
		expect(html).toContain('data-status="error"');
		expect(html).toMatch(/失败|failed/);
	});

	it("shows the totals the header cannot: model time, tokens and cost", () => {
		const html = renderToStaticMarkup(<TurnTracePanel trace={trace()} />);
		expect(html).toContain("3.0s");
		expect(html).toContain("800ms");
		expect(html).toContain("1.5k");
		expect(html).toContain("$0.03");
	});

	it("never shows a bare 0ms total for a turn whose steps were all untimed", () => {
		// "0ms" for the tools column reads as "the tools took no time"; the truth
		// is that nobody recorded it.
		const untimed = trace({
			steps: [
				{ id: "m1", kind: "model", label: "m", startedAt: 0, status: "ok", offsetPct: 0, widthPct: 0.6 },
				{ id: "c1", kind: "tool", label: "bash", startedAt: 0, status: "ok", offsetPct: 0, widthPct: 0.6 },
			],
			totals: { ...trace().totals, toolMs: 0, modelMs: 0, timedSteps: 0, untimedSteps: 2, failed: 0 },
		});
		const html = renderToStaticMarkup(<TurnTracePanel trace={untimed} />);
		expect(html).not.toContain(">0ms<");
		expect(html.match(/untimed|未记录/g)?.length).toBeGreaterThanOrEqual(2);
	});

	it("marks a partial total as a floor, not a sum", () => {
		// Two model rounds, one of them untimed: the model column can only be a
		// lower bound, and the "+" says so.
		const partial = trace({
			steps: [
				{
					id: "m1",
					kind: "model",
					label: "m",
					startedAt: 0,
					durationMs: 800,
					status: "ok",
					offsetPct: 0,
					widthPct: 8,
				},
				{ id: "m2", kind: "model", label: "m", startedAt: 900, status: "ok", offsetPct: 9, widthPct: 0.6 },
			],
			totals: { ...trace().totals, toolMs: 0, modelMs: 800, timedSteps: 1, untimedSteps: 1, failed: 0 },
		});
		const html = renderToStaticMarkup(<TurnTracePanel trace={partial} />);
		expect(html).toContain("800ms+");
	});

	it("leaves the timed column alone when only the other kind was untimed", () => {
		const mixed = trace({
			steps: [
				{
					id: "m1",
					kind: "model",
					label: "m",
					startedAt: 0,
					durationMs: 800,
					status: "ok",
					offsetPct: 0,
					widthPct: 8,
				},
				{ id: "c1", kind: "tool", label: "bash", startedAt: 0, status: "ok", offsetPct: 0, widthPct: 0.6 },
			],
			totals: { ...trace().totals, toolMs: 0, modelMs: 800, timedSteps: 1, untimedSteps: 1, failed: 0 },
		});
		const html = renderToStaticMarkup(<TurnTracePanel trace={mixed} />);
		expect(html).toContain(">800ms<");
		expect(html).toMatch(/>untimed<|>未记录</);
	});

	it("says a step is untimed instead of showing 0", () => {
		const untimed = trace({
			steps: [{ id: "c1", kind: "tool", label: "bash", startedAt: 0, status: "ok", offsetPct: 0, widthPct: 0.6 }],
			totals: { ...trace().totals, toolMs: 0, timedSteps: 0, untimedSteps: 1, failed: 0 },
		});
		const html = renderToStaticMarkup(<TurnTracePanel trace={untimed} />);
		expect(html).toMatch(/未记录|untimed/);
		expect(html).toContain("tr-trace-note");
	});

	it("omits the untimed note when everything was timed", () => {
		const html = renderToStaticMarkup(<TurnTracePanel trace={trace()} />);
		// The failure note shares the class, so assert the untimed wording.
		expect(html).not.toMatch(/未记录耗时|Untimed steps/);
	});
});
