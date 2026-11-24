import "./happy-dom-shim";
import { describe, expect, test } from "bun:test";
import { Document, Packer, Paragraph, TextRun, UnderlineType } from "docx";
import { strFromU8, unzipSync } from "fflate";
import { type OfficeDraft, readWordDraft, writeOfficeDraft } from "../src/lib/office-documents";
import { tiptapToWordDraft, wordDraftToTiptap } from "../src/lib/office-richtext";

type WordDraft = Extract<OfficeDraft, { kind: "word" }>;

async function wordDraft(
	runs: Array<{ text: string; bold?: boolean; italic?: boolean; underline?: boolean }>,
): Promise<{
	bytes: Uint8Array;
	draft: WordDraft;
}> {
	const document = new Document({
		sections: [
			{
				children: [
					new Paragraph({
						children: runs.map(
							run =>
								new TextRun({
									text: run.text,
									bold: run.bold,
									italics: run.italic,
									underline: run.underline ? { type: UnderlineType.SINGLE } : undefined,
								}),
						),
					}),
					new Paragraph({ children: [new TextRun("Second")] }),
				],
			},
		],
	});
	const bytes = new Uint8Array(await Packer.toBuffer(document));
	const draft = readWordDraft(bytes);
	if (draft.kind !== "word") throw new Error("wrong draft kind");
	return { bytes, draft };
}

function paragraphXml(bytes: Uint8Array): string {
	return strFromU8(unzipSync(bytes)["word/document.xml"]!);
}

describe("word draft to Tiptap", () => {
	test("keeps paragraph ids and inline marks", async () => {
		const { draft } = await wordDraft([{ text: "Styled", bold: true, italic: true }]);
		const document = wordDraftToTiptap(draft);
		expect(document.content?.map(node => node.type)).toEqual(["paragraph", "paragraph"]);
		expect(document.content?.[0]?.attrs?.paragraphId).toBe(0);
		expect(document.content?.[0]?.content?.[0]).toEqual({
			type: "text",
			text: "Styled",
			marks: [{ type: "bold" }, { type: "italic" }],
		});
	});

	test("renders content the writer refuses to rewrite as a preserved block", async () => {
		const { draft } = await wordDraft([{ text: "One" }]);
		const withPreserved: WordDraft = {
			...draft,
			paragraphs: draft.paragraphs.map(paragraph =>
				paragraph.id === 1 ? { ...paragraph, editable: false, runs: undefined } : paragraph,
			),
		};
		const document = wordDraftToTiptap(withPreserved);
		expect(document.content?.[1]?.type).toBe("officePreserved");
		expect(document.content?.[1]?.attrs).toMatchObject({ paragraphId: 1, text: "Second" });
	});

	test("prefers edited text over a stale run list", async () => {
		const { draft } = await wordDraft([{ text: "Before", bold: true }]);
		const stale: WordDraft = {
			...draft,
			paragraphs: draft.paragraphs.map(paragraph => ({ ...paragraph, text: "After" })),
		};
		expect(wordDraftToTiptap(stale).content?.[0]?.content?.[0]).toEqual({ type: "text", text: "After" });
	});
});

describe("Tiptap to word draft", () => {
	test("projects marks back into runs", async () => {
		const { draft } = await wordDraft([{ text: "Plain" }]);
		const document = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { paragraphId: 0 },
					content: [
						{ type: "text", text: "Bold ", marks: [{ type: "bold" }] },
						{ type: "text", text: "both", marks: [{ type: "bold" }, { type: "underline" }] },
					],
				},
				{ type: "paragraph", attrs: { paragraphId: 1 }, content: [{ type: "text", text: "Second" }] },
			],
		};
		const next = tiptapToWordDraft(document, draft);
		expect(next.paragraphs[0]).toEqual({
			id: 0,
			text: "Bold both",
			runs: [
				{ text: "Bold ", bold: true },
				{ text: "both", bold: true, underline: true },
			],
			editable: true,
		});
	});

	test("refuses a split, merge, or reorder", async () => {
		const { draft } = await wordDraft([{ text: "One" }]);
		expect(() =>
			tiptapToWordDraft({ type: "doc", content: [{ type: "paragraph", attrs: { paragraphId: 0 } }] }, draft),
		).toThrow("structure changed");
		expect(() =>
			tiptapToWordDraft(
				{
					type: "doc",
					content: [
						{ type: "paragraph", attrs: { paragraphId: 1 } },
						{ type: "paragraph", attrs: { paragraphId: 0 } },
					],
				},
				draft,
			),
		).toThrow("structure changed");
	});
});

describe("rich text write path", () => {
	test("writes one run per mark segment and keeps the paragraph properties", async () => {
		const { bytes, draft } = await wordDraft([{ text: "Plain" }]);
		const rich: WordDraft = {
			...draft,
			paragraphs: draft.paragraphs.map(paragraph =>
				paragraph.id === 0
					? {
							...paragraph,
							text: "Bold plain",
							runs: [{ text: "Bold", bold: true, italic: true, underline: true }, { text: " plain" }],
						}
					: paragraph,
			),
		};
		const saved = writeOfficeDraft(bytes, rich);
		const xml = paragraphXml(saved);
		expect(xml).toContain("<w:b/>");
		expect(xml).toContain("<w:i/>");
		expect(xml).toContain('<w:u w:val="single"/>');
		const reread = readWordDraft(saved);
		expect(reread.kind === "word" && reread.paragraphs[0]?.runs).toEqual([
			{ text: "Bold", bold: true, italic: true, underline: true },
			{ text: " plain" },
		]);
		expect(reread.kind === "word" && reread.paragraphs[1]?.text).toBe("Second");
	});

	test("clears a paragraph when every run is removed", async () => {
		const { bytes, draft } = await wordDraft([{ text: "Plain" }]);
		const emptied: WordDraft = {
			...draft,
			paragraphs: draft.paragraphs.map(paragraph =>
				paragraph.id === 0 ? { ...paragraph, text: "", runs: [] } : paragraph,
			),
		};
		const reread = readWordDraft(writeOfficeDraft(bytes, emptied));
		expect(reread.kind === "word" && reread.paragraphs[0]?.text).toBe("");
	});

	test("refuses to rewrite a preserved paragraph whose text changed", async () => {
		const { bytes, draft } = await wordDraft([{ text: "One" }]);
		const tampered: WordDraft = {
			...draft,
			paragraphs: draft.paragraphs.map(paragraph =>
				paragraph.id === 0 ? { ...paragraph, editable: false, text: "Changed", runs: undefined } : paragraph,
			),
		};
		expect(() => writeOfficeDraft(bytes, tampered)).toThrow("read-only");
	});
});
