import "./happy-dom-shim";
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { RemoteAccessDisclaimerDialog } from "../src/components/RemoteAccessDisclaimerDialog";

setLocale("zh-CN");
afterAll(() => setLocale("en-US"));

async function renderDialog(consented: boolean) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const calls: string[] = [];
	await act(async () => {
		root.render(
			createElement(RemoteAccessDisclaimerDialog, {
				open: true,
				consented,
				onAgree: () => calls.push("agree"),
				onDecline: () => calls.push("decline"),
				onClose: () => calls.push("close"),
			}),
		);
	});
	const dialog = document.querySelector('[role="dialog"]');
	if (!(dialog instanceof HTMLElement)) throw new Error("disclaimer did not render");
	return {
		dialog,
		calls,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

describe("RemoteAccessDisclaimerDialog", () => {
	test("first use offers distinct agree and decline decisions", async () => {
		const harness = await renderDialog(false);
		expect(harness.dialog.textContent).toContain("未同意");
		const agree = Array.from(harness.dialog.querySelectorAll("button")).find(el => el.textContent === "同意并继续");
		const decline = Array.from(harness.dialog.querySelectorAll("button")).find(el => el.textContent === "不同意");
		expect(agree).not.toBeUndefined();
		expect(decline).not.toBeUndefined();
		act(() => (agree as HTMLButtonElement).click());
		expect(harness.calls).toEqual(["agree"]);
		await harness.unmount();
	});

	test("closing a first-use disclaimer declines rather than granting access", async () => {
		const harness = await renderDialog(false);
		const decline = Array.from(harness.dialog.querySelectorAll("button")).find(el => el.textContent === "不同意");
		act(() => (decline as HTMLButtonElement).click());
		expect(harness.calls).toEqual(["decline"]);
		expect(harness.calls).not.toContain("agree");
		await harness.unmount();
	});

	test("reviewing an accepted disclaimer only offers close and exposes full details", async () => {
		const harness = await renderDialog(true);
		expect(harness.dialog.textContent).toContain("已同意");
		expect(harness.dialog.textContent).not.toContain("同意并继续");
		const summary = harness.dialog.querySelector("summary");
		expect(summary).not.toBeNull();
		act(() => (summary as HTMLElement).click());
		expect(harness.dialog.querySelector("details")?.hasAttribute("open")).toBe(true);
		const close = Array.from(harness.dialog.querySelectorAll("button")).find(el => el.textContent === "关闭");
		act(() => (close as HTMLButtonElement).click());
		expect(harness.calls).toEqual(["close"]);
		await harness.unmount();
	});
});
