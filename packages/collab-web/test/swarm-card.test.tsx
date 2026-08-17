import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView } from "../src/tool-render/ToolView";

/** Settled task batch: 2 done, 1 failed, 1 aborted, total wall time. */
const SETTLED = {
	name: "task",
	args: { tasks: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }] },
	result: {
		content: [],
		details: {
			totalDurationMs: 125000,
			results: [
				{ id: "A", exitCode: 0, durationMs: 2000, tokens: 1200, output: "first ok\nline two" },
				{ id: "B", exitCode: 0, durationMs: 4000, tokens: 900, output: "second ok" },
				{ id: "C", exitCode: 1, durationMs: 1000, error: "boom", output: "trace" },
				{ id: "D", aborted: true, durationMs: 500, abortReason: "user cancelled", output: "" },
			],
		},
	},
};

/** Still-running batch: 1 completed, 2 running from progress frames. */
const LIVE = {
	name: "task",
	running: true,
	args: { tasks: [{ id: "A" }, { id: "B" }, { id: "C" }] },
	result: {
		content: [],
		details: {
			progress: [
				{ id: "A", status: "completed", durationMs: 3000, tokens: 500 },
				{ id: "B", status: "running", durationMs: 8000, toolCount: 3, lastIntent: "search the repo" },
				{ id: "C", status: "running", durationMs: 1200, currentTool: "grep" },
			],
		},
	},
};

describe("task renderer swarm card (Kimi parity)", () => {
	it("renders a done/total chip in the head with the aggregate outcome", () => {
		const html = renderToStaticMarkup(<ToolView {...SETTLED} />);
		// done = 2 done + 1 failed + 1 aborted = 4 of 4
		expect(html).toContain(">4 / 4<");
		// aggregate failure tints the chip red
		expect(html).toMatch(/tv-badge--err[^>]*>4 \/ 4</);
	});

	it("renders the phase overview: progress line + segmented bar + legend", () => {
		const html = renderToStaticMarkup(<ToolView {...SETTLED} />);
		expect(html).toContain("tv-swarm-overview");
		expect(html).toContain("tv-swarm-seg");
		expect(html).toContain("tv-swarm-legend");
		// done / merge failed / failed / aborted segments (no running)
		expect(html).toContain("s-ok");
		expect(html).toContain("s-fail");
		expect(html).toContain("s-abort");
		expect(html).not.toContain("s-run");
		// legend labels reuse the status keys
		expect(html).toContain("done");
		expect(html).toContain("aborted");
	});

	it("counts live progress frames as done / running (no results yet)", () => {
		const html = renderToStaticMarkup(<ToolView {...LIVE} />);
		// chip: 1 done of 3
		expect(html).toContain(">1 / 3<");
		expect(html).toContain("s-run");
		// running members get the pulsing accent dot
		expect(html).toMatch(/tv-swarm-dot run/);
	});

	it("folds each member's output behind a per-row accordion", () => {
		const html = renderToStaticMarkup(<ToolView {...SETTLED} />);
		// member rows carry phase dots
		expect(html).toMatch(/tv-swarm-member--ok/);
		expect(html).toMatch(/tv-swarm-member--err/);
		// bodies are closed by default (accordion), but the chevron affordance exists
		expect(html).not.toContain("tv-swarm-member-body");
		expect(html).toContain("tv-swarm-chev");
		// the failed member's output text is not dumped while folded
		expect(html).not.toContain("boom");
	});

	it("keeps summary + footer counts for settled runs", () => {
		const html = renderToStaticMarkup(<ToolView {...SETTLED} />);
		expect(html).toContain("4 tasks");
		expect(html).toContain("2 succeeded");
		expect(html).toContain("1 failed");
		expect(html).toContain("1 aborted");
		// wall time footer: 125000ms → 2m 5s
		expect(html).toContain("2m 5s");
	});

	it("falls back to the declared batch size for the chip when no frames landed", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="task"
				args={{ tasks: [{ id: "A" }, { id: "B" }] }}
				result={{ content: [], details: {} }}
			/>,
		);
		expect(html).toContain(">0 / 2<");
	});
});
