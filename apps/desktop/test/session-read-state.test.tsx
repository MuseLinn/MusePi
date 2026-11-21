import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionList, type SessionListNode } from "../src/components/SessionList";

const mounted = new Set<Root>();

function node(id: string, label: string): SessionListNode {
	const timestamp = new Date().toISOString();
	return { entry: { type: "session", id, parentId: null, timestamp, updatedAt: timestamp, label }, children: [] };
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
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

describe("session read-state row markers", () => {
	it("a plain unread row keeps the accent unread dot and no failure marker", async () => {
		const container = await mount(
			<SessionList
				nodes={[node("s1", "Waiting on you")]}
				selectedId={null}
				onSelect={() => {}}
				unread={new Set(["s1"])}
			/>,
		);
		const row = container.querySelector<HTMLElement>(".gui-session-row");
		expect(row?.classList.contains("gui-session-row--unread")).toBe(true);
		expect(container.querySelector(".gui-session-failed")).toBeNull();
	});

	it("an unread failed row shows the danger marker instead of the unread dot", async () => {
		const container = await mount(
			<SessionList
				nodes={[node("s1", "Turn failed")]}
				selectedId={null}
				onSelect={() => {}}
				unread={new Set(["s1"])}
				failed={new Set(["s1"])}
			/>,
		);
		const row = container.querySelector<HTMLElement>(".gui-session-row");
		// The two markers never coexist: the failure dot replaces the accent one.
		expect(row?.classList.contains("gui-session-row--unread")).toBe(false);
		const marker = container.querySelector<HTMLElement>(".gui-session-failed");
		expect(marker).not.toBeNull();
		expect(marker?.classList.contains("gui-dot-danger")).toBe(true);
		expect(marker?.getAttribute("role")).toBe("img");
		expect(marker?.getAttribute("aria-label")?.trim()).not.toBe("");
	});

	it("a failed row that was read shows no marker at all", async () => {
		const container = await mount(
			<SessionList
				nodes={[node("s1", "Read failure")]}
				selectedId={null}
				onSelect={() => {}}
				unread={new Set()}
				failed={new Set()}
			/>,
		);
		expect(container.querySelector(".gui-session-failed")).toBeNull();
		expect(container.querySelectorAll(".gui-session-row--unread").length).toBe(0);
	});
});
