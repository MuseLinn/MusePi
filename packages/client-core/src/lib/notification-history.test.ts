import { beforeEach, describe, expect, test } from "bun:test";
import { pushActionToast } from "./action-toast";
import {
	clearNotificationHistory,
	listNotificationHistory,
	markAllNotificationHistoryRead,
	recordNotificationHistory,
	subscribeNotificationHistory,
	unreadNotificationHistoryCount,
} from "./notification-history";

beforeEach(() => {
	clearNotificationHistory();
});

describe("notification history", () => {
	test("records newest first and publishes changes", () => {
		let notifications = 0;
		const unsubscribe = subscribeNotificationHistory(() => notifications++);
		recordNotificationHistory({ id: 1, kind: "info", message: "first", createdAt: 10 });
		recordNotificationHistory({ id: 2, kind: "warning", title: "Careful", message: "second", createdAt: 20 });
		unsubscribe();
		expect(listNotificationHistory().map(entry => entry.id)).toEqual([2, 1]);
		expect(listNotificationHistory()[0]).toEqual({
			id: 2,
			kind: "warning",
			title: "Careful",
			message: "second",
			createdAt: 20,
			read: false,
		});
		expect(unreadNotificationHistoryCount()).toBe(2);
		expect(notifications).toBe(2);
	});

	test("caps history at 100 entries and drops the oldest", () => {
		for (let id = 0; id < 105; id++) {
			recordNotificationHistory({ id, kind: "info", message: `message ${id}`, createdAt: id });
		}
		const entries = listNotificationHistory();
		expect(entries.length).toBe(100);
		expect(entries[0]?.id).toBe(104);
		expect(entries.at(-1)?.id).toBe(5);
	});

	test("does not write the same id twice", () => {
		recordNotificationHistory({ id: 7, kind: "info", message: "original", createdAt: 10 });
		recordNotificationHistory({ id: 7, kind: "error", message: "replacement", createdAt: 20 });
		expect(listNotificationHistory().length).toBe(1);
		expect(listNotificationHistory()[0]?.message).toBe("original");
		expect(unreadNotificationHistoryCount()).toBe(1);
	});

	test("marks every entry read and clears the history", () => {
		recordNotificationHistory({ id: 1, kind: "info", message: "one", createdAt: 10 });
		recordNotificationHistory({ id: 2, kind: "info", message: "two", createdAt: 20 });
		markAllNotificationHistoryRead();
		expect(unreadNotificationHistoryCount()).toBe(0);
		expect(listNotificationHistory().every(entry => entry.read)).toBe(true);
		clearNotificationHistory();
		expect(listNotificationHistory()).toEqual([]);
	});

	test("every toast stores text only, without action callbacks", () => {
		const id = pushActionToast({
			kind: "success",
			title: "Saved",
			message: "Done",
			actionLabel: "Undo",
			onAction: () => {},
		});
		const entry = listNotificationHistory()[0];
		expect(entry?.id).toBe(id);
		expect(entry?.title).toBe("Saved");
		expect(entry?.message).toBe("Done");
		expect(entry && "onAction" in entry).toBe(false);
		expect(entry && "actionLabel" in entry).toBe(false);
	});
});
