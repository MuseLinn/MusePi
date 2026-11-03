/** Action-toast store/view contracts. */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ActionToastStack as ActionToastStackComponent } from "../src/components/ActionToast";
import {
	ACTION_TOAST_TTL_MS,
	dismissActionToast,
	dismissActionToastSource,
	getToasts,
	pauseActionToast,
	pushActionToast,
	resumeActionToast,
	subscribeActionToasts,
} from "../src/lib/action-toast";
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

	test("a stable dedupe key replaces updated content from the same source", () => {
		const first = pushActionToast({
			message: "正在加载插件",
			dedupeKey: "capability-center:load",
		});
		const second = pushActionToast({
			message: "插件加载失败",
			dedupeKey: "capability-center:load",
			kind: "error",
		});

		expect(getToasts()).toHaveLength(1);
		expect(getToasts()[0]?.id).toBe(second);
		expect(getToasts()[0]?.id).not.toBe(first);
		expect(getToasts()[0]?.message).toBe("插件加载失败");
	});

	test("recovery dismisses only the persistent error from that source", () => {
		pushActionToast({ message: "列表不可用", kind: "error", dedupeKey: "plugins:load" });
		const unrelated = pushActionToast({ message: "保存失败", kind: "error", dedupeKey: "file:save" });

		dismissActionToastSource("plugins:load");
		expect(getToasts().map(toast => toast.id)).toEqual([unrelated]);
	});

	test("the stack keeps three notices and evicts the oldest non-error first", () => {
		const persistent = pushActionToast({ message: "需要处理", kind: "error" });
		const oldestTransient = pushActionToast({ message: "第一条" });
		const secondTransient = pushActionToast({ message: "第二条" });
		const newest = pushActionToast({ message: "第三条" });

		expect(getToasts().map(toast => toast.id)).toEqual([persistent, secondTransient, newest]);
		expect(getToasts().some(toast => toast.id === oldestTransient)).toBe(false);
		expect(getToasts()).toHaveLength(3);
	});

	test("evicting a paused toast also clears its resumable state", () => {
		const paused = pushActionToast({ message: "已暂停" });
		pauseActionToast(paused);
		pushActionToast({ message: "第二条" });
		pushActionToast({ message: "第三条" });
		pushActionToast({ message: "第四条" });
		let notified = 0;
		const unsubscribe = subscribeActionToasts(() => notified++);

		resumeActionToast(paused);
		unsubscribe();
		expect(notified).toBe(0);
		expect(getToasts()).toHaveLength(3);
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
		expect(toast.getAttribute("role")).toBe("status");
		expect(toast.querySelector(".gui-action-toast-title")?.textContent).toBe("保存失败");
		expect(toast.querySelector(".gui-action-toast-details")?.textContent).toBe("EPERM: operation not permitted");

		advance(ACTION_TOAST_TTL_MS);
		expect(getToasts()).toHaveLength(0);
	});
});
