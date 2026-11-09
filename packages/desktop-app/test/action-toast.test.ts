/** Action-toast view contracts. The store contract lives in client-core. */
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
	test("owns the replacement registration after a stale DOM is replaced", () => {
		expect(ownsDomRegistration).toBe(true);
	});

	test("hover freezes the remaining lifetime and leaving resumes it", () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		mountStack();
		act(() => pushActionToast({ message: "稍后撤销", actionLabel: "撤销" }));
		const toast = toastElement();

		advance(2_000);
		hover(toast, true);
		advance(ACTION_TOAST_TTL_MS + 1_000);
		expect(getToasts()).toHaveLength(1);

		hover(toast, false);
		advance(ACTION_TOAST_TTL_MS - 2_000 - 1);
		expect(getToasts()).toHaveLength(1);
		advance(1);
		expect(getToasts()).toHaveLength(0);
	});

	test("focus pauses independently when the pointer leaves", () => {
		vi.useFakeTimers();
		setSystemTime(10_000);
		mountStack();
		act(() => pushActionToast({ message: "键盘撤销", actionLabel: "撤销" }));
		const toast = toastElement();
		const action = toast.querySelector<HTMLButtonElement>(".gui-action-toast-btn");
		const outside = document.createElement("button");
		document.body.appendChild(outside);
		if (!action) throw new Error("toast action did not render");

		act(() => action.focus());
		hover(toast, true);
		hover(toast, false);
		advance(ACTION_TOAST_TTL_MS + 1_000);
		expect(getToasts()).toHaveLength(1);

		act(() => outside.focus());
		advance(ACTION_TOAST_TTL_MS);
		expect(getToasts()).toHaveLength(0);
	});

	test("a manual close dismisses a non-error toast", () => {
		mountStack();
		act(() => pushActionToast({ message: "可关闭的通知" }));
		const close = toastElement().querySelector<HTMLButtonElement>(".gui-action-toast-close");
		expect(close).not.toBeNull();

		act(() => close!.click());
		expect(getToasts()).toHaveLength(0);
	});

	test("an error is persistent and announced assertively", () => {
		vi.useFakeTimers();
		mountStack();
		act(() => pushActionToast({ message: "操作失败", kind: "error" }));
		const toast = toastElement();
		expect(toast.getAttribute("role")).toBe("alert");
		expect(toast.getAttribute("aria-live")).toBe("assertive");

		advance(60_000);
		expect(getToasts()).toHaveLength(1);
	});

	test("a warning expires and renders its title and technical details", () => {
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
		expect(toast.classList.contains("gui-action-toast--warning")).toBe(true);
		expect(toast.getAttribute("role")).toBeNull();
		expect((document.querySelector(".gui-action-toasts") as HTMLElement).getAttribute("role")).toBe("status");
		expect(toast.querySelector(".gui-action-toast-title")?.textContent).toBe("保存失败");
		expect(toast.querySelector(".gui-action-toast-details")?.textContent).toBe("EPERM: operation not permitted");

		advance(WARNING_TOAST_TTL_MS);
		expect(getToasts()).toHaveLength(0);
	});

	test("a collapsed stack expands on hover and focus", () => {
		mountStack();
		act(() => {
			pushActionToast({ message: "one", dedupeKey: "1" });
			pushActionToast({ message: "two", dedupeKey: "2" });
		});
		const stack = document.querySelector(".gui-action-toasts") as HTMLElement;
		expect(stack.dataset.expanded).toBe("false");
		act(() => stack.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
		expect(stack.dataset.expanded).toBe("true");
		act(() => stack.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
		expect(stack.dataset.expanded).toBe("false");
		act(() => (document.querySelector(".gui-action-toast-close") as HTMLButtonElement).focus());
		expect(stack.dataset.expanded).toBe("true");
	});

	test("closing plays the exit class before unmounting", () => {
		vi.useFakeTimers();
		mountStack();
		act(() => void pushActionToast({ message: "bye" }));
		act(() => (document.querySelector(".gui-action-toast-close") as HTMLButtonElement).click());
		expect(document.querySelector(".gui-action-toast--closing")).not.toBeNull();
		act(() => vi.advanceTimersByTime(180));
		expect(document.querySelector(".gui-action-toast--closing")).toBeNull();
	});

	test("cancel runs before the toast is dismissed", () => {
		vi.useFakeTimers();
		let cancelled = 0;
		mountStack();
		act(() => void pushActionToast({ message: "retry?", cancelLabel: "取消", onCancel: () => cancelled++ }));
		act(() => (document.querySelector(".gui-action-toast-cancel") as HTMLButtonElement).click());
		expect(cancelled).toBe(1);
		expect(getToasts()).toHaveLength(0);
		expect(document.querySelector(".gui-action-toast--closing")).not.toBeNull();
		act(() => vi.advanceTimersByTime(180));
		expect(document.querySelector(".gui-action-toast")).toBeNull();
	});

	test("errors carry no countdown ring and pause freezes it", () => {
		mountStack();
		act(() => void pushActionToast({ message: "info" }));
		expect(document.querySelector(".gui-toast-ring")).not.toBeNull();
		act(() => void pushActionToast({ kind: "error", message: "bad" }));
		const error = document.querySelector(".gui-action-toast--error") as HTMLElement;
		expect(error.querySelector(".gui-toast-ring")).toBeNull();
		hover(document.querySelector(".gui-action-toast") as HTMLElement, true);
		expect((document.querySelector(".gui-action-toast") as HTMLElement).dataset.paused).toBe("true");
	});

	test("a focused row keeps the stack expanded after the pointer leaves", () => {
		mountStack();
		act(() => {
			pushActionToast({ message: "one", dedupeKey: "1" });
			pushActionToast({ message: "two", dedupeKey: "2" });
		});
		const stack = document.querySelector(".gui-action-toasts") as HTMLElement;
		const outside = document.createElement("button");
		document.body.appendChild(outside);

		act(() => (document.querySelector(".gui-action-toast-close") as HTMLButtonElement).focus());
		expect(stack.dataset.expanded).toBe("true");

		act(() => stack.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
		act(() => stack.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
		expect(stack.dataset.expanded).toBe("true");

		act(() => outside.focus());
		expect(stack.dataset.expanded).toBe("false");
	});

	test("hovering one row pauses every visible timer", () => {
		vi.useFakeTimers();
		mountStack();
		act(() => void pushActionToast({ message: "a", dedupeKey: "a" }));
		act(() => void pushActionToast({ message: "b", dedupeKey: "b" }));
		hover(document.querySelectorAll(".gui-action-toast")[0] as HTMLElement, true);
		expect(getToasts().every(toast => toast.expiresAt === Number.POSITIVE_INFINITY)).toBe(true);

		const stack = document.querySelector(".gui-action-toasts") as HTMLElement;
		act(() => stack.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
		expect(getToasts().every(toast => Number.isFinite(toast.expiresAt))).toBe(true);
	});

	test("a replacement stays paused while the stack is hovered", () => {
		mountStack();
		act(() => void pushActionToast({ message: "retrying", dedupeKey: "session:retry" }));
		hover(toastElement(), true);
		act(() => void pushActionToast({ message: "retrying again", kind: "info", dedupeKey: "session:retry" }));
		expect(getToasts()).toHaveLength(1);
		expect(getToasts()[0]?.expiresAt).toBe(Number.POSITIVE_INFINITY);

		const stack = document.querySelector(".gui-action-toasts") as HTMLElement;
		act(() => stack.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
		expect(Number.isFinite(getToasts()[0]?.expiresAt)).toBe(true);
	});

	test("re-pushing the same message drops its leaving row", () => {
		vi.useFakeTimers();
		mountStack();
		act(() => void pushActionToast({ message: "已归档会话" }));
		act(() => (document.querySelector(".gui-action-toast-close") as HTMLButtonElement).click());
		act(() => void pushActionToast({ message: "已归档会话" }));
		expect(document.querySelectorAll(".gui-action-toast")).toHaveLength(1);
		expect(document.querySelector(".gui-action-toast--closing")).toBeNull();
		act(() => vi.advanceTimersByTime(180));
		expect(document.querySelectorAll(".gui-action-toast")).toHaveLength(1);
	});

	test("a re-pushed then re-closed toast leaves one closing row", () => {
		vi.useFakeTimers();
		mountStack();
		act(() => void pushActionToast({ message: "已归档会话" }));
		act(() => (document.querySelector(".gui-action-toast-close") as HTMLButtonElement).click());
		act(() => void pushActionToast({ message: "已归档会话" }));
		act(() => (document.querySelector(".gui-action-toast-close") as HTMLButtonElement).click());
		expect(document.querySelectorAll(".gui-action-toast")).toHaveLength(1);
		expect(document.querySelectorAll(".gui-action-toast--closing")).toHaveLength(1);
	});

	test("the polite live region exists before the first toast", () => {
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
