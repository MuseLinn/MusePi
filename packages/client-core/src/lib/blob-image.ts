/**
 * Blob-ref images in the transcript.
 *
 * Session persistence externalizes every image payload over
 * `BLOB_EXTERNALIZE_THRESHOLD` to a content-addressed store and keeps only
 * `blob:sha256:<hash>` in the entry (`session-persistence.ts`). The bytes still
 * exist, but a `data:<mime>;base64,` prefix cannot carry a reference — that
 * URL is invalid and the `<img>` fails. The renderer therefore has to fetch the
 * blob back through the host's `attachment.get` capability.
 *
 * Resolution is display-only: the daemon keeps the reference in the transcript
 * and the model context, so a long session stays small on disk and in transit.
 * A resolved page is cached by hash (bounded), which is what makes a restored
 * session paint its images without re-reading the same blob per remount.
 */
import type { AttachmentGetResult } from "@musepi/pi-wire";
import { useEffect, useState } from "react";
import type { ToolRenderHost } from "../tool-render/types";

const BLOB_REF_RE = /^blob:sha256:([a-f0-9]{64})$/;
/** One `attachment.get` page stays under the daemon's 8 MiB cap. */
const PAGE_BYTES = 8 * 1024 * 1024;
/** Ceiling on one resolved image: past it the card keeps the alt text rather
 *  than allocating the bytes twice (base64 + decoded). */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const CACHE_MAX = 64;
const cache = new Map<string, string>();

type AttachmentRead = NonNullable<NonNullable<ToolRenderHost["attachment"]>["read"]>;

/** The blob hash a `blob:sha256:` src names, or null for any other src. */
export function blobImageHash(src: string): string | null {
	const match = BLOB_REF_RE.exec(src.trim());
	return match?.[1] ?? null;
}

/** A cached data URL for this ref, or undefined when it has not been resolved. */
export function cachedBlobImage(src: string): string | undefined {
	const hash = blobImageHash(src);
	return hash === null ? undefined : cache.get(hash);
}

/** Concatenate base64 pages decoded byte-wise — page boundaries are not
 *  guaranteed to land on 3-byte groups, so the strings cannot just be joined. */
function decodePages(pages: readonly string[], totalBytes: number): Uint8Array | null {
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const page of pages) {
		if (!page) continue;
		let raw: string;
		try {
			raw = atob(page);
		} catch {
			return null;
		}
		if (offset + raw.length > totalBytes) return null;
		for (let i = 0; i < raw.length; i++) bytes[offset + i] = raw.charCodeAt(i);
		offset += raw.length;
	}
	return offset === totalBytes ? bytes : bytes.subarray(0, offset);
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function decodedBase64Length(value: string): number {
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return (value.length / 4) * 3 - padding;
}

/**
 * Resolve a `blob:sha256:` image src to a data URL through the host attachment
 * capability. Returns the original src unchanged for anything that is not a
 * blob ref, when the host cannot read blobs, or when the blob is gone — the
 * card then shows its alt text instead of fabricating an image.
 */
export async function resolveBlobImageSrc(
	src: string,
	mimeType: string | undefined,
	read: AttachmentRead | undefined,
): Promise<string> {
	const hash = blobImageHash(src);
	if (hash === null || !read) return src;
	const cached = cache.get(hash);
	if (cached !== undefined) return cached;
	try {
		const pages: string[] = [];
		let total = 0;
		let offset = 0;
		for (;;) {
			const page = await read(hash, offset, PAGE_BYTES);
			if ("error" in page) return src;
			const result: AttachmentGetResult = page;
			if (total === 0) {
				total = result.size;
				if (total <= 0 || total > MAX_IMAGE_BYTES) return src;
			}
			if (!result.content) break;
			pages.push(result.content);
			offset += decodedBase64Length(result.content);
			if (offset >= total) break;
		}
		const bytes = decodePages(pages, total);
		if (!bytes || bytes.length === 0) return src;
		const resolved = `data:${mimeType ?? "application/octet-stream"};base64,${toBase64(bytes)}`;
		cache.set(hash, resolved);
		if (cache.size > CACHE_MAX) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		return resolved;
	} catch {
		return src;
	}
}

export interface BlobImageItem {
	src: string;
	alt: string;
	mimeType?: string;
}

/**
 * Resolve every blob-ref src in an image list. Non-ref srcs pass through
 * untouched, and a list without refs returns the same array (no re-render
 * churn). Cached refs are substituted synchronously on the first render.
 */
export function useResolvedImageItems<T extends BlobImageItem>(
	items: readonly T[],
	host?: ToolRenderHost,
): readonly T[] {
	const read = host?.attachment?.read;
	const key = items.map(item => item.src).join("\u0000");
	const [resolved, setResolved] = useState<Record<string, string>>(() => {
		const seed: Record<string, string> = {};
		for (const item of items) {
			const cached = cachedBlobImage(item.src);
			if (cached !== undefined) seed[item.src] = cached;
		}
		return seed;
	});

	useEffect(() => {
		if (!read) return;
		let alive = true;
		const pending = items.filter(item => blobImageHash(item.src) !== null && !cache.has(blobImageHash(item.src)!));
		if (pending.length === 0) return;
		void Promise.all(
			pending.map(async item => [item.src, await resolveBlobImageSrc(item.src, item.mimeType, read)] as const),
		).then(pairs => {
			if (!alive) return;
			const next = Object.fromEntries(pairs.filter(([, value]) => value !== undefined));
			setResolved(current => ({ ...current, ...next }));
		});
		return () => {
			alive = false;
		};
	}, [key, read, items]);

	if (items.every(item => blobImageHash(item.src) === null)) return items;
	return items.map(item => {
		const value = resolved[item.src] ?? cachedBlobImage(item.src);
		return value !== undefined ? { ...item, src: value } : item;
	});
}
