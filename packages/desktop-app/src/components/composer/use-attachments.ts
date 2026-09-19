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
	/** Board-drawn chip (SketchPad): clicking it reopens the canvas for
	 *  editing instead of the plain image lightbox (Codex parity). */
	sketch?: boolean;
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
			// Preserve the board-drawn marker so a restored chip still opens
			// the sketch pad rather than the plain lightbox.
			...(entry.sketch === true ? { sketch: true } : {}),
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

/** Write one batch of non-image files into `cwd` via fs.write(base64) and
 *  return the `[Attachment] <path>` reference lines for the prompt.
 *
 *  ONE implementation for both composers: the session composer has a cwd at
 *  send time, the empty-state composer only gets one after the session it
 *  creates exists — but the channel, the sanitizing rule and the same-name
 *  suffixing must not drift between them. Throws on the first failure so the
 *  caller can abort the send (a message whose attachments never landed just
 *  confuses the agent). */
export async function uploadAttachmentFiles(
	rpc: RpcClient,
	cwd: string | null | undefined,
	files: readonly { file?: File; name: string }[],
): Promise<string[]> {
	const refs: string[] = [];
	const usedPaths = new Set<string>();
	for (const chip of files) {
		if (!chip.file) throw new Error("attachment expired re-add");
		if (!cwd) throw new Error("no workspace for attachments");
		let wsPath = attachmentWorkspacePath(chip.name);
		// Same-name collisions get -2/-3 suffixes instead of silently
		// overwriting an earlier attachment.
		const dot = wsPath.lastIndexOf(".");
		const sep = wsPath.lastIndexOf("/");
		const stem = dot > sep ? wsPath.slice(0, dot) : wsPath;
		const ext = dot > sep ? wsPath.slice(dot) : "";
		let n = 2;
		while (usedPaths.has(wsPath)) {
			wsPath = `${stem}-${n}${ext}`;
			n++;
		}
		usedPaths.add(wsPath);
		const b64 = await readFileAsBase64(chip.file);
		const res = await rpc.request<{ ok?: boolean; error?: string }>("fs.write", {
			cwd,
			path: wsPath,
			content: b64,
			encoding: "base64",
		});
		if (res && res.ok === false) throw new Error(res.error ?? "fs.write failed");
		refs.push(`[Attachment] ${wsPath}`);
	}
	return refs;
}

/** Board/lightbox PNG → File so a finished sketch reuses the normal
 *  image-attachment pipeline (addFiles → data URL chip → send images).
 *
 *  Decoded by hand rather than `fetch(dataUrl)`: fetch on a data: URL is
 *  governed by the renderer CSP's connect-src, which lists ws/wss/http/
 *  https/file but NOT data:. The fetch was therefore blocked, the await
 *  threw, and a finished sketch silently produced no chip ("confirm does
 *  nothing") in both composers. atob is not CSP-governed, so this form
 *  cannot be broken by a policy edit. */
export function dataUrlToFile(dataUrl: string, name: string): File {
	const comma = dataUrl.indexOf(",");
	const header = comma >= 0 ? dataUrl.slice(0, comma) : "";
	const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
	const mimeType = /^data:([^;,]+)/.exec(header)?.[1] ?? "application/octet-stream";
	// base64 payload → bytes; a non-base64 data URL falls back to its raw text.
	const bytes = header.includes(";base64")
		? Uint8Array.from(atob(body), ch => ch.charCodeAt(0))
		: new TextEncoder().encode(decodeURIComponent(body));
	return new File([bytes], name, { type: mimeType });
}

/** Sequence for board-drawn chip names. Board chips are identified by name
 *  across two awaits (addFiles → setAttachments), so the name must be unique
 *  per finish: two sketches saved in the same millisecond would otherwise be
 *  marked together and a re-edit would target the wrong one. */
let sketchSeq = 0;

/** Name for the chip a finished board will produce. */
export function nextSketchFileName(now: number = Date.now()): string {
	return `sketch-${now.toString(36)}-${sketchSeq++}.png`;
}

/**
 * Mark ONE image chip — identified by its exact filename — as board-drawn.
 *
 * The name argument is not a convenience. Matching on the `sketch-` prefix
 * (the original form) marked *every* so-named chip: a re-edit ran against
 * several chips at once and every later sketch re-flagged older ones. Exact
 * name + image kind keeps the call idempotent and single-target.
 */
export function markSketchChip<T extends { kind: "image" | "file"; name: string }>(
	chips: readonly T[],
	fileName: string,
): (T & { sketch?: boolean })[] {
	return chips.map(c => (c.kind !== "file" && c.name === fileName ? { ...c, sketch: true } : c));
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
