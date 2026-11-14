import "./happy-dom-shim";
import { afterEach, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WelcomeComposer } from "../src/components/WelcomeComposer";
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
	await act(async () => root.render(<WelcomeComposer onSubmit={() => {}} rpc={rpc} focused />));
	const textarea = container.querySelector("textarea");
	const tip = container.querySelector(".gui-tip");
	const placeholder = textarea?.placeholder;
	const tipText = tip?.textContent;

	await act(async () => vi.advanceTimersByTime(10_000));

	expect(textarea?.placeholder).toBe(placeholder);
	expect(tip?.textContent).toBe(tipText);
});

it("lets the welcome textarea claim OS file drags on its own", async () => {
	// The window-level drop anchor is a fallback, not the only reason this
	// textarea receives a drop: Chromium needs dragover prevented here too.
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () => root.render(<WelcomeComposer onSubmit={() => {}} rpc={rpc} />));
	const textarea = container.querySelector("textarea");
	expect(textarea).not.toBeNull();

	const over = new Event("dragover", { bubbles: true, cancelable: true });
	Object.defineProperty(over, "dataTransfer", {
		value: { types: ["Files"], files: [], dropEffect: "none" },
	});
	await act(async () => {
		textarea?.dispatchEvent(over);
	});
	expect(over.defaultPrevented).toBe(true);
});
