import "./happy-dom-shim";
import { describe, expect, test } from "bun:test";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as XLSX from "xlsx";
import {
	parseOfficeDraft,
	readPresentationDraft,
	readWordDraft,
	readWorkbookDraft,
	serializeOfficeDraft,
	writeOfficeDraft,
} from "../src/lib/office-documents";

async function wordBytes(): Promise<Uint8Array> {
	const document = new Document({
		sections: [
			{
				children: [
					new Paragraph({ children: [new TextRun("Before")] }),
					new Paragraph({ children: [new TextRun("Keep this")] }),
				],
			},
		],
	});
	return new Uint8Array(await Packer.toBuffer(document));
}

describe("Word package editing", () => {
	test("changes only the selected paragraph and preserves package parts", async () => {
		const original = await wordBytes();
		const files = unzipSync(original);
		files["customXml/research-note.xml"] = strToU8("not tracked by git or rewritten by the editor");
		const withCustomPart = zipSync(files);
		const draft = readWordDraft(withCustomPart);
		expect(draft.kind).toBe("word");
		if (draft.kind !== "word") return;
		expect(draft.paragraphs.map(paragraph => paragraph.text)).toEqual(["Before", "Keep this"]);
		draft.paragraphs[0]!.text = "After";
		const saved = writeOfficeDraft(withCustomPart, draft);
		const savedDraft = readWordDraft(saved);
		expect(savedDraft.kind === "word" && savedDraft.paragraphs.map(paragraph => paragraph.text)).toEqual([
			"After",
			"Keep this",
		]);
		expect(strFromU8(unzipSync(saved)["customXml/research-note.xml"]!)).toBe(
			"not tracked by git or rewritten by the editor",
		);
	});

	test("survives the host draft serialization boundary", async () => {
		const draft = readWordDraft(await wordBytes());
		expect(parseOfficeDraft(serializeOfficeDraft(draft))).toEqual(draft);
	});
});

function workbookBytes(withChart = false): Uint8Array {
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(
		workbook,
		XLSX.utils.aoa_to_sheet([
			["Name", "Value"],
			["Alpha", 1],
		]),
		"Data",
	);
	const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
	if (!withChart) return bytes;
	return zipSync({ ...unzipSync(bytes), "xl/charts/chart1.xml": strToU8("<chart/>") });
}

describe("workbook editing", () => {
	test("writes a cell without converting formulas to values", () => {
		const original = workbookBytes();
		const draft = readWorkbookDraft(original);
		expect(draft.kind).toBe("workbook");
		if (draft.kind !== "workbook") return;
		draft.sheets[0]!.rows[1]![1]!.text = "2";
		const saved = writeOfficeDraft(original, draft);
		const sheet = XLSX.read(saved, { type: "array" }).Sheets.Data!;
		expect(sheet.B2?.v).toBe("2");
	});

	test("keeps formula cells and feature-rich workbooks read-only", () => {
		const workbook = XLSX.utils.book_new();
		const sheet = XLSX.utils.aoa_to_sheet([
			[1, 2],
			[3, 4],
		]);
		sheet.B2 = { t: "n", v: 7, f: "SUM(A1:B1)" };
		XLSX.utils.book_append_sheet(workbook, sheet, "Data");
		const formulaDraft = readWorkbookDraft(
			new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer),
		);
		expect(formulaDraft.kind === "workbook" && formulaDraft.sheets[0]?.rows[1]?.[1]?.editable).toBe(false);
		expect(readWorkbookDraft(workbookBytes(true)).readOnlyReason).toBe(
			"Charts, drawings, comments, links, or macros require the external app for editing.",
		);
	});
});

function presentationBytes(): Uint8Array {
	const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="7" name="Title"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="8000000" cy="1000000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>Old title</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;
	return zipSync({
		"ppt/presentation.xml": strToU8(
			`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
		),
		"ppt/slides/slide1.xml": strToU8(slide),
		"ppt/media/image1.png": new Uint8Array([1, 2, 3]),
	});
}

describe("presentation text editing", () => {
	test("uses stable slide and shape anchors and preserves media", () => {
		const original = presentationBytes();
		const draft = readPresentationDraft(original);
		expect(draft.kind).toBe("presentation");
		if (draft.kind !== "presentation") return;
		expect(draft.slides[0]?.shapes[0]).toMatchObject({ id: "7", text: "Old title", x: 914400 });
		draft.slides[0]!.shapes[0]!.text = "New title";
		const saved = writeOfficeDraft(original, draft);
		const savedDraft = readPresentationDraft(saved);
		expect(savedDraft.kind === "presentation" && savedDraft.slides[0]?.shapes[0]?.text).toBe("New title");
		expect(unzipSync(saved)["ppt/media/image1.png"]).toEqual(new Uint8Array([1, 2, 3]));
	});

	test("keeps multi-run shapes read-only instead of duplicating their text", () => {
		const original = presentationBytes();
		const files = unzipSync(original);
		files["ppt/slides/slide1.xml"] = strToU8(
			strFromU8(files["ppt/slides/slide1.xml"]!).replace(
				"</a:r></a:p>",
				"</a:r><a:r><a:t> subtitle</a:t></a:r></a:p>",
			),
		);
		const draft = readPresentationDraft(zipSync(files));
		expect(draft.kind === "presentation" && draft.slides[0]?.shapes[0]?.editable).toBe(false);
		if (draft.kind !== "presentation") return;
		draft.slides[0]!.shapes[0]!.text = "Unsafe rewrite";
		expect(() => writeOfficeDraft(zipSync(files), draft)).toThrow("read-only");
	});
});
