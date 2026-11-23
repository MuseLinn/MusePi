import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import { strFromU8, unzipSync } from "fflate";
import type { ToolSession } from "./contract";

export const officeReadSchema = type({
	path: type("string").describe("Path to a .docx, .xlsx or .pptx file, relative to the session working directory."),
	sheet: type("string").describe("xlsx only: worksheet name to read instead of every sheet.").optional(),
	slide: type("number").describe("pptx only: one-based slide number to read instead of every slide.").optional(),
	maxChars: type("number").describe("Character ceiling for the extracted text (1000-500000).").optional(),
});

export interface OfficeSection {
	title: string;
	text: string;
}

export interface OfficeReadDetails {
	format: "docx" | "xlsx" | "pptx";
	sections: OfficeSection[];
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

function pptxSections(files: Record<string, Uint8Array>, slide?: number): OfficeSection[] {
	const keys = Object.keys(files)
		.filter(key => /^ppt\/slides\/slide\d+\.xml$/.test(key))
		.sort((left, right) => Number(left.match(/(\d+)/)?.[1]) - Number(right.match(/(\d+)/)?.[1]));
	const sections: OfficeSection[] = [];
	for (const key of keys) {
		const number = Number(key.match(/(\d+)/)?.[1]);
		if (slide !== undefined && number !== slide) continue;
		const text = textRuns(strFromU8(files[key]!)).trim();
		if (text !== "") sections.push({ title: `Slide ${number}`, text });
	}
	if (sections.length === 0 && slide !== undefined) throw new Error(`slide ${slide} has no text or does not exist`);
	return sections;
}

function xlsxSections(files: Record<string, Uint8Array>, sheet?: string): OfficeSection[] {
	const sharedXml = files["xl/sharedStrings.xml"];
	const shared = sharedXml
		? [...strFromU8(sharedXml).matchAll(/<si\b[\s\S]*?<\/si>/g)].map(match => textRuns(match[0]))
		: [];
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
	const wanted = sheet?.toLowerCase();
	const selected = wanted ? sheets.filter(entry => entry.name.toLowerCase() === wanted) : sheets;
	if (wanted && selected.length === 0) {
		throw new Error(`worksheet "${sheet}" not found; available: ${sheets.map(entry => entry.name).join(", ")}`);
	}
	const sections: OfficeSection[] = [];
	for (const entry of selected) {
		const xml = files[entry.key];
		if (!xml) continue;
		const rows: string[] = [];
		for (const row of strFromU8(xml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
			const cells: string[] = [];
			for (const cell of row[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
				const attrs = cell[1]!;
				const body = cell[2]!;
				const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
				const inline = /<is>([\s\S]*?)<\/is>/.exec(body)?.[1];
				const kind = attribute(attrs, "t");
				if (kind === "s" && value !== undefined) cells.push(shared[Number(value)] ?? "");
				else if (inline !== undefined) cells.push(textRuns(inline));
				else if (value !== undefined) cells.push(decodeXml(value).trim());
			}
			if (cells.some(cell => cell !== "")) rows.push(cells.join("\t"));
		}
		if (rows.length > 0) sections.push({ title: `Sheet: ${entry.name}`, text: rows.join("\n") });
	}
	return sections;
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

/**
 * Read text and structure from Office Open XML files (dsh's office family,
 * text side). A full render/convert/recalculate pipeline needs an Office
 * converter service; this tool reads the package XML directly and reports only
 * what the file contains.
 */
export class OfficeReadTool implements AgentTool<typeof officeReadSchema, OfficeReadDetails> {
	readonly name = "office_read";
	readonly approval = "read" as const;
	readonly label = "Office";
	readonly summary = "Read text and structure from docx, xlsx and pptx files";
	readonly description =
		"Read text and structure from an Office Open XML file: Word paragraphs, PowerPoint slide text, or Excel worksheet rows. It reads the file's XML directly; it does not render pages, convert formats, or recalculate formulas.";
	readonly parameters = officeReadSchema;
	readonly loadMode = "discoverable";

	constructor(
		private readonly session: ToolSession,
		private readonly defaultMaxChars = 120_000,
	) {}

	async execute(
		_toolCallId: string,
		params: typeof officeReadSchema.infer,
	): Promise<AgentToolResult<OfficeReadDetails>> {
		const raw = typeof params.path === "string" ? params.path.trim() : "";
		if (raw === "") throw new Error("office_read: path must not be empty");
		const resolved = path.resolve(this.session.cwd, raw);
		const stat = await fs.stat(resolved).catch(() => null);
		if (stat === null) throw new Error(`office_read: file not found: ${raw}`);
		if (!stat.isFile()) throw new Error(`office_read: not a regular file: ${raw}`);
		const extension = path.extname(resolved).toLowerCase();
		if (extension !== ".docx" && extension !== ".xlsx" && extension !== ".pptx") {
			throw new Error(`office_read: unsupported format ${extension || "(none)"}; expected .docx, .xlsx or .pptx`);
		}
		const bytes = new Uint8Array(await Bun.file(resolved).arrayBuffer());
		let files: Record<string, Uint8Array>;
		try {
			files = unzipSync(bytes);
		} catch (error) {
			throw new Error(
				`office_read: cannot read the Office package: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const format = extension === ".docx" ? "docx" : extension === ".xlsx" ? "xlsx" : "pptx";
		const sections =
			format === "docx"
				? docxSections(files)
				: format === "pptx"
					? pptxSections(files, params.slide)
					: xlsxSections(files, params.sheet);
		const maxChars =
			typeof params.maxChars === "number" && params.maxChars >= 1000
				? Math.min(500_000, Math.floor(params.maxChars))
				: this.defaultMaxChars;
		const limited = truncateSections(sections, maxChars);
		const text =
			limited.sections.length === 0
				? `(${format}: no text found)`
				: limited.sections.map(section => `## ${section.title}\n${section.text}`).join("\n\n");
		return {
			content: [{ type: "text", text }],
			details: { format, sections: limited.sections, truncated: limited.truncated },
		};
	}
}
