import type { ClipboardEvent, DragEvent } from "react";
import { useState } from "react";
import { readAutoResizeImages, readFileAsDataURL, resizeImageDataUrl } from "../../lib/image-resize";
import type { RpcClient } from "../../lib/rpc";

/** One image attachment chip (base64 data URL rides along in session.send). */
export interface ComposerAttachment {
	id: number;
	dataUrl: string;
	mimeType: string;
	name: string;
}

/** One module sequence for chip ids: a restored draft re-seeds chips into a
 *  possibly non-empty composer, and two live chips must never share an id
 *  (React key + remove-by-id). Per-instance counters collide there. */
let attachSeq = 0;

/** Chips from a stashed payload; malformed entries are dropped rather than
 *  rendered (a stored value can outlive a shape change). */
export function parseAttachmentDraft(raw: string | null): ComposerAttachment[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: ComposerAttachment[] = [];
	for (const entry of parsed as Partial<ComposerAttachment>[]) {
		if (typeof entry?.dataUrl !== "string" || typeof entry.mimeType !== "string") continue;
		out.push({
			id: attachSeq++,
			dataUrl: entry.dataUrl,
			mimeType: entry.mimeType,
			name: typeof entry.name === "string" ? entry.name : "image",
		});
	}
	return out;
}

/**
 * Image paste/drop attachments (openchamber parity): read files as data
 * URLs for preview; the base64 payload rides along in session.send.images.
 * Front-resize large images (TUI parity, images.autoResize-governed) so
 * multi-MB screenshots don't ship full-size over the socket.
 *
 * The chips are the image half of the per-session draft: use-draft-persistence
 * stashes the payload under its own key, and a session switch must bring the
 * images back with the text.
 */
export function useAttachments(rpc: RpcClient): {
	attachments: ComposerAttachment[];
	setAttachments(next: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[])): void;
	addImageFiles(files: File[]): Promise<void>;
	onPaste(e: ClipboardEvent): void;
	onDrop(e: DragEvent): void;
} {
	const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);

	const addImageFiles = async (files: File[]): Promise<void> => {
		const imgs = files.filter(f => f.type.startsWith("image/"));
		if (imgs.length === 0) return;
		const autoResize = await readAutoResizeImages(rpc);
		const entries = await Promise.all(
			imgs.map(async f => {
				const dataUrl = await readFileAsDataURL(f);
				const resized = autoResize ? await resizeImageDataUrl(dataUrl, f.type) : null;
				return {
					id: attachSeq++,
					dataUrl: resized?.dataUrl ?? dataUrl,
					mimeType: resized?.mimeType ?? f.type,
					name: f.name,
				};
			}),
		);
		setAttachments(prev => [...prev, ...entries]);
	};

	const onPaste = (e: ClipboardEvent): void => {
		const files = [...e.clipboardData.items]
			.filter(i => i.type.startsWith("image/"))
			.map(i => i.getAsFile())
			.filter((f): f is File => f !== null);
		if (files.length > 0) {
			e.preventDefault();
			void addImageFiles(files);
		}
	};

	const onDrop = (e: DragEvent): void => {
		const files = [...e.dataTransfer.files];
		if (files.some(f => f.type.startsWith("image/"))) {
			e.preventDefault();
			void addImageFiles(files);
		}
	};

	return { attachments, setAttachments, addImageFiles, onPaste, onDrop };
}
