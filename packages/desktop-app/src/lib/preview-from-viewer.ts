/**
 * Map a viewer result onto the file pane's preview state.
 *
 * The viewer registry produces a {@link ViewerResult}; the pane renders from a
 * `PreviewState` object with one field per format plus a couple of loose
 * toggles. This is the seam between them, and it exists as a pure function so
 * the mapping — including the two behaviors that were easy to lose — can be
 * tested without mounting the component.
 *
 * Every textual viewer supplies its bounded raw source to the inline editor.
 * Large text results omit `raw` and remain read-only. Markdown and HTML keep
 * their live previews beside the editor instead of using a separate edit mode.
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
	pdfBytes?: ArrayBuffer;
	docxBytes?: ArrayBuffer;
	officeSheets?: ReadonlyArray<{ name: string; html: string; truncated: boolean }>;
	media?: { kind: "audio" | "video"; url: string };
	fontUrl?: string;
	mermaidSource?: string;
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
				...(result.raw === undefined ? {} : { editable: result.raw }),
			};
		case "markdown":
			return {
				fields: { text: result.text, ...(result.raw === undefined ? {} : { raw: result.raw }) },
				mdRender: true,
				...(result.raw === undefined ? {} : { editable: result.raw }),
			};
		case "html":
			return {
				fields: { htmlLive: result.text, ...(result.raw === undefined ? {} : { raw: result.raw }) },
				htmlLiveMode: "live",
				...(result.raw === undefined ? {} : { editable: result.raw }),
			};
		case "highlighted":
			return {
				fields: { html: result.html, ...(result.raw === undefined ? {} : { raw: result.raw }) },
				...(result.raw === undefined ? {} : { editable: result.raw }),
			};
		case "image":
			return { fields: { imageUrl: result.blobUrl } };
		case "pdf":
			return { fields: { pdfBytes: result.bytes } };
		case "docx":
			return { fields: { docxBytes: result.bytes } };
		case "sheets":
			return { fields: { officeSheets: result.sheets } };
		case "media":
			return { fields: { media: { kind: result.media, url: result.blobUrl } } };
		case "font":
			return { fields: { fontUrl: result.blobUrl } };
		case "mermaid":
			return { fields: { mermaidSource: result.source } };
	}
}
