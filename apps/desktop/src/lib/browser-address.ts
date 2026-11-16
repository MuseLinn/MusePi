export interface AddressDisplayParts {
	url: string;
	title?: string;
}

function hostnameLabel(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "") || url;
	} catch {
		return url;
	}
}

export function formatAddressDisplayParts(url: string, title?: string, showFullUrl = true): AddressDisplayParts {
	if (url === "about:blank") return { url: "" };
	const cleanTitle = title?.trim();
	const displayUrl = showFullUrl ? url.replace(/\/+$/, "") : hostnameLabel(url);
	if (!cleanTitle) return { url: displayUrl };
	const fallback = hostnameLabel(url);
	if (cleanTitle === fallback || cleanTitle === url) return { url: displayUrl };
	return { url: displayUrl, title: cleanTitle };
}

/**
 * The address-bar icon URL for a page, or undefined when there is none to try.
 */
export function pageIconUrl(url: string): string | undefined {
	if (!/^https?:\/\//i.test(url)) return undefined;
	try {
		return new URL("/favicon.ico", new URL(url).origin).toString();
	} catch {
		return undefined;
	}
}

/**
 * The address-bar icon for a page: the URL to try, or null to draw the glyph.
 *
 * `/favicon.ico` is the one icon location a renderer can reach without reading
 * the page — the guest's `<link rel="icon">` lives in another document — so the
 * guess fails on any site that hosts its icon elsewhere or ships none. A broken
 * `<img>` there reads as a rendering bug, so a failed load settles on the same
 * compass glyph a blank tab shows, and the failure is remembered per URL: it
 * applies to the page it happened on and is forgotten when another page loads.
 */
export function pageIcon(url: string, failedFor: string | null): { src: string | undefined; failed: boolean } {
	const src = pageIconUrl(url);
	return { src, failed: src !== undefined && failedFor === src };
}
