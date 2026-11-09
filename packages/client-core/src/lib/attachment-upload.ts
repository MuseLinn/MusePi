/**
 * Non-image attachment upload for the guest composer (mobile + browser).
 *
 * The daemon owns the bytes: `attachment.put` takes one padded-base64 body,
 * and `attachment.begin/chunk/commit` streams a larger file in fixed 3 MiB
 * chunk slots. A remote client cannot use `attachment.putFile` — the path
 * lives on the phone, not on the daemon host — so every file travels over the
 * RPC channel:
 *
 * - ≤ 8 MiB raw: one `attachment.put` frame. The daemon's frame limit is
 *   16 MiB; base64 inflates 4/3, so 8 MiB arrives around 10.7 MiB with room
 *   for the JSON envelope.
 * - Larger: `attachment.begin` → one `attachment.chunk` per `chunkSize` slice
 *   → `attachment.commit`. Chunk offsets are `index * chunkSize` daemon-side,
 *   and every chunk but the last must fill that slot exactly, so slicing must
 *   follow the server's returned size rather than a local constant.
 *
 * Both paths end in the same content-addressed `blob://<hash>` URL, which the
 * prompt references as `[Attachment] blob://<hash> (name)`.
 */
import type { AttachmentPutResult } from "@musepi/pi-wire";

/** Raw-byte ceiling for the single-frame `attachment.put` path. */
export const ATTACHMENT_INLINE_MAX_BYTES = 8 * 1024 * 1024;

/** Fallback when a daemon answers `begin` without a usable chunk size. */
const DEFAULT_CHUNK_BYTES = 3 * 1024 * 1024;

/**
 * Per-request deadline. A phone's link can go silent mid-upload (Wi-Fi
 * handoff, Doze); without a deadline the chip stays "uploading" forever and
 * send stays disabled. Every chunk gets the same generous cap, so a slow but
 * live link is never cut off — only a link that stopped answering is.
 */
const UPLOAD_RPC_TIMEOUT_MS = 120_000;

/** `btoa` argument chunk: large enough to be fast, small enough to stay under
 *  engines' spread-argument limits. */
const BASE64_STRING_CHUNK = 0x8000;

/** The only client surface the uploader needs — `SessionClient` satisfies it. */
export interface AttachmentRpc {
	rpc<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
}

interface BeginResult {
	uploadId: string;
	chunkSize?: number;
}

interface ChunkResult {
	received?: number;
	chunks?: number;
}

interface SoftError {
	error: string;
}

function softError(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return null;
	const error = (value as { error?: unknown }).error;
	return typeof error === "string" ? error : null;
}

/** Standard padded base64 of raw bytes. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += BASE64_STRING_CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_STRING_CHUNK));
	}
	return btoa(binary);
}

/** Base64 body for `attachment.put` / `attachment.chunk` (no data-URL prefix). */
export async function readBlobBase64(blob: Blob): Promise<string> {
	return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** Prompt line the agent resolves through the daemon's blob protocol. */
export function attachmentReferenceLine(url: string, name: string): string {
	return `[Attachment] ${url} (${name})`;
}

/** Prepends attachment reference lines in chip order to the prompt text. */
export function composePromptWithAttachments(text: string, lines: readonly string[]): string {
	return lines.length > 0 ? `${lines.join("\n")}\n\n${text}`.trim() : text;
}

/**
 * Uploads one non-image file and returns its blob reference.
 *
 * Throws on any failure, including a daemon soft error (`{ error }`), so the
 * caller can surface it instead of sending a prompt whose attachment never
 * landed. A failed chunked upload aborts its server-side session first.
 */
export async function uploadAttachment(rpc: AttachmentRpc, file: File): Promise<AttachmentPutResult> {
	const name = file.name || "attachment";
	const mimeType = file.type || "application/octet-stream";
	if (file.size <= ATTACHMENT_INLINE_MAX_BYTES) {
		const content = await readBlobBase64(file);
		const result = await rpc.rpc<AttachmentPutResult | SoftError>(
			"attachment.put",
			{ name, mimeType, content },
			{ timeoutMs: UPLOAD_RPC_TIMEOUT_MS },
		);
		return expectUploadResult(result);
	}
	return uploadAttachmentInChunks(rpc, file, name, mimeType);
}

async function uploadAttachmentInChunks(
	rpc: AttachmentRpc,
	file: File,
	name: string,
	mimeType: string,
): Promise<AttachmentPutResult> {
	const begun = await rpc.rpc<BeginResult | SoftError>(
		"attachment.begin",
		{ name, mimeType, size: file.size },
		{ timeoutMs: UPLOAD_RPC_TIMEOUT_MS },
	);
	const beginError = softError(begun);
	if (beginError) throw new Error(beginError);
	const { uploadId, chunkSize: declaredChunkSize } = begun as BeginResult;
	const chunkSize =
		typeof declaredChunkSize === "number" && declaredChunkSize > 0 ? declaredChunkSize : DEFAULT_CHUNK_BYTES;
	try {
		for (let index = 0; index * chunkSize < file.size; index++) {
			const start = index * chunkSize;
			const content = await readBlobBase64(file.slice(start, Math.min(start + chunkSize, file.size)));
			const chunk = await rpc.rpc<ChunkResult | SoftError>(
				"attachment.chunk",
				{ uploadId, index, content },
				{ timeoutMs: UPLOAD_RPC_TIMEOUT_MS },
			);
			const chunkError = softError(chunk);
			if (chunkError) throw new Error(chunkError);
		}
		const committed = await rpc.rpc<AttachmentPutResult | SoftError>(
			"attachment.commit",
			{ uploadId },
			{ timeoutMs: UPLOAD_RPC_TIMEOUT_MS },
		);
		return expectUploadResult(committed);
	} catch (error) {
		// Best-effort cleanup: the daemon also expires uncommitted uploads.
		void rpc.rpc("attachment.abort", { uploadId }).catch(() => {});
		throw error;
	}
}

function expectUploadResult(value: AttachmentPutResult | SoftError): AttachmentPutResult {
	const error = softError(value);
	if (error) throw new Error(error);
	const result = value as AttachmentPutResult;
	if (!result || typeof result.url !== "string" || result.url.length === 0) {
		throw new Error("attachment upload returned no reference");
	}
	return result;
}
