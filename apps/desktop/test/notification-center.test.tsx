import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import {
	clearNotificationHistory,
	recordNotificationHistory,
	unreadNotificationHistoryCount,
} from "@musepi/client-core/src/lib/notification-history";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NotificationCenter } from "../src/components/NotificationCenter";

let host: HTMLDivElement;
let root: Root;
let previousLocale: string;

beforeEach(async () => {
	previousLocale = getLocaleSnapshot();
	setLocale("en-US");
	clearNotificationHistory();
	host = document.createElement("div");
	host.id = "root";
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root.render(<NotificationCenter />));
});

afterEach(async () => {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 160));
		root.unmount();
	});
	host.remove();
	clearNotificationHistory();
	setLocale(previousLocale);
});

function trigger(): HTMLButtonElement {
	return host.querySelector<HTMLButtonElement>(".gui-notification-trigger")!;
}

function record(id: number): void {
	recordNotificationHistory({ id, kind: "info", message: `Notice ${id}`, createdAt: Date.now() });
}

describe("NotificationCenter", () => {
	test("shows unread counts and caps the badge at 99+", async () => {
		expect(host.querySelector(".gui-notification-badge") === null).toBe(true);
		await act(async () => {
			record(1);
			record(2);
			record(3);
		});
		expect(host.querySelector(".gui-notification-badge")?.textContent).toBe("3");
		expect(trigger().getAttribute("aria-label")).toBe("Notifications (3 unread)");
		await act(async () => {
			for (let id = 4; id <= 105; id++) record(id);
		});
		expect(host.querySelector(".gui-notification-badge")?.textContent).toBe("99+");
	});

	test("opening marks all read, and clearing leaves an empty state", async () => {
		await act(async () => {
			record(1);
			record(2);
		});
		await act(async () => {
			trigger().click();
			await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		});
		expect(unreadNotificationHistoryCount()).toBe(0);
		expect(host.querySelector(".gui-notification-badge") === null).toBe(true);
		expect(document.querySelectorAll(".gui-notification-row").length).toBe(2);
		expect(document.querySelector(".gui-notification-list")?.textContent).toContain("Notice 2");
		const clear = document.querySelector<HTMLButtonElement>(".gui-notification-clear")!;
		await act(async () => clear.click());
		expect(document.querySelectorAll(".gui-notification-row").length).toBe(0);
		expect(document.querySelector(".gui-notification-empty")?.textContent).toBe("No notifications");
	});
});
