import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Toasts } from "../src/components/shell/Toasts";
import type { Notice, SessionClient } from "../src/lib/client";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const roots: Root[] = [];

function clientWith(notices: readonly Notice[]): SessionClient {
	return {
		getSnapshot: () => ({ notices }),
		subscribe: () => () => {},
	} as unknown as SessionClient;
}

function notice(level: Notice["level"], message = level): Notice {
	return { id: level === "info" ? 1 : level === "warning" ? 2 : 3, level, message, at: Date.now() };
}

function mount(notices: readonly Notice[]): void {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(<Toasts client={clientWith(notices)} />));
}

function toast(level: Notice["level"]): HTMLElement {
	const element = document.querySelector<HTMLElement>(`.sh-toast-${level}`);
	if (!element) throw new Error(`${level} toast did not render`);
	return element;
}

function hover(element: HTMLElement, entering: boolean): void {
	act(() => {
		element.dispatchEvent(
			new MouseEvent(entering ? "mouseover" : "mouseout", {
				bubbles: true,
				relatedTarget: entering ? null : document.body,
			}),
		);
	});
}

function advance(ms: number): void {
	act(() => vi.advanceTimersByTime(ms));
}

beforeEach(() => {
	vi.useFakeTimers();
	setSystemTime(20_000);
});

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
	vi.useRealTimers();
	setSystemTime();
});

describe("Toasts", () => {
	test("hover preserves the remaining info lifetime until the pointer leaves", () => {
		mount([notice("info")]);
		const element = toast("info");

		advance(1_000);
		hover(element, true);
		advance(10_000);
		expect(document.querySelector(".sh-toast-info")).not.toBeNull();
		hover(element, false);
		advance(2_999);
		expect(document.querySelector(".sh-toast-info")).not.toBeNull();
		advance(1);
		expect(document.querySelector(".sh-toast-info")).toBeNull();
	});

	test("focus keeps a warning paused after the pointer leaves", () => {
		mount([notice("warning")]);
		const element = toast("warning");
		const outside = document.createElement("button");
		document.body.appendChild(outside);
		element.tabIndex = 0;

		act(() => element.focus());
		hover(element, true);
		hover(element, false);
		advance(20_000);
		expect(document.querySelector(".sh-toast-warning")).not.toBeNull();
		act(() => outside.focus());
		advance(8_000);
		expect(document.querySelector(".sh-toast-warning")).toBeNull();
	});

	test("every notice level can be dismissed manually", () => {
		mount([notice("info"), notice("warning"), notice("error")]);
		for (const level of ["info", "warning", "error"] as const) {
			const close = toast(level).querySelector<HTMLButtonElement>(".sh-toast-close");
			expect(close).not.toBeNull();
			act(() => close!.click());
			expect(document.querySelector(`.sh-toast-${level}`)).toBeNull();
		}
	});

	test("errors stay visible and use an alert while other levels are polite", () => {
		mount([notice("info"), notice("error")]);
		expect(toast("info").getAttribute("aria-live")).toBe("polite");
		expect(toast("error").getAttribute("role")).toBe("alert");
		expect(toast("error").getAttribute("aria-live")).toBe("assertive");

		advance(60_000);
		expect(document.querySelector(".sh-toast-error")).not.toBeNull();
	});
});
