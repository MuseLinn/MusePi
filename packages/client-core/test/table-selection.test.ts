import { describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	installTableSelection,
	serializeTableSelection,
	tableSelectionText,
} from "../src/components/transcript/table-selection";

GlobalRegistrator.register();

/** The rendered shape `decorateTables` produces: header row first. */
function table(rows: string[][]): HTMLTableElement {
	const el = document.createElement("table");
	const thead = document.createElement("thead");
	const tbody = document.createElement("tbody");
	rows.forEach((row, index) => {
		const tr = document.createElement("tr");
		for (const value of row) {
			const cell = document.createElement(index === 0 ? "th" : "td");
			cell.textContent = value;
			tr.appendChild(cell);
		}
		(index === 0 ? thead : tbody).appendChild(tr);
	});
	el.append(thead, tbody);
	return el;
}

function wrapper(el: HTMLTableElement): HTMLElement {
	const host = document.createElement("div");
	host.className = "tr-table";
	host.appendChild(el);
	document.body.appendChild(host);
	return host;
}

/** Drive the module's own selection state through a real drag. */
function drag(host: HTMLElement, from: [number, number], to: [number, number]): void {
	const cell = (row: number, column: number): HTMLElement => {
		const rows = Array.from(host.querySelectorAll("tr"));
		return rows[row]!.children[column] as HTMLElement;
	};
	const start = cell(...from);
	const end = cell(...to);
	const down = new Event("pointerdown", { bubbles: true }) as PointerEvent;
	Object.assign(down, { button: 0, clientX: 10, clientY: 10 });
	start.dispatchEvent(down);
	const move = new Event("pointermove", { bubbles: true }) as PointerEvent;
	Object.assign(move, { clientX: 60, clientY: 60 });
	end.dispatchEvent(move);
	host.dispatchEvent(new Event("pointerup", { bubbles: true }));
}

const ROWS = [
	["项", "结果", "说明"],
	["分支", "main", "已同步"],
	["规模", "6948", "+705428"],
];

describe("table region selection", () => {
	it("serializes a rectangle as markdown with the selected columns only", () => {
		const host = wrapper(table(ROWS));
		const el = host.querySelector("table")!;
		// A 2×2 rectangle from the header down, columns 0..1.
		const selection = {
			table: el,
			anchor: { row: 0, column: 0 },
			active: { row: 1, column: 1 },
			cells: new Map<string, HTMLTableCellElement>(),
		};
		for (const [row, column] of [
			[0, 0],
			[0, 1],
			[1, 0],
			[1, 1],
		] as const) {
			const rows = Array.from(el.querySelectorAll("tr"));
			selection.cells.set(`${row}:${column}`, rows[row]!.children[column] as HTMLTableCellElement);
		}
		expect(serializeTableSelection(selection, "markdown")).toBe("| 项 | 结果 |\n| --- | --- |\n| 分支 | main |");
		expect(serializeTableSelection(selection, "tsv")).toBe("项\t结果\n分支\tmain");
		expect(serializeTableSelection(selection, "csv")).toBe("项,结果\n分支,main");
	});

	it("gives a selection taken below the header the table's headers back", () => {
		const host = wrapper(table(ROWS));
		const el = host.querySelector("table")!;
		const rows = Array.from(el.querySelectorAll("tr"));
		const selection = {
			table: el,
			anchor: { row: 1, column: 1 },
			active: { row: 2, column: 1 },
			cells: new Map<string, HTMLTableCellElement>([
				["1:1", rows[1]!.children[1] as HTMLTableCellElement],
				["2:1", rows[2]!.children[1] as HTMLTableCellElement],
			]),
		};
		// Without a header row of its own the snippet would not be a table.
		expect(serializeTableSelection(selection, "markdown")).toBe("| 结果 |\n| --- |\n| main |\n| 6948 |");
	});

	it("escapes pipes and keeps line breaks inside a cell", () => {
		const host = wrapper(table([["h"], ["a | b"], ["line1\nline2"]]));
		const el = host.querySelector("table")!;
		const rows = Array.from(el.querySelectorAll("tr"));
		const selection = {
			table: el,
			anchor: { row: 0, column: 0 },
			active: { row: 1, column: 0 },
			cells: new Map<string, HTMLTableCellElement>([
				["0:0", rows[0]!.children[0] as HTMLTableCellElement],
				["1:0", rows[1]!.children[0] as HTMLTableCellElement],
			]),
		};
		const markdown = serializeTableSelection(selection, "markdown");
		// A pipe inside a cell would split it into two; a newline becomes `<br>`
		// so the row stays one row.
		expect(markdown).toContain("a \\| b");
		expect(markdown.split(String.fromCharCode(10))).toHaveLength(3);
	});

	it("reports no selection until one exists", () => {
		const host = wrapper(table(ROWS));
		expect(tableSelectionText(host)).toBeNull();
	});

	it("clears to nothing for an empty selection", () => {
		const host = wrapper(table(ROWS));
		const el = host.querySelector("table")!;
		const selection = { table: el, anchor: { row: 0, column: 0 }, active: { row: 0, column: 0 }, cells: new Map() };
		expect(serializeTableSelection(selection, "markdown")).toBe("");
	});
});

describe("table region selection interaction", () => {
	function setup(): { host: HTMLElement; teardown: () => void } {
		document.body.innerHTML = "";
		const host = document.createElement("div");
		host.innerHTML =
			'<div class="tr-table"><div class="tr-table-scroll"><table>' +
			"<thead><tr><th>项</th><th>结果</th></tr></thead>" +
			"<tbody><tr><td>分支</td><td>main</td></tr><tr><td>规模</td><td>6948</td></tr></tbody>" +
			"</table></div></div>";
		document.body.appendChild(host);
		return { host, teardown: installTableSelection(host, "Quote selection") };
	}

	function cellAt(host: HTMLElement, row: number, column: number): HTMLElement {
		return Array.from(host.querySelectorAll("tr"))[row]!.children[column] as HTMLElement;
	}

	function pointer(type: string, target: HTMLElement, x: number, y: number): void {
		const event = new Event(type, { bubbles: true });
		Object.assign(event, { button: 0, clientX: x, clientY: y, shiftKey: false });
		target.dispatchEvent(event);
	}

	it("selects the dragged rectangle and offers to quote it", () => {
		const { host, teardown } = setup();
		// A drag from a BODY cell selects a rectangle; one from a header cell
		// takes the whole column (covered below).
		pointer("pointerdown", cellAt(host, 1, 0), 10, 40);
		pointer("pointermove", cellAt(host, 1, 1), 80, 60);
		pointer("pointermove", cellAt(host, 2, 1), 90, 90);
		pointer("pointerup", cellAt(host, 2, 1), 90, 90);

		const wrapper = host.querySelector<HTMLElement>(".tr-table")!;
		expect(wrapper.querySelectorAll(".tr-table-cell--selected")).toHaveLength(4);
		expect(wrapper.classList.contains("tr-table--selecting")).toBe(true);
		const plate = wrapper.querySelector<HTMLElement>(".tr-table-quote");
		expect(plate?.getAttribute("aria-label")).toBe("Quote selection");
		expect(tableSelectionText(wrapper, "markdown")).toContain("| 项 | 结果 |");
		teardown();
	});

	it("quotes the selection through the shared channel and clears it", () => {
		const { host, teardown } = setup();
		const quoted: string[] = [];
		const listen = (event: Event): void => void quoted.push((event as CustomEvent<{ text: string }>).detail.text);
		window.addEventListener("musepi-gui-quote-append", listen);

		pointer("pointerdown", cellAt(host, 1, 0), 10, 10);
		pointer("pointermove", cellAt(host, 1, 1), 80, 60);
		pointer("pointerup", cellAt(host, 1, 1), 80, 60);
		host.querySelector<HTMLElement>("[data-table-quote]")!.click();

		expect(quoted).toHaveLength(1);
		// A selection below the header still produces a table.
		expect(quoted[0]).toContain("| 项 | 结果 |");
		expect(quoted[0]).toContain("| 分支 | main |");
		const wrapper = host.querySelector<HTMLElement>(".tr-table")!;
		expect(wrapper.querySelector(".tr-table-quote")).toBeNull();
		expect(wrapper.classList.contains("tr-table--selecting")).toBe(false);
		window.removeEventListener("musepi-gui-quote-append", listen);
		teardown();
	});

	it("takes the whole column when a header cell is clicked", () => {
		const { host, teardown } = setup();
		cellAt(host, 0, 1).dispatchEvent(new Event("click", { bubbles: true }));
		const wrapper = host.querySelector<HTMLElement>(".tr-table")!;
		expect(wrapper.querySelectorAll(".tr-table-cell--selected")).toHaveLength(3);
		expect(tableSelectionText(wrapper)).toBe("| 结果 |\n| --- |\n| main |\n| 6948 |");
		teardown();
	});

	it("leaves a drag inside one cell to text selection", () => {
		const { host, teardown } = setup();
		// A non-collapsed selection is a reading gesture, not a table rectangle.
		const range = document.createRange();
		range.selectNodeContents(cellAt(host, 1, 1));
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);

		pointer("pointerdown", cellAt(host, 1, 1), 10, 10);
		pointer("pointermove", cellAt(host, 1, 1), 30, 25);
		pointer("pointerup", cellAt(host, 1, 1), 30, 25);

		const wrapper = host.querySelector<HTMLElement>(".tr-table")!;
		expect(wrapper.querySelectorAll(".tr-table-cell--selected")).toHaveLength(0);
		window.getSelection()?.removeAllRanges();
		teardown();
	});

	it("clears the selection on Escape", () => {
		const { host, teardown } = setup();
		pointer("pointerdown", cellAt(host, 0, 0), 10, 10);
		pointer("pointermove", cellAt(host, 2, 1), 90, 90);
		pointer("pointerup", cellAt(host, 2, 1), 90, 90);
		const wrapper = host.querySelector<HTMLElement>(".tr-table")!;
		expect(wrapper.querySelectorAll(".tr-table-cell--selected").length).toBeGreaterThan(0);

		host.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(wrapper.querySelectorAll(".tr-table-cell--selected")).toHaveLength(0);
		expect(wrapper.querySelector(".tr-table-quote")).toBeNull();
		teardown();
	});
});
