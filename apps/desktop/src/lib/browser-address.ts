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
