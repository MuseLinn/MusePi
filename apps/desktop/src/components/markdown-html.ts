/**
 * Rendered raw HTML for the visual Markdown editor.
 *
 * Milkdown's commonmark preset parses README-style HTML (`<p align="center">`,
 * `<img>`, badge links) into an inline `html` atom. This node view renders a
 * sanitized copy of that HTML; the atom's `value` is untouched, so
 * serialization still writes the original tags back and saving never rewrites
 * the file's HTML into Markdown.
 */

import { htmlSchema } from "@milkdown/kit/preset/commonmark";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { NodeView } from "@milkdown/kit/prose/view";
import { $view } from "@milkdown/kit/utils";

/** Elements a README legitimately uses. Everything else is unwrapped (unknown)
 *  or removed outright (active content). */
const ALLOWED_TAGS = new Set([
	"a",
	"b",
	"blockquote",
	"br",
	"caption",
	"center",
	"code",
	"dd",
	"del",
	"details",
	"div",
	"dl",
	"dt",
	"em",
	"figcaption",
	"figure",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"i",
	"img",
	"ins",
	"kbd",
	"li",
	"mark",
	"ol",
	"p",
	"picture",
	"pre",
	"q",
	"s",
	"samp",
	"small",
	"source",
	"span",
	"strike",
	"strong",
	"sub",
	"summary",
	"sup",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"u",
	"ul",
	"var",
]);

/** Tags whose *content* must disappear with them. Unknown tags are unwrapped
 *  instead, so their text survives. */
const DROPPED_TAGS = new Set([
	"audio",
	"base",
	"button",
	"canvas",
	"embed",
	"form",
	"head",
	"iframe",
	"input",
	"link",
	"math",
	"meta",
	"noscript",
	"object",
	"script",
	"select",
	"style",
	"svg",
	"template",
	"textarea",
	"title",
	"video",
]);

const ALLOWED_ATTRS = new Set([
	"align",
	"alt",
	"border",
	"colspan",
	"decoding",
	"height",
	"href",
	"loading",
	"media",
	"open",
	"rel",
	"rowspan",
	"sizes",
	"src",
	"srcset",
	"target",
	"title",
	"type",
	"valign",
	"width",
]);

const URL_ATTRS = new Set(["href", "src", "srcset"]);

/** A URL is safe when it is relative or uses a harmless scheme. `data:` is
 *  limited to raster images so an SVG/HTML payload cannot carry script. */
function isSafeUrl(value: string): boolean {
	const compact = value.replace(/[\u0000-\u0020]+/g, "");
	if (/^(?:javascript|vbscript|data:text\/html)/i.test(compact)) return false;
	if (/^data:/i.test(compact) && !/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon);/i.test(compact)) return false;
	return true;
}

function sanitizeAttributes(element: Element): void {
	for (const attribute of Array.from(element.attributes)) {
		const name = attribute.name.toLowerCase();
		if (!ALLOWED_ATTRS.has(name) || (URL_ATTRS.has(name) && !isSafeUrl(attribute.value))) {
			element.removeAttribute(attribute.name);
		}
	}
	if (element.tagName.toLowerCase() === "a" && /^https?:/i.test(element.getAttribute("href") ?? "")) {
		element.setAttribute("target", "_blank");
		element.setAttribute("rel", "noopener noreferrer");
	}
}

function sanitizeChildren(parent: Element): void {
	for (const child of Array.from(parent.children)) {
		sanitizeChildren(child);
		const tag = child.tagName.toLowerCase();
		if (DROPPED_TAGS.has(tag)) {
			child.remove();
			continue;
		}
		if (ALLOWED_TAGS.has(tag)) {
			sanitizeAttributes(child);
			continue;
		}
		child.replaceWith(...Array.from(child.childNodes));
	}
}

/** Keep README layout/media markup, drop scripts, event handlers and unsafe
 *  URLs. Returns the sanitized fragment as HTML. */
export function sanitizeMarkdownHtml(html: string): string {
	const body = new DOMParser().parseFromString(html, "text/html").body;
	sanitizeChildren(body);
	return body.innerHTML;
}

/** Resolve a reference against the Markdown file's directory. Absolute,
 *  `~`-rooted and `file://` references pass through. Query and fragment are
 *  dropped: callers address files, not URLs. */
export function resolveDocumentPath(documentPath: string, reference: string): string | null {
	const raw = reference.startsWith("file://") ? reference.slice("file://".length) : reference;
	const clean = raw.split(/[?#]/, 1)[0] ?? "";
	if (!clean) return null;
	if (/^(?:[a-z]:[\\/]|\/|~)/i.test(clean)) return clean;
	const separator = Math.max(documentPath.lastIndexOf("/"), documentPath.lastIndexOf("\\"));
	const base = separator >= 0 ? documentPath.slice(0, separator + 1) : "";
	const segments = `${base}${clean}`.replace(/\\/g, "/").split("/");
	const normalized: string[] = [];
	for (const segment of segments) {
		if (!segment || segment === ".") continue;
		if (segment === ".." && normalized.at(-1) !== "..") normalized.pop();
		else normalized.push(segment);
	}
	const prefix = /^[a-z]:/i.test(segments[0] ?? "") ? "" : "/";
	return `${prefix}${normalized.join("/")}`;
}

/** Resolve an image reference without turning the Markdown source into a
 *  temporary blob/data URL. Only the DOM receives the readable data URL. */
export function markdownImagePath(documentPath: string, source: string): string | null {
	if (/^(https?:|data:)/i.test(source)) return null;
	if (!source || /^blob:/i.test(source)) return null;
	if (!/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(?:[?#].*)?$/i.test(source)) return null;
	return resolveDocumentPath(documentPath, source);
}

/** Bounded data-URL cache shared by every HTML node view: README images repeat
 *  across re-renders and a file page remounts whenever its tab re-activates. */
const IMAGE_CACHE = new Map<string, string>();
const IMAGE_CACHE_MAX = 80;

function rememberImage(path: string, dataUrl: string): void {
	IMAGE_CACHE.set(path, dataUrl);
	if (IMAGE_CACHE.size > IMAGE_CACHE_MAX) {
		const oldest = IMAGE_CACHE.keys().next().value;
		if (oldest !== undefined) IMAGE_CACHE.delete(oldest);
	}
}

const BLOCK_TAG =
	/^\s*<(?:address|article|aside|blockquote|center|details|div|dl|fieldset|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|ul)\b/i;

class MarkdownHtmlView implements NodeView {
	readonly dom: HTMLSpanElement;
	private node: ProseNode;
	private readonly documentPath: string;

	constructor(node: ProseNode, documentPath: string) {
		this.node = node;
		this.documentPath = documentPath;
		this.dom = document.createElement("span");
		this.dom.className = "gui-md-html";
		this.dom.addEventListener("click", this.onClick);
		this.render();
	}

	update(node: ProseNode): boolean {
		if (node.type !== this.node.type) return false;
		if (node.attrs.value === this.node.attrs.value) return true;
		this.node = node;
		this.render();
		return true;
	}

	/** The rendered markup is opaque to ProseMirror: it must not try to map
	 *  inner DOM mutations back onto the document. */
	ignoreMutation(): boolean {
		return true;
	}

	stopEvent(): boolean {
		return true;
	}

	private render(): void {
		const value = typeof this.node.attrs.value === "string" ? this.node.attrs.value : "";
		const html = sanitizeMarkdownHtml(value);
		this.dom.classList.toggle("gui-md-html--block", BLOCK_TAG.test(value));
		if (html.trim() === "") {
			// Nothing renderable (comments, scripts): keep the source visible so
			// the atom is not an invisible gap the user cannot find.
			this.dom.textContent = value;
			return;
		}
		this.dom.innerHTML = html;
		this.resolveImages();
	}

	private resolveImages(): void {
		for (const image of Array.from(this.dom.querySelectorAll<HTMLImageElement>("img[src]"))) {
			const source = image.getAttribute("src") ?? "";
			const path = markdownImagePath(this.documentPath, source);
			if (!path) continue;
			const cached = IMAGE_CACHE.get(path);
			if (cached !== undefined) {
				image.src = cached;
				continue;
			}
			void Promise.resolve(window.electronAPI?.readFileDataUrl(path))
				.then(result => {
					if (!result?.dataUrl || !image.isConnected) return;
					rememberImage(path, result.dataUrl);
					image.src = result.dataUrl;
				})
				.catch(() => {});
		}
	}

	private readonly onClick = (event: MouseEvent): void => {
		if (event.button !== 0 || event.defaultPrevented) return;
		const target = event.target;
		if (!(target instanceof Element)) return;
		const anchor = target.closest("a[href]");
		if (!anchor || !this.dom.contains(anchor)) return;
		const href = anchor.getAttribute("href") ?? "";
		if (!href || href.startsWith("#")) return;
		event.preventDefault();
		event.stopPropagation();
		if (/^https?:/i.test(href)) {
			window.dispatchEvent(new CustomEvent("musepi-open-url", { detail: { url: href } }));
			return;
		}
		if (/^mailto:/i.test(href)) {
			void window.electronAPI?.openExternal(href);
			return;
		}
		// Other schemes are not files; resolving them would fabricate a path.
		if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return;
		const path = resolveDocumentPath(this.documentPath, href);
		if (path) window.dispatchEvent(new CustomEvent("musepi-open-file", { detail: { path } }));
	};
}

/** Node view for commonmark's inline `html` atom, bound to the file whose
 *  relative image and link references it resolves. */
export function markdownHtmlView(documentPath: string) {
	return $view(htmlSchema.node, () => (node: ProseNode) => new MarkdownHtmlView(node, documentPath));
}
