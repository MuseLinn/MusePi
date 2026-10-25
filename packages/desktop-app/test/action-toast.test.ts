/** Action-toast store/view contracts and BrowserGuiHint corner placement. */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ActionToastStack as ActionToastStackComponent } from "../src/components/ActionToast";
import type { BrowserGuiHint as BrowserGuiHintComponent } from "../src/components/BrowserGuiHint";
import {
	ACTION_TOAST_TTL_MS,
	dismissActionToast,
	getToasts,
	pushActionToast,
	subscribeActionToasts,
} from "../src/lib/action-toast";
import type { RpcClient } from "../src/lib/rpc";
import { defineGlobal } from "./define-global";

const roots: Root[] = [];
let ActionToastStack: typeof ActionToastStackComponent;
let BrowserGuiHint: typeof BrowserGuiHintComponent;
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
	({ BrowserGuiHint } = await import("../src/components/BrowserGuiHint"));
});

afterAll(async () => {
	if (ownsDomRegistration) await GlobalRegistrator.unregister();
	expect(GlobalRegistrator.isRegistered).toBe(false);
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

describe("action toast store", () => {
	test("owns the replacement registration after a stale DOM is replaced", () => {
		expect(ownsDomRegistration).toBe(true);
	});

	test("push publishes to subscribers and is readable synchronously", () => {
		let notified = 0;
		const unsubscribe = subscribeActionToasts(() => {
			notified++;
		});
		const id = pushActionToast({
			message: "会话已归档",
			actionLabel: "撤销",
			onAction: () => {},
		});
		unsubscribe();

		expect(notified).toBe(1);
		const [toast] = getToasts();
		expect(toast?.id).toBe(id);
		expect(toast?.message).toBe("会话已归档");
		expect(toast?.actionLabel).toBe("撤销");
		// The expiry is relative to push time — a toast that never expires
		// would pin the stack open forever.
		expect(toast!.expiresAt).toBeGreaterThan(Date.now());
		expect(toast!.expiresAt).toBeLessThanOrEqual(Date.now() + ACTION_TOAST_TTL_MS);
	});

	test("a second toast with the same message replaces the first, not stacks", () => {
		// Contract: archiving three sessions in a row must not build a
		// three-row wall of identical toasts. The newest undo wins, because
		// it is the one the user can still act on meaningfully.
		const first = pushActionToast({
			message: "会话已归档",
			actionLabel: "撤销",
			onAction: () => {},
		});
		const second = pushActionToast({
			message: "会话已归档",
			actionLabel: "撤销",
			onAction: () => {},
		});

		const toasts = getToasts();
		expect(toasts).toHaveLength(1);
		expect(toasts[0]?.id).toBe(second);
		expect(toasts[0]?.id).not.toBe(first);
	});

	test("distinct messages coexist and dismissing one leaves the other", () => {
		const a = pushActionToast({
			message: "会话已归档",
			actionLabel: "撤销",
			onAction: () => {},
		});
		const b = pushActionToast({
			message: "文件已删除",
			actionLabel: "撤销",
			onAction: () => {},
		});
		expect(getToasts()).toHaveLength(2);

		dismissActionToast(a);
		expect(getToasts().map(t => t.id)).toEqual([b]);
		// Dismissing an already-gone id is a no-op, not a notification storm:
		// the toast's own timer and the click handler can both fire.
		let notified = 0;
		const unsubscribe = subscribeActionToasts(() => {
			notified++;
		});
		dismissActionToast(a);
		unsubscribe();
		expect(notified).toBe(0);
	});

	test("the undo callback is the caller's, invoked before the toast clears", () => {
		// Collected in an array rather than a reassigned flag: control-flow
		// analysis would narrow a `let x: string | null` to `null` here and
		// reject the comparison, since the write happens inside a callback.
		const undoCalls: string[] = [];
		const id = pushActionToast({
			message: "会话已归档",
			actionLabel: "撤销",
			onAction: () => {
				undoCalls.push("restored");
			},
		});
		const toast = getToasts().find(t => t.id === id);
		toast?.onAction?.();
		dismissActionToast(id);

		expect(undoCalls).toEqual(["restored"]);
		expect(getToasts()).toHaveLength(0);
	});
});

describe("ActionToastStack", () => {
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
});

describe("BrowserGuiHint placement", () => {
	test("the browser hint joins the unified notification corner", async () => {
		const corner = document.createElement("div");
		corner.className = "gui-toast-corner";
		document.body.appendChild(corner);
		const rpc = {
			request: async () => ({ "browser.gui": false }),
		} as unknown as RpcClient;
		const host = mount(
			createElement(BrowserGuiHint, {
				activeTools: undefined,
				browserPanelOpen: true,
				rpc,
				onView: () => {},
			}),
		);
		await act(async () => {
			await Promise.resolve();
		});

		const hint = corner.querySelector<HTMLElement>('[data-testid="browser-gui-hint"]');
		expect(hint).not.toBeNull();
		expect(host.contains(hint)).toBe(false);
	});
});
