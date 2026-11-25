/**
 * Table region selection — choosing a rectangle of cells and handing it back
 * as a quote (kimi-code parity).
 *
 * A markdown table is a block of prose, but it is also a grid: people point at
 * "the 变动规模 row" or "these three columns", and quoting the whole table
 * drops that intent. Drag across cells to select a rectangle, click a header
 * cell to take its column, Shift-click to extend from the anchor.
 *
 * Cell coordinates come from the DOM's own `cellIndex` / `rowIndex` rather than
 * attributes this module would have to stamp into regenerated markup: the
 * message's HTML is rebuilt on every stream tick, and anything added there is
 * lost (and any observer re-stamping it is a second source of truth).
 *
 * Dragging that turns out to be a text selection is left alone — selecting a
 * sentence inside a cell is a plain reading gesture, not a table rectangle.
 */

/** Cells carrying this class are part of the current selection. */
export const TABLE_CELL_SELECTED = "tr-table-cell--selected";
/** Set on `.tr-table` while a rectangle is selected. */
export const TABLE_HAS_SELECTION = "tr-table--selecting";

const DRAG_THRESHOLD_PX = 5;

interface Point {
	row: number;
	column: number;
}

interface Selection {
	table: HTMLTableElement;
	anchor: Point;
	active: Point;
	/** Cell → coordinate, resolved once per selection so serialization is
	 *  consistent even if the DOM is rebuilt under us. */
	cells: Map<string, HTMLTableCellElement>;
}

const selections = new WeakMap<HTMLElement, Selection>();

/** Rows in document order, header row included (row 0 is the header). */
function rowsOf(table: HTMLTableElement): HTMLTableRowElement[] {
	return Array.from(table.querySelectorAll<HTMLTableRowElement>("thead > tr, tbody > tr"));
}

function cellAt(table: HTMLTableElement, point: Point): HTMLTableCellElement | null {
	const row = rowsOf(table)[point.row];
	const cells = row ? Array.from(row.children) : [];
	const cell = cells[point.column];
	return cell instanceof HTMLTableCellElement ? cell : null;
}

function dimensions(table: HTMLTableElement): { rows: number; columns: number } {
	const rows = rowsOf(table);
	return {
		rows: rows.length,
		columns: Math.max(0, ...rows.map(row => Array.from(row.children).length)),
	};
}

function pointOf(cell: HTMLTableCellElement): Point | null {
	const row = cell.parentElement;
	if (!(row instanceof HTMLTableRowElement)) return null;
	const rowIndex = rowsOf(cell.closest("table") as HTMLTableElement).indexOf(row);
	if (rowIndex < 0) return null;
	return { row: rowIndex, column: cell.cellIndex };
}

/** Every cell in the rectangle spanned by two corners, interleaved with the
 *  coordinates that name them. */
function rectangle(table: HTMLTableElement, from: Point, to: Point): Map<string, HTMLTableCellElement> {
	const cells = new Map<string, HTMLTableCellElement>();
	const rowFrom = Math.min(from.row, to.row);
	const rowTo = Math.max(from.row, to.row);
	const columnFrom = Math.min(from.column, to.column);
	const columnTo = Math.max(from.column, to.column);
	for (let row = rowFrom; row <= rowTo; row++) {
		for (let column = columnFrom; column <= columnTo; column++) {
			const cell = cellAt(table, { row, column });
			if (cell) cells.set(`${row}:${column}`, cell);
		}
	}
	return cells;
}

/** The column a header cell belongs to, over every row. */
function column(table: HTMLTableElement, columnIndex: number): Map<string, HTMLTableCellElement> {
	const { rows } = dimensions(table);
	return rectangle(table, { row: 0, column: columnIndex }, { row: rows - 1, column: columnIndex });
}

function cellText(cell: HTMLTableCellElement): string {
	// `<br>` is a line break in source, not a space: a cell written as two lines
	// must come back as two lines (markdown re-encodes it as `<br>`).
	const clone = cell.cloneNode(true) as HTMLElement;
	for (const br of Array.from(clone.querySelectorAll("br"))) br.replaceWith("\n");
	return (clone.textContent ?? "")
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map(line => line.trim())
		.join("\n")
		.trim();
}

function markdownCell(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/\*/g, "\\*")
		.replace(/_/g, "\\_")
		.replace(/\r?\n/g, "<br>");
}

function csvCell(value: string): string {
	return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export type TableSelectionFormat = "markdown" | "tsv" | "csv";

/**
 * Serialize the selected rectangle. Rows and columns keep the table's order
 * even when the drag ran bottom-right to top-left, and columns the drag skipped
 * are omitted rather than emitted empty — a selection is a rectangle, so every
 * selected row contributes the same columns.
 */
export function serializeTableSelection(selection: Selection, format: TableSelectionFormat): string {
	const keys = [...selection.cells.keys()].map(key => key.split(":").map(Number) as [number, number]);
	if (keys.length === 0) return "";
	const rows = [...new Set(keys.map(([row]) => row))].sort((a, b) => a - b);
	const columns = [...new Set(keys.map(([, column]) => column))].sort((a, b) => a - b);
	const matrix = rows.map(row =>
		columns.map(column => {
			const cell = selection.cells.get(`${row}:${column}`);
			return cell ? cellText(cell) : "";
		}),
	);

	if (format === "tsv") return matrix.map(row => row.join("\t")).join("\n");
	if (format === "csv") return matrix.map(row => row.map(csvCell).join(",")).join("\n");

	// A selection that starts below the header has no header of its own; its
	// first row becomes one so the result is still a valid markdown table.
	const includesHeader = rows[0] === 0;
	const header = includesHeader
		? (matrix[0] ?? [])
		: columns.map(column => {
				const cell = cellAt(selection.table, { row: 0, column });
				return cell ? cellText(cell) : "";
			});
	const body = includesHeader ? matrix.slice(1) : matrix;
	return [
		`| ${header.map(markdownCell).join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...body.map(row => `| ${row.map(markdownCell).join(" | ")} |`),
	].join("\n");
}

function clearSelection(wrapper: HTMLElement): void {
	const selection = selections.get(wrapper);
	if (selection) {
		for (const cell of selection.cells.values()) {
			cell.classList.remove(TABLE_CELL_SELECTED);
			cell.setAttribute("aria-selected", "false");
		}
		selections.delete(wrapper);
	}
	wrapper.classList.remove(TABLE_HAS_SELECTION);
	wrapper.querySelector<HTMLElement>(".tr-table-quote")?.remove();
}

function paint(wrapper: HTMLElement, selection: Selection): void {
	const previous = selections.get(wrapper);
	if (previous && previous !== selection) {
		for (const cell of previous.cells.values()) cell.classList.remove(TABLE_CELL_SELECTED);
	}
	for (const cell of selection.cells.values()) {
		cell.classList.add(TABLE_CELL_SELECTED);
		cell.setAttribute("aria-selected", "true");
	}
	selections.set(wrapper, selection);
	wrapper.classList.add(TABLE_HAS_SELECTION);
}

/** The selected rectangle as source text, or null when nothing is selected. */
export function tableSelectionText(wrapper: HTMLElement, format: TableSelectionFormat = "markdown"): string | null {
	const selection = selections.get(wrapper);
	if (!selection || selection.cells.size === 0) return null;
	return serializeTableSelection(selection, format);
}

function selectTable(table: HTMLTableElement, next: Selection, quoteLabel: string): void {
	const wrapper = table.closest<HTMLElement>(".tr-table");
	if (!wrapper) return;
	paint(wrapper, next);
	showQuoteAction(wrapper, next, quoteLabel);
}

/** Floating "quote" affordance, anchored over the selection. It is a sibling of
 *  the scroll container (not a child) so a wide table scrolls under it. */
function showQuoteAction(wrapper: HTMLElement, selection: Selection, label: string): void {
	wrapper.querySelector<HTMLElement>(".tr-table-quote")?.remove();
	const button = document.createElement("button");
	button.type = "button";
	button.className = "tr-table-quote";
	button.dataset.tableQuote = "";
	button.setAttribute("aria-label", label);
	button.title = label;
	button.textContent = label;
	wrapper.appendChild(button);
	// Position over the selection's top-right corner, clamped into the wrapper.
	const wrapperRect = wrapper.getBoundingClientRect();
	const cells = [...selection.cells.values()];
	const rects = cells.map(cell => cell.getBoundingClientRect()).filter(rect => rect.width > 0);
	if (rects.length === 0 || wrapperRect.width === 0) return;
	const top = Math.min(...rects.map(rect => rect.top)) - wrapperRect.top;
	const right = Math.max(...rects.map(rect => rect.right)) - wrapperRect.left;
	button.style.top = `${Math.max(0, top - 30)}px`;
	button.style.left = `${Math.max(0, Math.min(right - 96, wrapperRect.width - 100))}px`;
}

/** Resolve the coordinate a pointer landed on, falling back to hit-testing so
 *  a fast drag that leaves the table still tracks the nearest cell. */
function pointFromEvent(wrapper: HTMLElement, table: HTMLTableElement, event: PointerEvent): Point | null {
	const direct = event.target instanceof Element ? event.target.closest<HTMLTableCellElement>("th, td") : null;
	if (direct && wrapper.contains(direct)) return pointOf(direct);
	const element = document.elementFromPoint?.(event.clientX, event.clientY);
	const cell = element instanceof Element ? element.closest<HTMLTableCellElement>("th, td") : null;
	return cell && wrapper.contains(cell) ? pointOf(cell) : null;
}

/**
 * Bind region selection to every table under `root`, and re-bind when the
 * message's HTML is rebuilt. Returns a teardown for the component effect.
 */
export function installTableSelection(root: HTMLElement, quoteLabel: string): () => void {
	let drag: {
		wrapper: HTMLElement;
		table: HTMLTableElement;
		anchor: Point;
		startX: number;
		startY: number;
		kind: "column" | "cell";
		moved: boolean;
		textSelection: boolean;
	} | null = null;

	const onPointerDown = (event: PointerEvent): void => {
		if (event.button !== 0) return;
		const target = event.target instanceof Element ? event.target : null;
		// The toolbar, a link, a menu: not a cell gesture.
		if (target?.closest("button, a, input, select, textarea, .tr-table-bar")) return;
		const cell = target?.closest<HTMLTableCellElement>("th, td");
		const table = cell?.closest("table");
		const wrapper = table?.closest<HTMLElement>(".tr-table");
		if (!cell || !table || !wrapper) return;
		const point = pointOf(cell);
		if (!point) return;
		const existing = selections.get(wrapper);
		// A drag that starts inside an existing selection with Shift extends it;
		// a plain press starts over.
		if (!event.shiftKey && existing) clearSelection(wrapper);
		drag = {
			wrapper,
			table,
			anchor: event.shiftKey && existing ? existing.anchor : point,
			startX: event.clientX,
			startY: event.clientY,
			kind: point.row === 0 && !event.shiftKey ? "column" : "cell",
			moved: false,
			textSelection: false,
		};
		if (event.shiftKey) event.preventDefault();
	};

	const onPointerMove = (event: PointerEvent): void => {
		if (!drag) return;
		const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
		if (!drag.moved && distance < DRAG_THRESHOLD_PX) return;
		const point = pointFromEvent(drag.wrapper, drag.table, event);
		if (!point) return;
		// A drag that the browser has turned into a text selection is a reading
		// gesture inside one cell, not a table rectangle. The test is the
		// selection itself, not the pointer's cell: the first few pixels of a
		// real drag never leave the anchor cell, so keying the bail-out on
		// "still in the anchor cell" swallowed the gesture entirely.
		if (!drag.moved && !(window.getSelection?.()?.isCollapsed ?? true)) {
			drag.textSelection = true;
			return;
		}
		if (drag.textSelection) return;
		drag.moved = true;
		event.preventDefault();
		const cells =
			drag.kind === "column" ? column(drag.table, point.column) : rectangle(drag.table, drag.anchor, point);
		selectTable(drag.table, { table: drag.table, anchor: drag.anchor, active: point, cells }, quoteLabel);
	};

	const onPointerUp = (): void => {
		drag = null;
	};

	const onQuote = (event: MouseEvent): void => {
		const target = event.target instanceof Element ? event.target : null;
		const plate = target?.closest<HTMLElement>("[data-table-quote]");
		if (!plate) return;
		const wrapper = plate.closest<HTMLElement>(".tr-table");
		const text = wrapper ? tableSelectionText(wrapper, "markdown") : null;
		if (text) {
			// The channel the generative-UI faces already use for a quoted
			// selection, so a quoted table lands in the composer like any other
			// quoted passage rather than through a bespoke path.
			window.dispatchEvent(new CustomEvent("musepi-gui-quote-append", { detail: { text } }));
		}
		if (wrapper) clearSelection(wrapper);
	};

	const onClick = (event: MouseEvent): void => {
		if (event.target instanceof Element && event.target.closest("[data-table-quote]")) return;
		const target = event.target instanceof Element ? event.target : null;
		// A click on the header cell (no drag) takes the whole column.
		const cell = target?.closest<HTMLTableCellElement>("th");
		const table = cell?.closest("table");
		const wrapper = table?.closest<HTMLElement>(".tr-table");
		if (!cell || !table || !wrapper || drag) return;
		const point = pointOf(cell);
		if (!point) return;
		selectTable(table, { table, anchor: point, active: point, cells: column(table, point.column) }, quoteLabel);
	};

	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") return;
		for (const wrapper of Array.from(root.querySelectorAll<HTMLElement>(".tr-table--selecting"))) {
			clearSelection(wrapper);
		}
	};

	root.addEventListener("pointerdown", onPointerDown);
	root.addEventListener("pointermove", onPointerMove);
	root.addEventListener("pointerup", onPointerUp);
	root.addEventListener("pointercancel", onPointerUp);
	root.addEventListener("click", onQuote);
	root.addEventListener("click", onClick);
	root.addEventListener("keydown", onKeyDown);
	return () => {
		root.removeEventListener("pointerdown", onPointerDown);
		root.removeEventListener("pointermove", onPointerMove);
		root.removeEventListener("pointerup", onPointerUp);
		root.removeEventListener("pointercancel", onPointerUp);
		root.removeEventListener("click", onQuote);
		root.removeEventListener("click", onClick);
		root.removeEventListener("keydown", onKeyDown);
	};
}
