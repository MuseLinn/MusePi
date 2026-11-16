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
	// An HTTP-served shell imports the module URL directly: it shares the
	// artifact origin, so the browser's own module loader and HTTP cache do the
	// work. A `file://` document cannot import a cross-origin module, so it
	// fetches the bytes and evaluates them from a blob instead.
	if (artifact.url && window.location.protocol !== "file:") {
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
