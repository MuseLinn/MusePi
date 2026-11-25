import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "../src/components/transcript/Markdown";
import { t } from "../src/i18n/index.js";

// The table is a React block now: its width, formats and copy feedback are
// component state. These cases drive the rendered controls instead of the DOM
// attributes the string version used, so they survive another refactor of how
// the block is produced.
GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	window.localStorage.clear();
	GlobalRegistrator.unregister();
});

beforeEach(() => {
	window.localStorage.clear();
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

async function unmount(mounted: Mounted): Promise<void> {
	await act(async () => mounted.root.unmount());
	mounted.container.remove();
}

function tables(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>(".tr-table"));
}

/** The width toggle: first control in the bar, `aria-pressed` says the state. */
function wideButton(table: HTMLElement): HTMLButtonElement {
	const button = table.querySelector<HTMLButtonElement>(".tr-table-bar button[aria-pressed]");
	expect(button).not.toBeNull();
	return button!;
}

function caret(table: HTMLElement): HTMLButtonElement {
	const button = table.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
	expect(button).not.toBeNull();
	return button!;
}

function menuItems(table: HTMLElement): HTMLElement[] {
	return Array.from(table.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

/** Wide-table hashes the component wrote to storage. */
function storedWide(): string[] {
	const raw = window.localStorage.getItem("musepi-gui-wide-tables");
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

describe("table width toggle", () => {
	it("widens on press and restores on the second press", async () => {
		const { container, root } = await mount(TABLE_A);
		const table = tables(container)[0]!;
		expect(wideButton(table).getAttribute("aria-pressed")).toBe("false");
		expect(table.classList.contains("tr-table--wide")).toBe(false);

		await act(async () => wideButton(table).click());
		expect(tables(container)[0]!.classList.contains("tr-table--wide")).toBe(true);
		expect(wideButton(tables(container)[0]!).getAttribute("aria-pressed")).toBe("true");

		await act(async () => wideButton(tables(container)[0]!).click());
		expect(tables(container)[0]!.classList.contains("tr-table--wide")).toBe(false);
		await unmount({ container, root });
	});

	it("keys the state by table, so widening one leaves its sibling alone", async () => {
		const { container, root } = await mount(`${TABLE_A}\n\n${TABLE_B}`);
		const [first, second] = tables(container);
		expect(first && second).toBeDefined();

		await act(async () => wideButton(first!).click());
		expect(tables(container)[0]!.classList.contains("tr-table--wide")).toBe(true);
		expect(tables(container)[1]!.classList.contains("tr-table--wide")).toBe(false);
		await unmount({ container, root });
	});

	it("keeps a widened table wide when later text arrives", async () => {
		const { container, root } = await mount(`${TABLE_A}\n\n第一段`);
		await act(async () => wideButton(tables(container)[0]!).click());
		expect(tables(container)[0]!.classList.contains("tr-table--wide")).toBe(true);

		await act(async () => root.render(createElement(Markdown, { text: `${TABLE_A}\n\n第一段\n\n第二段` })));
		expect(tables(container)[0]!.classList.contains("tr-table--wide")).toBe(true);
		await unmount({ container, root });
	});

	it("remembers the width across a remount (session switch)", async () => {
		const first = await mount(TABLE_A);
		await act(async () => wideButton(tables(first.container)[0]!).click());
		await unmount(first);

		const second = await mount(TABLE_A);
		expect(tables(second.container)[0]!.classList.contains("tr-table--wide")).toBe(true);
		await unmount(second);
	});

	it("drops the record when the width is restored", async () => {
		const { container, root } = await mount(TABLE_A);
		const hash = tables(container)[0]!.dataset.tableHash!;
		await act(async () => wideButton(tables(container)[0]!).click());
		expect(storedWide()).toContain(hash);

		await act(async () => wideButton(tables(container)[0]!).click());
		expect(storedWide()).not.toContain(hash);
		await unmount({ container, root });
	});

	it("falls back to the default width when the stored record is unreadable", async () => {
		window.localStorage.setItem("musepi-gui-wide-tables", "{not json");
		const { container, root } = await mount(TABLE_A);
		expect(tables(container)[0]!.classList.contains("tr-table--wide")).toBe(false);
		await unmount({ container, root });
	});
});

describe("table formats", () => {
	function stubClipboard(): { writes: string[]; restore(): void } {
		const original = navigator.clipboard;
		const writes: string[] = [];
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					writes.push(text);
				},
			},
		});
		return {
			writes,
			restore: () => Object.defineProperty(navigator, "clipboard", { configurable: true, value: original }),
		};
	}

	it("opens one format menu and closes it on a second press", async () => {
		const { container, root } = await mount(TABLE_A);
		const table = tables(container)[0]!;
		expect(caret(table).getAttribute("aria-expanded")).toBe("false");
		expect(menuItems(table)).toHaveLength(0);

		await act(async () => caret(table).click());
		expect(caret(tables(container)[0]!).getAttribute("aria-expanded")).toBe("true");
		expect(menuItems(tables(container)[0]!).map(item => item.textContent)).toEqual([
			"CSV",
			"TSV",
			"Markdown",
			"CSV",
			"Markdown",
		]);

		await act(async () => caret(tables(container)[0]!).click());
		expect(menuItems(tables(container)[0]!)).toHaveLength(0);
		await unmount({ container, root });
	});

	it("keeps only one table's menu open at a time", async () => {
		const { container, root } = await mount(`${TABLE_A}\n\n${TABLE_B}`);
		await act(async () => caret(tables(container)[0]!).click());
		expect(menuItems(tables(container)[0]!)).toHaveLength(5);

		await act(async () => caret(tables(container)[1]!).click());
		expect(menuItems(tables(container)[0]!)).toHaveLength(0);
		expect(menuItems(tables(container)[1]!)).toHaveLength(5);
		await unmount({ container, root });
	});

	it("closes the menu on an outside press and on Escape", async () => {
		const { container, root } = await mount(TABLE_A);
		await act(async () => caret(tables(container)[0]!).click());
		expect(menuItems(tables(container)[0]!)).toHaveLength(5);

		await act(async () => {
			document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		});
		expect(menuItems(tables(container)[0]!)).toHaveLength(0);

		await act(async () => caret(tables(container)[0]!).click());
		expect(menuItems(tables(container)[0]!)).toHaveLength(5);
		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(menuItems(tables(container)[0]!)).toHaveLength(0);
		await unmount({ container, root });
	});

	it("copies the default format in one press, then announces it", async () => {
		const clipboard = stubClipboard();
		try {
			const { container, root } = await mount(TABLE_A);
			const copy = tables(container)[0]!.querySelector<HTMLButtonElement>(
				".tr-table-bar button:not([aria-pressed]):not([aria-haspopup])",
			)!;
			expect(copy.getAttribute("aria-label")).toBe(t("settings.copy"));

			await act(async () => copy.click());
			await act(async () => {
				await Promise.resolve();
			});

			// One press copies Markdown — the default — not CSV.
			expect(clipboard.writes).toEqual(["| a | b |\n| --- | --- |\n| 1 | 2 |"]);
			// The button and the status region both report it.
			expect(tables(container)[0]!.querySelector(".tr-table-status")?.textContent).toBe(t("settings.copied"));
			await unmount({ container, root });
		} finally {
			clipboard.restore();
		}
	});

	it("copies the format chosen in the menu", async () => {
		const clipboard = stubClipboard();
		try {
			const { container, root } = await mount(TABLE_A);
			await act(async () => caret(tables(container)[0]!).click());
			const csv = menuItems(tables(container)[0]!).find(item => item.textContent === "CSV")!;
			await act(async () => csv.click());
			await act(async () => {
				await Promise.resolve();
			});
			expect(clipboard.writes).toEqual(["a,b\n1,2"]);
			expect(menuItems(tables(container)[0]!)).toHaveLength(0);
			await unmount({ container, root });
		} finally {
			clipboard.restore();
		}
	});
});

describe("table region selection", () => {
	function cellOf(table: HTMLElement, row: number, column: number): HTMLElement {
		return Array.from(table.querySelectorAll("tr"))[row]!.children[column] as HTMLElement;
	}

	/** Each step gets its own `act`: React batches state updates, and a drag
	 *  that is dispatched as one blob would leave the move unrendered. */
	async function drag(table: HTMLElement, from: [number, number], to: [number, number]): Promise<void> {
		const fire = async (type: string, target: HTMLElement, x: number, y: number): Promise<void> => {
			await act(async () => {
				const event = new Event(type, { bubbles: true });
				Object.assign(event, { button: 0, clientX: x, clientY: y, shiftKey: false });
				target.dispatchEvent(event);
			});
		};
		await fire("pointerdown", cellOf(table, ...from), 10, 10);
		await fire("pointermove", cellOf(table, ...to), 80, 60);
		await fire("pointerup", cellOf(table, ...to), 80, 60);
	}

	it("selects the dragged rectangle", async () => {
		const { container, root } = await mount(TABLE_A);
		const table = tables(container)[0]!;
		// A body cell starts a rectangle (a header cell takes its column).
		await drag(table, [1, 0], [1, 1]);
		expect(table.querySelectorAll(".tr-table-cell--selected")).toHaveLength(2);
		await unmount({ container, root });
	});

	it("offers to quote the selection and clears it on Escape", async () => {
		const { container, root } = await mount(TABLE_A);
		const table = tables(container)[0]!;
		await drag(table, [1, 0], [1, 1]);
		const plate = table.querySelector<HTMLElement>(".tr-table-quote");
		expect(plate).not.toBeNull();

		await act(async () => {
			table.querySelector("table")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(tables(container)[0]!.querySelectorAll(".tr-table-cell--selected")).toHaveLength(0);
		await unmount({ container, root });
	});

	it("quotes the region into the composer channel", async () => {
		const { container, root } = await mount(TABLE_A);
		const quoted: string[] = [];
		const listen = (event: Event): void => void quoted.push((event as CustomEvent<{ text: string }>).detail.text);
		window.addEventListener("musepi-gui-quote-append", listen);

		await drag(tables(container)[0]!, [1, 0], [1, 1]);
		await act(async () => tables(container)[0]!.querySelector<HTMLElement>(".tr-table-quote")!.click());

		expect(quoted).toHaveLength(1);
		// A selection below the header still comes back as a table.
		expect(quoted[0]).toContain("| a | b |");
		expect(quoted[0]).toContain("| 1 | 2 |");
		window.removeEventListener("musepi-gui-quote-append", listen);
		await unmount({ container, root });
	});
});
