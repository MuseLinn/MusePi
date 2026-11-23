import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";
import { OfficeReadTool } from "@musepi/pi-coding-agent/tools/office";
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

describe("office_read", () => {
	it("extracts Word paragraphs", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "office-read-"));
		dirs.push(dir);
		const document = `<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>`;
		await Bun.write(path.join(dir, "a.docx"), zipSync({ "word/document.xml": strToU8(document) }));
		const result = await new OfficeReadTool(session(dir), 10_000).execute("call", { path: "a.docx" });
		const text = textOf(result);
		expect(text).toContain("Hello world");
		expect(text).toContain("Second paragraph");
		expect(result.details?.format).toBe("docx");
	});

	it("extracts PowerPoint slide text", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "office-read-"));
		dirs.push(dir);
		const slide = `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
		await Bun.write(path.join(dir, "a.pptx"), zipSync({ "ppt/slides/slide1.xml": strToU8(slide) }));
		const result = await new OfficeReadTool(session(dir), 10_000).execute("call", { path: "a.pptx" });
		const text = textOf(result);
		expect(text).toContain("Slide 1");
		expect(text).toContain("Slide title");
	});

	it("extracts worksheet cells with shared strings", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "office-read-"));
		dirs.push(dir);
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
		const result = await new OfficeReadTool(session(dir), 10_000).execute("call", { path: "a.xlsx" });
		const text = textOf(result);
		expect(text).toContain("Sheet: Data");
		expect(text).toContain("Name");
		expect(text).toContain("Ada\t42");
	});

	it("refuses an unsupported extension", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "office-read-"));
		dirs.push(dir);
		await Bun.write(path.join(dir, "a.txt"), "text");
		await expect(new OfficeReadTool(session(dir), 10_000).execute("call", { path: "a.txt" })).rejects.toThrow(
			"unsupported format",
		);
	});
});
