import "./happy-dom-shim";
import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WidgetFit } from "../../client-core/src/widgets/fit";

const roots = new Set<Root>();
const observers: MockResizeObserver[] = [];
class MockResizeObserver {
	constructor(readonly callback: () => void) {
		observers.push(this);
	}
	observe(): void {}
	disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver;

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	observers.length = 0;
	document.body.innerHTML = "";
});

it("fits both dimensions and remeasures when widget content changes", async () => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.add(root);
	await act(async () =>
		root.render(
			<WidgetFit>
				<div />
			</WidgetFit>,
		),
	);
	const outer = host.querySelector<HTMLElement>(".gui-widget-fit");
	const inner = host.querySelector<HTMLElement>(".gui-widget-fit-inner");
	expect(outer).not.toBeNull();
	expect(inner).not.toBeNull();
	for (const [key, value] of Object.entries({ clientWidth: 100, clientHeight: 100 })) {
		Object.defineProperty(outer!, key, { value, configurable: true });
	}
	for (const [key, value] of Object.entries({ scrollWidth: 200, scrollHeight: 100 })) {
		Object.defineProperty(inner!, key, { value, configurable: true });
	}
	await act(async () => {
		for (const observer of observers) observer.callback();
	});
	expect(inner!.style.transform).toBe("scale(0.5)");

	Object.defineProperty(inner!, "scrollWidth", { value: 100, configurable: true });
	Object.defineProperty(inner!, "scrollHeight", { value: 50, configurable: true });
	await act(async () => {
		for (const observer of observers) observer.callback();
	});
	expect(inner!.style.transform).toBe("scale(1)");
});
