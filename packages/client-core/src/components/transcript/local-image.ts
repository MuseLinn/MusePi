/**
 * Which image sources the chat may show.
 *
 * Lives apart from the transcript component because two places ask the same
 * question and must answer it the same way: the prose pass that swaps a
 * filesystem path for a data URL, and a UI block that draws an `Image`. A
 * second copy of this predicate is how a block and prose end up disagreeing
 * about whether a path is safe.
 */

/** Filesystem path behind an image src: strips `file://` and undoes the
 *  renderer's `encodeURI` (marked percent-encodes spaces and every non-ASCII
 *  character, so `/tmp/图 1.png` arrives as `/tmp/%E5%9B%BE%201.png` and names
 *  no real file). Remote/data/blob URLs never reach here. */
export function localImagePath(src: string): string {
	const raw = src.startsWith("file://") ? src.slice("file://".length) : src;
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** `/abs/path.png`, `~/x.png`, `./rel.png`, `../rel.png`, `file://…` — but
 *  never http(s)/data/blob URLs, and never local paths without a known
 *  image extension (`/etc/hosts` stays a plain text path). */
export function isLocalImageSrc(src: string): boolean {
	if (/^(https?:|data:|blob:)/i.test(src)) return false;
	return /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(localImagePath(src));
}
