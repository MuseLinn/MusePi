import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView } from "../src/tool-render/ToolView";
import { taskRenderer } from "../src/tool-render/tools/task";

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

describe("task renderer native card body (one line per subagent)", () => {
	it("renders a done/total chip in the head with the aggregate outcome", () => {
		const html = renderToStaticMarkup(<ToolView {...SETTLED} />);
		// done = 2 done + 1 failed + 1 aborted = 4 of 4
		expect(html).toContain(">4 / 4<");
		// aggregate failure tints the chip red
		expect(html).toMatch(/tv-badge--err[^>]*>4 \/ 4</);
	});

	it("renders the native task card head; the swarm grid is not inline (composer chip hosts it)", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="task"
				intent="Survey WebSocket architecture in reference repos"
				args={{ tasks: [{ id: "A" }, { id: "B" }] }}
				result={{ content: [], details: { results: [] } }}
			/>,
		);
		// native card keeps the tool-name head + intent line
		expect(html).toContain("tv-name");
		expect(html).toContain("Survey WebSocket architecture in reference repos");
		expect(html).toContain("tv-intent");
		// the member grid is hosted by the GUI composer's temporary swarm
		// chip — the transcript card renders the native body only.
		expect(html).not.toContain("tv-stack");
		expect(html).not.toContain("tv-swarm-card");
		expect(html).not.toContain("tv-swarm-members");
	});

	it("skips the empty task list when every entry is index-only", () => {
		const html = renderToStaticMarkup(<ToolView {...SETTLED} />);
		// Batch entries with only ids carry no per-entry description; the
		// overview chip already counts them — the list wrapper must not
		// render an empty <div class="tv-list">.
		expect(html).not.toMatch(/<div class="tv-list"><\/div>/);
	});

	it("lists one compact line per settled subagent (agent link + status + stats)", () => {
		const html = renderToStaticMarkup(
			<ToolView
				{...SETTLED}
				host={{
					hasAgent: (id: string) => ["A", "B"].includes(id),
					openAgent: (id: string) => {
						void id;
					},
				}}
			/>,
		);
		// native body rows: AgentLink names, per-row status, no avatar cards
		expect(html).toContain("tv-agent-link");
		expect(html).toContain("Done");
		expect(html).toContain("Failed");
		expect(html).not.toContain("tv-swarm-avatar");
	});

	it("folds each settled subagent's output behind a per-row chevron (TUI parity)", () => {
		const html = renderToStaticMarkup(
			<ToolView
				{...SETTLED}
				host={{
					hasAgent: (id: string) => ["A", "B"].includes(id),
					openAgent: (id: string) => {
						void id;
					},
				}}
			/>,
		);
		// compact row per agent with an expand affordance
		expect(html).toContain("tv-agent-link");
		expect(html).toContain("tv-swarm-chev");
		// output folds by default — not dumped inline
		expect(html).not.toContain("first ok");
		expect(html).not.toContain("boom");
	});

	it("lists one compact line per live subagent (running rows)", () => {
		const html = renderToStaticMarkup(
			<ToolView
				{...LIVE}
				host={{
					hasAgent: (id: string) => ["A", "B"].includes(id),
					openAgent: (id: string) => {
						void id;
					},
				}}
			/>,
		);
		expect(html).toContain("tv-agent-link");
		expect(html).toContain("running");
		expect(html).not.toContain("tv-swarm-avatar");
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

describe("task renderer floating SwarmCard (avatar grid content)", () => {
	// taskRenderer.SwarmCard is optional by contract; the task renderer
	// ships it, so assert its content directly here.
	const SwarmCard = taskRenderer.SwarmCard!;

	it("renders the phase overview: progress line + segmented bar + legend", () => {
		const html = renderToStaticMarkup(<SwarmCard {...SETTLED} />);
		expect(html).toContain("tv-swarm-overview");
		expect(html).toContain("tv-swarm-seg");
		expect(html).toContain("tv-swarm-legend");
		// done / merge failed / failed / aborted segments (no running)
		expect(html).toContain("s-ok");
		expect(html).toContain("s-fail");
		expect(html).toContain("s-abort");
		expect(html).not.toContain("s-run");
		// legend labels reuse the status keys (en-US dict renders capitalized)
		expect(html).toContain("Done");
		expect(html).toContain("Aborted");
	});

	it("counts live progress frames as done / running (no results yet)", () => {
		// head chip (done/total) lives in the native card Summary
		const headHtml = renderToStaticMarkup(<ToolView {...LIVE} />);
		expect(headHtml).toContain(">1 / 3<");
		// floating grid: overview counts progress frames, running avatars
		const html = renderToStaticMarkup(<SwarmCard {...LIVE} />);
		expect(html).toContain("s-run");
		expect(html).toMatch(/tv-swarm-avatar--run/);
		expect(html).toContain("tv-swarm-bar-fill--live");
	});

	it("folds each member's output behind a per-row accordion", () => {
		const html = renderToStaticMarkup(<SwarmCard {...SETTLED} />);
		// member rows carry phase dots
		expect(html).toMatch(/tv-swarm-member--ok/);
		expect(html).toMatch(/tv-swarm-member--err/);
		// bodies are closed by default (accordion), but the chevron affordance exists
		expect(html).not.toContain("tv-swarm-member-body");
		expect(html).toContain("tv-swarm-chev");
		// the failed member's output text is not dumped while folded
		expect(html).not.toContain("boom");
	});

	it("renders members as cards with avatar + agent link + progress bar", () => {
		const html = renderToStaticMarkup(
			<SwarmCard
				{...SETTLED}
				host={{
					hasAgent: (id: string) => ["A", "B"].includes(id),
					openAgent: (id: string) => {
						void id;
					},
				}}
			/>,
		);
		// avatar initials from the agent id (A → "A")
		expect(html).toMatch(/tv-swarm-avatar tv-swarm-avatar--ok/);
		// member name is a clickable AgentLink (opens the trajectory panel)
		expect(html).toContain("tv-agent-link");
		// settled member shows the full progress bar (ok → 100%)
		expect(html).toMatch(/tv-swarm-bar-fill--ok" style="width:100%/);
		// the grid container renders
		expect(html).toContain("tv-swarm-members");
	});
});

describe("task card style setting (display.taskCardStyle)", () => {
	it("classic renders the native task card only (no additive swarm card)", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="task"
				taskCardStyle="classic"
				intent="Survey WebSocket architecture in reference repos"
				args={{ tasks: [{ id: "A" }, { id: "B" }] }}
				result={{ content: [], details: { results: [] } }}
			/>,
		);
		// plain tool card: tool-name head + intent line, no additive swarm card
		expect(html).toContain("tv-name");
		expect(html).toContain("tv-intent");
		expect(html).not.toContain("tv-swarm-card");
		expect(html).not.toContain("tv-swarm-members");
	});

	it("swarm (default) keeps the native card (member grid lives at the composer chip)", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="task"
				intent="Survey WebSocket architecture in reference repos"
				args={{ tasks: [{ id: "A" }, { id: "B" }] }}
				result={{ content: [], details: { results: [] } }}
			/>,
		);
		// native tool-call card stays (tv-name head); the swarm member grid
		// is rendered by the GUI composer's temporary chip, never inline.
		expect(html).toContain("tv-name");
		expect(html).not.toContain("tv-stack");
		expect(html).not.toContain("tv-swarm-card");
		expect(html).not.toContain("tv-swarm-members");
	});

	it("non-task tools never render the additive swarm card", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="grep"
				taskCardStyle="swarm"
				args={{ pattern: "foo" }}
				result={{ content: [] }}
			/>,
		);
		expect(html).not.toContain("tv-swarm-card");
		expect(html).not.toContain("tv-stack");
	});
});
