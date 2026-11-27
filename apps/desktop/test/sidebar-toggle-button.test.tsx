import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SidebarToggleButton } from "../src/components/SidebarToggleButton";
import {
	type CapabilityNavAction,
	clearCapabilityNav,
	publishCapabilityNav,
	subscribeCapabilityNavAction,
} from "../src/lib/capability-nav";
import {
	clearTaskNav,
	publishTaskNav,
	subscribeTaskNavAction,
	type TaskNavAction,
} from "../src/lib/scheduled-task-nav";

let host: HTMLDivElement;
let root: Root;
let unsubscribeActions: (() => void) | undefined;
const sessions = [
	{ id: "a", label: "Alpha" },
	{ id: "b", label: "Beta" },
];

beforeEach(() => {
	host = document.createElement("div");
	host.id = "root";
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 160));
		root.unmount();
	});
	host.remove();
	unsubscribeActions?.();
	unsubscribeActions = undefined;
	clearTaskNav();
	clearCapabilityNav();
});

async function render(
	collapsed: boolean,
	onSelect = () => {},
	onNew = () => {},
	panelId: "home" | "scheduled" | "capability" = "home",
): Promise<void> {
	await act(async () =>
		root.render(
			<SidebarToggleButton
				collapsed={collapsed}
				panelId={panelId}
				onToggle={() => {}}
				sessions={sessions}
				selectedId="a"
				onSelectSession={onSelect}
				onNewSession={onNew}
			/>,
		),
	);
}

async function hover(): Promise<void> {
	await act(async () => {
		host.querySelector(".gui-sidebar-toggle")?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
		await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	});
}

describe("SidebarToggleButton quick sessions", () => {
	test("collapsed hover offers session switching and new chat without opening the full panel", async () => {
		let selected = "";
		let created = 0;
		await render(
			true,
			id => (selected = id),
			() => created++,
		);
		await hover();
		expect(document.querySelector(".gui-session-quick-menu") !== null).toBe(true);
		expect(document.querySelectorAll(".gui-session-quick-row").length).toBe(2);
		await act(async () => document.querySelector<HTMLButtonElement>('[data-session-id="b"]')?.click());
		expect(selected).toBe("b");
		await hover();
		await act(async () => document.querySelector<HTMLButtonElement>(".gui-session-quick-new")?.click());
		expect(created).toBe(1);
	});

	test("expanded hover does not open the quick menu", async () => {
		await render(false);
		await hover();
		expect(document.querySelector(".gui-session-quick-menu") === null).toBe(true);
	});

	test("scheduled hover shows the current tasks instead of sessions", async () => {
		publishTaskNav({
			tasks: [
				{ id: "task-a", name: "Nightly build", enabled: true, cwd: "/work/a" },
				{ id: "task-b", name: "Weekly report", enabled: false, cwd: "/work/b", lastStatus: "error" },
			],
			selectedId: "task-b",
			view: "tasks",
			busy: false,
		});
		await render(
			true,
			() => {},
			() => {},
			"scheduled",
		);
		await hover();

		expect(document.querySelectorAll("[data-task-id]").length).toBe(2);
		expect(document.querySelectorAll("[data-session-id]").length).toBe(0);
		expect(document.querySelector('[data-task-id="task-b"]')?.getAttribute("data-active")).toBe("true");
	});

	test("scheduled quick menu emits selection and creation actions", async () => {
		const seen: TaskNavAction[] = [];
		unsubscribeActions = subscribeTaskNavAction(action => seen.push(action));
		publishTaskNav({
			tasks: [{ id: "task-a", name: "Nightly build", enabled: true, cwd: "/work/a" }],
			selectedId: null,
			view: "tasks",
			busy: false,
		});
		await render(
			true,
			() => {},
			() => {},
			"scheduled",
		);
		await hover();
		await act(async () => document.querySelector<HTMLButtonElement>('[data-task-id="task-a"]')?.click());
		expect(seen).toEqual([{ type: "select", id: "task-a" }]);

		await hover();
		await act(async () => document.querySelector<HTMLButtonElement>(".gui-session-quick-new")?.click());
		expect(seen).toEqual([{ type: "select", id: "task-a" }, { type: "new" }]);
	});

	test("capability hover shows capability destinations instead of sessions", async () => {
		publishCapabilityNav({ tab: "plugins", skillsCount: 4, pluginsCount: 2 });
		await render(
			true,
			() => {},
			() => {},
			"capability",
		);
		await hover();

		expect(document.querySelectorAll("[data-capability-tab]").length).toBe(3);
		expect(document.querySelectorAll("[data-session-id]").length).toBe(0);
		expect(document.querySelector('[data-capability-tab="plugins"]')?.getAttribute("data-active")).toBe("true");
	});

	test("capability quick menu emits selection and add actions", async () => {
		const seen: CapabilityNavAction[] = [];
		unsubscribeActions = subscribeCapabilityNavAction(action => seen.push(action));
		publishCapabilityNav({ tab: "skills", skillsCount: 4, pluginsCount: 2 });
		await render(
			true,
			() => {},
			() => {},
			"capability",
		);
		await hover();
		await act(async () => document.querySelector<HTMLButtonElement>('[data-capability-tab="marketplace"]')?.click());
		expect(seen).toEqual([{ type: "select", tab: "marketplace" }]);

		await hover();
		await act(async () => document.querySelector<HTMLButtonElement>(".gui-session-quick-new")?.click());
		expect(seen).toEqual([{ type: "select", tab: "marketplace" }, { type: "add" }]);
	});
});
