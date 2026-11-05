import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "../src/components/transcript/Markdown";

// Wide-table toggling is a DOM state transition (class + aria-pressed after a
// delegated click), which bun:test's default environment cannot exercise.
GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	GlobalRegistrator.unregister();
});

const TABLE_A = "| a | b |\n|---|---|\n| 1 | 2 |";
const TABLE_B = "| x | y |\n|---|---|\n| 3 | 4 |";

interface Mounted {
	container: HTMLElement;
	root: Root;
}

async function mount(text: string): Promise<Mounted> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(createElement(Markdown, { text }));
	});
	return { container, root };
}

function tables(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>(".tr-table"));
}

function wideButton(table: HTMLElement): HTMLButtonElement {
	const button = table.querySelector<HTMLButtonElement>("[data-table-wide]");
	expect(button).not.toBeNull();
	return button!;
}

describe("table width toggle", () => {
	it("widens the clicked table and restores it on the second click", async () => {
		const { container, root } = await mount(TABLE_A);
		const table = tables(container)[0]!;
		const widenTitle = wideButton(table).getAttribute("title");
		expect(widenTitle).toBeTruthy();
		expect(wideButton(table).getAttribute("aria-pressed")).toBe("false");
		expect(table.classList.contains("tr-table--wide")).toBe(false);

		await act(async () => wideButton(table).click());
		expect(table.classList.contains("tr-table--wide")).toBe(true);
		expect(wideButton(table).getAttribute("aria-pressed")).toBe("true");
		expect(wideButton(table).getAttribute("title")).not.toBe(widenTitle);

		await act(async () => wideButton(table).click());
		expect(table.classList.contains("tr-table--wide")).toBe(false);
		expect(wideButton(table).getAttribute("aria-pressed")).toBe("false");
		expect(wideButton(table).getAttribute("title")).toBe(widenTitle);
		await act(async () => root.unmount());
	});

	it("keys the state by table, so widening one leaves its sibling alone", async () => {
		const { container, root } = await mount(`${TABLE_A}\n\n${TABLE_B}`);
		const [first, second] = tables(container);
		expect(first && second).toBeDefined();

		await act(async () => wideButton(first!).click());
		expect(first!.classList.contains("tr-table--wide")).toBe(true);
		expect(second!.classList.contains("tr-table--wide")).toBe(false);

		await act(async () => wideButton(second!).click());
		expect(first!.classList.contains("tr-table--wide")).toBe(true);
		expect(second!.classList.contains("tr-table--wide")).toBe(true);

		await act(async () => wideButton(first!).click());
		expect(first!.classList.contains("tr-table--wide")).toBe(false);
		expect(second!.classList.contains("tr-table--wide")).toBe(true);
		await act(async () => root.unmount());
	});

	it("keeps a widened table wide when the markdown html is rebuilt (stream settle)", async () => {
		// Contract: the table markup is re-created by every markdown re-render,
		// so the toggle state must live in the component and be re-applied —
		// a class toggled once on the element silently reverts mid-stream.
		const { container, root } = await mount(TABLE_A);
		await act(async () => wideButton(tables(container)[0]!).click());
		expect(tables(container)[0]!.classList.contains("tr-table--wide")).toBe(true);

		await act(async () => {
			root.render(createElement(Markdown, { text: `${TABLE_A}\n\nTrailing prose.` }));
		});
		const rebuilt = tables(container)[0]!;
		expect(rebuilt.classList.contains("tr-table--wide")).toBe(true);
		expect(wideButton(rebuilt).getAttribute("aria-pressed")).toBe("true");
		expect(container.querySelector("table")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("leaves tables in the default layout until the user asks", async () => {
		const { container, root } = await mount(`${TABLE_A}\n\n${TABLE_B}`);
		for (const table of tables(container)) {
			expect(table.classList.contains("tr-table--wide")).toBe(false);
			expect(wideButton(table).getAttribute("aria-pressed")).toBe("false");
		}
		await act(async () => root.unmount());
	});
});
