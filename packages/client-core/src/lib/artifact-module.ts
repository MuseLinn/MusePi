/**
 * Import a compiled extension module.
 *
 * The daemon delivers one of two shapes: a `url` (the desktop asks for this —
 * every module is its own loopback HTTP resource, so the browser revalidates it
 * with an ETag instead of transferring it again) or the same module's `code`
 * inline (transports that cannot reach the daemon's origin).
 *
 * The bytes reach the page either way: a `file://` document cannot import a
 * cross-origin module URL, so the source is fetched first and evaluated from a
 * blob. The blob is released once the import has settled — revoking while the
 * import is in flight fails it.
 */
export async function importCompiledModule(artifact: { code?: string; url?: string }): Promise<unknown> {
	// An HTTP-served shell imports the module URL directly — except while the
	// document runs from a dev server: a dev page's CSP (`script-src-elem`
	// without the artifact origin) blocks a fetched module URL, and the whole
	// surface then fails to mount. The blob below is how a `file://` document
	// already imports a cross-origin module, and it works under that CSP.
	const devDocument = window.location.port !== "" && window.location.hostname !== "";
	if (artifact.url && window.location.protocol !== "file:" && !devDocument) {
		return (await import(/* @vite-ignore */ artifact.url)) as unknown;
	}
	const source = artifact.url ? await fetchSource(artifact.url) : (artifact.code ?? "");
	const blob = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
	try {
		return (await import(/* @vite-ignore */ blob)) as unknown;
	} finally {
		URL.revokeObjectURL(blob);
	}
}

async function fetchSource(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`extension artifact ${url} returned HTTP ${response.status}`);
	return await response.text();
}
