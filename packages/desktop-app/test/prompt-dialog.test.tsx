import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DialogFrame } from "../src/components/DialogFrame";
import { PromptProvider, useConfirm, usePrompt } from "../src/lib/prompt-dialog";

const roots: Root[] = [];

type Result = string;

function Probe({ onSettle }: { onSettle(result: Result): void }): ReactNode {
	const { confirm } = useConfirm();
	const { prompt } = usePrompt();
	return (
		<>
			<button
				type="button"
				className="probe-normal"
				onClick={() => void confirm("Normal action", "Continue").then(value => onSettle(`normal:${value}`))}
			>
				Normal
			</button>
			<button
				type="button"
				className="probe-destructive"
				onClick={() =>
					void confirm("Permanent deletion", "Delete", { destructive: true }).then(value =>
						onSettle(`destructive:${value}`),
					)
				}
			>
				Destructive
			</button>
			<button
				type="button"
				className="probe-prompt"
				onClick={() => void prompt({ title: "Prompt title" }).then(value => onSettle(`prompt:${value}`))}
			>
				Prompt
			</button>
		</>
	);
}

function mountProbe(results: Result[], extra?: ReactNode): Root {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() =>
		root.render(
			<PromptProvider>
				{extra}
				<Probe onSettle={result => results.push(result)} />
			</PromptProvider>,
		),
	);
	return root;
}

function openDialog(kind: "normal" | "destructive" | "prompt"): void {
	const trigger = document.querySelector<HTMLElement>(`.probe-${kind}`);
	if (!trigger) throw new Error(`${kind} trigger did not render`);
	act(() => trigger.click());
}

function press(key: "Enter" | "Escape"): void {
	act(() => {
		document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	});
}

async function settleExit(): Promise<void> {
	await act(async () => Bun.sleep(220));
}

function dialog(): HTMLElement {
	const element = document.querySelector<HTMLElement>(".gui-dialog");
	if (!element) throw new Error("dialog did not render");
	return element;
}

function clickDialogButton(kind: "cancel" | "confirm"): void {
	const selector = kind === "cancel" ? ".gui-btn:not(.gui-btn-primary)" : ".gui-btn-primary";
	const button = dialog().querySelector<HTMLElement>(selector);
	if (!button) throw new Error(`${kind} button did not render`);
	act(() => button.click());
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

describe("Promise prompt and confirm", () => {
	test("a normal confirm handles Enter and resolves only after the 180ms exit", async () => {
		const results: Result[] = [];
		mountProbe(results);
		openDialog("normal");

		press("Enter");
		expect(results).toEqual([]);
		await act(async () => Bun.sleep(140));
		expect(results).toEqual([]);
		await act(async () => Bun.sleep(100));

		expect(results).toEqual(["normal:true"]);
		expect(document.querySelector(".gui-dialog")).toBeNull();
	});

	test("a confirm exposes its message as the accessible dialog name", () => {
		mountProbe([]);
		openDialog("normal");

		expect(dialog().getAttribute("aria-label")).toBe("Normal action");
	});

	test("a destructive confirm focuses Cancel initially", async () => {
		mountProbe([]);
		openDialog("destructive");
		await act(async () => Bun.sleep(30));
		const cancel = dialog().querySelector<HTMLElement>(".gui-btn:not(.gui-btn-primary)");

		expect(document.activeElement === cancel).toBe(true);
	});

	for (const { from, to, expected } of [
		{ from: "prompt", to: "destructive", expected: "cancel" },
		{ from: "destructive", to: "prompt", expected: "input" },
		{ from: "normal", to: "destructive", expected: "cancel" },
		{ from: "destructive", to: "normal", expected: "cancel" },
	] as const) {
		test(`replacing ${from} with ${to} focuses the new request's ${expected} control`, () => {
			mountProbe([]);
			openDialog(from);
			if (from !== "prompt") {
				const primary = dialog().querySelector<HTMLElement>(".gui-btn-primary");
				if (!primary) throw new Error("primary button did not render");
				primary.focus();
			}

			openDialog(to);

			const selector = expected === "input" ? "input" : ".gui-btn:not(.gui-btn-primary)";
			const target = dialog().querySelector<HTMLElement>(selector);
			if (!target) throw new Error(`${expected} control did not render`);
			expect(document.activeElement === target).toBe(true);
		});
	}

	test("a destructive confirm ignores Enter but still settles on Cancel", async () => {
		const results: Result[] = [];
		mountProbe(results);
		openDialog("destructive");

		press("Enter");
		await settleExit();

		expect(results).toEqual([]);
		expect(document.querySelector(".gui-dialog")).not.toBeNull();
		clickDialogButton("cancel");
		await settleExit();
		expect(results).toEqual(["destructive:false"]);
	});

	for (const cancelPath of ["escape", "cancel-button", "backdrop"] as const) {
		test(`${cancelPath} cancellation settles exactly once`, async () => {
			const results: Result[] = [];
			mountProbe(results);
			openDialog("normal");

			const cancel = (): void => {
				if (cancelPath === "escape") press("Escape");
				else if (cancelPath === "cancel-button") clickDialogButton("cancel");
				else act(() => dialog().parentElement?.click());
			};
			cancel();
			cancel();
			await settleExit();

			expect(results).toEqual(["normal:false"]);
		});
	}

	test("a repeated request cancels the previous promise and keeps the new request independent", async () => {
		const results: Result[] = [];
		mountProbe(results);
		openDialog("normal");
		openDialog("normal");
		await settleExit();
		press("Enter");
		await settleExit();

		expect(results).toEqual(["normal:false", "normal:true"]);
	});

	test("unmount settles a pending confirm as cancelled", async () => {
		const results: Result[] = [];
		const root = mountProbe(results);
		openDialog("normal");

		act(() => root.unmount());
		await settleExit();

		expect(results).toEqual(["normal:false"]);
	});

	test("unmount settles a pending prompt as cancelled", async () => {
		const results: Result[] = [];
		const root = mountProbe(results);
		openDialog("prompt");

		act(() => root.unmount());
		await settleExit();

		expect(results).toEqual(["prompt:null"]);
	});

	test("Escape settles only the top confirm, not the dialog beneath it", async () => {
		const results: Result[] = [];
		let baseCloseCount = 0;
		mountProbe(
			results,
			<DialogFrame open onClose={() => baseCloseCount++} label="Base dialog">
				<button type="button">Base action</button>
			</DialogFrame>,
		);
		openDialog("normal");

		press("Escape");
		await settleExit();

		expect(results).toEqual(["normal:false"]);
		expect(baseCloseCount).toBe(0);
		press("Escape");
		expect(baseCloseCount).toBe(1);
	});
});
