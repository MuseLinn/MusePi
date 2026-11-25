/**
 * Rasterize a DOM element to a PNG blob (widget card 下载为图片 / 复制为图片).
 *
 * Two defects shaped this implementation:
 *
 * 1. **Sandboxed widget frames are invisible to `html-to-image`.** The
 *    library clones an `<iframe>` by reading `contentDocument.body` — an
 *    opaque-origin `sandbox="allow-scripts"` frame throws, so the clone keeps
 *    an empty frame and the export is a blank card. Rewriting the clone
 *    through the library's `onclone` hook is not an option: `html-to-image
 *    1.11.13` has no such option, and the callback that used to live here was
 *    silently dropped. Instead we build the export source ourselves: each
 *    srcdoc frame is re-rendered same-origin in a shadow frame, its rendered
 *    document is captured into a `<style>` + markup subtree inside a *shadow
 *    root*, and that subtree takes the frame's place in a staged clone of the
 *    card. The library walks shadow roots (and inlines the computed styles it
 *    finds there), so the face lands in the image while its CSS stays scoped
 *    to the shadow root instead of leaking into the app.
 *
 * 2. **A transparent card exports as "blank".** `getComputedStyle(el)
 *    .backgroundColor` is `rgba(0, 0, 0, 0)` for the widget wrapper, so a
 *    dark theme's light text landed on transparency and vanished in any
 *    white-backed viewer. Resolve the first opaque ancestor color instead.
 *
 * The dynamic import keeps `html-to-image` out of the main bundle; the font
 * CSS is embedded once per session (the library re-reads every stylesheet and
 * re-encodes every font face on each call otherwise, which is what made the
 * copy button feel stuck for seconds).
 */

/** Face scripts render on load; give a slow face a hard cap so a broken
 *  widget degrades to a partially rendered export instead of hanging. */
const SHADOW_LOAD_TIMEOUT_MS = 3000;

/** Chromium caps canvas dimensions; past it `toBlob` yields a blank image.
 *  Cap the pixel ratio so a tall widget still exports at 1×. */
const MAX_CANVAS_EDGE = 16384;

interface FaceSnapshot {
	/** Replaces the frame: a shadow host carrying the face's rendered markup. */
	node: HTMLElement;
}

interface ShadowPair {
	original: HTMLIFrameElement;
	shadow: HTMLIFrameElement;
}

/** Wait for a frame's load event and a couple of paints (inline face scripts
 *  run during parse; fonts/layout settle right after).
 *
 *  Timers, not `requestAnimationFrame`: a backgrounded or occluded window
 *  pauses rAF, and an export started from there would then hang forever
 *  instead of finishing late. The face boot script's own height probe takes
 *  the same route for the same reason. */
function waitShadowReady(frame: HTMLIFrameElement): Promise<void> {
	return new Promise(resolve => {
		let settled = false;
		const deadline = performance.now() + SHADOW_LOAD_TIMEOUT_MS;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			// Two frames of layout after load: let the face's first paint land.
			window.setTimeout(() => window.setTimeout(resolve, 32), 32);
		};
		frame.addEventListener("load", finish, { once: true });
		const poll = (): void => {
			if (settled) return;
			try {
				if (frame.contentDocument?.readyState === "complete") {
					finish();
					return;
				}
			} catch {
				/* cross-origin race — keep waiting for the cap */
			}
			if (performance.now() > deadline) {
				finish();
				return;
			}
			window.setTimeout(poll, 32);
		};
		poll();
	});
}

/** Canvas pixels are not part of the DOM: a face that draws a chart exports
 *  an empty `<canvas>` slot. Swap each canvas for an image of itself first. */
function bakeCanvases(doc: Document): void {
	for (const canvas of Array.from(doc.querySelectorAll("canvas"))) {
		let url = "";
		try {
			url = canvas.toDataURL();
		} catch {
			continue; // tainted — leave the (blank) canvas in place
		}
		if (!url || url === "data:,") continue;
		const img = doc.createElement("img");
		img.src = url;
		const style = canvas.getAttribute("style");
		if (style) img.setAttribute("style", style);
		img.setAttribute("width", String(canvas.width));
		img.setAttribute("height", String(canvas.height));
		canvas.replaceWith(img);
	}
}

/** Serialize a rendered shadow document into a shadow-root host of the same
 *  box. The face's own `<style>` elements travel with the markup; inside a
 *  shadow root they stay scoped, and the rasterizer copies the resulting
 *  computed styles from there. */
function faceHost(doc: Document, box: { width: number; height: number }): HTMLElement {
	const host = document.createElement("div");
	host.setAttribute("style", `width:${box.width}px;height:${box.height}px;overflow:hidden;position:relative;`);
	const root = host.attachShadow({ mode: "open" });
	const styles = Array.from(doc.head?.querySelectorAll("style") ?? [])
		.map(el => el.outerHTML)
		.join("");
	const bodyStyle = doc.body?.getAttribute("style");
	const wrapper = doc.createElement("div");
	if (bodyStyle) wrapper.setAttribute("style", bodyStyle);
	wrapper.innerHTML = doc.body?.innerHTML ?? "";
	root.innerHTML = styles;
	root.appendChild(wrapper);
	return host;
}

function collectFaces(element: HTMLElement): HTMLIFrameElement[] {
	return Array.from(element.querySelectorAll("iframe[srcdoc]")).filter(
		(frame): frame is HTMLIFrameElement => frame instanceof HTMLIFrameElement && !!frame.getAttribute("srcdoc"),
	);
}

/** Re-render every srcdoc face same-origin, read the result, and hand back a
 *  host node per frame (document order). */
async function snapshotFaces(frames: readonly HTMLIFrameElement[]): Promise<Map<HTMLIFrameElement, FaceSnapshot>> {
	const snapshots = new Map<HTMLIFrameElement, FaceSnapshot>();
	if (frames.length === 0) return snapshots;

	const container = document.createElement("div");
	container.setAttribute("aria-hidden", "true");
	container.style.cssText = "position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;";

	const pairs: ShadowPair[] = [];
	for (const frame of frames) {
		const srcdoc = frame.getAttribute("srcdoc");
		if (!srcdoc) continue;
		const shadow = document.createElement("iframe");
		// allow-same-origin: the srcdoc document inherits OUR origin, so the
		// rendered face is readable. allow-scripts: the face boots and paints.
		shadow.setAttribute("sandbox", "allow-scripts allow-same-origin");
		shadow.setAttribute("srcdoc", srcdoc);
		const rect = frame.getBoundingClientRect();
		shadow.style.width = `${Math.max(1, Math.round(rect.width))}px`;
		// The face reports its own height onto the frame's inline style; the
		// rect of a zero-height face would flatten it.
		const styleHeight = frame.style.height;
		shadow.style.height =
			styleHeight && styleHeight !== "auto" ? styleHeight : `${Math.max(1, Math.round(rect.height))}px`;
		shadow.style.border = "none";
		container.appendChild(shadow);
		pairs.push({ original: frame, shadow });
	}
	if (pairs.length === 0) return snapshots;

	document.body.appendChild(container);
	try {
		await Promise.all(pairs.map(p => waitShadowReady(p.shadow)));
		for (const { original, shadow } of pairs) {
			let doc: Document | null = null;
			try {
				doc = shadow.contentDocument;
			} catch {
				continue; // unreadable — the frame keeps its (blank) clone
			}
			if (!doc?.body) continue;
			bakeCanvases(doc);
			const rect = original.getBoundingClientRect();
			snapshots.set(original, {
				node: faceHost(doc, {
					width: Math.max(1, Math.round(rect.width)),
					height: Math.max(1, Math.round(rect.height)),
				}),
			});
		}
	} finally {
		container.remove();
	}
	return snapshots;
}

/** First opaque background up the ancestor chain — the card's own wrapper is
 *  usually transparent, and a transparent PNG of a dark theme's white text
 *  reads as an empty image once pasted. Exported for the export test. */
export function opaqueBackground(element: HTMLElement, fallback: string): string {
	for (let node: HTMLElement | null = element; node; node = node.parentElement) {
		const color = getComputedStyle(node).backgroundColor;
		if (!color) continue;
		const alpha = /rgba?\(([^)]+)\)/.exec(color);
		if (alpha) {
			const parts = alpha[1].split(",");
			if (parts.length < 4 || Number.parseFloat(parts[3]) > 0.05) return color;
			continue;
		}
		if (color !== "transparent") return color;
	}
	return fallback;
}

/** Pixel ratio that keeps the canvas inside Chromium's dimension cap. Past it
 *  `toBlob` yields an empty image, indistinguishable from a broken export. */
export function cappedPixelRatio(ratio: number, width: number, height: number): number {
	return Math.max(1, Math.min(ratio, MAX_CANVAS_EDGE / Math.max(Math.max(width, 1), Math.max(height, 1))));
}

/** Font CSS is embedded once per session: the library otherwise reads and
 *  re-encodes every stylesheet and font face on every export. */
let fontEmbedCss: Promise<string | null> | null = null;

function loadFontEmbedCss(): Promise<string | null> {
	fontEmbedCss ??= import("html-to-image").then(mod => mod.getFontEmbedCSS(document.body)).catch(() => null);
	return fontEmbedCss;
}

/** Wait for the faces the card is about to measure, but never for long: a
 *  slow/blocked font must not turn an export into a hang. Measured with
 *  fallback metrics the image keeps the *wrong* glyph widths, which is the
 *  kind of "almost right" that is worse than a visible failure. */
const FONTS_TIMEOUT_MS = 2000;

async function fontsSettled(): Promise<void> {
	const ready = document.fonts?.ready;
	if (!ready) return;
	await Promise.race([
		ready.then(() => undefined).catch(() => undefined),
		new Promise<void>(r => setTimeout(r, FONTS_TIMEOUT_MS)),
	]);
}

/** Paint/layout properties only. The computed style of the root carries every
 *  theme custom property the app defines; copying all of them onto every node
 *  bloats the serialized SVG by megabytes and can stop Chromium from decoding
 *  it (the "blank image" failure again, from the other side). Custom
 *  properties are excluded because the computed values already resolved
 *  `var()` — nothing is lost, only the unresolved tokens. */
function captureStyleProperties(container: HTMLElement): string[] {
	return Array.from(getComputedStyle(container)).filter(name => !name.startsWith("--"));
}

/** Do two RGBA pixels differ by more than rounding noise? Alpha counts (a
 *  fully transparent pixel against an opaque one is a difference); two
 *  transparent pixels never differ, whatever colour they nominally carry. */
export function pixelsDiffer(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
	const alphaA = a[3] ?? 0;
	const alphaB = b[3] ?? 0;
	if (Math.abs(alphaA - alphaB) > 2) return true;
	if (alphaA === 0 || alphaB === 0) return false;
	return (
		Math.abs((a[0] ?? 0) - (b[0] ?? 0)) > 2 ||
		Math.abs((a[1] ?? 0) - (b[1] ?? 0)) > 2 ||
		Math.abs((a[2] ?? 0) - (b[2] ?? 0)) > 2
	);
}

/** Reject a raster that carries nothing but the background. An SVG decode or
 *  draw failure returns a valid, nonempty PNG — handing that to the clipboard
 *  is exactly how "copy as image" shipped a blank picture before. Samples
 *  bounded strips so a long image never allocates a second full buffer. */
export function assertCanvasHasContent(canvas: HTMLCanvasElement): void {
	const context = canvas.getContext("2d");
	if (!context || !canvas.width || !canvas.height) throw new Error("canvas is empty");
	let reference: ArrayLike<number> | null = null;
	for (let y = 0; y < canvas.height; y += 32) {
		const { data } = context.getImageData(0, y, canvas.width, Math.min(32, canvas.height - y));
		for (let i = 0; i < data.length; i += 4) {
			const pixel = data.subarray(i, i + 4);
			if (!reference) {
				reference = pixel;
				continue;
			}
			if (pixelsDiffer(reference, pixel)) return;
		}
	}
	throw new Error("rendered image is blank");
}

export interface RasterizeOptions {
	pixelRatio?: number;
	backgroundColor?: string;
}

export async function rasterizeToBlob(element: HTMLElement, options: RasterizeOptions = {}): Promise<Blob> {
	const rect = element.getBoundingClientRect();
	const frames = collectFaces(element);
	const snapshots = await snapshotFaces(frames);

	// Stage a clone we are allowed to rewrite: the live card keeps its running
	// faces (and its scroll position) untouched meanwhile.
	const stage = document.createElement("div");
	stage.setAttribute("aria-hidden", "true");
	stage.style.cssText = `position:fixed;left:-10000px;top:0;width:${Math.max(
		1,
		Math.round(rect.width),
	)}px;pointer-events:none;`;
	const clone = element.cloneNode(true) as HTMLElement;
	stage.appendChild(clone);
	document.body.appendChild(stage);

	try {
		if (snapshots.size > 0) {
			const clonedFrames = collectFaces(clone);
			clonedFrames.forEach((frame, index) => {
				const snapshot = snapshots.get(frames[index]);
				if (snapshot) frame.replaceWith(snapshot.node);
			});
			// The staged clone is laid out like the live card once the browser
			// has run a frame of layout — shadow-host boxes included. A timer,
			// not rAF: rAF is paused while the window is hidden.
			await new Promise<void>(resolve => window.setTimeout(resolve, 32));
		}
		await fontsSettled();

		const { toCanvas } = await import("html-to-image");
		const fontEmbedCSS = await loadFontEmbedCss();
		const background = opaqueBackground(element, options.backgroundColor ?? "#ffffff");
		const preferred = options.pixelRatio ?? 2;
		const includeStyleProperties = captureStyleProperties(clone);

		// A decode/draw failure returns a valid but blank raster; the same
		// failure usually clears at a lower resolution, so a retry is a real
		// recovery rather than a hope. The blank check is what makes it safe:
		// without it the retry could hand back the same empty picture.
		let lastError: unknown = null;
		for (const ratio of [preferred, 1]) {
			const pixelRatio = cappedPixelRatio(ratio, rect.width, rect.height);
			let canvas: HTMLCanvasElement | null = null;
			try {
				canvas = await toCanvas(clone, {
					pixelRatio,
					backgroundColor: background,
					includeStyleProperties,
					...(fontEmbedCSS ? { fontEmbedCSS } : {}),
				});
				if (!canvas) throw new Error("canvas produced no raster");
				assertCanvasHasContent(canvas);
				const blob = await new Promise<Blob | null>(resolve => canvas?.toBlob(resolve, "image/png"));
				if (!blob) throw new Error("canvas produced no blob");
				return blob;
			} catch (err) {
				lastError = err;
				if (canvas) {
					canvas.width = 0;
					canvas.height = 0;
				}
				if (pixelRatio <= 1) break;
			}
		}
		throw lastError instanceof Error ? lastError : new Error("image export failed");
	} finally {
		stage.remove();
	}
}
