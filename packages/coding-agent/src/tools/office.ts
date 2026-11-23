import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import { strFromU8, unzipSync } from "fflate";
import type { ToolSession } from "./contract";

export const officeRenderSchema = type({
	input: type("string").describe("Path to a .docx, .xlsx or .pptx file, relative to the session working directory."),
	pages: type("number")
		.array()
		.describe("pptx only: one-based slide numbers to render instead of every slide.")
		.optional(),
	sheet: type("string").describe("xlsx only: worksheet name to render instead of every sheet.").optional(),
	range: type("string").describe("xlsx only: A1 range such as A1:H40.").optional(),
	maxChars: type("number").describe("Character ceiling for the extracted text (1000-500000).").optional(),
});

export const officeConvertSchema = type({
	input: type("string").describe("Path to a .docx, .xlsx or .pptx file."),
	format: type("'txt' | 'md' | 'csv'").describe(
		"Target text format. docx/pptx: txt or md. xlsx: csv (a sheet name is required for a multi-sheet workbook), txt or md.",
	),
	sheet: type("string").describe("xlsx only: worksheet to convert.").optional(),
	output: type("string").describe("Write the converted text to this path instead of returning it.").optional(),
	maxChars: type("number").describe("Character ceiling for the returned text (1000-500000).").optional(),
});

export interface OfficeSection {
	title: string;
	text: string;
}

export interface OfficeRenderDetails {
	format: "docx" | "xlsx" | "pptx";
	sections: OfficeSection[];
	truncated: boolean;
}

export interface OfficeConvertDetails {
	format: "docx" | "xlsx" | "pptx";
	target: "txt" | "md" | "csv";
	output?: string;
	truncated: boolean;
}

function decodeXml(text: string): string {
	return text.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/gi, (_, entity: string) => {
		const lower = entity.toLowerCase();
		if (lower === "amp") return "&";
		if (lower === "lt") return "<";
		if (lower === "gt") return ">";
		if (lower === "quot") return '"';
		if (lower === "apos") return "'";
		if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
		return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
	});
}

function textRuns(xml: string): string {
	return [...xml.matchAll(/<(?:[\w.-]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g)]
		.map(match => decodeXml(match[1]!))
		.join("");
}

function attribute(tag: string, name: string): string | undefined {
	const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
	return match?.[1];
}

function docxSections(files: Record<string, Uint8Array>): OfficeSection[] {
	const xml = files["word/document.xml"];
	if (!xml) throw new Error("not a Word document: word/document.xml is missing");
	const source = strFromU8(xml);
	const paragraphs = [...source.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
		.map(match => textRuns(match[0]))
		.map(text => text.trim())
		.filter(text => text !== "");
	return paragraphs.length > 0 ? [{ title: "Paragraphs", text: paragraphs.join("\n") }] : [];
}

function pptxSections(files: Record<string, Uint8Array>, pages?: readonly number[]): OfficeSection[] {
	const wanted = pages && pages.length > 0 ? new Set(pages) : null;
	const keys = Object.keys(files)
		.filter(key => /^ppt\/slides\/slide\d+\.xml$/.test(key))
		.sort((left, right) => Number(left.match(/(\d+)/)?.[1]) - Number(right.match(/(\d+)/)?.[1]));
	const sections: OfficeSection[] = [];
	for (const key of keys) {
		const number = Number(key.match(/(\d+)/)?.[1]);
		if (wanted && !wanted.has(number)) continue;
		const text = textRuns(strFromU8(files[key]!)).trim();
		if (text !== "") sections.push({ title: `Slide ${number}`, text });
	}
	if (wanted && sections.length === 0) throw new Error("none of the requested slides exist or have text");
	return sections;
}

interface SheetRows {
	name: string;
	rows: string[][];
}

interface CellRange {
	minCol: number;
	maxCol: number;
	minRow: number;
	maxRow: number;
}

function columnIndex(ref: string): number {
	const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
	let out = 0;
	for (const letter of letters) out = out * 26 + (letter.charCodeAt(0) - 64);
	return out;
}

function cellPosition(ref: string): { col: number; row: number } | null {
	const match = /^([A-Z]+)(\d+)$/.exec(ref);
	if (!match) return null;
	return { col: columnIndex(match[1]!), row: Number(match[2]) };
}

function parseRange(range: string | undefined): CellRange | null {
	if (!range) return null;
	const match = /^([A-Z]+\d+):([A-Z]+\d+)$/i.exec(range.trim());
	if (!match) throw new Error(`invalid range "${range}"; expected A1:H40`);
	const start = cellPosition(match[1]!.toUpperCase());
	const end = cellPosition(match[2]!.toUpperCase());
	if (!start || !end) throw new Error(`invalid range "${range}"; expected A1:H40`);
	return {
		minCol: Math.min(start.col, end.col),
		maxCol: Math.max(start.col, end.col),
		minRow: Math.min(start.row, end.row),
		maxRow: Math.max(start.row, end.row),
	};
}

function workbookSheets(files: Record<string, Uint8Array>): Array<{ name: string; key: string }> {
	const sharedXml = files["xl/sharedStrings.xml"];
	void sharedXml;
	const workbookXml = files["xl/workbook.xml"];
	const relsXml = files["xl/_rels/workbook.xml.rels"];
	const targets = new Map<string, string>();
	if (relsXml) {
		for (const match of strFromU8(relsXml).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
			const id = attribute(match[1]!, "Id");
			const target = attribute(match[1]!, "Target");
			if (id && target) targets.set(id, target);
		}
	}
	const sheets: Array<{ name: string; key: string }> = [];
	if (workbookXml) {
		for (const match of strFromU8(workbookXml).matchAll(/<sheet\b([^>]*)\/?>/g)) {
			const name = attribute(match[1]!, "name");
			const id = attribute(match[1]!, "r:id");
			const target = id ? targets.get(id) : undefined;
			if (name && target) sheets.push({ name, key: `xl/${target.replace(/^\/+/, "")}` });
		}
	}
	if (sheets.length === 0) {
		for (const key of Object.keys(files).filter(key => /^xl\/worksheets\/sheet\d+\.xml$/.test(key))) {
			sheets.push({ name: key.match(/(\d+)\.xml$/)?.[1] ?? key, key });
		}
	}
	return sheets;
}

function xlsxRows(files: Record<string, Uint8Array>, sheet?: string, range?: string): SheetRows[] {
	const sharedXml = files["xl/sharedStrings.xml"];
	const shared = sharedXml
		? [...strFromU8(sharedXml).matchAll(/<si\b[\s\S]*?<\/si>/g)].map(match => textRuns(match[0]))
		: [];
	const sheets = workbookSheets(files);
	const wanted = sheet?.toLowerCase();
	const selected = wanted ? sheets.filter(entry => entry.name.toLowerCase() === wanted) : sheets;
	if (wanted && selected.length === 0) {
		throw new Error(`worksheet "${sheet}" not found; available: ${sheets.map(entry => entry.name).join(", ")}`);
	}
	const bounds = parseRange(range);
	const out: SheetRows[] = [];
	for (const entry of selected) {
		const xml = files[entry.key];
		if (!xml) continue;
		const rows: string[][] = [];
		for (const row of strFromU8(xml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
			const cells: string[] = [];
			for (const cell of row[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
				const attrs = cell[1]!;
				const body = cell[2]!;
				const reference = attribute(attrs, "r");
				const position = reference ? cellPosition(reference) : null;
				if (bounds && position) {
					if (position.row < bounds.minRow || position.row > bounds.maxRow) continue;
					if (position.col < bounds.minCol || position.col > bounds.maxCol) continue;
				}
				const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
				const inline = /<is>([\s\S]*?)<\/is>/.exec(body)?.[1];
				const kind = attribute(attrs, "t");
				if (kind === "s" && value !== undefined) cells.push(shared[Number(value)] ?? "");
				else if (inline !== undefined) cells.push(textRuns(inline));
				else if (value !== undefined) cells.push(decodeXml(value).trim());
			}
			if (cells.some(cell => cell !== "")) rows.push(cells);
		}
		if (rows.length > 0) out.push({ name: entry.name, rows });
	}
	return out;
}

function xlsxSections(files: Record<string, Uint8Array>, sheet?: string, range?: string): OfficeSection[] {
	return xlsxRows(files, sheet, range)
		.map(entry => ({ title: `Sheet: ${entry.name}`, text: entry.rows.map(row => row.join("\t")).join("\n") }))
		.filter(section => section.text !== "");
}

function truncateSections(
	sections: OfficeSection[],
	maxChars: number,
): { sections: OfficeSection[]; truncated: boolean } {
	let budget = maxChars;
	let truncated = false;
	const out: OfficeSection[] = [];
	for (const section of sections) {
		if (budget <= 0) {
			truncated = true;
			break;
		}
		if (section.text.length <= budget) {
			out.push(section);
			budget -= section.text.length;
			continue;
		}
		out.push({ title: section.title, text: `${section.text.slice(0, budget)}\n… (truncated)` });
		truncated = true;
		budget = 0;
	}
	return { sections: out, truncated };
}

function csvCell(value: string): string {
	return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function formatSections(sections: OfficeSection[], target: "txt" | "md"): string {
	return sections
		.map(section => (target === "md" ? `## ${section.title}\n${section.text}` : section.text))
		.join("\n\n");
}

interface OfficePackage {
	format: "docx" | "xlsx" | "pptx";
	files: Record<string, Uint8Array>;
}

async function readPackage(resolved: string, raw: string): Promise<OfficePackage> {
	const stat = await fs.stat(resolved).catch(() => null);
	if (stat === null) throw new Error(`file not found: ${raw}`);
	if (!stat.isFile()) throw new Error(`not a regular file: ${raw}`);
	const extension = path.extname(resolved).toLowerCase();
	if (extension !== ".docx" && extension !== ".xlsx" && extension !== ".pptx") {
		throw new Error(`unsupported format ${extension || "(none)"}; expected .docx, .xlsx or .pptx`);
	}
	const bytes = new Uint8Array(await Bun.file(resolved).arrayBuffer());
	try {
		return {
			format: extension === ".docx" ? "docx" : extension === ".xlsx" ? "xlsx" : "pptx",
			files: unzipSync(bytes),
		};
	} catch (error) {
		throw new Error(`cannot read the Office package: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Render the text structure of an Office Open XML file (dsh's `office_render`,
 * text side). Page/slide images need an Office converter service; this tool
 * reads the package XML and returns paragraphs, slide text or worksheet rows.
 */
export class OfficeRenderTool implements AgentTool<typeof officeRenderSchema, OfficeRenderDetails> {
	readonly name = "office_render";
	readonly approval = "read" as const;
	readonly label = "Office";
	readonly summary = "Render text and structure from docx, xlsx and pptx files";
	readonly description =
		"Render the text structure of an Office Open XML file: Word paragraphs, PowerPoint slide text, or Excel worksheet rows (and an A1 range). It reads the file's XML directly; page images, format conversion and formula recalculation are not part of this tool.";
	readonly parameters = officeRenderSchema;
	readonly loadMode = "discoverable";

	constructor(
		private readonly session: ToolSession,
		private readonly defaultMaxChars = 120_000,
	) {}

	async execute(
		_toolCallId: string,
		params: typeof officeRenderSchema.infer,
	): Promise<AgentToolResult<OfficeRenderDetails>> {
		const raw = typeof params.input === "string" ? params.input.trim() : "";
		if (raw === "") throw new Error("office_render: input must not be empty");
		const resolved = path.resolve(this.session.cwd, raw);
		const pkg = await readPackage(resolved, raw);
		if (pkg.format === "docx" && params.pages && params.pages.length > 0) {
			throw new Error("office_render: page selection needs the Office converter; omit pages for docx");
		}
		const sections =
			pkg.format === "docx"
				? docxSections(pkg.files)
				: pkg.format === "pptx"
					? pptxSections(pkg.files, params.pages)
					: xlsxSections(pkg.files, params.sheet, params.range);
		const maxChars =
			typeof params.maxChars === "number" && params.maxChars >= 1000
				? Math.min(500_000, Math.floor(params.maxChars))
				: this.defaultMaxChars;
		const limited = truncateSections(sections, maxChars);
		const text =
			limited.sections.length === 0
				? `(${pkg.format}: no text found)`
				: limited.sections.map(section => `## ${section.title}\n${section.text}`).join("\n\n");
		return {
			content: [{ type: "text", text }],
			details: { format: pkg.format, sections: limited.sections, truncated: limited.truncated },
		};
	}
}

/**
 * Convert an Office Open XML file to a text format (dsh's `office_convert`,
 * text-target subset). PDF/Office-format conversion needs an Office converter
 * service; this tool supports txt/md for docx/pptx/xlsx and csv for xlsx.
 */
export class OfficeConvertTool implements AgentTool<typeof officeConvertSchema, OfficeConvertDetails> {
	readonly name = "office_convert";
	readonly approval = "write" as const;
	readonly label = "Office";
	readonly summary = "Convert docx, xlsx and pptx to text or CSV";
	readonly description =
		"Convert an Office Open XML file to a text format: docx/pptx to txt or md, xlsx to csv (a sheet name is required for a multi-sheet workbook), txt or md. Writes the result when `output` is given, otherwise returns it. PDF and Office-format conversion need an Office converter service.";
	readonly parameters = officeConvertSchema;
	readonly loadMode = "discoverable";

	constructor(
		private readonly session: ToolSession,
		private readonly defaultMaxChars = 120_000,
	) {}

	async execute(
		_toolCallId: string,
		params: typeof officeConvertSchema.infer,
	): Promise<AgentToolResult<OfficeConvertDetails>> {
		const raw = typeof params.input === "string" ? params.input.trim() : "";
		if (raw === "") throw new Error("office_convert: input must not be empty");
		const resolved = path.resolve(this.session.cwd, raw);
		const pkg = await readPackage(resolved, raw);
		const target = params.format;
		if (target === "csv" && pkg.format !== "xlsx") {
			throw new Error("office_convert: csv is only supported for .xlsx");
		}
		let text: string;
		if (target === "csv") {
			const rows = xlsxRows(pkg.files, params.sheet);
			if (rows.length > 1 && !params.sheet) {
				throw new Error(
					`office_convert: this workbook has ${rows.length} sheets; pass sheet to choose one for CSV`,
				);
			}
			text = rows.map(entry => entry.rows.map(row => row.map(csvCell).join(",")).join("\n")).join("\n\n");
		} else {
			const sections =
				pkg.format === "docx"
					? docxSections(pkg.files)
					: pkg.format === "pptx"
						? pptxSections(pkg.files)
						: xlsxSections(pkg.files, params.sheet);
			const maxChars =
				typeof params.maxChars === "number" && params.maxChars >= 1000
					? Math.min(500_000, Math.floor(params.maxChars))
					: this.defaultMaxChars;
			const limited = truncateSections(sections, maxChars);
			text = formatSections(limited.sections, target);
		}
		if (typeof params.output === "string" && params.output.trim() !== "") {
			const output = path.resolve(this.session.cwd, params.output);
			await fs.mkdir(path.dirname(output), { recursive: true });
			await Bun.write(output, text);
			return {
				content: [{ type: "text", text: `Converted ${resolved} -> ${output}` }],
				details: { format: pkg.format, target, output, truncated: false },
			};
		}
		return {
			content: [{ type: "text", text: text === "" ? `(${pkg.format}: no text found)` : text }],
			details: { format: pkg.format, target, truncated: false },
		};
	}
}
