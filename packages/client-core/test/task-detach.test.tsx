import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getLocaleSnapshot, setLocale } from "../src/i18n/index.js";
import { ToolView } from "../src/tool-render/ToolView";
import { taskRenderer } from "../src/tool-render/tools/task";
import type { ToolRenderHost, ToolRenderProps } from "../src/tool-render/types";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const INITIAL_LOCALE = getLocaleSnapshot();
beforeAll(() => setLocale("en-US"));
afterAll(() => {
	setLocale(INITIAL_LOCALE);
	void GlobalRegistrator.unregister();
});

const roots: Root[] = [];
afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

function mount(node: ReactNode): void {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(node));
}

function detachButtons(): HTMLButtonElement[] {
	return Array.from(document.querySelectorAll("button")).filter(
		button => button.textContent?.trim() === "To background",
	);
}

/** One live subagent row, as the task tool streams it before the run settles. */
const RUNNING = {
	name: "task",
	running: true,
	args: { tasks: [{ id: "A" }] },
	result: {
		content: [],
		details: { progress: [{ id: "A", status: "running", durationMs: 1200, toolCount: 2 }] },
	},
};

const SETTLED = {
	name: "task",
	args: { tasks: [{ id: "A" }] },
	result: {
		content: [],
		details: { progress: [{ id: "A", status: "completed", durationMs: 900 }] },
	},
};

const SwarmCard = taskRenderer.SwarmCard!;

function host(detachAgent?: (id: string) => void): ToolRenderHost {
	return { hasAgent: () => true, openAgent: () => {}, ...(detachAgent ? { detachAgent } : {}) };
}

describe("task card — move a running subagent to the background", () => {
	it("shows the action on a live row only when the host supports it", () => {
		mount(<ToolView {...RUNNING} host={host()} />);
		expect(detachButtons()).toHaveLength(0);

		document.body.innerHTML = "";
		mount(<ToolView {...RUNNING} host={host(() => {})} />);
		expect(detachButtons()).toHaveLength(1);
	});

	it("keeps finished rows undetachable", () => {
		mount(<ToolView {...SETTLED} host={host(() => {})} />);
		expect(detachButtons()).toHaveLength(0);
	});

	it("requests the detach once and collapses to a status badge", () => {
		const calls: string[] = [];
		mount(<ToolView {...RUNNING} host={host(id => calls.push(id))} />);
		const [button] = detachButtons();
		act(() => button!.click());
		expect(calls).toEqual(["A"]);
		// The run is adopted now: no second request, and the row says so.
		expect(detachButtons()).toHaveLength(0);
		expect(document.body.textContent).toContain("In background");
	});

	it("offers the same action in the floating swarm card", () => {
		const calls: string[] = [];
		mount(<SwarmCard {...(RUNNING as unknown as ToolRenderProps)} host={host(id => calls.push(id))} />);
		const [button] = detachButtons();
		expect(button).toBeDefined();
		act(() => button!.click());
		expect(calls).toEqual(["A"]);
	});
});
