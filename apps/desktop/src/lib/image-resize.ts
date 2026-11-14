import type { RpcClient } from "./rpc";

/**
 * Browser-side front resize for attached images (TUI parity).
 *
 * The TUI pre-resizes images before they reach the daemon
 * (coding-agent file-processor.ts, governed by `images.autoResize`);
 * the GUI now applies the same front-end resize so large screenshots
 * don't ship full-size base64 over the socket. The daemon's own
 * normalize pass (normalizeModelContextImages) stays idempotent on top.
 */

/** daemon image-resize.ts DEFAULT_OPTIONS parity: Anthropic's internal
 * recommended longest edge before vision processing. */
const MAX_EDGE = 1568;
/** daemon DEFAULT_MIN_DIMENSION parity: tiny inputs are upscaled. */
const MIN_EDGE = 200;
/** daemon DEFAULT_MAX_BYTES parity: encoded output budget. */
const MAX_BYTES = 500 * 1024;
/** daemon DEFAULT_OPTIONS.jpegQuality parity (0.8) for the first pass. */
const JPEG_QUALITY = 0.8;
/** daemon image-resize.ts qualitySteps parity ([70,60,50,40]). */
const QUALITY_STEPS = [0.7, 0.6, 0.5, 0.4];
/** daemon image-resize.ts scaleSteps parity. */
const SCALE_STEPS = [1, 0.75, 0.5, 0.35, 0.25];
/** daemon early-return budget: within bounds AND ≤ maxBytes/4 keeps the
 * original payload untouched (resizeImage.ts comfortableSize). */
const COMFORTABLE_BYTES = MAX_BYTES / 4;

/** Decoded byte length of a data URL (base64 ≈ len × 3/4). */
const dataUrlByteLength = (d: string): number => {
	const comma = d.indexOf(",");
	return comma === -1 ? 0 : Math.floor(((d.length - comma - 1) * 3) / 4);
};

/**
 * Decode a data URL to a Blob without fetch(). fetch(dataUrl) is blocked by
 * the app CSP (connect-src has no data:) and adds a full network-stack
 * round-trip; base64 decode is direct and CSP-immune.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
	const comma = dataUrl.indexOf(",");
	if (comma === -1) throw new Error("Not a data URL");
	const mime = dataUrl.slice(5, comma).split(";")[0] || "application/octet-stream";
	const bin = atob(dataUrl.slice(comma + 1));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: mime });
}

/**
 * Resolve `images.autoResize` from the daemon (defaults true, matching
 * the schema default). A settings.get failure keeps the default — the
 * daemon's own normalize pass would still cap sizes on arrival.
 */
export async function readAutoResizeImages(rpc: RpcClient): Promise<boolean> {
	try {
		const res = await rpc.request<Record<string, unknown>>("settings.get", { keys: ["images.autoResize"] });
		return res?.["images.autoResize"] !== false;
	} catch {
		return true;
	}
}

export function readFileAsDataURL(file: File): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
	reader.onerror = () => reject(reader.error);
	reader.readAsDataURL(file);
	return promise;
}

interface Encoded {
	dataUrl: string;
	mimeType: string;
	bytes: number;
}

/**
 * Scale a data-URL image to the daemon resizeImage DEFAULT_OPTIONS
 * bounds AND byte budget, mirroring its full encode chain:
 *
 *  1. long edge ≤ 1568px, short edge ≥ 200px (upscaled),
 *  2. first pass at target size: PNG + JPEG(q0.8) + WebP(q0.8), pick
 *     the smallest (daemon encodeSmallest),
 *  3. if > 500KB: lossy quality ladder 0.7 → 0.4,
 *  4. if still > 500KB: dimension ladder ×0.75 → ×0.25 (≥100px) with
 *     the same quality ladder,
 *  5. decode failure → null (caller keeps the original payload, daemon
 *     decodeFailed parity).
 *
 * Returns null also when the image is already within bounds AND
 * ≤ maxBytes/4 — the daemon early-return keeps those untouched.
 */
export async function resizeImageDataUrl(
	dataUrl: string,
	mimeType: string,
): Promise<{ dataUrl: string; mimeType: string } | null> {
	let bitmap: ImageBitmap | null = null;
	try {
		const blob = dataUrlToBlob(dataUrl);
		bitmap = await createImageBitmap(blob);
		const { width, height } = bitmap;
		const originalBytes = dataUrlByteLength(dataUrl);
		// daemon early-return parity: within bounds AND comfortably small.
		if (
			width >= MIN_EDGE &&
			height >= MIN_EDGE &&
			width <= MAX_EDGE &&
			height <= MAX_EDGE &&
			originalBytes <= COMFORTABLE_BYTES
		) {
			return null;
		}
		let targetWidth = width;
		let targetHeight = height;
		if (targetWidth > MAX_EDGE) {
			targetHeight = Math.round((targetHeight * MAX_EDGE) / targetWidth);
			targetWidth = MAX_EDGE;
		}
		if (targetHeight > MAX_EDGE) {
			targetWidth = Math.round((targetWidth * MAX_EDGE) / targetHeight);
			targetHeight = MAX_EDGE;
		}
		if (targetWidth < MIN_EDGE || targetHeight < MIN_EDGE) {
			const upscale = Math.min(
				MIN_EDGE / Math.min(targetWidth, targetHeight),
				MAX_EDGE / targetWidth,
				MAX_EDGE / targetHeight,
			);
			if (upscale > 1) {
				targetWidth = Math.round(targetWidth * upscale);
				targetHeight = Math.round(targetHeight * upscale);
			}
			targetWidth = Math.min(MAX_EDGE, Math.max(MIN_EDGE, targetWidth));
			targetHeight = Math.min(MAX_EDGE, Math.max(MIN_EDGE, targetHeight));
		}

		// Encoding host: target-size canvas is drawn once; scale steps
		// re-rasterize at the stepped size.
		const canvas = document.createElement("canvas");
		canvas.width = targetWidth;
		canvas.height = targetHeight;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		const bmp = bitmap;
		if (!bmp) return null;
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(bmp, 0, 0, targetWidth, targetHeight);

		const pickSmallest = (candidates: Encoded[]): Encoded => {
			candidates.sort((a, b) => a.bytes - b.bytes);
			return candidates[0]!;
		};
		// One encoding round at (w,h): PNG + JPEG + WebP when includePng
		// (encodeSmallest parity), else JPEG + WebP (encodeLossy parity).
		const encode = (w: number, h: number, quality: number, includePng: boolean): Encoded => {
			const host =
				w === targetWidth && h === targetHeight
					? canvas
					: (() => {
							const step = document.createElement("canvas");
							step.width = w;
							step.height = h;
							const sctx = step.getContext("2d");
							if (!sctx) return null;
							sctx.imageSmoothingEnabled = true;
							sctx.imageSmoothingQuality = "high";
							sctx.drawImage(bmp, 0, 0, w, h);
							return step;
						})();
			if (!host) return { dataUrl, mimeType, bytes: originalBytes };
			const candidates: Encoded[] = [];
			if (includePng) {
				const png = host.toDataURL("image/png");
				candidates.push({ dataUrl: png, mimeType: "image/png", bytes: dataUrlByteLength(png) });
			}
			const jpeg = host.toDataURL("image/jpeg", quality);
			candidates.push({ dataUrl: jpeg, mimeType: "image/jpeg", bytes: dataUrlByteLength(jpeg) });
			const webp = host.toDataURL("image/webp", quality);
			candidates.push({ dataUrl: webp, mimeType: "image/webp", bytes: dataUrlByteLength(webp) });
			return pickSmallest(candidates);
		};

		// First attempt: target size at JPEG_QUALITY (0.8), PNG included.
		let best = encode(targetWidth, targetHeight, JPEG_QUALITY, true);
		if (best.bytes <= MAX_BYTES) return { dataUrl: best.dataUrl, mimeType: best.mimeType };

		// Quality ladder (lossy only).
		for (const quality of QUALITY_STEPS) {
			best = encode(targetWidth, targetHeight, quality, false);
			if (best.bytes <= MAX_BYTES) return { dataUrl: best.dataUrl, mimeType: best.mimeType };
		}

		// Dimension ladder (≥100px), same quality ladder inside.
		for (const scale of SCALE_STEPS) {
			const w = Math.round(targetWidth * scale);
			const h = Math.round(targetHeight * scale);
			if (w < 100 || h < 100) break;
			for (const quality of QUALITY_STEPS) {
				best = encode(w, h, quality, false);
				if (best.bytes <= MAX_BYTES) return { dataUrl: best.dataUrl, mimeType: best.mimeType };
			}
		}

		// Last resort: the smallest version produced (daemon parity).
		return { dataUrl: best.dataUrl, mimeType: best.mimeType };
	} catch {
		// decode failure → keep original (daemon decodeFailed parity).
		return null;
	} finally {
		bitmap?.close();
	}
}
