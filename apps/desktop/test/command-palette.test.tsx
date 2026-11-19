import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CommandPalette } from "../src/components/CommandPalette";
import type { RpcClient } from "../src/lib/rpc";

const roots: Root[] = [];
const hosts: HTMLElement[] = [];
const rpc = { request: () => Promise.resolve({ matches: [], sessions: [] }) } as unknown as RpcClient;

function props(open: boolean, onClose = () => {}) {
	return {
		open,
		onClose,
		rpc,
		sessions: [{ id: "session-a", label: "Session A" }],
		onNewSession: () => {},
		onOpenWorkspace: () => {},
		onSettings: () => {},
		onToggleSidebar: () => {},
		onToggleTerminal: () => {},
		onTogglePreview: () => {},
		onSelectSession: () => {},
	};
}

function mount(open = true): { root: Root; opener: HTMLButtonElement } {
	const opener = document.createElement("button");
	opener.textContent = "Open palette";
	document.body.appendChild(opener);
	opener.focus();
	const host = document.createElement("div");
	host.id = "root";
	document.body.appendChild(host);
	hosts.push(host, opener);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(<CommandPalette {...props(open)} />));
	return { root, opener };
}

afterEach(() => {
	while (roots.length) act(() => roots.pop()?.unmount());
	while (hosts.length) hosts.pop()?.remove();
});

describe("CommandPalette keyboard contract", () => {
	test("links the combobox to the active option and wraps arrow navigation", () => {
		mount();
		const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
		expect(document.activeElement).toBe(input);
		expect(input.getAttribute("aria-controls")).toBe("gui-palette-listbox");
		expect(input.getAttribute("aria-activedescendant")).toBe("gui-palette-option-0");
		expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.getAttribute("role")).toBe(
			"option",
		);

		act(() =>
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })),
		);
		const activeId = input.getAttribute("aria-activedescendant")!;
		expect(activeId).not.toBe("gui-palette-option-0");
		expect(document.getElementById(activeId)?.getAttribute("aria-selected")).toBe("true");
	});

	test("initializes focus when a persistently mounted palette opens", () => {
		const { root } = mount(false);
		expect(document.querySelector('[role="combobox"]')).toBeNull();

		act(() => root.render(<CommandPalette {...props(true)} />));
		const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
		expect(document.activeElement).toBe(input);
	});

	test("traps Tab and restores the opener on close", () => {
		const { root, opener } = mount();
		const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
		const last = document.querySelector<HTMLButtonElement>(".gui-palette-config")!;
		act(() => last.focus());
		act(() => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
		expect(document.activeElement).toBe(input);

		act(() => input.focus());
		act(() =>
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, shiftKey: true }),
			),
		);
		expect(document.activeElement).toBe(last);

		act(() => root.render(<CommandPalette {...props(false)} />));
		expect(document.activeElement).toBe(opener);
	});
});

describe("CommandPalette result ordering", () => {
	test("ranks a title hit ahead of body matches and filters commands by the query", async () => {
		const searchRpc = {
			request: () =>
				Promise.resolve({
					matches: [
						{ sessionId: "body-only", content: "鹅鹅 出现在这条消息里", timestamp: "" },
						{ sessionId: "body-heavy", content: "鹅鹅", timestamp: "" },
					],
					sessions: [
						{ sessionId: "body-only", messageCount: 1 },
						{ sessionId: "body-heavy", messageCount: 9 },
					],
				}),
		} as unknown as RpcClient;
		const host = document.createElement("div");
		host.id = "root";
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push(root);
		hosts.push(host);
		act(() =>
			root.render(
				<CommandPalette
					{...props(true)}
					rpc={searchRpc}
					sessions={[
						{ id: "body-only", label: "无关会话" },
						{ id: "body-heavy", label: "另一条无关会话" },
						{ id: "title-hit", label: "鹅鹅 与伙伴的自行车小游戏" },
					]}
				/>,
			),
		);
		const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
		act(() => {
			const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
			setValue.call(input, "鹅鹅");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		// The daemon search is debounced; wait past the 250ms window.
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 320));
		});

		const rows = [...document.querySelectorAll<HTMLElement>("[data-palette-row]")];
		const labels = rows.map(row => row.textContent ?? "");
		// Every command row disappeared: none of their labels contain 鹅鹅.
		expect(labels[0]).toContain("鹅鹅");
		expect(labels[0]).toContain("自行车");
		// Body-heavy (9 matches) outranks body-only (1) after the title hit.
		expect(labels[1]).toContain("另一条无关会话");
		expect(labels[2]).toContain("无关会话");
	});
});
