/**
 * File preview viewers, as a registry rather than a branch chain.
 *
 * Reading a file used to be one `if` ladder in `FilePane`: classify by mime
 * and extension, decode, maybe render, then write the result into a state
 * object with a field per format. Adding a format meant editing that ladder,
 * which put every new viewer inside a component that already knew about nine
 * others — and left a third-party plugin with no seam at all, since a plugin
 * cannot reach into a component's state machine.
 *
 * A viewer here answers two questions for one file: does it handle it, and what
 * should be shown. Loading the bytes stays with the caller, because every viewer
 * needs them and only some need them decoded.
 *
 * The order matters and is the table's order, not the registration order: a
 * plugin registering a viewer for `*.md` must not be able to displace the
 * Markdown renderer it did not know about, and a viewer that declines a file
 * must leave the next one a chance rather than claiming it.
 *
 * @module desktop-app/lib/file-viewers
 */

/** The bytes as they came off disk, plus what the host knows about them. */
export interface ViewerInput {
	readonly name: string;
	readonly path: string;
	readonly size: number;
	/**
	 * The file's bytes.
	 *
	 * Backed by a plain `ArrayBuffer` rather than the general
	 * `ArrayBufferLike`, because every consumer here either decodes it or hands
	 * it to a browser API — and the DOM's `BlobPart` admits only the former.
	 * A view onto a shared buffer would type-check nowhere it is actually used.
	 */
	readonly bytes: Uint8Array<ArrayBuffer>;
	/** MIME the host resolved, when it could. */
	readonly mime?: string;
	/** Lower-case extension without the dot, or `""`. */
	readonly ext: string;
}

/**
 * What a viewer produced. Mirrors the fields `FilePane` renders, so a built-in
 * viewer can be lifted out of the component without changing the component's
 * rendering.
 */
export type ViewerResult =
	| { readonly kind: "text"; readonly text: string; readonly raw?: string }
	| { readonly kind: "markdown"; readonly text: string; readonly raw?: string }
	| { readonly kind: "html"; readonly text: string; readonly raw?: string }
	| { readonly kind: "highlighted"; readonly html: string; readonly raw?: string }
	| { readonly kind: "image"; readonly blobUrl: string }
	| { readonly kind: "pdf"; readonly pages: readonly string[] }
	| { readonly kind: "docx"; readonly bytes: ArrayBuffer }
	| { readonly kind: "sheets"; readonly sheets: readonly { name: string; html: string; truncated: boolean }[] };

export interface FileViewer {
	/** Stable id, for diagnostics and for a plugin to claim a slot by name. */
	readonly id: string;
	/**
	 * Lowerest first: a viewer runs before any viewer with a higher priority.
	 *
	 * Built-ins sit in the middle of the range so a plugin can take precedence
	 * over a format it knows better without having to displace the ones it does
	 * not.
	 */
	readonly priority?: number;
	/**
	 * Whether this viewer handles the file.
	 *
	 * Must not throw and must not do expensive work: it runs once per registered
	 * viewer per file, and a viewer that panics here takes the whole preview with
	 * it. Reading the bytes is allowed where deciding requires it — telling a
	 * binary that happens to be named like source apart from real source means
	 * looking at the first few bytes — but decoding them is not.
	 */
	matches(input: ViewerInput): boolean;
	/**
	 * Produce what to show, or `undefined` to decline and let the next viewer
	 * try.
	 *
	 * Declining after matching is the normal path for a format that can fail to
	 * decode — an encrypted workbook, a corrupt PDF — where the host's answer is
	 * to fall through to the system app rather than show an error.
	 */
	render(input: ViewerInput): Promise<ViewerResult | undefined>;
}

/** Priority for the built-in viewers; the default when a viewer omits one. */
export const VIEWER_PRIORITY = {
	/** A plugin that fully replaces a built-in format. */
	override: 0,
	/** The host's own viewers. */
	builtin: 100,
	/** Anything that wants the file after every built-in declined it. */
	fallback: 200,
} as const;

const registry: FileViewer[] = [];

/**
 * Register a viewer.
 *
 * A later registration of the same id replaces the earlier one, so a plugin that
 * reloads does not accumulate duplicates — the same reason `register*` calls on
 * the extension API are idempotent per source.
 */
export function registerFileViewer(viewer: FileViewer): () => void {
	const existing = registry.findIndex(v => v.id === viewer.id);
	if (existing === -1) registry.push(viewer);
	else registry[existing] = viewer;
	return () => {
		const index = registry.findIndex(v => v.id === viewer.id);
		if (index !== -1) registry.splice(index, 1);
	};
}

/**
 * Registered viewers, in the order they will be tried.
 *
 * Not exported: what a person needs when two viewers disagree is the order, and
 * that is answered by the symptom (a preview that never appears) rather than by
 * a list. Exporting it would also freeze this ordering into a second contract
 * that has to be kept in step with the one below.
 */
function listFileViewers(): readonly FileViewer[] {
	return [...registry].sort(
		(a, b) => (a.priority ?? VIEWER_PRIORITY.builtin) - (b.priority ?? VIEWER_PRIORITY.builtin),
	);
}

/** Drop every registration. Tests only — a real unload goes through the returned disposer. */
export function resetFileViewers(): void {
	registry.length = 0;
}

/**
 * The first viewer that handles this file, or `undefined`.
 *
 * Matching and rendering are separate because they answer different questions:
 * whether a file is this viewer's business is a fact about the name and the
 * first few bytes, while whether it renders is a fact about the whole file, and
 * a format that fails to decode must not consume it.
 */
export function selectFileViewer(input: ViewerInput): FileViewer | undefined {
	return listFileViewers().find(viewer => viewer.matches(input));
}

/**
 * Render a file with the first viewer that both handles and can render it.
 *
 * @returns what to show, or `undefined` when no viewer took the file — the
 * caller's cue to open it externally rather than to report a failure.
 */
export async function renderWithViewers(input: ViewerInput): Promise<ViewerResult | undefined> {
	for (const viewer of listFileViewers()) {
		if (!viewer.matches(input)) continue;
		const result = await viewer.render(input);
		if (result !== undefined) return result;
	}
	return undefined;
}
