import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type OfficeKit, OfficeKitError, setOfficeKit } from "@musepi/pi-coding-agent/office/office-kit";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";
import { OfficeConvertTool, OfficeRecalculateTool, OfficeRenderTool } from "@musepi/pi-coding-agent/tools/office";
import { strToU8, zipSync } from "fflate";

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});
afterEach(() => setOfficeKit(null));

/** A 1×1 transparent PNG; the tools only read its IHDR dimensions. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function session(cwd: string): ToolSession {
	return { cwd, hasUI: false, getSessionId: () => "test-session" } as unknown as ToolSession;
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

async function writePptx(dir: string): Promise<void> {
	const slide = `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
	await Bun.write(path.join(dir, "a.pptx"), zipSync({ "ppt/slides/slide1.xml": strToU8(slide) }));
}

async function writeXlsx(dir: string, name = "a.xlsx"): Promise<void> {
	const workbook = `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`;
	const rels = `<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
	const shared = `<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>`;
	const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>`;
	await Bun.write(
		path.join(dir, name),
		zipSync({
			"xl/workbook.xml": strToU8(workbook),
			"xl/_rels/workbook.xml.rels": strToU8(rels),
			"xl/sharedStrings.xml": strToU8(shared),
			"xl/worksheets/sheet1.xml": strToU8(sheet),
		}),
	);
}

function kit(overrides: Partial<OfficeKit> = {}): OfficeKit {
	return {
		outputDirectory: os.tmpdir(),
		renderImages: async request => ({
			pageCount: 3,
			dpi: request.dpi ?? 144,
			images: [{ png: PNG, width: 1, height: 1, page: 1 }],
		}),
		convertTo: async request => {
			const file = path.join(await tempDir(), request.name);
			await Bun.write(file, "converted");
			return { path: file, bytes: 9 };
		},
		recalculate: async request => {
			const file = path.join(await tempDir(), request.name);
			await Bun.write(file, "recalculated");
			return { path: file, bytes: 12 };
		},
		...overrides,
	};
}

describe("office_render", () => {
	it("renders selected pages as image blocks through the Office kit", async () => {
		const dir = await tempDir();
		await writeDocx(dir);
		let seen: Record<string, unknown> = {};
		setOfficeKit(
			kit({
				renderImages: async request => {
					seen = { ...request };
					return {
						pageCount: 4,
						dpi: request.dpi ?? 144,
						images: [
							{ png: PNG, width: 1, height: 1, page: 2 },
							{ png: PNG, width: 1, height: 1, page: 4 },
						],
					};
				},
			}),
		);
		const result = await new OfficeRenderTool(session(dir)).execute("call", {
			input: "a.docx",
			pages: [2, 4],
			dpi: 96,
		});
		expect(seen).toMatchObject({ extension: "docx", pages: [2, 4], dpi: 96 });
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(result.content[2]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(result.details).toMatchObject({
			format: "docx",
			pageCount: 4,
			dpi: 96,
			images: [
				{ page: 2, width: 1, height: 1 },
				{ page: 4, width: 1, height: 1 },
			],
		});
	});

	it("reports an unavailable converter instead of substituting text", async () => {
		const dir = await tempDir();
		await writeDocx(dir);
		setOfficeKit(
			kit({
				renderImages: async () => {
					throw new OfficeKitError("unavailable", "No Office converter is installed.");
				},
			}),
		);
		await expect(new OfficeRenderTool(session(dir)).execute("call", { input: "a.docx" })).rejects.toThrow(
			"do not substitute system soffice",
		);
	});

	it("requires sheet for a range and rejects pages on a spreadsheet", async () => {
		const dir = await tempDir();
		await writeXlsx(dir);
		setOfficeKit(kit());
		await expect(
			new OfficeRenderTool(session(dir)).execute("call", { input: "a.xlsx", range: "A1:B2" }),
		).rejects.toThrow("range requires sheet");
		await expect(new OfficeRenderTool(session(dir)).execute("call", { input: "a.xlsx", pages: [1] })).rejects.toThrow(
			"pages does not apply to spreadsheets",
		);
	});

	it("refuses an unsupported extension", async () => {
		const dir = await tempDir();
		await Bun.write(path.join(dir, "a.txt"), "text");
		await expect(new OfficeRenderTool(session(dir)).execute("call", { input: "a.txt" })).rejects.toThrow(
			"render accepts",
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

	it("converts a pptx to text", async () => {
		const dir = await tempDir();
		await writePptx(dir);
		const result = await new OfficeConvertTool(session(dir), 10_000).execute("call", {
			input: "a.pptx",
			format: "md",
		});
		expect(textOf(result)).toContain("Slide title");
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

	it("converts a docx to pdf through the Office kit and copies it to output", async () => {
		const dir = await tempDir();
		await writeDocx(dir);
		setOfficeKit(kit());
		const result = await new OfficeConvertTool(session(dir)).execute("call", {
			input: "a.docx",
			format: "pdf",
			output: "out/a.pdf",
		});
		expect(await Bun.file(path.join(dir, "out", "a.pdf")).text()).toBe("converted");
		expect(result.details).toMatchObject({ format: "docx", target: "pdf", output: path.join(dir, "out", "a.pdf") });
	});

	it("rejects a format the input family cannot produce", async () => {
		const dir = await tempDir();
		await writeDocx(dir);
		await expect(
			new OfficeConvertTool(session(dir)).execute("call", { input: "a.docx", format: "csv" }),
		).rejects.toThrow("this file converts to");
	});
});

describe("office_recalculate", () => {
	it("returns the recalculated workbook from the kit", async () => {
		const dir = await tempDir();
		await writeXlsx(dir);
		setOfficeKit(kit());
		const result = await new OfficeRecalculateTool(session(dir)).execute("call", {
			input: "a.xlsx",
			format: "xlsx",
		});
		expect(textOf(result)).toContain("Recalculated");
		expect(result.details).toMatchObject({ format: "xlsx", bytes: 12 });
	});

	it("refuses a non-workbook input before calling the kit", async () => {
		const dir = await tempDir();
		await writeDocx(dir);
		setOfficeKit(kit());
		await expect(
			new OfficeRecalculateTool(session(dir)).execute("call", { input: "a.docx", format: "xlsx" }),
		).rejects.toThrow("recalculate accepts xls, xlsx, or ods workbooks");
	});

	it("reports an unavailable recalculation engine", async () => {
		const dir = await tempDir();
		await writeXlsx(dir);
		setOfficeKit(
			kit({
				recalculate: async () => {
					throw new OfficeKitError("unavailable", "No Office recalculation engine is configured.");
				},
			}),
		);
		await expect(
			new OfficeRecalculateTool(session(dir)).execute("call", { input: "a.xlsx", format: "xlsx" }),
		).rejects.toThrow("No Office recalculation engine");
	});
});
