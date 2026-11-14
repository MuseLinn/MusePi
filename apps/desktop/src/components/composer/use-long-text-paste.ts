/** Large pastes collapse into an editable attachment chip instead of a
 *  chooser dialog. Threshold: >100 lines OR >4000 chars. */
const MAX_GATE_LINES = 100;
const MAX_GATE_CHARS = 4000;

export function isLongPastedText(text: string): boolean {
	if (!text) return false;
	const lineCount = text.split("\n").length;
	return lineCount > MAX_GATE_LINES || text.length > MAX_GATE_CHARS;
}

/** File + display metadata for a collapsed paste chip. */
export function createPasteAttachment(text: string): { file: File; name: string; editText: string } {
	const lineCount = text.split("\n").length;
	const charCount = text.length;
	return {
		file: new File([text], `paste-${Date.now()}.md`, { type: "text/markdown" }),
		name: `粘贴的文本 · ${lineCount} 行 / ${charCount} 字符`,
		editText: text,
	};
}

/** Gate a paste to the collapsed-attachment path (no chooser dialog). */
export function useLongTextPaste(onAttach: (text: string) => void): { requestPaste: (text: string) => void } {
	const requestPaste = (text: string): void => onAttach(text);
	return { requestPaste };
}

import type { RpcClient } from "../../lib/rpc";
import { type ComposerAttachment, uploadOneAttachment } from "./use-attachments";

/** Collapse a large paste into an attachment chip with line/char metadata. */
export function attachPaste({
	text,
	addFiles,
	setAttachments,
}: {
	text: string;
	addFiles(files: File[]): Promise<void>;
	setAttachments(next: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[])): void;
}): void {
	const { file, name, editText } = createPasteAttachment(text);
	void addFiles([file]).then(() => {
		setAttachments(prev => prev.map(a => (a.file === file ? { ...a, paste: true, editText, name } : a)));
	});
}

/** Persist an edited paste: swap the file bytes, keep the chip identity, and
 *  re-stage the upload so the next send uses the edited content. */
export function saveEditedPaste({
	id,
	text,
	attachments,
	setAttachments,
	rpc,
}: {
	id: number;
	text: string;
	attachments: ComposerAttachment[];
	setAttachments(next: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[])): void;
	rpc: RpcClient;
}): void {
	setAttachments(prev =>
		prev.map(a => {
			if (a.id !== id) return a;
			const nextFile = new File([text], a.file?.name ?? `paste-${id}.md`, { type: "text/markdown" });
			return {
				...a,
				file: nextFile,
				editText: text,
				staged: uploadOneAttachment(rpc, nextFile, nextFile.name).catch(() => null),
			};
		}),
	);
}
