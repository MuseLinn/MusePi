/**
 * Rasterize a DOM element to a PNG blob (widget card 下载为图片 / 复制为图片).
 *
 * Why not a plain `html-to-image.toBlob(element)`: the library clones the
 * node into an SVG foreignObject, and content living inside a nested
 * <iframe srcdoc> is INVISIBLE to that clone — the opaque-origin sandbox
 * (widget faces) cannot be read or copied, so every html-face widget
 * exported as a blank card. The fix here: before rasterizing, rebuild each
 * srcdoc iframe as a SAME-ORIGIN shadow (`sandbox="allow-scripts
 * allow-same-origin"` keeps the srcdoc document on our own origin), let it
 * boot its face scripts, serialize the rendered document, and swap that
 * markup into the clone via html-to-image's `onclone` hook.
 */

/** Face scripts render on load; give a slow face a hard cap so a broken
 *  widget degrades to a partially rendered export instead of hanging. */
const SHADOW_LOAD_TIMEOUT_MS = 4000;

interface ShadowPair {
	original: HTMLIFrameElement;
	shadow: HTMLIFrameElement;
}

/** Wait for a frame's load event and two subsequent paints (inline face
 *  scripts run during parse; fonts/layout settle right after). */
function waitShadowReady(frame: HTMLIFrameElement): Promise<void> {
	return new Promise(resolve => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			// Two rAFs after load: let the face's first layout land.
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
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
			if (performance.now() > SHADOW_LOAD_TIMEOUT_MS) {
				finish();
				return;
			}
			requestAnimationFrame(poll);
		};
		poll();
	});
}

/** Collect the serialized document of each loaded shadow frame. */
function readShadowDocuments(pairs: readonly ShadowPair[]): Map<HTMLIFrameElement, string> {
	const docs = new Map<HTMLIFrameElement, string>();
	for (const { original, shadow } of pairs) {
		try {
			const doc = shadow.contentDocument;
			docs.set(original, doc ? doc.documentElement.outerHTML : "");
		} catch {
			// unreadable — leave it out; the clone keeps the empty frame
			docs.set(original, "");
		}
	}
	return docs;
}

export interface RasterizeOptions {
	pixelRatio?: number;
	backgroundColor?: string;
}

export async function rasterizeToBlob(element: HTMLElement, options: RasterizeOptions = {}): Promise<Blob> {
	const pairs: ShadowPair[] = [];
	const container = document.createElement("div");
	container.setAttribute("aria-hidden", "true");
	container.style.cssText = "position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;";

	const frames = element.querySelectorAll("iframe[srcdoc]");
	frames.forEach(frame => {
		if (!(frame instanceof HTMLIFrameElement)) return;
		const srcdoc = frame.getAttribute("srcdoc");
		if (!srcdoc) return;
		const shadow = document.createElement("iframe");
		// allow-same-origin: the srcdoc document inherits OUR origin, so the
		// rendered face is readable. allow-scripts: the face boots and paints.
		shadow.setAttribute("sandbox", "allow-scripts allow-same-origin");
		shadow.setAttribute("srcdoc", srcdoc);
		const rect = frame.getBoundingClientRect();
		shadow.style.width = `${Math.max(1, rect.width)}px`;
		// The face reports its own height (omp-widget-resize) onto the frame's
		// inline style; the rect of a zero-height face would flatten it.
		const styleHeight = frame.style.height;
		shadow.style.height = styleHeight && styleHeight !== "auto" ? styleHeight : `${Math.max(1, rect.height)}px`;
		shadow.style.border = "none";
		container.appendChild(shadow);
		pairs.push({ original: frame, shadow });
	});

	let docs: Map<HTMLIFrameElement, string> = new Map();
	if (pairs.length > 0) {
		document.body.appendChild(container);
		try {
			await Promise.all(pairs.map(p => waitShadowReady(p.shadow)));
			docs = readShadowDocuments(pairs);
		} finally {
			container.remove();
		}
	}

	const { toBlob } = await import("html-to-image");
	const blob = await toBlob(element, {
		pixelRatio: options.pixelRatio ?? 2,
		backgroundColor: options.backgroundColor,
		...(pairs.length > 0
			? {
					onclone: (clonedDoc: Document): void => {
						// Document-order match: querySelectorAll walks the same
						// order the scan above did.
						const clonedFrames = clonedDoc.querySelectorAll("iframe[srcdoc]");
						clonedFrames.forEach((cloned, i) => {
							const pair = pairs[i];
							if (!pair) return;
							const html = docs.get(pair.original);
							if (html === undefined) return;
							const holder = clonedDoc.createElement("div");
							// Same box as the frame (inline style carries the
							// face-reported height); the serialized face document
							// fills it. The face's own <style> tags go global inside
							// the rasterized SVG document — an acceptable snapshot
							// approximation, invisible to the live page.
							holder.setAttribute("style", cloned.getAttribute("style") ?? "");
							const cs = clonedDoc.defaultView?.getComputedStyle(cloned);
							if (cs) {
								holder.style.display = "block";
								holder.style.width = cs.width;
								holder.style.height = cs.height;
								holder.style.overflow = "hidden";
								holder.style.border = "none";
								holder.style.margin = "0";
							}
							holder.innerHTML = html;
							cloned.replaceWith(holder);
						});
					},
				}
			: {}),
	});
	if (!blob) throw new Error("canvas produced no blob");
	return blob;
}
