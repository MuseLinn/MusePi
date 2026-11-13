/**
 * Front matter reading for the file preview and the WYSIWYG editor.
 *
 * This module is imported by a plugin component that bundles for the browser,
 * so it cannot use `@musepi/pi-utils`' `parseFrontmatter` (it reads `Bun.YAML`).
 * The blocks the app writes here are flat `key: value` maps with optional list
 * values, so a small reader covers them; nested maps render as one JSON row.
 */

export interface MetadataEntry {
	key: string;
	/** One row per value: YAML lists (e.g. `scope`) stack, scalars are one row. */
	values: string[];
}

export interface MarkdownFrontMatter {
	/** The exact source block, delimiters and trailing newline included. */
	raw: string;
	/** Everything after the block, untouched — this is what the editor edits. */
	body: string;
}

/** Leading `---` … `---` (or `...`) block. The closing delimiter must start a
 *  line, so a document that merely opens with a horizontal rule is left alone. */
const FRONT_MATTER_BLOCK = /^\uFEFF?---[\t ]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/;

/** Split without parsing: the raw block is what the WYSIWYG editor keeps
 *  verbatim and re-prepends on save, so it must never be re-serialized. */
export function readMarkdownFrontMatter(text: string): MarkdownFrontMatter {
	const match = FRONT_MATTER_BLOCK.exec(text);
	if (!match) return { raw: "", body: text };
	return { raw: match[0], body: text.slice(match[0].length) };
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' || first === "'") && last === first) return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** `a`, `a, b`, `[a, b]` → the values the card should list. */
function scalarValues(rest: string): string[] {
	const value = rest.trim();
	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		return inner ? inner.split(",").map(unquote) : [];
	}
	return [unquote(value)];
}

interface PendingEntry {
	key: string;
	values: string[];
	nested: string[];
}

function flush(entries: MetadataEntry[], pending: PendingEntry | null): void {
	if (!pending) return;
	if (pending.nested.length > 0) {
		const map: Record<string, string> = {};
		for (const line of pending.nested) {
			const split = line.indexOf(":");
			if (split <= 0) continue;
			map[line.slice(0, split).trim()] = unquote(line.slice(split + 1));
		}
		pending.values.push(JSON.stringify(map));
	}
	entries.push({ key: pending.key, values: pending.values.length > 0 ? pending.values : [""] });
}

/** Parse the block into display rows. Unknown YAML shapes degrade to their
 *  raw line instead of hiding the whole block. */
export function parseMarkdownMetadata(raw: string): MetadataEntry[] {
	if (!raw) return [];
	const lines = raw.split(/\r?\n/);
	const inner = lines.slice(/^\uFEFF?---/.test(lines[0] ?? "") ? 1 : 0);
	const entries: MetadataEntry[] = [];
	let pending: PendingEntry | null = null;
	for (const line of inner) {
		if (!line.trim() || /^\s*#/.test(line)) continue;
		if (/^(?:---|\.\.\.)\s*$/.test(line)) break;
		const item = /^(\s*)-\s+(.*)$/.exec(line);
		if (item) {
			if (pending) pending.values.push(unquote(item[2]));
			continue;
		}
		const pair = /^([^:\s][^:]*):(.*)$/.exec(line);
		if (pair && !/^\s/.test(line)) {
			flush(entries, pending);
			pending = { key: pair[1].trim(), values: [], nested: [] };
			const rest = pair[2].trim();
			if (rest) {
				pending.values.push(...scalarValues(rest));
				pending = { ...pending, nested: [] };
			}
			continue;
		}
		// Indented continuation: a nested map line, or YAML we do not model.
		if (pending) pending.nested.push(line.trim());
	}
	flush(entries, pending);
	return entries;
}
