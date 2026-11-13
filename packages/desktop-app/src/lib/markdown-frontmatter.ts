import { parseFrontmatter } from "@musepi/pi-utils";

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

export function parseMarkdownMetadata(raw: string): MetadataEntry[] {
	if (!raw) return [];
	try {
		const { frontmatter } = parseFrontmatter(raw, { rawKeys: true, level: "off" });
		return Object.entries(frontmatter).map(([key, value]) => ({ key, values: formatValue(value) }));
	} catch {
		return [];
	}
}

function formatValue(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(item => formatValue(item));
	if (value === null || value === undefined) return [""];
	if (typeof value === "object") {
		try {
			return [JSON.stringify(value)];
		} catch {
			return [String(value)];
		}
	}
	return [String(value)];
}
