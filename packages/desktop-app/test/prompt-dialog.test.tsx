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

async function mountProbe(results: Result[], extra?: ReactNode, settledAt?: number[]): Promise<Root> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () =>
		root.render(
			<PromptProvider>
				{extra}
				<Probe
					onSettle={result => {
						results.push(result);
						settledAt?.push(performance.now());
					}}
				/>
			</PromptProvider>,
		),
	);
	return root;
}

async function openDialog(kind: "normal" | "destructive" | "prompt"): Promise<void> {
	const trigger = document.querySelector<HTMLElement>(`.probe-${kind}`);
	if (!trigger) throw new Error(`${kind} trigger did not render`);
	await act(async () => trigger.click());
	// The provider advances its enter phase on a rAF pair plus an 80ms timer.
	await act(async () => Bun.sleep(90));
}

async function press(key: "Enter" | "Escape"): Promise<void> {
	await act(async () => {
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

async function clickDialogButton(kind: "cancel" | "confirm"): Promise<void> {
	const selector = kind === "cancel" ? ".gui-btn:not(.gui-btn-primary)" : ".gui-btn-primary";
	const button = dialog().querySelector<HTMLElement>(selector);
	if (!button) throw new Error(`${kind} button did not render`);
	await act(async () => button.click());
}

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) await act(async () => root.unmount());
	}
	document.body.innerHTML = "";
});

describe("Promise prompt and confirm", () => {
	test("a normal confirm handles Enter and resolves only after the 180ms exit", async () => {
		const results: Result[] = [];
		const settledAt: number[] = [];
		await mountProbe(results, undefined, settledAt);
		await openDialog("normal");

		const pressedAt = performance.now();
		await press("Enter");
		expect(results).toEqual([]);
		// Still closing, not settled: the promise waits for the exit animation.
		expect(document.querySelector(".gui-dialog")).not.toBeNull();
		await settleExit();

		expect(results).toEqual(["normal:true"]);
		// The promise must not settle before the 180ms exit finishes. Sampling
		// the state mid-exit races the runner's clock, so assert the elapsed time
		// to the settle instead.
		expect(settledAt[0]! - pressedAt).toBeGreaterThanOrEqual(180);
		expect(document.querySelector(".gui-dialog")).toBeNull();
	});

	test("a confirm exposes its message as the accessible dialog name", async () => {
		await mountProbe([]);
		await openDialog("normal");

		expect(dialog().getAttribute("aria-label")).toBe("Normal action");
	});

	test("a destructive confirm focuses Cancel initially", async () => {
		await mountProbe([]);
		await openDialog("destructive");
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
		test(`replacing ${from} with ${to} focuses the new request's ${expected} control`, async () => {
			await mountProbe([]);
			await openDialog(from);
			if (from !== "prompt") {
				const primary = dialog().querySelector<HTMLElement>(".gui-btn-primary");
				if (!primary) throw new Error("primary button did not render");
				primary.focus();
			}

			await openDialog(to);

			const selector = expected === "input" ? "input" : ".gui-btn:not(.gui-btn-primary)";
			const target = dialog().querySelector<HTMLElement>(selector);
			if (!target) throw new Error(`${expected} control did not render`);
			expect(document.activeElement === target).toBe(true);
		});
	}

	test("a destructive confirm ignores Enter but still settles on Cancel", async () => {
		const results: Result[] = [];
		await mountProbe(results);
		await openDialog("destructive");

		await press("Enter");
		await settleExit();

		expect(results).toEqual([]);
		expect(document.querySelector(".gui-dialog")).not.toBeNull();
		await clickDialogButton("cancel");
		await settleExit();
		expect(results).toEqual(["destructive:false"]);
	});

	for (const cancelPath of ["escape", "cancel-button", "backdrop"] as const) {
		test(`${cancelPath} cancellation settles exactly once`, async () => {
			const results: Result[] = [];
			await mountProbe(results);
			await openDialog("normal");

			const cancel = async (): Promise<void> => {
				if (cancelPath === "escape") await press("Escape");
				else if (cancelPath === "cancel-button") await clickDialogButton("cancel");
				else await act(async () => dialog().parentElement?.click());
			};
			await cancel();
			await cancel();
			await settleExit();

			expect(results).toEqual(["normal:false"]);
		});
	}

	test("a repeated request cancels the previous promise and keeps the new request independent", async () => {
		const results: Result[] = [];
		await mountProbe(results);
		await openDialog("normal");
		await openDialog("normal");
		await settleExit();
		await press("Enter");
		await settleExit();

		expect(results).toEqual(["normal:false", "normal:true"]);
	});

	test("unmount settles a pending confirm as cancelled", async () => {
		const results: Result[] = [];
		const root = await mountProbe(results);
		await openDialog("normal");

		await act(async () => root.unmount());
		await settleExit();

		expect(results).toEqual(["normal:false"]);
	});

	test("unmount settles a pending prompt as cancelled", async () => {
		const results: Result[] = [];
		const root = await mountProbe(results);
		await openDialog("prompt");

		await act(async () => root.unmount());
		await settleExit();

		expect(results).toEqual(["prompt:null"]);
	});

	test("Escape settles only the top confirm, not the dialog beneath it", async () => {
		const results: Result[] = [];
		let baseCloseCount = 0;
		await mountProbe(
			results,
			<DialogFrame open onClose={() => baseCloseCount++} label="Base dialog">
				<button type="button">Base action</button>
			</DialogFrame>,
		);
		await openDialog("normal");

		await press("Escape");
		await settleExit();

		expect(results).toEqual(["normal:false"]);
		expect(baseCloseCount).toBe(0);
		await press("Escape");
		expect(baseCloseCount).toBe(1);
	});
});
