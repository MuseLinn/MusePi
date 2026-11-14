import "./happy-dom-shim";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceTabStrip, SurfaceTabStripSortable } from "../src/components/surface-tabs";

// The panel tab strip's drag never armed in Electron even though pointerdown
// reached the tab. Guard the one contract that decides it: dnd-kit's synthetic
// activator listeners must actually be present on the rendered tab buttons.

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

beforeAll(async () => {
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
	GlobalRegistrator.register();
});

beforeEach(() => {
	(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	};
	vi.spyOn(window, "matchMedia").mockReturnValue({
		matches: false,
		addEventListener: () => {},
		removeEventListener: () => {},
	} as unknown as MediaQueryList);
});

afterEach(() => {
	while (roots.length) act(() => roots.pop()?.unmount());
	while (hosts.length) hosts.pop()?.remove();
	vi.restoreAllMocks();
});

function mount(): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	roots.push(root);
	act(() =>
		root.render(
			<SurfaceTabStrip
				tabs={[
					{ id: "a", title: "A" },
					{ id: "b", title: "B" },
				]}
				activeId="a"
				onActivate={() => {}}
				onClose={() => {}}
				onReorder={() => {}}
				closeLabel="close"
				ariaLabel="tabs"
			/>,
		),
	);
	return host;
}

function reactProps(element: Element): Record<string, unknown> | null {
	const key = Object.getOwnPropertyNames(element).find(name => name.startsWith("__reactProps$"));
	return key ? ((element as unknown as Record<string, unknown>)[key] as Record<string, unknown>) : null;
}

describe("SurfaceTabStrip drag activator", () => {
	it("binds the pointer-down activator on every tab", () => {
		const host = mount();
		const tabs = [...host.querySelectorAll(".gui-surface-tab")];
		expect(tabs.length).toBe(2);
		for (const tab of tabs) {
			const props = reactProps(tab);
			expect(props).not.toBeNull();
			expect(typeof props?.onPointerDown).toBe("function");
		}
	});

	it("binds the parent context's activator instead of nesting its own", () => {
		// The panel shares ONE context across the strip and the body so a tab can
		// be dragged onto the split zone. An inner context here would swallow the
		// gesture: the parent's drag start never fires and its drop zones stay
		// unarmed. The strip must therefore render straight into the parent.
		const host = document.createElement("div");
		document.body.appendChild(host);
		hosts.push(host);
		const root = createRoot(host);
		roots.push(root);
		const WithParent = (): ReactNode => {
			const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
			return (
				<DndContext sensors={sensors}>
					<SurfaceTabStripSortable
						tabs={[
							{ id: "a", title: "A" },
							{ id: "b", title: "B" },
						]}
						activeId="a"
						onActivate={() => {}}
						onClose={() => {}}
						onReorder={() => {}}
					/>
				</DndContext>
			);
		};
		act(() => root.render(<WithParent />));
		const tabs = [...host.querySelectorAll(".gui-surface-tab")];
		expect(tabs.length).toBe(2);
		for (const tab of tabs) expect(typeof reactProps(tab)?.onPointerDown).toBe("function");
	});
});
