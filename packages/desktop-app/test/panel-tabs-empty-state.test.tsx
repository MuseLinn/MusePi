import "./happy-dom-shim"; // MUST be first: component module graphs touch DOM globals at evaluation time.
import { afterEach, describe, expect, it, mock } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PanelTabsEmptyState } from "../src/components/panel-tabs-empty-state";

/**
 * The panel's zero-tab page is the only place a surface can be named while it
 * is not launchable (session-scoped views before a session exists). Those rows
 * must stay in the list as explanations and refuse activation.
 */

const mounted: Array<{ host: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];

afterEach(() => {
	while (mounted.length > 0) {
		const entry = mounted.pop();
		if (!entry) continue;
		act(() => entry.root.unmount());
		entry.host.remove();
	}
	document.body.innerHTML = "";
});

function render(items: Parameters<typeof PanelTabsEmptyState>[0]["items"]): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push({ host, root });
	act(() => root.render(createElement(PanelTabsEmptyState, { heading: "Start here", items })));
	return host;
}

describe("panel empty state", () => {
	it("renders an unavailable entry disabled with its reason", () => {
		const onSelect = mock(() => {});
		const host = render([
			{ id: "files", label: "Files", onSelect },
			{ id: "context", label: "Context", hint: "Create a session first", disabled: true, onSelect },
		]);

		const buttons = host.querySelectorAll<HTMLButtonElement>(".gui-panel-empty-item");
		expect(buttons).toHaveLength(2);
		expect(buttons[0]?.disabled).toBe(false);
		expect(buttons[1]?.disabled).toBe(true);
		expect(buttons[1]?.textContent).toContain("Create a session first");

		// A disabled control must not reach its handler, even when the click is
		// synthesized rather than produced by a pointer.
		act(() => buttons[1]?.click());
		expect(onSelect).not.toHaveBeenCalled();
	});
});
