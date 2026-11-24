import { t } from "@musepi/client-core";
import type { JSONContent } from "@tiptap/react";
import type { OfficeDraft, OfficeWordRun } from "./office-documents";

type WordDraft = Extract<OfficeDraft, { kind: "word" }>;

const RUN_MARKS = ["bold", "italic", "underline"] as const;

function runMarks(run: OfficeWordRun): { type: string }[] {
	return RUN_MARKS.filter(name => run[name] === true).map(name => ({ type: name }));
}

function marksOf(node: JSONContent): Omit<OfficeWordRun, "text"> {
	const names = new Set((node.marks ?? []).map(mark => mark.type));
	return {
		...(names.has("bold") ? { bold: true } : {}),
		...(names.has("italic") ? { italic: true } : {}),
		...(names.has("underline") ? { underline: true } : {}),
	};
}

/**
 * The working copy as a ProseMirror document: editable paragraphs carry their
 * draft id and inline marks; content the byte-preserving writer refuses to
 * rewrite (images, tables, multi-run paragraphs) becomes a read-only block in
 * document order.
 */
export function wordDraftToTiptap(draft: WordDraft): JSONContent {
	return {
		type: "doc",
		content: draft.paragraphs.map(paragraph => {
			if (!paragraph.editable) {
				return {
					type: "officePreserved",
					attrs: {
						paragraphId: paragraph.id,
						text: paragraph.text,
						label: t("settings.officeWordPreserved"),
					},
				};
			}
			const runs =
				paragraph.runs && paragraph.runs.map(run => run.text).join("") === paragraph.text
					? paragraph.runs
					: paragraph.text === ""
						? []
						: [{ text: paragraph.text }];
			return {
				type: "paragraph",
				attrs: { paragraphId: paragraph.id },
				content: runs
					.filter(run => run.text !== "")
					.map(run => ({
						type: "text",
						text: run.text,
						...(runMarks(run).length > 0 ? { marks: runMarks(run) } : {}),
					})),
			};
		}),
	};
}

function paragraphRuns(node: JSONContent): OfficeWordRun[] {
	const runs: OfficeWordRun[] = [];
	for (const child of node.content ?? []) {
		if (child.type !== "text") throw new Error("Only text can be pasted into a Word paragraph");
		runs.push({ text: child.text ?? "", ...marksOf(child) });
	}
	return runs;
}

/**
 * Project the editor document back onto the draft. Paragraph ids must line up
 * one-for-one with the original draft: the editor allows text and marks, not
 * splitting, merging, deleting, or reordering, so a mismatch means the edit
 * cannot be written back and the save is refused.
 */
export function tiptapToWordDraft(document: JSONContent, original: WordDraft): WordDraft {
	const nodes = document.content ?? [];
	if (nodes.length !== original.paragraphs.length) {
		throw new Error("Word paragraph structure changed");
	}
	const paragraphs = nodes.map((node, index) => {
		const source = original.paragraphs[index]!;
		if ((node.attrs?.paragraphId ?? null) !== source.id) {
			throw new Error("Word paragraph structure changed");
		}
		if (!source.editable) {
			if (node.type !== "officePreserved") throw new Error("Word paragraph structure changed");
			return source;
		}
		if (node.type !== "paragraph") throw new Error("Word paragraph structure changed");
		const runs = paragraphRuns(node);
		return { id: source.id, text: runs.map(run => run.text).join(""), runs, editable: true };
	});
	return { ...original, paragraphs };
}
