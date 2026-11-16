/** Action-toast view contracts. Store semantics live in client-core's own suite. */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	ACTION_TOAST_TTL_MS,
	dismissActionToast,
	getToasts,
	pushActionToast,
	WARNING_TOAST_TTL_MS,
} from "@musepi/client-core/src/lib/action-toast";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ActionToastStack as ActionToastStackComponent } from "../src/components/ActionToast";
import { defineGlobal } from "./define-global";

const roots: Root[] = [];
let ActionToastStack: typeof ActionToastStackComponent;
let ownsDomRegistration = false;

beforeAll(async () => {
	// Test entries are evaluated before any suite runs. Load component graphs
	// only after the execution-time DOM is ready, and unload only our own registration.
	// Always cover the stale-DOM replacement branch, not only the current green order.
	if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
	defineGlobal("document", { body: {}, head: {}, documentElement: {} } as unknown as Document);
	const wasRegistered = GlobalRegistrator.isRegistered;
	const hasRealDom = typeof document !== "undefined" && typeof document.addEventListener === "function";
	if (wasRegistered && !hasRealDom) await GlobalRegistrator.unregister();
	if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
	ownsDomRegistration = !wasRegistered || !hasRealDom;
	(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
	({ ActionToastStack } = await import("../src/components/ActionToast"));
});

afterAll(async () => {
	if (ownsDomRegistration) await GlobalRegistrator.unregister();
	if (!GlobalRegistrator.isRegistered) await GlobalRegistrator.register();
	expect(GlobalRegistrator.isRegistered).toBe(true);
});

function mount(node: Parameters<Root["render"]>[0]): HTMLDivElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(node));
	return host;
}

function mountStack(): void {
	mount(createElement(ActionToastStack));
}

function toastElement(): HTMLElement {
	const element = document.querySelector<HTMLElement>(".gui-action-toast");
	if (!element) throw new Error("action toast did not render");
	return element;
}

function activeCount(): number {
	return getToasts().length;
}

function rows(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>(".gui-action-toast")];
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

function closeFirst(): void {
	const close = toastElement().querySelector<HTMLButtonElement>(".gui-action-toast-close");
	if (!close) throw new Error("toast close button did not render");
	act(() => close.click());
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	// Drain by dismissing whatever is left; ids are monotonic so this cannot
	// disturb a later test's expectations.
	for (const toast of getToasts()) dismissActionToast(toast.id);
	vi.useRealTimers();
	setSystemTime();
	document.body.innerHTML = "";
});

describe("ActionToastStack", () => {
	test("a toast disappears at its lifetime", () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		mountStack();
		act(() => void pushActionToast({ message: "稍后撤销", actionLabel: "撤销" }));

		advance(ACTION_TOAST_TTL_MS - 1);
		expect(activeCount()).toBe(1);
		advance(1);
		expect(activeCount()).toBe(0);
	});

	test("hover freezes the remaining lifetime and leaving resumes it", () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		mountStack();
		act(() => void pushActionToast({ message: "稍后撤销", actionLabel: "撤销" }));
		const toast = toastElement();

		advance(2_000);
		hover(toast, true);
		advance(ACTION_TOAST_TTL_MS + 1_000);
		expect(activeCount()).toBe(1);

		hover(toast, false);
		advance(ACTION_TOAST_TTL_MS - 2_000 - 1);
		expect(activeCount()).toBe(1);
		advance(1);
		expect(activeCount()).toBe(0);
	});

	test("focus freezes the lifetime even after the pointer leaves", () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		mountStack();
		act(() => void pushActionToast({ message: "键盘撤销", actionLabel: "撤销" }));
		const toast = toastElement();
		const action = toast.querySelector<HTMLButtonElement>(".gui-action-toast-btn");
		const outside = document.createElement("button");
		document.body.appendChild(outside);
		if (!action) throw new Error("toast action did not render");

		act(() => action.focus());
		hover(toast, true);
		hover(toast, false);
		advance(ACTION_TOAST_TTL_MS + 1_000);
		expect(activeCount()).toBe(1);

		act(() => outside.focus());
		advance(ACTION_TOAST_TTL_MS);
		expect(activeCount()).toBe(0);
	});

	test("hovering one row freezes every visible toast, and leaving resumes them", () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		mountStack();
		act(() => {
			pushActionToast({ message: "a", dedupeKey: "a" });
			pushActionToast({ message: "b", dedupeKey: "b" });
		});
		hover(rows()[0], true);
		advance(ACTION_TOAST_TTL_MS + 1_000);
		expect(activeCount()).toBe(2);

		hover(rows()[0], false);
		advance(ACTION_TOAST_TTL_MS);
		expect(activeCount()).toBe(0);
	});

	test("a replacement stays frozen while the stack is hovered", () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		mountStack();
		act(() => void pushActionToast({ message: "retrying", dedupeKey: "session:retry" }));
		hover(toastElement(), true);
		act(() => void pushActionToast({ message: "retrying again", kind: "info", dedupeKey: "session:retry" }));

		advance(ACTION_TOAST_TTL_MS + 1_000);
		expect(activeCount()).toBe(1);

		hover(toastElement(), false);
		advance(ACTION_TOAST_TTL_MS);
		expect(activeCount()).toBe(0);
	});

	test("an error stays until dismissed and is announced assertively", () => {
		vi.useFakeTimers();
		mountStack();
		act(() => void pushActionToast({ message: "操作失败", kind: "error" }));
		const toast = toastElement();
		expect(toast.getAttribute("role")).toBe("alert");
		expect(toast.getAttribute("aria-live")).toBe("assertive");

		advance(60_000);
		expect(activeCount()).toBe(1);
		closeFirst();
		expect(activeCount()).toBe(0);
	});

	test("a warning renders its content and expires at the warning lifetime", () => {
		vi.useFakeTimers();
		mountStack();
		act(() =>
			pushActionToast({
				kind: "warning",
				title: "保存失败",
				message: "请检查文件权限后重试",
				details: "EPERM: operation not permitted",
			}),
		);
		const toast = toastElement();
		expect(toast.querySelector(".gui-action-toast-title")?.textContent).toBe("保存失败");
		expect(toast.querySelector(".gui-action-toast-msg")?.textContent).toBe("请检查文件权限后重试");
		expect(toast.querySelector(".gui-action-toast-details")?.textContent).toBe("EPERM: operation not permitted");

		advance(WARNING_TOAST_TTL_MS);
		expect(activeCount()).toBe(0);
	});

	test("every pushed toast is readable at once, up to the stack cap", () => {
		mountStack();
		act(() => {
			pushActionToast({ message: "one", dedupeKey: "1" });
			pushActionToast({ message: "two", dedupeKey: "2" });
			pushActionToast({ message: "three", dedupeKey: "3" });
			pushActionToast({ message: "four", dedupeKey: "4" });
		});
		const texts = rows().map(row => row.querySelector(".gui-action-toast-msg")?.textContent);
		expect(texts).toHaveLength(3);
		expect(texts).toContain("two");
		expect(texts).toContain("three");
		expect(texts).toContain("four");
	});

	test("a dismissed row stays visible through its exit, then unmounts", () => {
		vi.useFakeTimers();
		mountStack();
		act(() => void pushActionToast({ message: "bye" }));
		closeFirst();
		expect(rows()).toHaveLength(1);
		advance(179);
		expect(rows()).toHaveLength(1);
		advance(1);
		expect(rows()).toHaveLength(0);
	});

	test("the cancel action runs before the toast is dismissed", () => {
		vi.useFakeTimers();
		let cancelled = 0;
		mountStack();
		act(() => void pushActionToast({ message: "retry?", cancelLabel: "取消", onCancel: () => cancelled++ }));
		const cancel = toastElement().querySelector<HTMLButtonElement>(".gui-action-toast-cancel");
		if (!cancel) throw new Error("toast cancel button did not render");
		act(() => cancel.click());
		expect(cancelled).toBe(1);
		expect(activeCount()).toBe(0);
		expect(rows()).toHaveLength(1);
		advance(180);
		expect(rows()).toHaveLength(0);
	});

	test("the countdown on a self-closing toast runs for exactly its lifetime", () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		mountStack();
		act(() => void pushActionToast({ message: "info" }));
		const infoRing = toastElement().querySelector<SVGSVGElement>(".gui-toast-ring");
		expect(infoRing?.style.animationDuration).toBe(`${ACTION_TOAST_TTL_MS}ms`);

		act(() => void pushActionToast({ message: "warning", kind: "warning", dedupeKey: "w" }));
		const warning = rows().find(row => row.textContent?.includes("warning"));
		const warningRing = warning?.querySelector<SVGSVGElement>(".gui-toast-ring");
		expect(warningRing?.style.animationDuration).toBe(`${WARNING_TOAST_TTL_MS}ms`);

		// The toast really leaves at the duration its countdown advertises.
		advance(WARNING_TOAST_TTL_MS);
		expect(getToasts().some(toast => toast.dedupeKey === "w")).toBe(false);
	});

	test("re-pushing a source drops its still-exiting row", () => {
		vi.useFakeTimers();
		mountStack();
		act(() => void pushActionToast({ message: "已归档会话" }));
		closeFirst();
		act(() => void pushActionToast({ message: "已归档会话" }));
		expect(rows()).toHaveLength(1);
		advance(180);
		expect(rows()).toHaveLength(1);
	});

	test("closing a re-pushed toast leaves one row that then unmounts", () => {
		vi.useFakeTimers();
		mountStack();
		act(() => void pushActionToast({ message: "已归档会话" }));
		closeFirst();
		act(() => void pushActionToast({ message: "已归档会话" }));
		closeFirst();
		expect(rows()).toHaveLength(1);
		advance(180);
		expect(rows()).toHaveLength(0);
	});

	test("the polite live region announces before the first toast", () => {
		mountStack();
		const stack = document.querySelector(".gui-action-toasts") as HTMLElement;
		expect(stack.getAttribute("role")).toBe("status");
		expect(stack.getAttribute("aria-live")).toBe("polite");

		act(() => void pushActionToast({ message: "info" }));
		expect(toastElement().getAttribute("role")).toBeNull();
		act(() => void pushActionToast({ kind: "error", message: "bad" }));
		const error = document.querySelector(".gui-action-toast--error") as HTMLElement;
		expect(error.getAttribute("role")).toBe("alert");
	});
});
