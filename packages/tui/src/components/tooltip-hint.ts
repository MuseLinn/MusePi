/**
 * Hover hints for rows whose text does not fit.
 *
 * A fullscreen overlay truncates what it cannot fit, and a terminal has no
 * hover of its own: the reader loses the tail of a long quota name, account
 * address or reset time with no way to see it. Mouse tracking is already on
 * while such an overlay holds the alternate screen (`tui.ts` enables `1003h`
 * for any-motion tracking), so the pointer position is available — this maps a
 * screen cell to the full text that cell truncated away.
 *
 * A row can hold several independently truncated cells, so a record is a column
 * range rather than a single span. The state is deliberately free of
 * rendering: a caller records what it hid and asks what the cell under the
 * pointer would reveal, which keeps the policy of which cells are worth a hint
 * in the component and the bookkeeping here.
 */
export class TooltipHint {
	/** Screen row (0-based, as painted by the component) → its truncated cells. */
	readonly #rows = new Map<number, Array<{ from: number; to: number; text: string }>>();
	#activeRow: number | undefined;

	/**
	 * Record the text a cell truncated away. `text === ""` drops the cell: a
	 * cell that fits must not raise a hint, or every cell would nag. Columns
	 * outside `available` are ignored, as is a later record for a cell already
	 * held — the first truncation a painter reports wins.
	 */
	track(row: number, from: number, available: number, text: string): void {
		if (text === "" || available <= 0) return;
		const to = from + available;
		const cells = this.#rows.get(row);
		if (!cells) {
			this.#rows.set(row, [{ from, to, text }]);
			return;
		}
		if (cells.some(cell => cell.from === from)) return;
		cells.push({ from, to, text });
	}

	/** Drop every record, for a rebuild that repaints the frame. */
	clear(): void {
		this.#rows.clear();
		this.#activeRow = undefined;
	}

	/**
	 * Move the pointer to a screen cell and return the text to show, or
	 * `undefined` when the cell fits or the pointer left the hinted area.
	 * Columns are 0-based, matching {@link SgrMouseEvent}.
	 */
	hover(col: number, row: number | undefined): string | undefined {
		this.#activeRow = row;
		if (row === undefined) return undefined;
		const cell = this.#rows.get(row)?.find(candidate => col >= candidate.from && col < candidate.to);
		return cell?.text;
	}

	/** The row currently under the pointer, for callers that repaint on change. */
	get activeRow(): number | undefined {
		return this.#activeRow;
	}
}
