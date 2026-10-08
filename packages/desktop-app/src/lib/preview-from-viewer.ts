/**
 * Map a viewer result onto the file pane's preview state.
 *
 * The viewer registry produces a {@link ViewerResult}; the pane renders from a
 * `PreviewState` object with one field per format plus a couple of loose
 * toggles. This is the seam between them, and it exists as a pure function so
 * the mapping — including the two behaviors that were easy to lose — can be
 * tested without mounting the component.
 *
 * The two that are not obvious: HTML and highlighted results do NOT seed the
 * inline editor, while Markdown and plain text do. That asymmetry was in the
 * original branch chain (the HTML and highlight paths returned before the
 * shared editor-seed line), and collapsing them to "everything editable" would
 * mean an `.html` preview opens in source-edit mode unexpectedly, and a
 * highlighted file's buffer would reset on every re-open.
 */
import type { ViewerResult } from "./file-viewers";

/** The content fields of the file pane's preview state. Not exported: it is
 *  reached through {@link PreviewMapping}'s `fields` and nothing imports it by
 *  name, so an export would only widen the surface. */
interface PreviewFields {
	text?: string;
	raw?: string;
	html?: string;
	htmlLive?: string;
	imageUrl?: string;
	pdfPages?: readonly string[];
	docxBytes?: ArrayBuffer;
	officeSheets?: ReadonlyArray<{ name: string; html: string; truncated: boolean }>;
}

/** What the pane must do with a viewer result: what to show, plus the two
 *  toggles and the optional editor seed that used to be interleaved in the
 *  branch chain. */
export interface PreviewMapping {
	readonly fields: PreviewFields;
	/** Only set for an HTML result — the pane's live/source toggle. */
	readonly htmlLiveMode?: "live";
	/** Only set for a Markdown result — the render/source toggle. */
	readonly mdRender?: true;
	/** The text the inline editor should start from, when this format is
	 *  editable on open. Absent means: do not seed the editor. */
	readonly editable?: string;
}

/** Translate a viewer result into the fields and toggles the pane reads. */
export function previewMappingFor(result: ViewerResult): PreviewMapping {
	switch (result.kind) {
		case "text":
			return {
				fields: { text: result.text, ...(result.raw === undefined ? {} : { raw: result.raw }) },
				editable: result.text,
			};
		case "markdown":
			return {
				fields: { text: result.text, ...(result.raw === undefined ? {} : { raw: result.raw }) },
				mdRender: true,
				editable: result.text,
			};
		case "html":
			// The preview IS the page; the source lives in `raw` only so the
			// editor can reach it when toggled. No editor seed on open, matching
			// the chain that returned here before seeding.
			return {
				fields: { htmlLive: result.text, ...(result.raw === undefined ? {} : { raw: result.raw }) },
				htmlLiveMode: "live",
			};
		case "highlighted":
			return { fields: { html: result.html, ...(result.raw === undefined ? {} : { raw: result.raw }) } };
		case "image":
			return { fields: { imageUrl: result.blobUrl } };
		case "pdf":
			return { fields: { pdfPages: result.pages } };
		case "docx":
			return { fields: { docxBytes: result.bytes } };
		case "sheets":
			return { fields: { officeSheets: result.sheets } };
	}
}
