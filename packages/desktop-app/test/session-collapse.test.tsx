import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	hasCollapsedSubtrees,
	SessionList,
	type SessionListNode,
	setAllSubtreesCollapsed,
} from "../src/components/SessionList";
import { SessionSidebar } from "../src/components/SessionSidebar";

const mounted = new Set<Root>();

function node(id: string, label: string, children: SessionListNode[] = []): SessionListNode {
	const timestamp = new Date().toISOString();
	return { entry: { type: "session", id, parentId: null, timestamp, updatedAt: timestamp, label }, children };
}

function parent(id: string, childId: string): SessionListNode {
	const child = node(childId, `Child ${childId}`);
	return { ...node(id, `Parent ${id}`, [child]), children: [child] };
}

async function flush(frames = 4): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(10);
	});
}

async function mount(element: React.ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(element));
	return container;
}

afterEach(async () => {
	setAllSubtreesCollapsed(false);
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	window.localStorage.clear();
});

describe("session subtree collapse", () => {
	it("keeps the parent row visible after its children collapse and restores them on expansion", async () => {
		const container = await mount(<SessionList nodes={[parent("p1", "c1")]} selectedId={null} onSelect={() => {}} />);
		const parentRow = container.querySelector<HTMLElement>(".gui-session-row");
		expect(parentRow?.textContent).toContain("Parent p1");
		expect(container.querySelector("button button")).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>(".gui-tree-fold")?.click());
		const parentItem = parentRow?.closest("li") as HTMLElement | null;
		expect(parentItem?.style.height).not.toBe("0px");
		await flush(40);
		expect(container.textContent).toContain("Parent p1");
		expect(container.textContent).not.toContain("Child c1");
		expect(parentItem?.style.height).not.toBe("0px");
		await act(async () => container.querySelector<HTMLButtonElement>(".gui-tree-fold")?.click());
		await flush(40);
		expect(container.textContent).toContain("Child c1");
	});

	it("keeps row selection off the fold control's keyboard event", async () => {
		let selected = "";
		const container = await mount(
			<SessionList nodes={[parent("p1", "c1")]} selectedId={null} onSelect={id => (selected = id)} />,
		);
		const fold = container.querySelector<HTMLButtonElement>(".gui-tree-fold");
		await act(async () => fold?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
		expect(selected).toBe("");
	});

	it("collapses and expands every registered subtree across independent list instances", async () => {
		const container = await mount(
			<>
				<SessionList nodes={[parent("p2", "c2")]} selectedId={null} onSelect={() => {}} />
				<SessionList nodes={[parent("p3", "c3")]} selectedId={null} onSelect={() => {}} />
			</>,
		);
		await flush();
		await act(async () => setAllSubtreesCollapsed(true));
		await flush(40);
		expect(container.textContent).toContain("Parent p2");
		expect(container.textContent).toContain("Parent p3");
		expect(container.textContent).not.toContain("Child c2");
		expect(container.textContent).not.toContain("Child c3");
		await act(async () => setAllSubtreesCollapsed(false));
		await flush(40);
		expect(container.textContent).toContain("Child c2");
		expect(container.textContent).toContain("Child c3");
	});

	it("drives the same global action from the sidebar header", async () => {
		const container = await mount(
			<SessionSidebar
				nodes={[parent("p4", "c4"), parent("p5", "c5")]}
				sessionMeta={new Map()}
				selectedId={null}
				onSelect={() => {}}
				onNewSession={() => {}}
				onDisconnect={() => {}}
				onOpenConnect={() => {}}
				onOpenSettings={() => {}}
				onOpenSearch={() => {}}
				collapsed={false}
				onDeleteArchived={async () => true}
				connected
				daemonUrl="ws://localhost:8300"
				onReconnect={() => {}}
				hosts={[]}
				onSwitchHost={() => {}}
				onAddHost={() => {}}
				onRemoveHost={() => {}}
			/>,
		);
		await flush();
		const toggle = container.querySelectorAll<HTMLButtonElement>(".gui-tab-action")[1];
		await act(async () => toggle?.click());
		await flush(40);
		expect(container.textContent).toContain("Parent p4");
		expect(container.textContent).toContain("Parent p5");
		expect(container.textContent).not.toContain("Child c4");
		expect(container.textContent).not.toContain("Child c5");
		await act(async () => container.querySelectorAll<HTMLButtonElement>(".gui-tab-action")[1]?.click());
		await flush(40);
		expect(hasCollapsedSubtrees()).toBe(false);
		expect(container.textContent).toContain("Child c4");
		expect(container.textContent).toContain("Child c5");
	});
});
