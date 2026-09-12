import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@musepi/pi-tui";
import type { ExtensionAPI, ExtensionUIContext } from "../../../src/extensibility/extensions/types";
import { createTaskCardStyleExtension } from "../../../src/musepi/swarm/task-card-style";

/**
 * The swarm widget key ("task-swarm") is global, while its data belongs to ONE
 * `task` call. Without the call-id guard a second concurrent `task` call — or a
 * late event from one that already ended — repainted the same widget with its
 * own member list, so the panel alternated between `0/3` and `0/4` on every
 * frame (user: 加了子 agent 后两个列表同时在刷新).
 */

type Handler = (event: unknown, ctx: unknown) => void;

interface Harness {
	fire: (event: string, payload: unknown) => void;
	frames: string[][];
	clearFrames: () => void;
}

const theme = {
	bold: (s: string) => s,
	fg: (_color: string, s: string) => s,
	spinnerFrames: ["⠋", "⠙", "⠹"],
};

function harness(): Harness {
	const handlers = new Map<string, Handler[]>();
	const frames: string[][] = [];
	const ui = {
		theme,
		setWidget: (_key: string, content: unknown) => {
			if (Array.isArray(content)) frames.push(content as string[]);
		},
	} as unknown as ExtensionUIContext;
	const api = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerSetting: () => {},
	} as unknown as ExtensionAPI;
	createTaskCardStyleExtension({ enabled: true })(api);
	return {
		fire: (event, payload) => {
			for (const handler of handlers.get(event) ?? []) handler(payload, { ui });
		},
		frames,
		clearFrames: () => {
			frames.length = 0;
		},
	};
}

const tasks = (n: number) =>
	Array.from({ length: n }, (_, i) => ({ id: `agent-${i + 1}`, description: `work ${i + 1}` }));

/** Details payload as the task tool reports it (taskMembersFromDetails shape). */
const details = (n: number) => ({
	progress: Array.from({ length: n }, (_, i) => ({
		id: `agent-${i + 1}`,
		description: `work ${i + 1}`,
		status: "running",
	})),
});

const header = (frame: string[] | undefined) => (frame?.[0] ?? "").replace(/\s+/g, " ").trim();

describe("task-card swarm widget call scoping", () => {
	it("ignores updates from a different task call while one is live", () => {
		const h = harness();
		h.fire("tool_execution_start", { toolName: "task", toolCallId: "call-a", args: { tasks: tasks(4) } });
		expect(header(h.frames.at(-1))).toContain("0/4 agent(s)");

		h.clearFrames();
		// A different call (a later batch) must not repaint the live widget.
		h.fire("tool_execution_update", {
			toolName: "task",
			toolCallId: "call-b",
			partialResult: { details: details(3) },
		});
		expect(h.frames).toHaveLength(0);

		// The owning call still updates normally.
		h.fire("tool_execution_update", {
			toolName: "task",
			toolCallId: "call-a",
			partialResult: { details: details(4) },
		});
		expect(h.frames.at(-1)?.[0]).toContain("0/4 agent(s)");

		h.fire("agent_end", {});
	});

	it("does not let a stale call tear down the widget a newer call owns", () => {
		const h = harness();
		h.fire("tool_execution_start", { toolName: "task", toolCallId: "call-a", args: { tasks: tasks(3) } });
		h.fire("agent_end", {});
		h.clearFrames();

		h.fire("tool_execution_start", { toolName: "task", toolCallId: "call-c", args: { tasks: tasks(4) } });
		expect(header(h.frames.at(-1))).toContain("0/4 agent(s)");
		h.clearFrames();

		// `call-a` is already gone; its end event must not settle/stop the
		// widget the newer call owns.
		h.fire("tool_execution_end", { toolName: "task", toolCallId: "call-a", result: { details: details(3) } });
		expect(h.frames).toHaveLength(0);

		h.fire("agent_end", {});
	});
});

/**
 * The grid sizes its cells from the id column, and the id column must hold the
 * LONGEST member id. Budgeting it from the member count (`String(count).length`
 * = 1 for four agents) laid out more columns than could hold their content, so
 * every row ran past the terminal and labels collapsed to `◉ Re…`
 * (user: 排版没优化好).
 */
describe("task-card swarm widget width budget", () => {
	const columnWidth = 80;
	const saved = Object.getOwnPropertyDescriptor(process.stdout, "columns");

	function atTerminalWidth(run: () => void): void {
		Object.defineProperty(process.stdout, "columns", { value: columnWidth, configurable: true });
		try {
			run();
		} finally {
			if (saved) Object.defineProperty(process.stdout, "columns", saved);
			else Reflect.deleteProperty(process.stdout, "columns");
		}
	}

	it("keeps every rendered row inside the terminal width with long ids", () => {
		atTerminalWidth(() => {
			const h = harness();
			h.fire("tool_execution_start", {
				toolName: "task",
				toolCallId: "call-wide",
				args: {
					tasks: ["ExtCenterLayout", "ArmWinExeLookup", "SwarmGuiCurrent", "SwarmTuiCurrent"].map(id => ({
						id,
						description: `Complete assignment thoroughly: ${id}`,
					})),
				},
			});
			const frame = h.frames.at(-1) ?? [];
			expect(frame.length).toBeGreaterThan(0);
			expect(frame.filter(line => visibleWidth(line) > columnWidth)).toEqual([]);
			h.fire("agent_end", {});
		});
	});
});
