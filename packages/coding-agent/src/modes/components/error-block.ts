import { t } from "../../i18n/index.js";

/**
 * Shared layout for the two places a failed turn is printed in the terminal: the
 * pinned banner above the editor and the transcript's own error block.
 *
 * Both used to take the message, drop blank lines and truncate every line at a
 * fixed column. That is wrong for provider errors specifically: a 400 or 429 body
 * arrives as one long line of JSON or prose whose *tail* carries the provider's
 * own explanation, so a fixed-column cut removes precisely the part a user needs.
 * The lines were also clamped before wrapping, so on a narrow terminal the text
 * was cut twice — once at the column limit, then again by the renderer's wrap.
 *
 * So the clamp happens after wrapping, against the width the renderer actually
 * has. Callers pass that width in through a format callback rather than reading
 * it here, because it is only known at render time.
 */

/** Indent for the wrapped tail of a line, matching the block's left padding. */
const CONTINUATION_INDENT = "  ";

const ESC = "";

/** Break one styled line into rows no wider than `wrapWidth`. */
function wrapStyledLine(styled: string, wrapWidth: number): string[] {
	const rows: string[] = [];
	for (const row of Bun.wrapAnsi(styled, wrapWidth).split("\n")) {
		if (Bun.stringWidth(row) <= wrapWidth) {
			rows.push(row);
			continue;
		}

		// `Bun.wrapAnsi` breaks at whitespace only, so a token with none in it — a
		// JSON envelope, a base64 blob, a long URL, which is most of what a
		// provider error body turns out to be — comes back as one over-wide row.
		// The old fixed-column truncation produced the same row with the tail
		// discarded instead of moved down, so slice it here instead.
		//
		// Styling is carried across each slice rather than dropped: the escape
		// sequences present in the row are re-emitted around every piece, so a
		// colour neither bleeds past the fold nor stops mid-row.
		const codes = row.match(new RegExp(`${ESC}\\[[0-9;]*m`, "g")) ?? [];
		const prefix = codes.join("");
		const suffix = codes.length > 0 ? `${ESC}[0m` : "";

		let rest = row;
		while (Bun.stringWidth(rest) > wrapWidth) {
			let cut = 0;
			let width = 0;
			while (cut < rest.length && width < wrapWidth) {
				if (rest[cut] === ESC) {
					const end = rest.indexOf("m", cut);
					if (end !== -1) {
						cut = end + 1;
						continue;
					}
				}
				// Width is measured on the single character rather than trusted as 1:
				// a CJK glyph or an emoji occupies two terminal cells, and stepping
				// one code unit at a time would overshoot the budget.
				const step = Math.max(1, Bun.stringWidth(rest.slice(cut, cut + 2)));
				cut += 1;
				width += step;
			}
			if (cut === 0) break;
			rows.push(`${prefix}${rest.slice(0, cut)}${suffix}`);
			rest = `${prefix}${rest.slice(cut)}`;
		}
		if (rest.length > 0) rows.push(rest);
	}
	return rows;
}

/**
 * Wrap `message` to `contentWidth` and clamp the result to `maxRows`.
 *
 * `maxRows` counts *wrapped* rows, not source lines, which is what makes the
 * clamp predictable at any terminal width. Pass `Infinity` to render the whole
 * message. Styling is applied per source line before wrapping, and `styleLine`
 * receives the 0-based source index so a caller can mark the first line
 * differently from the rest.
 */
export function formatErrorBlock(
	message: string,
	contentWidth: number,
	maxRows: number,
	styleLine: (line: string, index: number) => string,
	moreRowsHint: (hidden: number) => string,
): string {
	const lines = message
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
	if (lines.length === 0) lines.push(t("Unknown error"));

	// A wrapped row carries the indent, so the text has to fit in what is left.
	const wrapWidth = Math.max(1, contentWidth - CONTINUATION_INDENT.length);
	const rows: string[] = [];
	lines.forEach((line, index) => {
		const wrapped = wrapStyledLine(styleLine(line, index), wrapWidth);
		for (const [offset, row] of wrapped.entries()) {
			rows.push(rows.length === 0 || offset === 0 ? row : `${CONTINUATION_INDENT}${row}`);
		}
	});

	if (rows.length > maxRows) {
		const hidden = rows.length - maxRows;
		rows.length = Math.max(0, maxRows);
		rows.push(`${CONTINUATION_INDENT}${moreRowsHint(hidden)}`);
	}
	return rows.join("\n");
}
