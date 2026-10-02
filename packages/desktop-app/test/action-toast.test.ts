/**
 * Unit tests for the undo-action toast store (src/lib/action-toast.ts).
 *
 * The store is what makes "archive → Undo" safe to offer unconditionally, so
 * its two observable rules are pinned here: a repeated action replaces its
 * own toast instead of stacking identical rows, and dismissing one toast
 * never touches another.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	ACTION_TOAST_TTL_MS,
	dismissActionToast,
	getToasts,
	pushActionToast,
	subscribeActionToasts,
} from "../src/lib/action-toast";

afterEach(() => {
	// Drain by dismissing whatever is left; ids are monotonic so this cannot
	// disturb a later test's expectations.
	for (const toast of getToasts()) dismissActionToast(toast.id);
});

describe("action toast store", () => {
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
