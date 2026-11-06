/**
 * Video normalization at the session boundary.
 *
 * A `video` block is reference-first (`url`), because base64 clips are not
 * viable in a transcript. Providers that take video need the bytes inline when
 * the reference is a local `file://` path — Gemini fetches `fileData.fileUri`
 * only for its own hosted URIs, never an arbitrary local path (and there is no
 * upload service here yet). So when the selected model declares video input, a
 * local clip is read once into `data`; an unreadable or oversized file keeps
 * its URL and the provider layer decides what to do with it.
 */
import type { Model, VideoContent } from "@musepi/pi-ai";

/** Inline base64 above this size is refused: the request would be unusable. */
export const MAX_INLINE_VIDEO_BYTES = 20 * 1024 * 1024;

/** Local filesystem path behind a `file://` URL, or null for other sources. */
export function fileUrlPath(url: string | undefined): string | null {
	if (!url?.startsWith("file://")) return null;
	const raw = url.slice("file://".length);
	if (!raw) return null;
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

export async function normalizeModelContextVideos(
	videos: VideoContent[] | undefined,
	options?: { model?: Model },
): Promise<VideoContent[] | undefined> {
	if (!videos || videos.length === 0) return undefined;
	if (!options?.model?.input.includes("video")) return videos;
	const normalized: VideoContent[] = [];
	for (const video of videos) {
		const path = video.data ? null : fileUrlPath(video.url);
		if (path) {
			try {
				const file = Bun.file(path);
				const size = file.size;
				if (size > 0 && size <= MAX_INLINE_VIDEO_BYTES) {
					normalized.push({ ...video, data: Buffer.from(await file.arrayBuffer()).toString("base64") });
					continue;
				}
			} catch {
				// Unreadable local file: keep the reference, never drop the block.
			}
		}
		normalized.push(video);
	}
	return normalized;
}
