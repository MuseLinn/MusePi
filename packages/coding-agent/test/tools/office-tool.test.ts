import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";
import { OfficeConvertTool, OfficeRenderTool } from "@musepi/pi-coding-agent/tools/office";
import { strToU8, zipSync } from "fflate";

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

function session(cwd: string): ToolSession {
	return { cwd, hasUI: false } as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "office-tool-"));
	dirs.push(dir);
	return dir;
}

async function writeDocx(dir: string): Promise<void> {
	const document = `<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>`;
	await Bun.write(path.join(dir, "a.docx"), zipSync({ "word/document.xml": strToU8(document) }));
}

async function writeXlsx(dir: string): Promise<void> {
	const workbook = `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`;
	const rels = `<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
	const shared = `<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>`;
	const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>`;
	await Bun.write(
		path.join(dir, "a.xlsx"),
		zipSync({
			"xl/workbook.xml": strToU8(workbook),
			"xl/_rels/workbook.xml.rels": strToU8(rels),
			"xl/sharedStrings.xml": strToU8(shared),
			"xl/worksheets/sheet1.xml": strToU8(sheet),
		}),
	);
}

describe("office_render", () => {
	it("renders Word paragraphs", async () => {
		const dir = await tempDir();
		await writeDocx(dir);
		const result = await new OfficeRenderTool(session(dir), 10_000).execute("call", { input: "a.docx" });
		const text = textOf(result);
		expect(text).toContain("Hello world");
		expect(text).toContain("Second paragraph");
		expect(result.details?.format).toBe("docx");
	});

	it("renders PowerPoint slide text and selects pages", async () => {
		const dir = await tempDir();
		const slide = `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
		await Bun.write(path.join(dir, "a.pptx"), zipSync({ "ppt/slides/slide1.xml": strToU8(slide) }));
		const result = await new OfficeRenderTool(session(dir), 10_000).execute("call", {
			input: "a.pptx",
			pages: [1],
		});
		const text = textOf(result);
		expect(text).toContain("Slide 1");
		expect(text).toContain("Slide title");
	});

	it("renders worksheet rows with shared strings and an A1 range", async () => {
		const dir = await tempDir();
		await writeXlsx(dir);
		const result = await new OfficeRenderTool(session(dir), 10_000).execute("call", {
			input: "a.xlsx",
			range: "A1:B2",
		});
		const text = textOf(result);
		expect(text).toContain("Sheet: Data");
		expect(text).toContain("Name");
		expect(text).toContain("Ada\t42");
	});

	it("refuses an unsupported extension", async () => {
		const dir = await tempDir();
		await Bun.write(path.join(dir, "a.txt"), "text");
		await expect(new OfficeRenderTool(session(dir), 10_000).execute("call", { input: "a.txt" })).rejects.toThrow(
			"unsupported format",
		);
	});
});

describe("office_convert", () => {
	it("converts a docx to text and writes the output", async () => {
		const dir = await tempDir();
		await writeDocx(dir);
		const result = await new OfficeConvertTool(session(dir), 10_000).execute("call", {
			input: "a.docx",
			format: "txt",
			output: "out.txt",
		});
		expect(textOf(result)).toContain("Converted");
		expect(await Bun.file(path.join(dir, "out.txt")).text()).toContain("Hello world");
		expect(result.details).toMatchObject({ format: "docx", target: "txt" });
	});

	it("converts an xlsx sheet to CSV", async () => {
		const dir = await tempDir();
		await writeXlsx(dir);
		const result = await new OfficeConvertTool(session(dir), 10_000).execute("call", {
			input: "a.xlsx",
			format: "csv",
			sheet: "Data",
		});
		expect(textOf(result)).toContain("Ada,42");
		expect(result.details).toMatchObject({ format: "xlsx", target: "csv" });
	});

	it("requires a sheet for a multi-sheet CSV", async () => {
		const dir = await tempDir();
		const workbook = `<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/><sheet name="B" sheetId="2" r:id="rId2"/></sheets></workbook>`;
		const rels = `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`;
		const sheet = `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;
		await Bun.write(
			path.join(dir, "b.xlsx"),
			zipSync({
				"xl/workbook.xml": strToU8(workbook),
				"xl/_rels/workbook.xml.rels": strToU8(rels),
				"xl/worksheets/sheet1.xml": strToU8(sheet),
				"xl/worksheets/sheet2.xml": strToU8(sheet),
			}),
		);
		await expect(
			new OfficeConvertTool(session(dir), 10_000).execute("call", { input: "b.xlsx", format: "csv" }),
		).rejects.toThrow("pass sheet");
	});
});
