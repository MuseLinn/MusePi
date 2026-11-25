import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "../src/components/transcript/Markdown";
import { t } from "../src/i18n/index.js";

// Wide-table toggling is a DOM state transition (class + aria-pressed after a
// delegated click), which bun:test's default environment cannot exercise.
GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	// Wide-table state outlives the component by design; leaving a record (or a
	// deliberately corrupted one) behind would seed the next suite's mount.
	window.localStorage.clear();
	GlobalRegistrator.unregister();
});

beforeEach(() => {
	// Wide-table state now persists; a leaked record from a previous case would
	// arrive pre-widened and mask the default-layout assertions.
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

function tables(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>(".tr-table"));
}

function wideButton(table: HTMLElement): HTMLButtonElement {
	const button = table.querySelector<HTMLButtonElement>("[data-table-wide]");
	expect(button).not.toBeNull();
	return button!;
}

/** Hashes the component has written to storage (any array-valued record). */
function storedHashes(): string[] {
	const hashes: string[] = [];
	for (let i = 0; i < window.localStorage.length; i++) {
		const key = window.localStorage.key(i);
		const raw = key ? window.localStorage.getItem(key) : null;
		if (!raw) continue;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed))
				hashes.push(...parsed.filter((entry): entry is string => typeof entry === "string"));
		} catch {
			// not a record this component wrote
		}
	}
	return hashes;
}

/** The storage key holding the wide-table record, so a case can corrupt it. */
function storedKey(): string | null {
	for (let i = 0; i < window.localStorage.length; i++) {
		const key = window.localStorage.key(i);
		if (!key) continue;
		try {
			if (Array.isArray(JSON.parse(window.localStorage.getItem(key) ?? ""))) return key;
		} catch {
			// not ours
		}
	}
	return null;
}

async function unmount(mounted: Mounted): Promise<void> {
	await act(async () => mounted.root.unmount());
	mounted.container.remove();
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

	it("keeps a widened table wide after a remount (session switch)", async () => {
		// The transcript component is torn down and rebuilt when the session
		// switches; losing the width there would make the choice look like it
		// never stuck.
		const first = await mount(TABLE_A);
		const hash = tables(first.container)[0]!.dataset.tableHash;
		expect(hash).toBeTruthy();
		await act(async () => wideButton(tables(first.container)[0]!).click());
		expect(storedHashes()).toContain(hash!);
		await unmount(first);

		const second = await mount(TABLE_A);
		const restored = tables(second.container)[0]!;
		expect(restored.classList.contains("tr-table--wide")).toBe(true);
		expect(wideButton(restored).getAttribute("aria-pressed")).toBe("true");
		await unmount(second);
	});

	it("drops the record when the width is restored, so a remount starts default", async () => {
		const first = await mount(TABLE_A);
		const hash = tables(first.container)[0]!.dataset.tableHash!;
		await act(async () => wideButton(tables(first.container)[0]!).click());
		expect(storedHashes()).toContain(hash);

		await act(async () => wideButton(tables(first.container)[0]!).click());
		expect(storedHashes()).not.toContain(hash);
		await unmount(first);

		const second = await mount(TABLE_A);
		const table = tables(second.container)[0]!;
		expect(table.classList.contains("tr-table--wide")).toBe(false);
		expect(wideButton(table).getAttribute("aria-pressed")).toBe("false");
		await unmount(second);
	});

	it("falls back to the default layout when the stored record is unreadable", async () => {
		const seeded = await mount(TABLE_A);
		await act(async () => wideButton(tables(seeded.container)[0]!).click());
		const key = storedKey();
		expect(key).toBeTruthy();
		await unmount(seeded);

		// Private mode / a half-written value / an older shape must not take the
		// table down with it — it just renders at the default width.
		window.localStorage.setItem(key!, "{not json");
		const { container, root } = await mount(TABLE_A);
		expect(tables(container)[0]!.classList.contains("tr-table--wide")).toBe(false);
		await act(async () => root.unmount());
	});
});

describe("table toolbar interaction", () => {
	function caret(table: HTMLElement): HTMLButtonElement {
		const button = table.querySelector<HTMLButtonElement>("[data-table-menu]");
		expect(button).not.toBeNull();
		return button!;
	}

	function split(table: HTMLElement): HTMLElement {
		const wrap = table.querySelector<HTMLElement>(".tr-table-split");
		expect(wrap).not.toBeNull();
		return wrap!;
	}

	it("opens a format menu on the caret and closes it on a second press", async () => {
		const { container, root } = await mount(TABLE_A);
		const table = tables(container)[0]!;
		expect(split(table).hasAttribute("data-menu-open")).toBe(false);
		expect(caret(table).getAttribute("aria-expanded")).toBe("false");

		await act(async () => caret(table).click());
		expect(split(table).hasAttribute("data-menu-open")).toBe(true);
		expect(caret(table).getAttribute("aria-expanded")).toBe("true");

		await act(async () => caret(table).click());
		expect(split(table).hasAttribute("data-menu-open")).toBe(false);
		expect(caret(table).getAttribute("aria-expanded")).toBe("false");
		await unmount({ container, root });
	});

	it("keeps only one table's menu open at a time", async () => {
		const { container, root } = await mount(`${TABLE_A}\n\n${TABLE_B}`);
		const [first, second] = tables(container);
		await act(async () => caret(first!).click());
		await act(async () => caret(second!).click());
		expect(split(first!).hasAttribute("data-menu-open")).toBe(false);
		expect(split(second!).hasAttribute("data-menu-open")).toBe(true);
		await unmount({ container, root });
	});

	it("closes the open menu on an outside pointer press and on Escape", async () => {
		const { container, root } = await mount(TABLE_A);
		const table = tables(container)[0]!;

		await act(async () => caret(table).click());
		expect(split(table).hasAttribute("data-menu-open")).toBe(true);
		await act(async () => {
			document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		});
		expect(split(table).hasAttribute("data-menu-open")).toBe(false);

		await act(async () => caret(table).click());
		expect(split(table).hasAttribute("data-menu-open")).toBe(true);
		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(split(table).hasAttribute("data-menu-open")).toBe(false);
		await unmount({ container, root });
	});

	it("swaps the copy glyph for a check after a successful write", async () => {
		const writes: string[] = [];
		const original = navigator.clipboard;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: async (text: string) => void writes.push(text) },
		});
		try {
			const { container, root } = await mount(TABLE_A);
			const table = tables(container)[0]!;
			const copy = table.querySelector<HTMLElement>("[data-table-copy]")!;
			expect(copy.querySelector("svg")?.getAttribute("data-glyph")).toBe("copy");

			await act(async () => copy.click());
			await act(async () => {
				await Promise.resolve();
			});

			// One click copies the DEFAULT format: Markdown, not CSV.
			expect(writes).toHaveLength(1);
			expect(writes[0]).toContain("| a | b |");
			expect(writes[0]).toContain("| --- | --- |");
			// The copy state re-renders the message's innerHTML, so the feedback
			// lands on the nodes that are in the document now — re-query from the
			// mount root, never hold the pre-click reference.
			const fresh = container.querySelector<HTMLElement>(".tr-table [data-table-copy]")!;
			expect(fresh.querySelector("svg")?.getAttribute("data-glyph")).toBe("check");
			expect(fresh.hasAttribute("data-copied")).toBe(true);
			expect(fresh.getAttribute("aria-label")).toBe(t("settings.copied"));
			await unmount({ container, root });
		} finally {
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
		}
	});

	it("copies the chosen format from the menu", async () => {
		const writes: string[] = [];
		const original = navigator.clipboard;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: async (text: string) => void writes.push(text) },
		});
		try {
			const { container, root } = await mount(TABLE_A);
			const table = tables(container)[0]!;
			const csv = table.querySelector<HTMLElement>('[role="menuitem"][data-table-copy="csv"]')!;
			await act(async () => csv.click());
			await act(async () => {
				await Promise.resolve();
			});
			expect(writes).toEqual(["a,b\n1,2"]);
			// Choosing from the menu also dismisses it.
			expect(split(table).hasAttribute("data-menu-open")).toBe(false);
			await unmount({ container, root });
		} finally {
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
		}
	});
});
