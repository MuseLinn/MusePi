import type { ClipboardEvent, DragEvent } from "react";
import { useRef, useState } from "react";
import { readAutoResizeImages, readFileAsDataURL, resizeImageDataUrl } from "../../lib/image-resize";
import type { RpcClient } from "../../lib/rpc";

/** One image attachment chip (base64 data URL rides along in session.send). */
export interface ComposerAttachment {
	id: number;
	dataUrl: string;
	mimeType: string;
	name: string;
}

/**
 * Image paste/drop attachments (openchamber parity): read files as data
 * URLs for preview; the base64 payload rides along in session.send.images.
 * Front-resize large images (TUI parity, images.autoResize-governed) so
 * multi-MB screenshots don't ship full-size over the socket.
 */
export function useAttachments(rpc: RpcClient): {
	attachments: ComposerAttachment[];
	setAttachments(
		next: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[]),
	): void;
	addImageFiles(files: File[]): Promise<void>;
	onPaste(e: ClipboardEvent): void;
	onDrop(e: DragEvent): void;
} {
	const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
	const attachId = useRef(0);

	const addImageFiles = async (files: File[]): Promise<void> => {
		const imgs = files.filter(f => f.type.startsWith("image/"));
		if (imgs.length === 0) return;
		const autoResize = await readAutoResizeImages(rpc);
		const entries = await Promise.all(
			imgs.map(async f => {
				const dataUrl = await readFileAsDataURL(f);
				const resized = autoResize ? await resizeImageDataUrl(dataUrl, f.type) : null;
				return {
					id: attachId.current++,
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
