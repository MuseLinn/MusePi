import "./dom-shim";
import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { buildSheetModels } from "../src/components/FilePane";

/** Spreadsheet preview contract: the file pane turns a workbook into escaped
 *  HTML tables, caps huge sheets, and yields to the OS app when the bytes are
 *  not a workbook at all. Fed real workbook bytes — no mocks — because the
 *  failure mode that matters is a cell full of markup reaching the DOM. */

function workbookBytes(sheetRows: Array<Array<unknown>>[], names: string[]): Uint8Array {
	const wb = XLSX.utils.book_new();
	for (let i = 0; i < sheetRows.length; i++) {
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetRows[i]!), names[i] ?? `S${i + 1}`);
	}
	const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
	return new Uint8Array(out as ArrayBuffer);
}

describe("buildSheetModels", () => {
	test("escapes markup in cells instead of injecting it into the preview", () => {
		const bytes = workbookBytes(
			[
				[
					["name", "qty"],
					["<script>alert(1)</script>", 2],
				],
			],
			["Sheet1"],
		);
		const sheets = buildSheetModels(bytes)!;
		expect(sheets).toHaveLength(1);
		expect(sheets[0]!.html).toContain("&lt;script&gt;");
		expect(sheets[0]!.html).not.toContain("<script>");
	});

	test("one model per sheet, in workbook order", () => {
		const bytes = workbookBytes(
			[
				[["a"], [1]],
				[["b"], [2]],
			],
			["First", "Second"],
		);
		const sheets = buildSheetModels(bytes)!;
		expect(sheets.map(s => s.name)).toEqual(["First", "Second"]);
	});

	test("caps a large sheet and flags it truncated", () => {
		const huge: Array<Array<unknown>> = [["header"]];
		for (let i = 0; i < 5000; i++) huge.push([i]);
		const bytes = workbookBytes([huge], ["Big"]);
		const sheets = buildSheetModels(bytes)!;
		expect(sheets[0]!.truncated).toBe(true);
		// The rendered table holds exactly the cap, not the whole sheet.
		expect(sheets[0]!.html.split("<tr>").length - 1).toBe(1000);
	});

	test("a sheet under the cap renders complete and untruncated", () => {
		const bytes = workbookBytes([[["h"], [1], [2]]], ["Small"]);
		const sheets = buildSheetModels(bytes)!;
		expect(sheets[0]!.truncated).toBe(false);
		expect(sheets[0]!.html.split("<tr>").length - 1).toBe(3);
	});

	test("returns null for non-workbook bytes so the OS app takes over", () => {
		// SheetJS does not throw on junk — it reads it as a workbook with no
		// sheets. That degenerate result must read as "nothing to preview"
		// so the file falls through to the system default app, not an empty
		// table pretending to be the document.
		expect(buildSheetModels(new Uint8Array(0))).toBeNull();
		expect(buildSheetModels(new TextEncoder().encode("<b>not a spreadsheet</b>"))).toBeNull();
	});
});
