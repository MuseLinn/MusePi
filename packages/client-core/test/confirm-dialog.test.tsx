import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConfirmDialog } from "../src/components/shell/ConfirmDialog";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	void GlobalRegistrator.unregister();
});

const roots: Root[] = [];

function mount(node: ReactNode): Root {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(node));
	return root;
}

function dialog(): HTMLElement {
	const element = document.querySelector<HTMLElement>('[role="dialog"]');
	if (!element) throw new Error("confirm dialog did not render");
	return element;
}

function buttons(): HTMLButtonElement[] {
	return Array.from(dialog().querySelectorAll("button"));
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

describe("ConfirmDialog", () => {
	test("explicit Cancel and Confirm buttons invoke only their respective action", () => {
		const actions: string[] = [];
		mount(
			<ConfirmDialog
				open
				title="Delete file?"
				confirmLabel="Delete"
				onConfirm={() => actions.push("confirm")}
				onClose={() => actions.push("close")}
			/>,
		);
		const [cancel, confirm] = buttons();
		if (!cancel || !confirm) throw new Error("confirm actions did not render");

		act(() => cancel.click());
		act(() => confirm.click());

		expect(actions).toEqual(["close", "confirm"]);
	});

	test("busy disables both actions so an in-flight destructive operation cannot repeat", () => {
		const actions: string[] = [];
		mount(
			<ConfirmDialog
				open
				busy
				title="Deleting file"
				onConfirm={() => actions.push("confirm")}
				onClose={() => actions.push("close")}
			/>,
		);

		for (const button of buttons()) {
			expect(button.disabled).toBe(true);
			act(() => button.click());
		}
		expect(actions).toEqual([]);
	});

	test("a non-destructive dialog confirms from Enter", () => {
		const actions: string[] = [];
		mount(
			<ConfirmDialog
				open
				title="Continue"
				onConfirm={() => actions.push("confirm")}
				onClose={() => actions.push("close")}
			/>,
		);

		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		});

		expect(actions).toEqual(["confirm"]);
	});

	test("a destructive dialog never confirms from Enter", () => {
		const actions: string[] = [];
		mount(
			<ConfirmDialog
				open
				destructive
				title="Permanent deletion"
				onConfirm={() => actions.push("confirm")}
				onClose={() => actions.push("close")}
			/>,
		);

		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		});

		expect(actions).toEqual([]);
	});
});
