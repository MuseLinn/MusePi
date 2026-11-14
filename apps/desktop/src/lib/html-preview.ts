function fileBaseHref(documentPath: string): string {
	const normalized = documentPath.replace(/\\/g, "/");
	const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
	const separator = absolute.lastIndexOf("/");
	return `file://${encodeURI(absolute.slice(0, separator + 1))}`;
}

/** Resolve relative images, styles and scripts against the previewed file.
 * The sandbox remains opaque-origin; this does not grant same-origin access. */
export function withHtmlPreviewBase(source: string, documentPath: string): string {
	if (/<base\b/i.test(source)) return source;
	const base = `<base href="${fileBaseHref(documentPath)}">`;
	if (/<head[^>]*>/i.test(source)) return source.replace(/<head[^>]*>/i, match => `${match}${base}`);
	if (/<html[^>]*>/i.test(source)) return source.replace(/<html[^>]*>/i, match => `${match}<head>${base}</head>`);
	return `${base}${source}`;
}

/** Static file preview cannot execute source TypeScript or JSX modules. */
export function htmlPreviewRequiresBuild(source: string): boolean {
	return /<script\b[^>]*\bsrc\s*=\s*["'][^"']+\.(?:tsx?|jsx)(?:[?#][^"']*)?["'][^>]*>/i.test(source);
}

function previewPath(documentPath: string, href: string): string | null {
	if (!href || href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
	const documentDir = documentPath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
	const raw = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? href);
	const segments = (raw.startsWith("/") ? raw : `${documentDir}/${raw}`).split("/");
	const out: string[] = [];
	for (const segment of segments) {
		if (segment === "..") out.pop();
		else if (segment !== ".") out.push(segment);
	}
	return out.join("/");
}

/** Inline relative stylesheets because an opaque-origin srcdoc cannot load file URLs. */
export async function inlineHtmlPreviewStyles(
	source: string,
	documentPath: string,
	read: (path: string) => Promise<string | null>,
): Promise<string> {
	const replacements = new Map<string, string>();
	for (const match of source.matchAll(/<link\b[^>]*>/gi)) {
		const tag = match[0];
		if (!/\brel\s*=\s*["'][^"']*stylesheet/i.test(tag)) continue;
		const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
		if (!href) continue;
		const path = previewPath(documentPath, href);
		if (!path) continue;
		try {
			const css = await read(path);
			if (css !== null) replacements.set(tag, `<style>${css}</style>`);
		} catch {
			// Keep the original link when the workspace refuses or cannot read it.
		}
	}
	let document = source;
	for (const [tag, style] of replacements) document = document.replace(tag, style);
	return withHtmlPreviewBase(document, documentPath);
}
