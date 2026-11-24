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
	it("draws one row per step, each with a magnitude bar", () => {
		const html = renderToStaticMarkup(<TurnTracePanel trace={trace()} />);
		expect(html.match(/<li class="tr-trace-row[ "]/g)?.length).toBe(2);
		expect(html.match(/class="tr-trace-gauge-fill[ "]/g)?.length).toBe(2);
	});

	it("scales each bar to the turn's longest step, not to the span", () => {
		// 800ms model next to a 3s tool: the model bar is ~27% of the tool's, so
		// both stay visible instead of collapsing into sub-pixel slivers.
		const html = renderToStaticMarkup(<TurnTracePanel trace={trace()} />);
		expect(html).toContain("width:100%");
		expect(html).toMatch(/width:26\.6/);
	});

	it("marks a failed step in words, not only in colour", () => {
		const html = renderToStaticMarkup(<TurnTracePanel trace={trace()} />);
		expect(html).toContain('data-status="error"');
		expect(html).toMatch(/失败|failed/);
		expect(html).toContain("tr-trace-gauge-fill--failed");
	});

	it("carries its own visible title, since the dialog shell has none", () => {
		const html = renderToStaticMarkup(<TurnTracePanel trace={trace()} />);
		expect(html).toContain("tr-trace-title-name");
		expect(html).toMatch(/本轮轨迹|This turn/);
	});

	it("leads with the turn total and its split, then tokens and cost", () => {
		const html = renderToStaticMarkup(<TurnTracePanel trace={trace()} />);
		expect(html).toContain("tr-trace-hero-total");
		expect(html).toContain("10.0s");
		expect(html).toContain("tr-trace-split-tools");
		expect(html).toContain("tr-trace-split-model");
		expect(html).toContain("1.5k");
		expect(html).toContain("$0.03");
	});

	it("shows the unattributed remainder only when it is large enough to matter", () => {
		// 10s span, 3s tools + 0.8s model: ~62% is neither, and a bar with a
		// silent gap would look broken rather than informative.
		const html = renderToStaticMarkup(<TurnTracePanel trace={trace()} />);
		expect(html).toContain("tr-trace-split-rest");
		expect(html).toMatch(/其余|Elsewhere/);

		// A turn that is almost entirely accounted for gets no third legend.
		const tight = trace({
			endedAt: 3_900,
			totals: { ...trace().totals, toolMs: 3_000, modelMs: 800 },
		});
		const tightHtml = renderToStaticMarkup(<TurnTracePanel trace={tight} />);
		expect(tightHtml).not.toContain("tr-trace-split-rest");
	});

	it("names the model once, then says Request while it stays the same", () => {
		const twoRounds = trace({
			steps: [
				{
					id: "m1",
					kind: "model",
					label: "group/a",
					startedAt: 0,
					durationMs: 900,
					status: "ok",
					offsetPct: 0,
					widthPct: 9,
				},
				{
					id: "m2",
					kind: "model",
					label: "group/a",
					startedAt: 1_000,
					durationMs: 800,
					status: "ok",
					offsetPct: 10,
					widthPct: 8,
				},
				{
					id: "m3",
					kind: "model",
					label: "group/b",
					startedAt: 2_000,
					durationMs: 700,
					status: "ok",
					offsetPct: 20,
					widthPct: 7,
				},
			],
		});
		const html = renderToStaticMarkup(<TurnTracePanel trace={twoRounds} />);
		expect(html).toContain(">a<");
		expect(html).toMatch(/>Request<|>请求</);
		// The switch to another model IS information, so it is named.
		expect(html).toContain(">b<");
	});

	it("groups a request with the work it set off", () => {
		const html = renderToStaticMarkup(<TurnTracePanel trace={trace()} />);
		expect(html.match(/<li class="tr-trace-round[ "]/g)?.length).toBe(1);
		expect(html).toContain("tr-trace-tools");
		// The model row leads its round; the tool sits inside it.
		expect(html.indexOf("tr-trace-row--model")).toBeLessThan(
			html.indexOf("tr-trace-row--sub") === -1 ? Infinity : html.indexOf("tr-trace-row--sub"),
		);
	});

	it("lists delegated members under their task call, indented and without a bar", () => {
		const withSubs = trace({
			steps: [
				{
					id: "c1",
					kind: "tool",
					label: "task",
					startedAt: 0,
					durationMs: 5_000,
					status: "ok",
					offsetPct: 0,
					widthPct: 50,
					children: [
						{ id: "m1", label: "reviewer", detail: "审查改动", durationMs: 3_000, status: "ok", tokens: 12_000 },
						{ id: "m2", label: "researcher", durationMs: 2_000, status: "error" },
					],
				},
			],
		});
		const html = renderToStaticMarkup(<TurnTracePanel trace={withSubs} />);
		expect(html.match(/tr-trace-row--sub/g)?.length).toBe(2);
		expect(html).toContain("reviewer");
		expect(html).toContain("12k");
		// The failed member is marked in words as well as colour.
		expect(html).toMatch(/failed|失败/);
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
