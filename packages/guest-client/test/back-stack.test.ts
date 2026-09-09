import { afterEach, describe, expect, it } from "bun:test";
import { dispatchBack, registerBackLayer, resetBackLayers } from "../src/lib/back-stack";

afterEach(() => {
	resetBackLayers();
});

describe("back-stack dispatch", () => {
	it("returns false when no layer is registered — the shell falls through to history/exit", () => {
		expect(dispatchBack()).toBe(false);
	});

	it("a consumed handler (returns true) stops the fall-through", () => {
		const calls: string[] = [];
		registerBackLayer(40, () => {
			calls.push("workspace");
			return true;
		});
		expect(dispatchBack()).toBe(true);
		expect(calls).toEqual(["workspace"]);
	});

	it("a declining handler (returns false) lets lower-priority layers consume", () => {
		const calls: string[] = [];
		registerBackLayer(60, () => {
			calls.push("panel");
			return false; // layer not actually open — declines
		});
		registerBackLayer(40, () => {
			calls.push("workspace");
			return true;
		});
		expect(dispatchBack()).toBe(true);
		expect(calls).toEqual(["panel", "workspace"]);
	});

	it("highest priority consumes first — one back press closes exactly one layer", () => {
		const closed: string[] = [];
		// Each handler mirrors the React lifecycle: consuming the press is
		// followed by the component unregistering itself (active → false
		// cleanup), so the next dispatch reaches the next layer down.
		const popSheet = registerBackLayer(90, () => {
			closed.push("sheet");
			popSheet();
			return true;
		});
		const popPanel = registerBackLayer(60, () => {
			closed.push("panel");
			popPanel();
			return true;
		});
		const popWorkspace = registerBackLayer(40, () => {
			closed.push("workspace");
			popWorkspace();
			return true;
		});
		expect(dispatchBack()).toBe(true);
		// The regression this guards: a shared CustomEvent broadcast closed
		// every layer at once. The stack closes only the topmost.
		expect(closed).toEqual(["sheet"]);

		expect(dispatchBack()).toBe(true);
		expect(closed).toEqual(["sheet", "panel"]);

		expect(dispatchBack()).toBe(true);
		expect(closed).toEqual(["sheet", "panel", "workspace"]);

		// All layers consumed and unregistered — the shell may now exit.
		expect(dispatchBack()).toBe(false);
	});

	it("unregister removes the layer — subsequent dispatch skips it", () => {
		const closed: string[] = [];
		const popSheet = registerBackLayer(90, () => {
			closed.push("sheet");
			return true;
		});
		registerBackLayer(40, () => {
			closed.push("workspace");
			return true;
		});
		popSheet();
		expect(dispatchBack()).toBe(true);
		expect(closed).toEqual(["workspace"]);
	});

	it("equal priority: earlier-registered layer dispatches first", () => {
		const order: string[] = [];
		registerBackLayer(90, () => {
			order.push("first");
			return true;
		});
		registerBackLayer(90, () => {
			order.push("second");
			return true;
		});
		expect(dispatchBack()).toBe(true);
		expect(order).toEqual(["first"]);
	});

	it("resetBackLayers clears everything — dispatch returns false again", () => {
		registerBackLayer(90, () => true);
		resetBackLayers();
		expect(dispatchBack()).toBe(false);
	});
});
