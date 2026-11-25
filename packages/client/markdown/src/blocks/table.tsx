/**
 * A markdown table as React nodes.
 *
 * Why a component and not rendered HTML: a message's HTML arrives as one
 * string, and React re-applies `dangerouslySetInnerHTML` on every update —
 * measured in Chromium, appending a paragraph reset a finished table's
 * horizontal scroll from 40 to 0. Owning `<table>/<thead>/<tr>/<th>/<td>` puts
 * those nodes under React's reconciler, so a stable `hash` keeps them across a
 * stream tick; only the per-cell inline markup goes through `innerHTML`, which
 * changes nothing about the box around it.
 *
 * Everything the toolbar does lives here too, as state instead of the DOM
 * attributes and `WeakMap`s the string version needed: widen, one format menu,
 * copy feedback, region selection and the expanded view.
 */

import { Check, Copy, Download, Ellipsis, FoldHorizontal, Maximize2, UnfoldHorizontal, X } from "lucide";
import { MorphIcon } from "morphicons/react";
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MarkdownBlockProps, MarkdownTableCellPayload, MarkdownTablePayload } from "../registry";

/** Closes whichever format menu is open. A menu belongs to one table block,
 *  so a second block cannot see it; a document-level hook is the only way the
 *  page keeps to one open menu (two open menus read as one menu with doubled
 *  entries, and leaving one open behind a click elsewhere is worse). */
const openMenus = new Set<() => void>();

function closeOtherMenus(keep: () => void): void {
	for (const close of openMenus) {
		if (close !== keep) close();
	}
}

/** Widened-table hashes, persisted so a remount renders at the stored width. */
const WIDE_TABLES_KEY = "musepi-gui-wide-tables";
const WIDE_TABLES_LIMIT = 200;

function loadWideTables(): Set<string> {
	if (typeof window === "undefined") return new Set();
	try {
		const parsed: unknown = JSON.parse(window.localStorage.getItem(WIDE_TABLES_KEY) ?? "[]");
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((entry): entry is string => typeof entry === "string").slice(-WIDE_TABLES_LIMIT));
	} catch {
		return new Set();
	}
}

function saveWideTables(hashes: Set<string>): void {
	if (typeof window === "undefined") return;
	const overflow = hashes.size - WIDE_TABLES_LIMIT;
	if (overflow > 0) {
		const iterator = hashes.values();
		for (let i = 0; i < overflow; i++) hashes.delete(iterator.next().value as string);
	}
	try {
		if (hashes.size === 0) window.localStorage.removeItem(WIDE_TABLES_KEY);
		else window.localStorage.setItem(WIDE_TABLES_KEY, JSON.stringify(Array.from(hashes)));
	} catch {
		// storage quota / private mode — best effort
	}
}

const escapeCsv = (value: string): string => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

function toCsv(payload: MarkdownTablePayload): string {
	const rows = [payload.header, ...payload.rows];
	return rows.map(row => row.map(cell => escapeCsv(cell.text)).join(",")).join("\n");
}

function toTsv(payload: MarkdownTablePayload): string {
	const rows = [payload.header, ...payload.rows];
	return rows.map(row => row.map(cell => cell.text).join("\t")).join("\n");
}

function toMarkdown(payload: MarkdownTablePayload): string {
	const line = (row: readonly MarkdownTableCellPayload[]): string =>
		`| ${row.map(cell => cell.text.replace(/\|/g, "\\|")).join(" | ")} |`;
	const separator = `| ${payload.header.map(() => "---").join(" | ")} |`;
	return [line(payload.header), separator, ...payload.rows.map(line)].join("\n");
}

function serialize(payload: MarkdownTablePayload, format: "csv" | "tsv" | "markdown"): string {
	if (format === "tsv") return toTsv(payload);
	if (format === "markdown") return toMarkdown(payload);
	return toCsv(payload);
}

function downloadBlob(name: string, content: string | Blob, mime?: string): void {
	const blob =
		typeof content === "string" ? new Blob([content], { type: mime ?? "application/octet-stream" }) : content;
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

type Format = "csv" | "tsv" | "markdown";
type Point = { row: number; column: number };

const pointKey = (point: Point): string => `${point.row}:${point.column}`;

/** Every cell in the rectangle spanned by two corners, plus the column above a
 *  header cell. Rows and columns are clamped to the table's own extent, so a
 *  drag that leaves the table still ends somewhere sensible. */
function selectRange(from: Point, to: Point, rows: number, columns: number): Set<string> {
	const selected = new Set<string>();
	const rowFrom = Math.min(from.row, to.row);
	const rowTo = Math.max(from.row, to.row);
	const columnFrom = Math.min(from.column, to.column);
	const columnTo = Math.max(from.column, to.column);
	for (let row = rowFrom; row <= rowTo; row++) {
		for (let column = columnFrom; column <= columnTo; column++) {
			if (row >= 0 && row < rows && column >= 0 && column < columns) selected.add(pointKey({ row, column }));
		}
	}
	return selected;
}

/** The selected rectangle as Markdown, header supplied when the selection
 *  starts below it — a body-only selection would otherwise not be a table. */
function selectionMarkdown(payload: MarkdownTablePayload, selected: ReadonlySet<string>): string | null {
	if (selected.size === 0) return null;
	const rows: number[] = [];
	const columns: number[] = [];
	for (const key of selected) {
		const [row, column] = key.split(":").map(Number) as [number, number];
		if (!rows.includes(row)) rows.push(row);
		if (!columns.includes(column)) columns.push(column);
	}
	rows.sort((a, b) => a - b);
	columns.sort((a, b) => a - b);
	const cellAt = (row: number, column: number): MarkdownTableCellPayload | undefined =>
		row === 0 ? payload.header[column] : payload.rows[row - 1]?.[column];
	const body = rows.map(row => columns.map(column => cellAt(row, column)?.text ?? ""));
	const hasHeader = rows[0] === 0;
	const header = hasHeader ? (body.shift() ?? []) : columns.map(column => payload.header[column]?.text ?? "");
	return [
		`| ${header.map(value => value.replace(/\|/g, "\\|")).join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...body.map(row => `| ${row.map(value => value.replace(/\|/g, "\\|")).join(" | ")} |`),
	].join("\n");
}

/** A block without a payload has nothing to draw (a stale session's table).
 *  React requires the same hooks on every render, so the guard lives outside
 *  the component that owns them. */
export function MarkdownTableBlock(props: MarkdownBlockProps): ReactNode {
	if (!props.table) return null;
	return <TableBlock {...props} table={props.table} />;
}

function TableBlock({
	table,
	hash,
	labels,
	quoteText,
	fly,
	motionDisabled,
}: MarkdownBlockProps & { table: MarkdownTablePayload }): ReactNode {
	const [wide, setWide] = useState(() => loadWideTables().has(hash));
	const [menu, setMenu] = useState<null | "formats">(null);
	const [copied, setCopied] = useState(false);
	const [selection, setSelection] = useState<{ anchor: Point; active: Point } | null>(null);
	const [dialog, setDialog] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const tableRef = useRef<HTMLTableElement | null>(null);
	const menuButtonRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const copyTimer = useRef<number | null>(null);
	const drag = useRef<null | {
		anchor: Point;
		startX: number;
		startY: number;
		column: boolean;
		moved: boolean;
		text: boolean;
	}>(null);
	const menuId = useId();

	const rowCount = table.rows.length + 1;
	const columnCount = table.header.length;

	const selected = useMemo(
		() => (selection ? selectRange(selection.anchor, selection.active, rowCount, columnCount) : null),
		[selection, rowCount, columnCount],
	);

	// Toggling width is a state change on a component React already owns, so the
	// class is applied directly — no observer re-applying it after a rebuild,
	// which is what the string version needed.
	useLayoutEffect(() => {
		const widened = loadWideTables();
		if (wide) widened.add(hash);
		else widened.delete(hash);
		saveWideTables(widened);
	}, [wide, hash]);

	useEffect(
		() => () => {
			if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
		},
		[],
	);

	const announce = useCallback((now: boolean) => {
		setCopied(now);
		if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
		if (now) copyTimer.current = window.setTimeout(() => setCopied(false), 1400);
	}, []);

	const copy = useCallback(
		(format: Format) => {
			const text = serialize(table, format);
			void navigator.clipboard.writeText(text).then(() => announce(true));
			setMenu(null);
		},
		[table, announce],
	);

	const download = useCallback(
		(format: "csv" | "markdown") => {
			// CSV opens in Excel, which reads a UTF-8 file as the local codepage
			// without a BOM — every CJK cell then arrives as mojibake.
			const markdown = format === "markdown";
			downloadBlob(
				markdown ? "table.md" : "table.csv",
				markdown ? toMarkdown(table) : `\uFEFF${toCsv(table)}`,
				markdown ? "text/markdown" : "text/csv",
			);
			setMenu(null);
		},
		[table],
	);

	// One dismisser for the menu: a click anywhere else, a scroll, or Escape.
	useEffect(() => {
		if (menu === null) return;
		const self = (): void => setMenu(null);
		closeOtherMenus(self);
		openMenus.add(self);
		const close = (event?: Event): void => {
			if (event?.type === "pointerdown") {
				const target = event.target as Node | null;
				if (target && (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target))) return;
			}
			setMenu(null);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setMenu(null);
		};
		document.addEventListener("pointerdown", close, true);
		document.addEventListener("keydown", onKey);
		document.addEventListener("scroll", close, true);
		return () => {
			openMenus.delete(self);
			document.removeEventListener("pointerdown", close, true);
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("scroll", close, true);
		};
	}, [menu]);

	const pointOf = (cell: Element | null): Point | null => {
		if (!(cell instanceof HTMLTableCellElement)) return null;
		const row = Number(cell.dataset.row);
		const column = Number(cell.dataset.column);
		return Number.isInteger(row) && Number.isInteger(column) ? { row, column } : null;
	};

	const onPointerDown = (event: React.PointerEvent<HTMLTableElement>): void => {
		if (event.button !== 0) return;
		const target = event.target as Element | null;
		if (target?.closest("button, a, input, select, textarea")) return;
		const point = pointOf(target?.closest("th, td") ?? null);
		if (!point) return;
		if (!event.shiftKey && selected) setSelection(null);
		drag.current = {
			anchor: event.shiftKey && selection ? selection.anchor : point,
			startX: event.clientX,
			startY: event.clientY,
			// A header cell takes its whole column; a body cell starts a rectangle.
			column: point.row === 0 && !event.shiftKey,
			moved: false,
			text: false,
		};
		if (event.shiftKey) event.preventDefault();
	};

	const onPointerMove = (event: React.PointerEvent<HTMLTableElement>): void => {
		const current = drag.current;
		if (!current) return;
		if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
		const element = document.elementFromPoint?.(event.clientX, event.clientY);
		const point = pointOf(element?.closest("th, td") ?? (event.target as Element)?.closest("th, td") ?? null);
		if (!point) return;
		// A drag the browser has turned into a text selection is a reading
		// gesture inside a cell, not a table rectangle. The first few pixels of a
		// real drag never leave the anchor cell, so the test is the selection,
		// not the pointer's cell.
		if (!current.moved && !(window.getSelection?.()?.isCollapsed ?? true)) {
			current.text = true;
			return;
		}
		if (current.text) return;
		current.moved = true;
		event.preventDefault();
		const target = current.column ? { row: rowCount - 1, column: point.column } : point;
		setSelection({ anchor: current.anchor, active: target });
	};

	const onPointerUp = (): void => {
		drag.current = null;
	};

	const quote = (): void => {
		if (!selected || !quoteText) return;
		const text = selectionMarkdown(table, selected);
		if (text) quoteText(text);
		setSelection(null);
	};

	const onQuotePlateKey = (event: React.KeyboardEvent): void => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			quote();
		}
	};

	const onTableKeyDown = (event: React.KeyboardEvent): void => {
		if (event.key === "Escape" && selected) setSelection(null);
	};
	// The floating quote plate sits over the selection's top-right corner. Its
	// position is read after layout (a rect during render would be a stale box),
	// and clamped into the card so it never hangs off a wide table.
	const [plate, setPlate] = useState<{ top: number; left: number } | null>(null);
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!selected || selected.size === 0 || !root || !tableRef.current) {
			setPlate(null);
			return;
		}
		const cells = tableRef.current.querySelectorAll<HTMLElement>('[data-selected="true"]');
		if (cells.length === 0) {
			setPlate(null);
			return;
		}
		const rootRect = root.getBoundingClientRect();
		let top = Number.POSITIVE_INFINITY;
		let right = Number.NEGATIVE_INFINITY;
		for (const cell of cells) {
			const rect = cell.getBoundingClientRect();
			top = Math.min(top, rect.top);
			right = Math.max(right, rect.right);
		}
		if (!Number.isFinite(top) || !Number.isFinite(right)) {
			setPlate(null);
			return;
		}
		setPlate({
			top: Math.max(0, top - rootRect.top - 30),
			left: Math.max(0, Math.min(right - rootRect.left - 100, Math.max(0, rootRect.width - 104))),
		});
	}, [selected]);

	const cell = (payload: MarkdownTableCellPayload, row: number, column: number, header: boolean): ReactNode => {
		const isSelected = selected?.has(pointKey({ row, column })) === true;
		const Tag = header ? "th" : "td";
		return (
			<Tag
				key={`${row}:${column}`}
				data-row={row}
				data-column={column}
				data-selected={isSelected ? "true" : undefined}
				aria-selected={isSelected ? "true" : undefined}
				className={isSelected ? "tr-table-cell--selected" : undefined}
				align={table.align[column] ?? undefined}
			>
				{/* Only the cell's inline markup goes through innerHTML; the cell
				 * itself is a React node, so selection classes and the scroll box
				 * around it survive a stream tick. The markup goes on the cell
				 * directly — an extra wrapper turns into its own layout box, which
				 * collapses the column to the wrapper's width. */}
				<span style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: payload.html }} />
			</Tag>
		);
	};

	const expand = (): void => {
		setDialog(true);
	};

	return (
		<div ref={rootRef} className={`tr-table${wide ? " tr-table--wide" : ""}`} data-table-hash={hash}>
			<div className="tr-table-bar">
				<button
					type="button"
					className="tr-code-btn tr-table-btn"
					aria-pressed={wide}
					aria-label={wide ? labels.resetWidth : labels.widen}
					title={wide ? labels.resetWidth : labels.widen}
					onClick={() => setWide(value => !value)}
				>
					<MorphIcon icon={wide ? FoldHorizontal : UnfoldHorizontal} size={14} spring="snappy" />
				</button>
				<button
					type="button"
					className="tr-code-btn tr-table-btn"
					aria-label={labels.copy}
					title={copied ? labels.copied : labels.copy}
					onClick={() => copy("markdown")}
				>
					<MorphIcon icon={copied ? Check : Copy} size={14} spring="snappy" />
				</button>
				<button
					type="button"
					className="tr-code-btn tr-table-btn"
					aria-label={labels.download}
					title={labels.download}
					onClick={() => download("csv")}
				>
					<MorphIcon icon={Download} size={14} strokeWidth={1.8} spring="snappy" />
				</button>
				<span className="tr-table-split">
					<button
						ref={menuButtonRef}
						type="button"
						className="tr-code-btn tr-table-btn tr-table-caret"
						aria-haspopup="menu"
						aria-expanded={menu !== null}
						aria-controls={menu !== null ? menuId : undefined}
						aria-label={labels.moreFormats}
						title={labels.moreFormats}
						onClick={() => setMenu(value => (value === null ? "formats" : null))}
					>
						<MorphIcon icon={Ellipsis} size={14} strokeWidth={1.8} spring="snappy" />
					</button>
					{menu !== null && (
						<span ref={menuRef} id={menuId} className="tr-table-menu" role="menu">
							<span className="tr-table-menu-label" role="presentation">
								{labels.copy}
							</span>
							<MenuItem onSelect={() => copy("csv")}>CSV</MenuItem>
							<MenuItem onSelect={() => copy("tsv")}>TSV</MenuItem>
							<MenuItem onSelect={() => copy("markdown")}>Markdown</MenuItem>
							<span className="tr-table-menu-sep" role="separator" />
							<span className="tr-table-menu-label" role="presentation">
								{labels.download}
							</span>
							<MenuItem onSelect={() => download("csv")}>CSV</MenuItem>
							<MenuItem onSelect={() => download("markdown")}>Markdown</MenuItem>
						</span>
					)}
				</span>
				<button
					type="button"
					className="tr-code-btn tr-table-btn"
					aria-label={labels.expand}
					title={labels.expand}
					onClick={expand}
				>
					<MorphIcon icon={Maximize2} size={14} strokeWidth={1.8} spring="snappy" />
				</button>
			</div>
			<div className="tr-table-scroll">
				<table
					ref={tableRef}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
					onKeyDown={onTableKeyDown}
				>
					<thead>
						<tr>{table.header.map((payload, column) => cell(payload, 0, column, true))}</tr>
					</thead>
					<tbody>
						{table.rows.map((row, index) => (
							<tr key={index}>{row.map((payload, column) => cell(payload, index + 1, column, false))}</tr>
						))}
					</tbody>
				</table>
			</div>
			{/* Announced on copy: a renamed focused button is announced unevenly
			 *  across screen readers, a status region is the reliable channel. */}
			<span className="tr-table-status" role="status" aria-live="polite">
				{copied ? labels.copied : ""}
			</span>
			{plate && quoteText && (
				<button
					type="button"
					className="tr-table-quote"
					style={{ top: plate.top, left: plate.left }}
					aria-label={labels.quoteRegion}
					title={labels.quoteRegion}
					onClick={quote}
					onKeyDown={onQuotePlateKey}
				>
					{labels.quoteRegion}
				</button>
			)}
			{dialog &&
				createPortal(
					<ExpandDialog
						payload={table}
						labels={labels}
						hash={hash}
						origin={() => tableRef.current?.getBoundingClientRect() ?? null}
						fly={fly}
						motionDisabled={motionDisabled}
						onClose={() => setDialog(false)}
					/>,
					document.body,
				)}
		</div>
	);
}

function MenuItem({ children, onSelect }: { children: ReactNode; onSelect(): void }): ReactNode {
	return (
		<button type="button" role="menuitem" onClick={onSelect}>
			{children}
		</button>
	);
}

/**
 * Expanded view: a native `<dialog>` with `showModal()`, which supplies the
 * focus trap, Escape, the inert background and focus restoration. The table is
 * rendered again from the same payload, so the wide view needs no clone of the
 * live DOM, and it flies out of the source table and back.
 */
function ExpandDialog({
	payload,
	labels,
	hash,
	origin,
	fly,
	motionDisabled,
	onClose,
}: {
	payload: MarkdownTablePayload;
	labels: MarkdownBlockProps["labels"];
	hash: string;
	origin(): DOMRect | null;
	fly?: MarkdownBlockProps["fly"];
	motionDisabled?(): boolean;
	onClose(): void;
}): ReactNode {
	const dialogRef = useRef<HTMLDialogElement | null>(null);
	const [closing, setClosing] = useState(false);
	const titleId = useId();

	useLayoutEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		const from = origin();
		dialog.showModal();
		if (from && fly && !(motionDisabled?.() ?? false)) {
			fly(dialog, from, dialog.getBoundingClientRect());
		}
	}, [fly, motionDisabled, origin]);

	const requestClose = useCallback(() => {
		if (closing) return;
		const dialog = dialogRef.current;
		const from = origin();
		const flight =
			dialog && from && fly && !(motionDisabled?.() ?? false)
				? fly(dialog, from, dialog.getBoundingClientRect(), { reverse: true, fill: "forwards" })
				: null;
		if (!flight) {
			onClose();
			return;
		}
		setClosing(true);
		flight.onfinish = onClose;
	}, [closing, fly, motionDisabled, onClose, origin]);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		const onCancel = (event: Event): void => {
			event.preventDefault();
			requestClose();
		};
		dialog.addEventListener("cancel", onCancel);
		return () => dialog.removeEventListener("cancel", onCancel);
	}, [requestClose]);

	return (
		<dialog
			ref={dialogRef}
			className="tr-table-expand"
			aria-labelledby={titleId}
			onClick={event => {
				if (event.target === event.currentTarget) requestClose();
			}}
		>
			<div className="tr-table-expand-head">
				<span id={titleId}>{labels.expand}</span>
				<button
					type="button"
					className="tr-code-btn"
					aria-label={labels.close}
					title={labels.close}
					onClick={requestClose}
				>
					<MorphIcon icon={X} size={14} strokeWidth={1.8} spring="snappy" />
				</button>
			</div>
			{/* `.tr-md` is the scope the table's frame, dividers and header fill
			 *  hang off; without it the table renders as an unstyled browser table. */}
			<div className="tr-md tr-table-expand-body" data-table-hash={hash}>
				<table>
					<thead>
						<tr>
							{payload.header.map((cell, column) => (
								<th
									key={column}
									align={payload.align[column] ?? undefined}
									dangerouslySetInnerHTML={{ __html: cell.html }}
								/>
							))}
						</tr>
					</thead>
					<tbody>
						{payload.rows.map((row, index) => (
							<tr key={index}>
								{row.map((cell, column) => (
									<td
										key={column}
										align={payload.align[column] ?? undefined}
										dangerouslySetInnerHTML={{ __html: cell.html }}
									/>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</dialog>
	);
}
