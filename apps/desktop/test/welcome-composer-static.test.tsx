import "./happy-dom-shim";
import { afterEach, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HeroComposer } from "../src/components/HeroComposer";
import type { RpcClient } from "../src/lib/rpc";

const roots = new Set<Root>();
const rpc = { request: async () => null, addEventListener: () => () => {} } as unknown as RpcClient;

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
});

it("keeps empty-state placeholder and tip static while focus mode is open", async () => {
	vi.useFakeTimers();
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () => root.render(<HeroComposer onSubmit={() => {}} rpc={rpc} focused />));
	const placeholderNode = container.querySelector(".gui-cm-placeholder");
	const tip = container.querySelector(".gui-tip");
	const placeholder = placeholderNode?.textContent;
	const tipText = tip?.textContent;

	await act(async () => vi.advanceTimersByTime(10_000));

	expect(container.querySelector(".gui-cm-placeholder")?.textContent).toBe(placeholder);
	expect(tip?.textContent).toBe(tipText);
});

it("left-aligns workspace, mode, memory and connector choices in one row", async () => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	const connectorRpc = {
		request: async (method: string) => {
			if (method === "connectors.list") return { servers: [{ name: "workspace" }], selected: null };
			if (method === "git.branches") return { current: "main", branches: ["main"] };
			return null;
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
	await act(async () =>
		root.render(
			<HeroComposer
				onSubmit={() => {}}
				rpc={connectorRpc}
				project="/workspace"
				onProject={() => {}}
				modes={[{ id: "work", label: "Work" }]}
				memoryMode="persistent"
				onMemoryModeChange={() => {}}
			/>,
		),
	);
	const row = container.querySelector(".gui-project-row");
	for (const selector of [".gui-project-chip", ".gui-memory-chip", ".gui-connector-chip"]) {
		expect(row?.querySelector(selector) !== null).toBe(true);
	}
	expect(row?.querySelectorAll(".gui-project-chip").length).toBe(3);
	expect(row?.querySelector(".gui-composer-dock--welcome") === null).toBe(true);
});

it("lets the welcome textarea claim OS file drags on its own", async () => {
	// The window-level drop anchor is a fallback, not the only reason this
	// textarea receives a drop: Chromium needs dragover prevented here too.
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () => root.render(<HeroComposer onSubmit={() => {}} rpc={rpc} />));
	const editor = container.querySelector(".cm-content");
	expect(editor).not.toBeNull();

	const over = new Event("dragover", { bubbles: true, cancelable: true });
	Object.defineProperty(over, "dataTransfer", {
		value: { types: ["Files"], files: [], dropEffect: "none" },
	});
	await act(async () => {
		editor?.dispatchEvent(over);
	});
	expect(over.defaultPrevented).toBe(true);
});
