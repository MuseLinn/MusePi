import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Toasts } from "../src/components/shell/Toasts";
import { dismissActionToast, getToasts, pushActionToast } from "../src/lib/action-toast";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => void GlobalRegistrator.unregister());

const roots: Root[] = [];
function mount(): void {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(<Toasts />));
}
function toast(level: "info" | "warning" | "error"): HTMLElement {
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
	const startedAt = Date.now();
	act(() => {
		vi.advanceTimersByTime(ms);
		setSystemTime(startedAt + ms);
	});
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
	for (const item of getToasts()) dismissActionToast(item.id);
	document.body.innerHTML = "";
	vi.useRealTimers();
	setSystemTime();
});

describe("Toasts", () => {
	test("renders store content in the bottom strip", () => {
		mount();
		act(() => void pushActionToast({ kind: "info", message: "上下文已压缩" }));
		expect(toast("info").textContent).toContain("上下文已压缩");
	});

	test("the polite live region exists before the first toast", () => {
		mount();
		const strip = document.querySelector(".sh-toasts") as HTMLElement;
		expect(strip.getAttribute("role")).toBe("status");
		expect(strip.getAttribute("aria-live")).toBe("polite");

		act(() => void pushActionToast({ message: "info" }));
		expect(toast("info").getAttribute("role")).toBeNull();
		act(() => void pushActionToast({ kind: "error", message: "bad" }));
		expect(toast("error").getAttribute("role")).toBe("alert");
	});

	test("hover preserves the remaining lifetime until the pointer leaves", () => {
		mount();
		act(() => void pushActionToast({ message: "6s" }));
		advance(3000);
		hover(toast("info"), true);
		advance(10_000);
		expect(document.querySelector(".sh-toast-info")).not.toBeNull();
		hover(toast("info"), false);
		advance(3000);
		expect(document.querySelector(".sh-toast-info")).toBeNull();
	});

	test("errors stay visible and announce assertively", () => {
		mount();
		act(() => void pushActionToast({ kind: "error", message: "失败" }));
		const element = toast("error");
		expect(element.getAttribute("role")).toBe("alert");
		advance(60_000);
		expect(document.querySelector(".sh-toast-error")).not.toBeNull();
	});

	test("hovering the strip pauses every visible toast", () => {
		mount();
		act(() => void pushActionToast({ message: "a", dedupeKey: "a" }));
		act(() => void pushActionToast({ message: "b", dedupeKey: "b" }));
		hover(document.querySelectorAll(".sh-toast")[0] as HTMLElement, true);
		expect(getToasts().every(item => item.expiresAt === Number.POSITIVE_INFINITY)).toBe(true);
	});
});
