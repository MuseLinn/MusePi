import { t } from "@musepi/client-core";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as XLSX from "xlsx";

/** One styled text span of a Word paragraph. */
export interface OfficeWordRun {
	text: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
}

/** Editable Office models contain text and stable package locations, never DOM nodes. */
export type OfficeDraft =
	| {
			kind: "word";
			paragraphs: Array<{ id: number; text: string; runs?: OfficeWordRun[]; editable: boolean }>;
			readOnlyReason?: string;
	  }
	| {
			kind: "presentation";
			width: number;
			height: number;
			slides: Array<{
				number: number;
				shapes: Array<{
					id: string;
					text: string;
					x: number;
					y: number;
					cx: number;
					cy: number;
					editable: boolean;
				}>;
			}>;
			readOnlyReason?: string;
	  }
	| {
			kind: "workbook";
			format: "xlsx";
			sheets: Array<{
				name: string;
				rows: Array<Array<{ address: string; text: string; editable: boolean }>>;
			}>;
			readOnlyReason?: string;
	  };

export function serializeOfficeDraft(draft: OfficeDraft): string {
	return JSON.stringify(draft);
}

export function parseOfficeDraft(text: string): OfficeDraft | null {
	try {
		const value = JSON.parse(text) as OfficeDraft;
		return value && ["word", "presentation", "workbook"].includes(value.kind) ? value : null;
	} catch {
		return null;
	}
}

function xml(source: Uint8Array): Document {
	const document = new DOMParser().parseFromString(strFromU8(source), "application/xml");
	if (document.querySelector("parsererror")) throw new Error("Invalid Office XML");
	return document;
}

function entries(data: Uint8Array): Record<string, Uint8Array> {
	return unzipSync(data);
}

function textOf(root: Element, name: string): string {
	return elements(root, name)
		.map(node => node.textContent ?? "")
		.join("");
}

function elements(root: Document | Element, name: string): Element[] {
	return Array.from(root.getElementsByTagName(name));
}

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** Whether an on/off run property (w:b, w:i, w:u) is enabled on this run. */
function runFlag(run: Element | undefined, name: "w:b" | "w:i" | "w:u"): boolean {
	const property = run?.getElementsByTagName("w:rPr")[0]?.getElementsByTagName(name)[0];
	if (!property) return false;
	const value = property.getAttribute("w:val")?.toLowerCase();
	return value === null || value === undefined || !["0", "false", "none"].includes(value);
}

function runMarks(run: Element | undefined): Omit<OfficeWordRun, "text"> {
	return {
		...(runFlag(run, "w:b") ? { bold: true } : {}),
		...(runFlag(run, "w:i") ? { italic: true } : {}),
		...(runFlag(run, "w:u") ? { underline: true } : {}),
	};
}

function sameRuns(left: readonly OfficeWordRun[], right: readonly OfficeWordRun[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(run, index) =>
				run.text === right[index]!.text &&
				(run.bold === true) === (right[index]!.bold === true) &&
				(run.italic === true) === (right[index]!.italic === true) &&
				(run.underline === true) === (right[index]!.underline === true),
		)
	);
}

function setRunMark(run: Element, name: "b" | "i" | "u", enabled: boolean): void {
	const document = run.ownerDocument;
	const namespace = run.namespaceURI ?? WORD_NAMESPACE;
	let properties = run.getElementsByTagName("w:rPr")[0];
	if (!properties) {
		properties = document.createElementNS(namespace, "w:rPr");
		run.insertBefore(properties, run.firstChild);
	}
	const existing = properties.getElementsByTagName(`w:${name}`)[0];
	if (enabled && !existing) {
		const mark = document.createElementNS(namespace, `w:${name}`);
		if (name === "u") mark.setAttribute("w:val", "single");
		properties.appendChild(mark);
	} else if (!enabled && existing) {
		properties.removeChild(existing);
	}
}

/** A paragraph whose entire content is plain runs (no hyperlink, field, tab,
 * break, drawing or object) can be rewritten without touching anything else. */
function editableWordParagraph(paragraph: Element): boolean {
	const content = Array.from(paragraph.children).filter(child => child.localName !== "pPr");
	if (content.length === 0) return true;
	return content.every(child => {
		if (child.localName !== "r") return false;
		const onlyPropertiesAndText = Array.from(child.children).every(
			grand => grand.localName === "rPr" || grand.localName === "t",
		);
		return (
			onlyPropertiesAndText &&
			child.getElementsByTagName("w:drawing").length === 0 &&
			child.getElementsByTagName("w:object").length === 0
		);
	});
}

function paragraphRuns(paragraph: Element): OfficeWordRun[] {
	return Array.from(paragraph.children)
		.filter(child => child.localName === "r")
		.map(run => ({ text: textOf(run, "w:t"), ...runMarks(run) }));
}

/** Only paragraphs whose content is plain runs are directly editable. Other
 * content stays visible and byte-preserved; saving never rewrites it. */
export function readWordDraft(data: Uint8Array): OfficeDraft {
	const files = entries(data);
	const source = files["word/document.xml"];
	if (!source) throw new Error("Missing word/document.xml");
	const paragraphs = elements(xml(source), "w:body").flatMap(body => elements(body, "w:p"));
	return {
		kind: "word",
		paragraphs: paragraphs.map((paragraph, id) => {
			const runs = paragraphRuns(paragraph);
			const editable = editableWordParagraph(paragraph);
			return {
				id,
				text: textOf(paragraph, "w:t"),
				...(editable ? { runs } : {}),
				editable,
			};
		}),
	};
}

/** Replace a paragraph's runs with the edited runs, keeping its properties. */
function writeParagraphRuns(paragraph: Element, runs: readonly OfficeWordRun[]): void {
	const document = paragraph.ownerDocument;
	const namespace = paragraph.namespaceURI ?? WORD_NAMESPACE;
	const existingRuns = Array.from(paragraph.children).filter(child => child.localName === "r");
	const anchor = existingRuns[0] ?? null;
	const template = existingRuns[0];
	if (runs.length === 0) {
		for (const run of existingRuns) paragraph.removeChild(run);
		return;
	}
	const createRun = (): Element => {
		if (template) {
			const clone = template.cloneNode(true) as Element;
			for (const child of Array.from(clone.childNodes)) {
				if (child.nodeType === 1 && (child as Element).localName === "rPr") continue;
				clone.removeChild(child);
			}
			return clone;
		}
		return document.createElementNS(namespace, "w:r");
	};
	for (const run of runs) {
		const element = createRun();
		const text = document.createElementNS(namespace, "w:t");
		text.setAttribute("xml:space", "preserve");
		text.textContent = run.text;
		element.appendChild(text);
		setRunMark(element, "b", run.bold === true);
		setRunMark(element, "i", run.italic === true);
		setRunMark(element, "u", run.underline === true);
		paragraph.insertBefore(element, anchor);
	}
	for (const run of existingRuns) paragraph.removeChild(run);
}

function writeWordDraft(data: Uint8Array, draft: Extract<OfficeDraft, { kind: "word" }>): Uint8Array {
	const files = entries(data);
	const source = files["word/document.xml"];
	if (!source) throw new Error("Missing word/document.xml");
	const document = xml(source);
	const paragraphs = elements(document, "w:body").flatMap(body => elements(body, "w:p"));
	for (const edited of draft.paragraphs) {
		const paragraph = paragraphs[edited.id];
		if (!paragraph) throw new Error("Word paragraph no longer exists");
		const originalRuns = paragraphRuns(paragraph);
		const runs =
			edited.runs && edited.runs.length > 0 && edited.runs.map(run => run.text).join("") === edited.text
				? edited.runs
				: edited.text === ""
					? []
					: [{ text: edited.text }];
		if (sameRuns(originalRuns, runs)) continue;
		if (!edited.editable || !editableWordParagraph(paragraph)) throw new Error("This Word paragraph is read-only");
		writeParagraphRuns(paragraph, runs);
	}
	files["word/document.xml"] = strToU8(new XMLSerializer().serializeToString(document));
	return zipSync(files);
}

function numberAttribute(root: Element, name: string, fallback: number): number {
	const value = Number(root.getAttribute(name));
	return Number.isFinite(value) ? value : fallback;
}

/** Read the text-shape layer of a presentation. The UI labels this as a text
 * layout preview instead of claiming to reproduce every PowerPoint effect. */
export function readPresentationDraft(data: Uint8Array): OfficeDraft {
	const files = entries(data);
	const presentation = files["ppt/presentation.xml"];
	if (!presentation) throw new Error("Missing ppt/presentation.xml");
	const presentationXml = xml(presentation);
	const size = elements(presentationXml, "p:sldSz")[0];
	const width = size ? numberAttribute(size, "cx", 12_192_000) : 12_192_000;
	const height = size ? numberAttribute(size, "cy", 6_858_000) : 6_858_000;
	const slideNames = Object.keys(files)
		.filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
		.sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
	return {
		kind: "presentation",
		width,
		height,
		slides: slideNames.map((name, slideIndex) => {
			const shapes = elements(xml(files[name]!), "p:sp").map((shape, shapeIndex) => {
				const offset = elements(shape, "a:off")[0];
				const extent = elements(shape, "a:ext")[0];
				const identity = elements(shape, "p:cNvPr")[0];
				const texts = elements(shape, "a:t");
				return {
					id: identity?.getAttribute("id") ?? String(shapeIndex + 1),
					text: texts.map(node => node.textContent ?? "").join("\n"),
					x: offset ? numberAttribute(offset, "x", 0) : width * 0.08,
					y: offset ? numberAttribute(offset, "y", 0) : height * (0.08 + shapeIndex * 0.12),
					cx: extent ? numberAttribute(extent, "cx", width * 0.84) : width * 0.84,
					cy: extent ? numberAttribute(extent, "cy", height * 0.1) : height * 0.1,
					editable: texts.length === 1 && elements(shape, "a:graphicFrame").length === 0,
				};
			});
			return { number: slideIndex + 1, shapes };
		}),
		readOnlyReason: t("settings.officePresentationPreview"),
	};
}

function writePresentationDraft(data: Uint8Array, draft: Extract<OfficeDraft, { kind: "presentation" }>): Uint8Array {
	const files = entries(data);
	for (const slide of draft.slides) {
		const path = `ppt/slides/slide${slide.number}.xml`;
		const source = files[path];
		if (!source) throw new Error("Presentation slide no longer exists");
		const document = xml(source);
		const shapes = elements(document, "p:sp");
		for (const edited of slide.shapes) {
			const shape = shapes.find(
				(candidate, index) =>
					(elements(candidate, "p:cNvPr")[0]?.getAttribute("id") ?? String(index + 1)) === edited.id,
			);
			if (!shape) throw new Error("Presentation shape no longer exists");
			const textNodes = elements(shape, "a:t");
			const original = textNodes.map(node => node.textContent ?? "").join("\n");
			if (original === edited.text) continue;
			if (!edited.editable || textNodes.length !== 1) throw new Error("This presentation shape is read-only");
			textNodes[0]!.textContent = edited.text;
		}
		files[path] = strToU8(new XMLSerializer().serializeToString(document));
	}
	return zipSync(files);
}

const UNSAFE_WORKBOOK_PARTS = [
	"xl/charts/",
	"xl/drawings/",
	"xl/externalLinks/",
	"xl/pivot",
	"xl/threadedComments/",
	"xl/comments",
	"xl/vbaProject.bin",
];

export function readWorkbookDraft(data: Uint8Array): OfficeDraft {
	const files = entries(data);
	const readOnlyReason = Object.keys(files).some(name => UNSAFE_WORKBOOK_PARTS.some(part => name.startsWith(part)))
		? t("settings.officeWorkbookComplex")
		: undefined;
	const workbook = XLSX.read(data, { type: "array", cellFormula: true, cellText: true });
	if (workbook.SheetNames.length === 0) throw new Error("Empty workbook");
	const sheets = workbook.SheetNames.map(name => {
		const sheet = workbook.Sheets[name]!;
		const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
		if (range.e.r > 999) {
			return { name, rows: [], readOnly: true };
		}
		const rows: Array<Array<{ address: string; text: string; editable: boolean }>> = [];
		for (let row = range.s.r; row <= range.e.r; row++) {
			const cells: Array<{ address: string; text: string; editable: boolean }> = [];
			for (let column = range.s.c; column <= range.e.c; column++) {
				const address = XLSX.utils.encode_cell({ r: row, c: column });
				const cell = sheet[address] as XLSX.CellObject | undefined;
				cells.push({
					address,
					text: cell ? String(cell.w ?? cell.v ?? "") : "",
					editable: readOnlyReason === undefined && cell?.f === undefined,
				});
			}
			rows.push(cells);
		}
		return { name, rows, readOnly: false };
	});
	if (sheets.some(sheet => sheet.readOnly)) {
		return {
			kind: "workbook",
			format: "xlsx",
			sheets: sheets.map(sheet => ({ name: sheet.name, rows: sheet.rows })),
			readOnlyReason: t("settings.officeWorkbookLarge"),
		};
	}
	return {
		kind: "workbook",
		format: "xlsx",
		sheets: sheets.map(sheet => ({ name: sheet.name, rows: sheet.rows })),
		...(readOnlyReason ? { readOnlyReason } : {}),
	};
}

function writeWorkbookDraft(data: Uint8Array, draft: Extract<OfficeDraft, { kind: "workbook" }>): Uint8Array {
	if (draft.readOnlyReason) throw new Error(draft.readOnlyReason);
	const workbook = XLSX.read(data, { type: "array", cellFormula: true, cellText: true });
	for (const editedSheet of draft.sheets) {
		const sheet = workbook.Sheets[editedSheet.name];
		if (!sheet) throw new Error("Workbook sheet no longer exists");
		for (const row of editedSheet.rows) {
			for (const edited of row) {
				const cell = sheet[edited.address] as XLSX.CellObject | undefined;
				const original = cell ? String(cell.w ?? cell.v ?? "") : "";
				if (original === edited.text) continue;
				if (!edited.editable || cell?.f !== undefined) throw new Error("This workbook cell is read-only");
				sheet[edited.address] = { t: "s", v: edited.text, w: edited.text };
			}
		}
	}
	return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

export function writeOfficeDraft(data: Uint8Array, draft: OfficeDraft): Uint8Array {
	if (draft.kind === "word") return writeWordDraft(data, draft);
	if (draft.kind === "presentation") return writePresentationDraft(data, draft);
	return writeWorkbookDraft(data, draft);
}
