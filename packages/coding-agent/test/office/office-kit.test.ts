import { describe, expect, it } from "bun:test";
import { normalizePrintRange, OfficeKitError, selectWorkbookSheet } from "@musepi/pi-coding-agent/office/office-kit";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const workbook = (sheets: string, extra = "") =>
	strToU8(
		`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>${sheets}</sheets>${extra}</workbook>`,
	);

function parse(bytes: Uint8Array): { workbook: string; files: Record<string, Uint8Array> } {
	const files = unzipSync(bytes);
	return { files, workbook: strFromU8(files["xl/workbook.xml"]!) };
}

function packageWith(sheets: string): Uint8Array {
	return zipSync({
		"xl/workbook.xml": workbook(sheets),
		"xl/worksheets/sheet1.xml": strToU8("<worksheet/>"),
		"xl/worksheets/sheet2.xml": strToU8("<worksheet/>"),
	});
}

describe("normalizePrintRange", () => {
	it("turns an A1 range into the absolute print-area form", () => {
		expect(normalizePrintRange("a1:h40")).toBe("$A$1:$H$40");
		expect(normalizePrintRange(" B2:D9 ")).toBe("$B$2:$D$9");
	});

	it("refuses a malformed range", () => {
		expect(() => normalizePrintRange("A1")).toThrow(OfficeKitError);
		expect(() => normalizePrintRange("A1:H")).toThrow("expected A1:H40");
	});
});

describe("selectWorkbookSheet", () => {
	const sheets = `<sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Data" sheetId="2" r:id="rId2"/>`;

	it("keeps the chosen sheet visible, hides the others, and scopes a print area", () => {
		const { workbook: xml, files } = parse(
			selectWorkbookSheet(packageWith(sheets), { sheet: "Data", range: "A1:H40" }),
		);
		expect(xml).toContain('<sheet name="Summary" sheetId="1" r:id="rId1" state="hidden"/>');
		expect(xml).toContain('<sheet name="Data" sheetId="2" r:id="rId2" state="visible"/>');
		expect(xml).toContain(`<definedName name="_xlnm.Print_Area" localSheetId="1">'Data'!$A$1:$H$40</definedName>`);
		expect(files["xl/worksheets/sheet1.xml"]).toBeDefined();
	});

	it("omits the print area when only a sheet is selected", () => {
		const { workbook: xml } = parse(selectWorkbookSheet(packageWith(sheets), { sheet: "Summary" }));
		expect(xml).not.toContain("_xlnm.Print_Area");
		expect(xml).toContain('<sheet name="Summary" sheetId="1" r:id="rId1" state="visible"/>');
		expect(xml).toContain('<sheet name="Data" sheetId="2" r:id="rId2" state="hidden"/>');
	});

	it("replaces an existing print area for the same sheet", () => {
		const withArea = workbook(
			sheets,
			`<definedNames><definedName name="_xlnm.Print_Area" localSheetId="1">'Data'!$A$1:$Z$90</definedName></definedNames>`,
		);
		const bytes = zipSync({ "xl/workbook.xml": withArea });
		const { workbook: xml } = parse(selectWorkbookSheet(bytes, { sheet: "Data", range: "B2:C3" }));
		expect(xml).not.toContain("$A$1:$Z$90");
		expect(xml).toContain(`localSheetId="1">'Data'!$B$2:$C$3</definedName>`);
	});

	it("refuses an unknown sheet and lists the available names", () => {
		expect(() => selectWorkbookSheet(packageWith(sheets), { sheet: "Missing" })).toThrow(
			'worksheet "Missing" not found; available: Summary, Data',
		);
	});

	it("refuses a package without a workbook part", () => {
		expect(() =>
			selectWorkbookSheet(zipSync({ "xl/worksheets/sheet1.xml": strToU8("<worksheet/>") }), { sheet: "Data" }),
		).toThrow("xl/workbook.xml is missing");
	});
});
