import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScheduledTasksPage } from "../src/components/ScheduledTasksPage";
import { ScheduledTasksPanel } from "../src/components/ScheduledTasksPanel";
import { clearTaskNav, publishTaskNav } from "../src/lib/scheduled-task-nav";

/**
 * Task-center two-tier contracts (2026-11-08).
 *
 * The user-visible failure was "还是单容器三个切换": the workspace list was
 * a grid column INSIDE ScheduledTasksPage, so it vanished on the empty state
 * and sat to the right of the sidebar slot. The list now lives in the rail's
 * sidebar slot (ScheduledTasksPanel) as a separate React subtree; the page
 * publishes one cron.list projection and consumes the panel's actions.
 *
 * These tests mount both subtrees together, so they exercise the real
 * publish/action bridge instead of a mocked harness.
 */

const mounted = new Set<Root>();

async function flush(frames = 6): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(10);
	});
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	window.localStorage.clear();
	clearTaskNav();
});

async function mount(ui: React.ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(ui));
	await flush();
	return container;
}

function task(id: string, name: string, enabled = true, lastStatus = "success") {
	return {
		id,
		name,
		enabled,
		schedule: { kind: "daily", times: ["09:00"] },
		prompt: `Run ${name}`,
		cwd: `D:\\work\\${name.toLowerCase()}`,
		state: { createdAt: 1, lastStatus, nextRunAt: Date.now() + 60_000 },
	};
}

function taskRpc(tasks: ReturnType<typeof task>[]) {
	return {
		request: async (method: string): Promise<unknown> => {
			if (method === "cron.list") return { tasks, runs: [] };
			if (method === "cron.runs") return { runs: [] };
			if (method === "cron.nextRuns") return { runs: [] };
			if (method === "models.listAvailable") return [];
			return {};
		},
	};
}

function publishEmpty(): void {
	clearTaskNav();
	publishTaskNav({ tasks: [], selectedId: null, view: "tasks", busy: false });
}

describe("ScheduledTasksPanel in the sidebar slot", () => {
	it("still renders the panel with search, filters and an empty state when there are no tasks", async () => {
		publishEmpty();
		const container = await mount(<ScheduledTasksPanel width={256} collapsed={false} />);

		const slot = container.querySelector<HTMLElement>(".gui-scheduled-slot");
		expect(slot).not.toBeNull();
		expect(slot?.classList.contains("gui-pane-side")).toBe(true);
		expect(slot?.style.width).toBe("256px");
		expect(container.querySelector(".gui-side-panel-head")).not.toBeNull();
		expect(container.querySelector(".gui-side-panel-search input")).not.toBeNull();
		expect(container.querySelector(".gui-side-panel-filter")).not.toBeNull();
		// The old page column was gated on tasks.length > 0; the slot is not.
		expect(container.querySelector(".gui-side-panel-empty")?.textContent).toBeTruthy();
		expect(container.querySelectorAll(".gui-side-panel-row")).toHaveLength(0);
	});

	it("folds to zero width with the sidebar's collapse contract", async () => {
		publishEmpty();
		const container = await mount(<ScheduledTasksPanel width={256} collapsed />);
		const slot = container.querySelector<HTMLElement>(".gui-scheduled-slot");
		expect(slot?.classList.contains("gui-pane-side--collapsed")).toBe(true);
		expect(slot?.style.width).toBe("0px");
		// Contents stay mounted (search text survives an unfold).
		expect(container.querySelector(".gui-side-panel-scroll")).not.toBeNull();
	});

	it("filters by name and status from the page's published projection", async () => {
		clearTaskNav();
		publishTaskNav({
			tasks: [
				{ id: "a", name: "Alpha", enabled: true, cwd: "D:\\work\\a", lastStatus: "success" },
				{ id: "b", name: "Beta", enabled: false, cwd: "D:\\work\\b", lastStatus: "error" },
				{ id: "c", name: "Gamma", enabled: false, cwd: "D:\\work\\c", lastStatus: "success" },
			],
			selectedId: "a",
			view: "tasks",
			busy: false,
		});
		const container = await mount(<ScheduledTasksPanel width={256} collapsed={false} />);
		const names = () =>
			[...container.querySelectorAll<HTMLElement>(".gui-side-panel-row > span:nth-child(2)")].map(
				x => x.textContent,
			);
		expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);

		// happy-dom does not always surface native input events to React's
		// delegated listener; drive the wired onChange through React props,
		// with the native setter so the value tracker sees a real change
		// (same pattern as plugin-config-feedback.test.tsx).
		const reactOnChange = (element: Element): ((e: { target: Element }) => void) => {
			const propsKey = Object.keys(element).find(candidate => candidate.startsWith("__reactProps$"));
			if (!propsKey) throw new Error("control has no React props");
			const props = (element as unknown as Record<string, { onChange?: (e: { target: Element }) => void }>)[
				propsKey
			];
			if (!props?.onChange) throw new Error("control has no React onChange");
			return props.onChange;
		};
		const setValue = (element: Element, value: string): void => {
			const proto =
				element.tagName === "INPUT" ? window.HTMLInputElement.prototype : window.HTMLSelectElement.prototype;
			Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
		};
		const search = container.querySelector<HTMLInputElement>(".gui-side-panel-search input")!;
		const type = reactOnChange(search);
		const setNative = (value: string): void => setValue(search, value);
		setNative("bet");
		await act(async () => type({ target: search }));
		await flush();
		expect(names()).toEqual(["Beta"]);

		setNative("");
		await act(async () => type({ target: search }));
		// happy-dom exposes <select> own keys as option indices, hiding React's
		// props key; a native change event reaches the delegated listener.
		const filter = container.querySelector<HTMLSelectElement>(".gui-side-panel-filter")!;
		setValue(filter, "paused");
		await act(async () => filter.dispatchEvent(new Event("change", { bubbles: true })));
		await flush();
		expect(names()).toEqual(["Beta", "Gamma"]);
	});

	it("disables new-task while the page is saving (projection busy flag)", async () => {
		clearTaskNav();
		publishTaskNav({ tasks: [], selectedId: null, view: "tasks", busy: true });
		const container = await mount(<ScheduledTasksPanel width={256} collapsed={false} />);
		expect(container.querySelector<HTMLButtonElement>(".gui-side-panel-primary")?.disabled).toBe(true);
	});
});

describe("page <-> panel bridge", () => {
	it("publishes cron.list to the panel and applies the panel's selection", async () => {
		const rpc = taskRpc([task("a", "Alpha"), task("b", "Beta", false, "error")]);
		const container = await mount(
			<div>
				<ScheduledTasksPanel width={256} collapsed={false} />
				<ScheduledTasksPage rpc={rpc as never} onBack={() => {}} />
			</div>,
		);

		const rows = [...container.querySelectorAll<HTMLButtonElement>(".gui-side-panel-row")];
		expect(rows).toHaveLength(2);
		expect(container.querySelector(".gui-scheduled-detail-title")?.textContent).toBe("Alpha");

		await act(async () => rows[1]!.click());
		await flush();
		expect(container.querySelector(".gui-scheduled-detail-title")?.textContent).toBe("Beta");
		expect(container.querySelector(".gui-side-panel-row--active")?.textContent).toContain("Beta");
	});

	it("opens the editor from the panel's new-task action", async () => {
		const rpc = taskRpc([task("a", "Alpha")]);
		const container = await mount(
			<div>
				<ScheduledTasksPanel width={256} collapsed={false} />
				<ScheduledTasksPage rpc={rpc as never} onBack={() => {}} />
			</div>,
		);
		const newBtn = container.querySelector<HTMLButtonElement>(".gui-side-panel-primary");
		expect(newBtn?.disabled).toBe(false);
		await act(async () => newBtn!.click());
		await flush();
		// CronEditor portals to document.body (DialogFrame).
		expect(document.body.querySelector(".gui-cron-dialog")).not.toBeNull();
	});

	it("keeps the page to one column — no inner workspace list", async () => {
		const rpc = taskRpc([task("a", "Alpha"), task("b", "Beta")]);
		const container = await mount(<ScheduledTasksPage rpc={rpc as never} onBack={() => {}} />);
		expect(container.querySelector(".gui-scheduled-body")).not.toBeNull();
		expect(container.querySelector(".gui-scheduled-detail")).not.toBeNull();
		expect(container.querySelectorAll(".gui-scheduled-ws-head")).toHaveLength(0);
		expect(container.querySelectorAll(".gui-side-panel-row")).toHaveLength(0);
		expect(container.querySelectorAll(".gui-side-panel-head")).toHaveLength(0);
	});

	it("clears the stale projection when the page unmounts", async () => {
		// Separate roots, mirroring the real shell: the sidebar slot outlives
		// the page in the chat column. A previous visit's tasks must not flash
		// in the panel before the next page publishes its first snapshot.
		clearTaskNav();
		const panelHost = await mount(<ScheduledTasksPanel width={256} collapsed={false} />);
		await mount(<ScheduledTasksPage rpc={taskRpc([task("a", "Alpha")]) as never} onBack={() => {}} />);
		await flush();
		expect(panelHost.querySelectorAll(".gui-side-panel-row")).toHaveLength(1);

		const roots = [...mounted];
		const pageRoot = roots[roots.length - 1]!;
		await act(async () => pageRoot.unmount());
		mounted.delete(pageRoot);
		await flush();
		expect(panelHost.querySelectorAll(".gui-side-panel-row")).toHaveLength(0);
		expect(panelHost.querySelector(".gui-side-panel-empty")).not.toBeNull();
	});
});
