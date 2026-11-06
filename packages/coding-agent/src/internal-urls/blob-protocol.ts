/**
 * Protocol handler for blob:// URLs.
 *
 * Resolves content-addressed blobs from the agent blob store. The hash is the
 * SHA-256 digest of the stored bytes, so a blob URL always names immutable
 * content; there is no write path.
 *
 * URL form:
 * - blob://<sha256-hex> - Blob content as UTF-8 text
 */
import * as path from "node:path";
import { getBlobsDir, isEnoent, isProbablyBinary } from "@musepi/pi-utils";
import { BLOB_HASH_RE } from "../session/blob-store";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

const MAX_INLINE_BLOB_BYTES = 8 * 1024 * 1024;

/**
 * Reject every hash that is not canonical before it reaches `path.join`: the
 * blob directory is shared with all other session data, so an unvalidated
 * suffix such as `../sessions/x` would escape the store.
 */
function parseBlobHash(url: InternalUrl): string {
	const hash = url.rawHost || url.hostname;
	if (!BLOB_HASH_RE.test(hash)) {
		throw new Error(`blob:// requires a 64-character lowercase hexadecimal SHA-256 hash, got: ${hash || "(empty)"}`);
	}
	return hash;
}

export class BlobProtocolHandler implements ProtocolHandler {
	readonly scheme = "blob";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const hash = parseBlobHash(url);
		const blobPath = path.join(getBlobsDir(), hash);

		let size: number;
		try {
			size = (await Bun.file(blobPath).stat()).size;
		} catch (err) {
			if (isEnoent(err)) throw new Error(`Blob not found: blob://${hash}`);
			throw err;
		}

		// Path-only callers (search/grep, bash URL expansion) only need the
		// backing file, so they must not pay for bytes of any size.
		if (context?.pathOnly) {
			return {
				url: url.href,
				content: "",
				contentType: "text/plain",
				size,
				sourcePath: blobPath,
			};
		}

		if (size > MAX_INLINE_BLOB_BYTES) {
			throw new Error(
				`Blob ${hash} is ${size} bytes; full internal resolution is blocked. Use read with offset/limit against ${blobPath}, or the blob file path directly in search/copy workflows.`,
			);
		}

		// Blobs hold arbitrary binary payloads (images, PDFs). Decoding one as
		// text yields NUL bytes and U+FFFD mojibake, so refuse before reading and
		// point the caller at the channel that can carry binary content.
		if (await isProbablyBinary(blobPath)) {
			throw new Error(
				`Blob ${hash} is binary data (${size} bytes), not UTF-8 text. Use the media/attachment channel instead of blob:// text resolution: ${blobPath}`,
			);
		}

		return {
			url: url.href,
			content: await Bun.file(blobPath).text(),
			contentType: "text/plain",
			size,
			sourcePath: blobPath,
		};
	}

	/**
	 * No candidates: blobs are addressed by hash, and enumerating every hash in
	 * the store costs a full directory scan for names the user cannot type
	 * meaningfully.
	 */
	async complete(): Promise<UrlCompletion[]> {
		return [];
	}
}
