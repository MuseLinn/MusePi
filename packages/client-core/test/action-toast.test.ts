import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
	ACTION_TOAST_TTL_MS,
	dismissActionToast,
	dismissActionToastSource,
	getToasts,
	pauseActionToast,
	pushActionToast,
	resumeActionToast,
	ttlFor,
	WARNING_TOAST_TTL_MS,
} from "../src/lib/action-toast";

afterEach(() => {
	for (const toast of getToasts()) dismissActionToast(toast.id);
	setSystemTime();
});

beforeEach(() => setSystemTime(20_000));

describe("action toast store", () => {
	test("kind owns the lifetime, errors never expire", () => {
		expect(ttlFor("info")).toBe(ACTION_TOAST_TTL_MS);
		expect(ttlFor("success")).toBe(ACTION_TOAST_TTL_MS);
		expect(ttlFor("warning")).toBe(WARNING_TOAST_TTL_MS);
		expect(ttlFor("error")).toBe(Number.POSITIVE_INFINITY);
		pushActionToast({ kind: "warning", message: "w" });
		expect(getToasts()[0]?.expiresAt).toBe(20_000 + WARNING_TOAST_TTL_MS);
		pushActionToast({ kind: "error", message: "e" });
		expect(getToasts().at(-1)?.expiresAt).toBe(Number.POSITIVE_INFINITY);
	});

	test("the same message from different sources coexists", () => {
		pushActionToast({ message: "保存失败", dedupeKey: "file:save" });
		pushActionToast({ message: "保存失败", dedupeKey: "market:save" });
		expect(getToasts().map(t => t.message)).toEqual(["保存失败", "保存失败"]);
	});

	test("the same source replaces its content instead of stacking", () => {
		pushActionToast({ message: "下载中", dedupeKey: "update" });
		pushActionToast({ message: "已下载", dedupeKey: "update" });
		expect(getToasts()).toHaveLength(1);
		expect(getToasts()[0]?.message).toBe("已下载");
	});

	test("three errors survive a transient and a new error evicts the transient first", () => {
		pushActionToast({ kind: "error", message: "e1", dedupeKey: "e1" });
		pushActionToast({ kind: "error", message: "e2", dedupeKey: "e2" });
		pushActionToast({ message: "t1", dedupeKey: "t1" });
		pushActionToast({ kind: "error", message: "e3", dedupeKey: "e3" });
		expect(getToasts().map(t => t.message)).toEqual(["e1", "e2", "e3"]);
	});

	test("pause freezes the remainder and resume continues from it", () => {
		const id = pushActionToast({ message: "paused" });
		setSystemTime(23_000);
		pauseActionToast(id);
		expect(getToasts()[0]?.expiresAt).toBe(Number.POSITIVE_INFINITY);
		setSystemTime(40_000);
		resumeActionToast(id);
		expect(getToasts()[0]?.expiresAt).toBe(43_000);
	});

	test("source recovery dismisses only that source", () => {
		pushActionToast({ kind: "error", message: "a", dedupeKey: "a" });
		pushActionToast({ kind: "error", message: "b", dedupeKey: "b" });
		dismissActionToastSource("a");
		expect(getToasts().map(t => t.message)).toEqual(["b"]);
	});

	test("cancel copy travels with the toast", () => {
		let cancelled = 0;
		pushActionToast({ message: "retry?", cancelLabel: "取消", onCancel: () => cancelled++ });
		expect(getToasts()[0]?.cancelLabel).toBe("取消");
		getToasts()[0]?.onCancel?.();
		expect(cancelled).toBe(1);
	});
});
