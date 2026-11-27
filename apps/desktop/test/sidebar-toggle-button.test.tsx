import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SidebarToggleButton } from "../src/components/SidebarToggleButton";

let host: HTMLDivElement;
let root: Root;
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
});

async function render(collapsed: boolean, onSelect = () => {}, onNew = () => {}): Promise<void> {
	await act(async () =>
		root.render(
			<SidebarToggleButton
				collapsed={collapsed}
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
});
