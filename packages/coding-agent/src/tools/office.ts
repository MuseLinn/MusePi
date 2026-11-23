import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import { strFromU8, unzipSync } from "fflate";
import {
	getOfficeKit,
	isOfficeKitError,
	isSpreadsheet,
	type OfficeExtension,
	type OfficeFileResult,
	type OfficeImagesResult,
	officeExtensionOf,
} from "../office/office-kit";
import officeConvertDescription from "../prompts/tools/office_convert.md" with { type: "text" };
import officeRecalculateDescription from "../prompts/tools/office_recalculate.md" with { type: "text" };
import officeRenderDescription from "../prompts/tools/office_render.md" with { type: "text" };
import type { ToolSession } from "./contract";

export const officeRenderSchema = type({
	input: type("string").describe(
		"Path to a doc, docx, odt, xls, xlsx, ods, ppt, pptx, odp, or pdf file, relative to the session working directory.",
	),
	pages: type("number")
		.array()
		.describe(
			"Distinct one-based pages or slides to render; omit for every page. Spreadsheets use sheet and range instead.",
		)
		.optional(),
	sheet: type("string").describe("Spreadsheet only: exact worksheet name to render; omit for every sheet.").optional(),
	range: type("string").describe("Spreadsheet only: A1 range such as A1:H40; requires sheet.").optional(),
	dpi: type("number").describe("Rendering resolution from 24 to 600; default 144.").optional(),
});

export const officeConvertSchema = type({
	input: type("string").describe("Path to a doc, docx, odt, xls, xlsx, ods, ppt, pptx, odp, or pdf file."),
	format: type("'pdf' | 'docx' | 'odt' | 'txt' | 'md' | 'xlsx' | 'ods' | 'csv' | 'pptx' | 'odp'").describe(
		"Target format. Word: pdf, docx, odt, txt, md. Excel: pdf, xlsx, ods, csv, txt, md. PowerPoint: pdf, pptx, odp, txt, md.",
	),
	sheet: type("string").describe("Spreadsheet only: worksheet to convert to csv or text.").optional(),
	output: type("string")
		.describe("Copy the result to this path instead of leaving it in the conversion store.")
		.optional(),
	maxChars: type("number")
		.describe("Text targets only: character ceiling for the converted text (1000-500000).")
		.optional(),
});

export const officeRecalculateSchema = type({
	input: type("string").describe("Path to an xls, xlsx, or ods workbook."),
	format: type("'xlsx' | 'ods'").describe("Output workbook format."),
	output: type("string")
		.describe("Copy the result to this path instead of leaving it in the conversion store.")
		.optional(),
});

export interface OfficeSection {
	title: string;
	text: string;
}

export interface OfficeRenderImageDetails {
	page?: number;
	sheet?: string;
	range?: string;
	bytes: number;
	width: number;
	height: number;
}

export interface OfficeRenderDetails {
	format: OfficeExtension;
	pageCount: number;
	dpi: number;
	images: OfficeRenderImageDetails[];
}

export interface OfficeConvertDetails {
	format: OfficeExtension;
	target: string;
	output?: string;
	bytes?: number;
}

export interface OfficeRecalculateDetails {
	format: "xlsx" | "ods";
	output?: string;
	bytes?: number;
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

function pptxSections(files: Record<string, Uint8Array>): OfficeSection[] {
	const keys = Object.keys(files)
		.filter(key => /^ppt\/slides\/slide\d+\.xml$/.test(key))
		.sort((left, right) => Number(left.match(/(\d+)/)?.[1]) - Number(right.match(/(\d+)/)?.[1]));
	const sections: OfficeSection[] = [];
	for (const key of keys) {
		const number = Number(key.match(/(\d+)/)?.[1]);
		const text = textRuns(strFromU8(files[key]!)).trim();
		if (text !== "") sections.push({ title: `Slide ${number}`, text });
	}
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
		throw new Error(`text conversion needs .docx, .xlsx or .pptx; "${raw}" needs the Office converter`);
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

const CONVERSION_OUTPUTS: Readonly<Record<"text" | "spreadsheet" | "presentation", readonly string[]>> = {
	text: ["pdf", "docx", "odt", "txt", "md"],
	spreadsheet: ["pdf", "xlsx", "ods", "csv", "txt", "md"],
	presentation: ["pdf", "pptx", "odp", "txt", "md"],
};

const TEXT_FORMATS = new Set(["txt", "md", "csv"]);

function familyOf(extension: OfficeExtension): "text" | "spreadsheet" | "presentation" | "pdf" {
	if (extension === "pdf") return "pdf";
	if (extension === "doc" || extension === "docx" || extension === "odt") return "text";
	if (extension === "xls" || extension === "xlsx" || extension === "ods") return "spreadsheet";
	return "presentation";
}

/** Resolve the converter-input extension and refuse unsupported formats. */
function inputExtension(
	raw: string,
	resolved: string,
	operation: "render" | "convert" | "recalculate",
): OfficeExtension {
	const extension = officeExtensionOf(resolved);
	if (extension === undefined) {
		const accepted =
			operation === "recalculate"
				? "xls, xlsx or ods"
				: `doc, docx, odt, xls, xlsx, ods, ppt, pptx, odp${operation === "render" ? ", or pdf" : ""}`;
		throw new Error(`cannot ${operation} "${raw}": ${operation} accepts ${accepted} files`);
	}
	if (operation !== "render" && extension === "pdf") {
		throw new Error(`cannot ${operation} "${raw}": ${operation} does not accept PDF input`);
	}
	if (operation === "recalculate" && !isSpreadsheet(extension)) {
		throw new Error(`cannot recalculate "${raw}": recalculate accepts xls, xlsx, or ods workbooks`);
	}
	return extension;
}

/** Map a classified kit failure onto a model-facing tool error. */
function officeFailure(verb: string, displayPath: string, error: unknown): unknown {
	if (!isOfficeKitError(error)) return error;
	const hint =
		error.code === "unavailable"
			? " Tell the user this operation is unavailable, or retry later if the cause may be temporary; do not substitute system soffice, npx, or another converter."
			: error.code === "busy"
				? " Retry after other document operations finish."
				: error.code === "output-too-large" && verb === "render"
					? " Select fewer pages or a lower dpi."
					: "";
	return new Error(`cannot ${verb} "${displayPath}": ${error.message}${hint}`);
}

function outputOwner(session: ToolSession): string {
	return session.getSessionId?.() ?? "session";
}

async function saveConverted(
	session: ToolSession,
	convertedPath: string,
	output: string | undefined,
): Promise<{ output?: string; bytes: number }> {
	const bytes = (await fs.stat(convertedPath)).size;
	if (output === undefined || output.trim() === "") return { bytes };
	const target = path.resolve(session.cwd, output);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.copyFile(convertedPath, target);
	return { output: target, bytes };
}

/**
 * Render document pages, slides, or worksheet areas as images . Rendering goes through the host's Office kit; a missing
 * engine is reported as unavailable rather than replaced with a text summary.
 */
export class OfficeRenderTool implements AgentTool<typeof officeRenderSchema, OfficeRenderDetails> {
	readonly name = "office_render";
	readonly approval = "read" as const;
	readonly label = "Office";
	readonly summary = "Render document pages, slides, or worksheet areas as images";
	readonly description = officeRenderDescription.trim();
	readonly parameters = officeRenderSchema;
	readonly loadMode = "essential";
	readonly defaultInactive = true;

	constructor(
		private readonly session: ToolSession,
		private readonly maxImages = 20,
		private readonly maxBytes = 32 * 1024 * 1024,
	) {}

	async execute(
		_toolCallId: string,
		params: typeof officeRenderSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<OfficeRenderDetails>> {
		const raw = typeof params.input === "string" ? params.input.trim() : "";
		if (raw === "") throw new Error("office_render: input must not be empty");
		const resolved = path.resolve(this.session.cwd, raw);
		const extension = inputExtension(raw, resolved, "render");
		const spreadsheet = isSpreadsheet(extension);
		const pages = params.pages;
		if (pages !== undefined) {
			if (spreadsheet)
				throw new Error("office_render: pages does not apply to spreadsheets; select sheet and range instead");
			if (
				pages.length === 0 ||
				pages.some(page => !Number.isSafeInteger(page) || page < 1) ||
				new Set(pages).size !== pages.length
			) {
				throw new Error("office_render: pages must list distinct one-based page numbers");
			}
		}
		if (!spreadsheet && params.sheet !== undefined) {
			throw new Error("office_render: sheet applies only to spreadsheets");
		}
		if (params.range !== undefined && params.sheet === undefined) {
			throw new Error("office_render: range requires sheet");
		}
		if (params.sheet !== undefined && params.sheet.trim() === "") {
			throw new Error("office_render: sheet must be an exact worksheet name");
		}
		if (params.dpi !== undefined && (!Number.isSafeInteger(params.dpi) || params.dpi < 24 || params.dpi > 600)) {
			throw new Error("office_render: dpi must be an integer from 24 to 600");
		}
		const stat = await fs.stat(resolved).catch(() => null);
		if (stat === null) throw new Error(`office_render: file not found: ${raw}`);
		if (!stat.isFile()) throw new Error(`office_render: not a regular file: ${raw}`);

		let result: OfficeImagesResult;
		try {
			result = await getOfficeKit().renderImages(
				{
					input: resolved,
					extension,
					...(pages === undefined ? {} : { pages }),
					...(params.sheet === undefined ? {} : { sheet: params.sheet.trim() }),
					...(params.range === undefined ? {} : { range: params.range.trim() }),
					...(params.dpi === undefined ? {} : { dpi: params.dpi }),
					maxImages: this.maxImages,
					maxBytes: this.maxBytes,
				},
				signal,
			);
		} catch (error) {
			throw officeFailure("render", raw, error);
		}
		if (result.images.length === 0) {
			throw new Error(`office_render: the converter returned no images for "${raw}"`);
		}
		const images: OfficeRenderImageDetails[] = result.images.map(image => ({
			...(image.page === undefined ? {} : { page: image.page }),
			...(image.sheet === undefined ? {} : { sheet: image.sheet }),
			...(image.range === undefined ? {} : { range: image.range }),
			bytes: image.png.byteLength,
			width: image.width,
			height: image.height,
		}));
		const summary = `Rendered ${result.images.length} of ${result.pageCount} page${
			result.pageCount === 1 ? "" : "s"
		} from ${raw} at ${result.dpi} dpi.`;
		return {
			content: [
				{ type: "text", text: summary },
				...result.images.map(image => ({
					type: "image" as const,
					data: Buffer.from(image.png).toString("base64"),
					mimeType: "image/png",
				})),
			],
			details: { format: extension, pageCount: result.pageCount, dpi: result.dpi, images },
		};
	}
}

/**
 * Convert a document. Text targets keep the in-process
 * OOXML reader; every other target goes through the host's Office kit and
 * leaves the file in the conversion store for the model to copy with the shell
 * (or, when `output` is given, is copied into the workspace directly).
 */
export class OfficeConvertTool implements AgentTool<typeof officeConvertSchema, OfficeConvertDetails> {
	readonly name = "office_convert";
	readonly approval = "write" as const;
	readonly label = "Office";
	readonly summary = "Convert an Office document to another format";
	readonly description = officeConvertDescription.trim();
	readonly parameters = officeConvertSchema;
	readonly loadMode = "essential";
	readonly defaultInactive = true;

	constructor(
		private readonly session: ToolSession,
		private readonly defaultMaxChars = 120_000,
	) {}

	async execute(
		_toolCallId: string,
		params: typeof officeConvertSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<OfficeConvertDetails>> {
		const raw = typeof params.input === "string" ? params.input.trim() : "";
		if (raw === "") throw new Error("office_convert: input must not be empty");
		const resolved = path.resolve(this.session.cwd, raw);
		const extension = inputExtension(raw, resolved, "convert");
		const family = familyOf(extension);
		if (family === "pdf") throw new Error(`cannot convert "${raw}": convert does not accept PDF input`);
		const target = params.format;
		const accepted = CONVERSION_OUTPUTS[family];
		if (!accepted.includes(target)) {
			throw new Error(`cannot convert "${raw}" to ${target}: this file converts to ${accepted.join(", ")}`);
		}
		if (params.sheet !== undefined && target !== "csv") {
			throw new Error("office_convert: sheet applies only to CSV conversion");
		}
		if (params.sheet !== undefined && params.sheet.trim() === "") {
			throw new Error("office_convert: sheet must be an exact worksheet name");
		}
		const stat = await fs.stat(resolved).catch(() => null);
		if (stat === null) throw new Error(`office_convert: file not found: ${raw}`);
		if (!stat.isFile()) throw new Error(`office_convert: not a regular file: ${raw}`);

		if (TEXT_FORMATS.has(target) && target !== "csv") {
			const pkg = await readPackage(resolved, raw);
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
			const text = formatSections(limited.sections, target as "txt" | "md");
			return this.#textResult(pkg.format, target, text, params.output);
		}
		if (target === "csv") {
			const pkg = await readPackage(resolved, raw);
			if (pkg.format !== "xlsx") throw new Error("office_convert: csv is only supported for .xlsx");
			const rows = xlsxRows(pkg.files, params.sheet);
			if (rows.length > 1 && !params.sheet) {
				throw new Error(
					`office_convert: this workbook has ${rows.length} sheets; pass sheet to choose one for CSV`,
				);
			}
			const text = rows.map(entry => entry.rows.map(row => row.map(csvCell).join(",")).join("\n")).join("\n\n");
			return this.#textResult(pkg.format, target, text, params.output);
		}

		let converted: OfficeFileResult;
		try {
			converted = await getOfficeKit().convertTo(
				{
					input: resolved,
					extension,
					format: target,
					owner: outputOwner(this.session),
					name: `${path.basename(resolved).replace(/\.[^.]*$/u, "")}.${target}`,
				},
				signal,
			);
		} catch (error) {
			throw officeFailure("convert", raw, error);
		}
		const saved = await saveConverted(this.session, converted.path, params.output);
		return {
			content: [
				{
					type: "text",
					text:
						saved.output === undefined
							? `Converted ${raw} -> ${converted.path} (${converted.bytes} bytes). Copy it with the shell when you need it in the workspace.`
							: `Converted ${raw} -> ${saved.output} (${converted.bytes} bytes).`,
				},
			],
			details: {
				format: extension,
				target,
				bytes: converted.bytes,
				...(saved.output === undefined ? {} : { output: saved.output }),
			},
		};
	}

	async #textResult(
		format: "docx" | "xlsx" | "pptx",
		target: string,
		text: string,
		output: string | undefined,
	): Promise<AgentToolResult<OfficeConvertDetails>> {
		const body = text === "" ? `(${format}: no text found)` : text;
		if (output !== undefined && output.trim() !== "") {
			const targetPath = path.resolve(this.session.cwd, output);
			await fs.mkdir(path.dirname(targetPath), { recursive: true });
			await Bun.write(targetPath, body);
			return {
				content: [
					{ type: "text", text: `Converted ${format} -> ${targetPath} (${Buffer.byteLength(body)} bytes).` },
				],
				details: { format, target, output: targetPath },
			};
		}
		return {
			content: [{ type: "text", text: body }],
			details: { format, target },
		};
	}
}

/**
 * Recalculate every formula of a workbook.
 * The operation needs a recalculation engine; without one the call fails as
 * unavailable instead of returning a workbook with stale cached results.
 */
export class OfficeRecalculateTool implements AgentTool<typeof officeRecalculateSchema, OfficeRecalculateDetails> {
	readonly name = "office_recalculate";
	readonly approval = "write" as const;
	readonly label = "Office";
	readonly summary = "Recalculate spreadsheet formulas";
	readonly description = officeRecalculateDescription.trim();
	readonly parameters = officeRecalculateSchema;
	readonly loadMode = "essential";
	readonly defaultInactive = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: typeof officeRecalculateSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<OfficeRecalculateDetails>> {
		const raw = typeof params.input === "string" ? params.input.trim() : "";
		if (raw === "") throw new Error("office_recalculate: input must not be empty");
		const resolved = path.resolve(this.session.cwd, raw);
		const extension = inputExtension(raw, resolved, "recalculate");
		const stat = await fs.stat(resolved).catch(() => null);
		if (stat === null) throw new Error(`office_recalculate: file not found: ${raw}`);
		if (!stat.isFile()) throw new Error(`office_recalculate: not a regular file: ${raw}`);
		let converted: OfficeFileResult;
		try {
			converted = await getOfficeKit().recalculate(
				{
					input: resolved,
					extension,
					format: params.format,
					owner: outputOwner(this.session),
					name: `${path.basename(resolved).replace(/\.[^.]*$/u, "")}.${params.format}`,
				},
				signal,
			);
		} catch (error) {
			throw officeFailure("recalculate", raw, error);
		}
		const saved = await saveConverted(this.session, converted.path, params.output);
		return {
			content: [
				{
					type: "text",
					text:
						saved.output === undefined
							? `Recalculated ${raw} -> ${converted.path} (${converted.bytes} bytes). Copy it with the shell when you need it in the workspace.`
							: `Recalculated ${raw} -> ${saved.output} (${converted.bytes} bytes).`,
				},
			],
			details: {
				format: params.format,
				bytes: converted.bytes,
				...(saved.output === undefined ? {} : { output: saved.output }),
			},
		};
	}
}
