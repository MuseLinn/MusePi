/**
 * Readable TUI rendering for a `ui` block (OpenUI Lang).
 *
 * The GUI draws blocks as components; a terminal cannot. Showing the raw
 * program is the one thing a terminal must not do — the reader asked for an
 * answer, not for source. So the block is reduced to what it says: titles,
 * text, rows, steps and numbers, laid out as plain lines.
 *
 * This is a READING of the program, not a parser: it walks `Name(args)` calls
 * and picks up the string and number literals in the order the catalog puts
 * them. That is enough to show content, and it degrades to a plain listing
 * rather than to an error. The GUI remains the authority on what a block looks
 * like; a terminal just needs to be told the same thing in words.
 */

interface Call {
	name: string;
	args: string;
}

const LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(-?\d+(?:\.\d+)?)/g;

/** Literals in source order: `"text"`, `'text'`, numbers. Objects and arrays
 *  are skipped, because a component's own fields are what matter. */
function literals(args: string): string[] {
	const out: string[] = [];
	LITERAL.lastIndex = 0;
	for (let match = LITERAL.exec(args); match !== null; match = LITERAL.exec(args)) {
		const raw = match[1] ?? match[2];
		out.push(raw !== undefined ? raw.replace(/\\(["'\\])/g, "$1") : (match[3] as string));
	}
	return out;
}

/** Every `Name(...)` call in source order, with its balanced argument text. */
function calls(source: string): Call[] {
	const out: Call[] = [];
	const head = /([A-Z][A-Za-z]*)\s*\(/g;
	for (let match = head.exec(source); match !== null; match = head.exec(source)) {
		const name = match[1] as string;
		const open = head.lastIndex - 1;
		let depth = 0;
		let index = open;
		let quote: string | null = null;
		for (; index < source.length; index += 1) {
			const ch = source[index] as string;
			if (quote) {
				if (ch === "\\") index += 1;
				else if (ch === quote) quote = null;
				continue;
			}
			if (ch === '"' || ch === "'") quote = ch;
			else if (ch === "(") depth += 1;
			else if (ch === ")") {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		if (depth !== 0) break;
		out.push({ name, args: source.slice(open + 1, index) });
		// Continue INSIDE the call: a block's content lives in nested calls, and
		// skipping to its closing paren would leave nothing to show.
		head.lastIndex = open + 1;
	}
	return out;
}

/** Objects like `{title: "x", status: "done"}` are the only place structured
 *  fields appear; read the values by key instead of by position. */
function objectFields(args: string, key: string): string[] {
	const out: string[] = [];
	const pattern = new RegExp(`\\b${key}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "g");
	for (let match = pattern.exec(args); match !== null; match = pattern.exec(args)) {
		out.push((match[1] as string).replace(/\\(["'\\])/g, "$1"));
	}
	return out;
}

/** The bracketed groups of a call's arguments, innermost pairs included. */
function groups(args: string): string[][] {
	const out: string[][] = [];
	for (const match of args.matchAll(/\[([^[\]]*)\]/g)) out.push(literals(match[1] as string));
	return out;
}

function bar(value: number, max: number, cells: number): string {
	const filled = max > 0 ? Math.max(0, Math.min(cells, Math.round((value / max) * cells))) : 0;
	return "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled));
}

function clip(text: string, width: number): string {
	return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

/**
 * Render one block as lines. Returns null when the source is not a block at all,
 * so the caller falls back to a code fence.
 */
export function renderUiBlockAscii(source: string, maxWidth = 80): string | null {
	if (!/\bStack\s*\(/.test(source)) return null;
	const width = Math.max(24, maxWidth);
	const lines: string[] = [];

	for (const call of calls(source)) {
		switch (call.name) {
			case "Card": {
				const title = literals(call.args)[0];
				if (title) {
					if (lines.length > 0) lines.push("");
					lines.push(`▸ ${title}`);
				}
				break;
			}
			case "Text":
			case "Callout": {
				const text = literals(call.args)[0];
				if (!text) break;
				for (const row of text.split("\n")) lines.push(`  ${clip(row, width - 2)}`);
				break;
			}
			case "KeyValue": {
				const labels = objectFields(call.args, "label");
				const values = objectFields(call.args, "value");
				labels.forEach((label, index) => {
					lines.push(`  ${clip(label, Math.floor(width / 3))}: ${clip(values[index] ?? "", width)}`);
				});
				break;
			}
			case "Table": {
				// Table(columns[], rows[][]) — the first array is the header.
				const cells = groups(call.args);
				const header = cells[0] ?? [];
				if (header.length === 0) break;
				lines.push(`  ${header.join(" | ")}`);
				for (const row of cells.slice(1)) lines.push(`  ${row.join(" | ")}`);
				break;
			}
			case "Steps": {
				const titles = objectFields(call.args, "title");
				const statuses = objectFields(call.args, "status");
				titles.forEach((title, index) => {
					const status = statuses[index];
					const mark = status === "done" ? "✓" : status === "current" ? "▸" : status === "blocked" ? "✕" : "·";
					lines.push(`  ${mark} ${title}`);
				});
				break;
			}
			case "Stat": {
				const [label, value, delta] = literals(call.args);
				lines.push(`  ${label ?? ""}: ${value ?? ""}${delta ? ` (${delta})` : ""}`);
				break;
			}
			case "Progress": {
				const [label, value, max] = literals(call.args);
				const current = Number(value ?? 0);
				const total = Number(max ?? 100) || 100;
				lines.push(`  ${label ?? ""} ${bar(current, total, 16)} ${current}/${total}`);
				break;
			}
			case "Badge": {
				const [label] = literals(call.args);
				if (label) lines.push(`  [${label}]`);
				break;
			}
			case "BarChart": {
				// BarChart(labels[], [Series("name", [values])], unit?, whole?)
				const cells = groups(call.args);
				const labels = cells[0] ?? [];
				const values = (cells[1] ?? []).map(Number).filter(Number.isFinite);
				const max = Math.max(1, ...values);
				labels.forEach((label, index) => {
					const value = values[index];
					if (value === undefined) return;
					lines.push(`  ${clip(label, 12).padEnd(12)} ${bar(value, max, 20)} ${value}`);
				});
				break;
			}
			case "LineChart": {
				const cells = groups(call.args);
				const labels = cells[0] ?? [];
				const values = (cells[1] ?? []).map(Number).filter(Number.isFinite);
				if (values.length > 0) {
					const first = values[0] as number;
					const last = values[values.length - 1] as number;
					const trend = last > first ? "↗" : last < first ? "↘" : "→";
					lines.push(`  ${labels[0] ?? ""} ${trend} ${labels[labels.length - 1] ?? ""}  (${values.join(", ")})`);
				}
				break;
			}
			case "Details": {
				const title = literals(call.args)[0];
				if (title) lines.push(`  ▸ ${title} …`);
				break;
			}
			default:
				// Stack/Row/Series and anything else: structure, not content.
				break;
		}
	}

	return lines.length > 0 ? lines.join("\n") : null;
}
