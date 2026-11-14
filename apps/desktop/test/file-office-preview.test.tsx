import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as XLSX from "xlsx";
import { FileOfficePreview } from "../src/components/FileOfficePreview";
import { type OfficeDraft, readWordDraft, readWorkbookDraft } from "../src/lib/office-documents";

const mounted = new Set<Root>();

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	window.getSelection()?.removeAllRanges();
});

async function settle(): Promise<void> {
	await act(async () => {
		await Bun.sleep(10);
	});
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await settle();
	}
	throw new Error("condition did not become true");
}

function workbookDraft(): Extract<OfficeDraft, { kind: "workbook" }> {
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["First"]]), "One");
	XLSX.utils.book_append_sheet(
		workbook,
		XLSX.utils.aoa_to_sheet([
			["Name", "Value"],
			["Alpha", 42],
		]),
		"Data",
	);
	const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
	const draft = readWorkbookDraft(bytes);
	if (draft.kind !== "workbook") throw new Error("wrong draft kind");
	return draft;
}

describe("Office editor surface", () => {
	it("restores a workbook quote to its sheet and cell", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () =>
			root.render(
				<FileOfficePreview
					bytes={new Uint8Array()}
					draft={workbookDraft()}
					restore={{
						anchor: { kind: "workbook", sheet: "Data", startCell: "B2", endCell: "B2" },
						quote: "42",
						nonce: 1,
					}}
					onChange={() => {}}
					onSave={() => {}}
					onSelection={() => {}}
				/>,
			),
		);
		const cell = container.querySelector<HTMLElement>('[data-sheet="Data"][data-cell="B2"]');
		expect(cell).not.toBeNull();
		expect(container.querySelector(".gui-seg-btn--active")?.textContent).toBe("Data");
		expect(window.getSelection()?.toString()).toBe("42");
	});

	it("uses the latest Word draft when Ctrl+S follows an edit", async () => {
		const document = new Document({
			sections: [{ children: [new Paragraph({ children: [new TextRun("Before")] })] }],
		});
		const bytes = new Uint8Array(await Packer.toBuffer(document));
		const original = readWordDraft(bytes);
		const saved: OfficeDraft[] = [];
		function Fixture(): React.ReactNode {
			const [draft, setDraft] = useState<OfficeDraft>(original);
			return (
				<FileOfficePreview
					bytes={bytes}
					draft={draft}
					onChange={setDraft}
					onSave={() => saved.push(draft)}
					onSelection={() => {}}
				/>
			);
		}
		const container = globalThis.document.createElement("div");
		globalThis.document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () => root.render(<Fixture />));
		await waitFor(() => container.querySelector('[data-office-kind="word"]') !== null);
		const paragraph = container.querySelector<HTMLElement>('[data-office-kind="word"]')!;
		paragraph.innerText = "After";
		await act(async () => paragraph.dispatchEvent(new Event("input", { bubbles: true })));
		await act(async () =>
			paragraph.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true })),
		);
		expect(saved).toHaveLength(1);
		expect(saved[0]?.kind === "word" && saved[0].paragraphs[0]?.text).toBe("After");
	});

	it("renders the restored Word draft instead of the original package text", async () => {
		const document = new Document({
			sections: [{ children: [new Paragraph({ children: [new TextRun("Before")] })] }],
		});
		const bytes = new Uint8Array(await Packer.toBuffer(document));
		const original = readWordDraft(bytes);
		if (original.kind !== "word") throw new Error("wrong draft kind");
		const restored = {
			...original,
			paragraphs: original.paragraphs.map(paragraph => ({ ...paragraph, text: "Restored draft" })),
		};
		const container = globalThis.document.createElement("div");
		globalThis.document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () =>
			root.render(
				<FileOfficePreview
					bytes={bytes}
					draft={restored}
					onChange={() => {}}
					onSave={() => {}}
					onSelection={() => {}}
				/>,
			),
		);
		await waitFor(() => container.querySelector('[data-office-kind="word"]') !== null);
		expect(container.querySelector('[data-office-kind="word"]')?.textContent).toBe("Restored draft");
	});

	it("keeps Word paragraph anchors aligned across table cells", async () => {
		const document = new Document({
			sections: [
				{
					children: [
						new Paragraph({ children: [new TextRun("Before table")] }),
						new Table({
							width: { size: 100, type: WidthType.PERCENTAGE },
							rows: [
								new TableRow({
									children: [
										new TableCell({ children: [new Paragraph({ children: [new TextRun("Inside table")] })] }),
									],
								}),
							],
						}),
						new Paragraph({ children: [new TextRun("After table")] }),
					],
				},
			],
		});
		const bytes = new Uint8Array(await Packer.toBuffer(document));
		const container = globalThis.document.createElement("div");
		globalThis.document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () =>
			root.render(
				<FileOfficePreview
					bytes={bytes}
					draft={readWordDraft(bytes)}
					onChange={() => {}}
					onSave={() => {}}
					onSelection={() => {}}
				/>,
			),
		);
		await waitFor(() => container.querySelectorAll('[data-office-kind="word"]').length === 3);
		const paragraphs = Array.from(container.querySelectorAll<HTMLElement>('[data-office-kind="word"]'));
		expect(paragraphs.map(paragraph => paragraph.textContent)).toEqual([
			"Before table",
			"Inside table",
			"After table",
		]);
		expect(paragraphs.map(paragraph => paragraph.dataset.paragraphId)).toEqual(["0", "1", "2"]);
	});
});
