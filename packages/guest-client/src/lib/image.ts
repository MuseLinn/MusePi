/**
 * Image attachment pipeline for the mobile composer.
 *
 * The collab `prompt` frame already carries `images?: ImageContent[]` and the
 * host consumes it (`#handlePrompt`), so this is a pure client-side step:
 * pick → (optionally) re-encode → base64. Budget mirrors the design spec and
 * common multimodal context limits:
 *
 * - Under 1.5MB **and** within the 1568px long-edge cap → the original bytes
 *   are sent untouched (no recompression artifacts, no EXIF strip surprises).
 * - Otherwise → decoded via `createImageBitmap`, long edge clamped to 1568px,
 *   re-encoded as JPEG @ 80% quality (the JPEG source for photographic
 *   content; screenshots of text keep acceptable legibility at that ratio).
 */

import type { ImageContent } from "@musepi/pi-wire";

const MAX_EDGE_PX = 1568;
const JPEG_QUALITY = 0.8;
const PASSTHROUGH_BYTES = 1.5 * 1024 * 1024;

export interface PendingAttachment {
	/** Stable per-pick id for React keys. */
	id: string;
	/** Wire payload: base64 (no data-url prefix). */
	data: string;
	mimeType: string;
	/** Object URL for the thumbnail — revoke on remove/send/unmount. */
	previewUrl: string;
	/** Original file name (shown in aria labels only; not on the wire). */
	name: string;
}

let seq = 0;

function readAsDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error ?? new Error("read failed"));
		reader.readAsDataURL(blob);
	});
}

async function blobToAttachment(blob: Blob, name: string, mimeType: string): Promise<PendingAttachment> {
	const dataUrl = await readAsDataUrl(blob);
	return {
		id: `att-${Date.now()}-${seq++}`,
		data: dataUrl.slice(dataUrl.indexOf(",") + 1),
		mimeType,
		previewUrl: URL.createObjectURL(blob),
		name,
	};
}

/** Picks + encodes one image file into a wire-ready pending attachment. */
export async function processImageFile(file: File): Promise<PendingAttachment> {
	// Fast path: small enough AND no oversized edge → original bytes verbatim.
	if (file.size <= PASSTHROUGH_BYTES) {
		try {
			const bmp = await createImageBitmap(file);
			const withinCap = Math.max(bmp.width, bmp.height) <= MAX_EDGE_PX;
			bmp.close();
			if (withinCap) return blobToAttachment(file, file.name, file.type || "image/jpeg");
		} catch {
			// Decoder unavailable (old WebView) — passthrough is still the best
			// we can do; the host model sees whatever the browser would have
			// uploaded anyway.
			return blobToAttachment(file, file.name, file.type || "image/jpeg");
		}
	}

	// Re-encode path.
	const bmp = await createImageBitmap(file);
	try {
		const scale = Math.min(1, MAX_EDGE_PX / Math.max(bmp.width, bmp.height));
		const w = Math.max(1, Math.round(bmp.width * scale));
		const h = Math.max(1, Math.round(bmp.height * scale));
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("canvas unavailable");
		ctx.drawImage(bmp, 0, 0, w, h);
		const blob: Blob | null = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
		if (!blob) throw new Error("encode failed");
		return await blobToAttachment(blob, `${file.name.replace(/\.[^.]+$/, "")}.jpg`, "image/jpeg");
	} finally {
		bmp.close();
	}
}

/** Extracts the wire payload from pending attachments. */
export function toImageContent(pending: readonly PendingAttachment[]): ImageContent[] {
	return pending.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
}

/** Revokes every preview object URL (call on send/clear/unmount). */
export function revokePreviews(pending: readonly PendingAttachment[]): void {
	for (const p of pending) URL.revokeObjectURL(p.previewUrl);
}
