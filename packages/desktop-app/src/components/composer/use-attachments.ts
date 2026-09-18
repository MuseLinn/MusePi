import type { ClipboardEvent, DragEvent } from "react";
import { useState } from "react";
import { readAutoResizeImages, readFileAsDataURL, resizeImageDataUrl } from "../../lib/image-resize";
import type { RpcClient } from "../../lib/rpc";

/**
 * One attachment chip.
 *
 * Images carry a base64 data URL that rides along in session.send.images
 * (model-visible content parts). Every other file keeps its raw File handle
 * (`file`, memory only) and is written into the session workspace via
 * fs.write(encoding:"base64") at send time — the daemon-side `fs.write` is
 * the only channel that can carry arbitrary bytes, and the agent reads the
 * file from disk afterwards. The handle is deliberately not serialized:
 * a restored draft chip knows its metadata but the bytes are gone, so a
 * send with such a chip fails with a re-attach hint instead of silently
 * sending nothing.
 */
export interface ComposerAttachment {
	id: number;
	kind: "image" | "file";
	/** Image preview data URL; empty for file chips. */
	dataUrl: string;
	mimeType: string;
	name: string;
	size: number;
	/** Raw bytes for file chips (not persisted with the draft). */
	file?: File;
	/** Send-time upload in flight → progress ring overlay. */
	uploading?: boolean;
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
		const kind = entry.kind === "file" ? "file" : "image";
		// A file chip without its raw handle cannot be uploaded anymore —
		// keep it visible (the user attached it for a reason) but mark it
		// so the send path can refuse it with a re-attach hint.
		out.push({
			id: attachSeq++,
			kind,
			dataUrl: kind === "image" ? entry.dataUrl : "",
			mimeType: entry.mimeType,
			name: typeof entry.name === "string" ? entry.name : kind === "file" ? "file" : "image",
			size: typeof entry.size === "number" ? entry.size : 0,
		});
	}
	return out;
}

/** Read a File as bare base64 (no data-URL prefix) for the fs.write
 *  upload path — FileReader.readAsDataURL + prefix strip, no manual
 *  byte-loop (btoa would choke on multi-MB binaries). */
export function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? "").split(",")[1] ?? "");
		reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
		reader.readAsDataURL(file);
	});
}

/** Sanitize a client-supplied filename into a safe workspace-relative
 *  attachment path: the name may carry directories (some drops include
 *  webkitRelativePath-style separators) or traversal segments. */
export function attachmentWorkspacePath(name: string): string {
	const base = name.replace(/\\/g, "/").split("/").pop() ?? "file";
	const safe = base
		.replace(/\.\.+/g, "_")
		.replace(/[^\w.\-()\u4e00-\u9fa5 ]+/g, "_")
		.trim();
	return `attachments/${safe.length > 0 ? safe : "file"}`;
}

/**
 * Attachment intake (openchamber parity, generalized): paste/drop/pick any
 * file. Images become data-URL chips (front-resized, images.autoResize-
 * governed); other files become file chips whose bytes ride in the state
 * until send. The chips are the attachment half of the per-session draft:
 * use-draft-persistence stashes the payload under its own key, and a
 * session switch must bring the images back with the text.
 */
export function useAttachments(rpc: RpcClient): {
	attachments: ComposerAttachment[];
	setAttachments(next: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[])): void;
	addFiles(files: File[]): Promise<void>;
	onPaste(e: ClipboardEvent): void;
	onDragOver(e: DragEvent): void;
	onDrop(e: DragEvent): void;
} {
	const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);

	const addFiles = async (files: File[]): Promise<void> => {
		if (files.length === 0) return;
		const imgs = files.filter(f => f.type.startsWith("image/"));
		const others = files.filter(f => !f.type.startsWith("image/"));
		const autoResize = imgs.length > 0 ? await readAutoResizeImages(rpc) : false;
		const entries = await Promise.all([
			...imgs.map(async f => {
				const dataUrl = await readFileAsDataURL(f);
				const resized = autoResize ? await resizeImageDataUrl(dataUrl, f.type) : null;
				return {
					id: attachSeq++,
					kind: "image" as const,
					dataUrl: resized?.dataUrl ?? dataUrl,
					mimeType: resized?.mimeType ?? f.type,
					name: f.name,
					size: f.size,
				};
			}),
			...others.map(f => ({
				id: attachSeq++,
				kind: "file" as const,
				dataUrl: "",
				mimeType: f.type || "application/octet-stream",
				name: f.name,
				size: f.size,
				file: f,
			})),
		]);
		setAttachments(prev => [...prev, ...entries]);
	};

	const onPaste = (e: ClipboardEvent): void => {
		// Any pasted file (image or not) becomes a chip; plain text is left
		// to the textarea / long-paste gate.
		const files = [...e.clipboardData.items]
			.filter(i => i.kind === "file")
			.map(i => i.getAsFile())
			.filter((f): f is File => f !== null);
		if (files.length > 0) {
			e.preventDefault();
			void addFiles(files);
		}
	};

	const onDragOver = (e: DragEvent): void => {
		// Allow the drop: without a preventDefault on dragover the browser
		// never fires drop on the textarea (files dragged from the OS would
		// navigate the window instead of attaching).
		if (e.dataTransfer.types.includes("Files")) e.preventDefault();
	};

	const onDrop = (e: DragEvent): void => {
		const files = [...e.dataTransfer.files];
		// Full-type parity: a non-image drop used to be ignored (and the
		// browser default — opening the file — was never suppressed).
		if (files.length > 0) {
			e.preventDefault();
			void addFiles(files);
		}
	};

	return { attachments, setAttachments, addFiles, onPaste, onDragOver, onDrop };
}
