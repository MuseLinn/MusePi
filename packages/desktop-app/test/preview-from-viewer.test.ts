import "./happy-dom-shim"; // MUST be first: Office modules define HTMLElement subclasses at evaluation time.

/** Viewer-result → preview-state mapping. Text formats seed the inline editor
 * only when the viewer supplied a bounded raw source; binary formats do not. */
import { describe, expect, test } from "bun:test";
import { previewMappingFor } from "../src/lib/preview-from-viewer";

describe("previewMappingFor", () => {
	test("a text result fills text+raw and marks the buffer editable", () => {
		expect(previewMappingFor({ kind: "text", text: "hi", raw: "hi" })).toEqual({
			fields: { text: "hi", raw: "hi" },
			editable: "hi",
		});
	});

	test("a text result with no raw stays read-only", () => {
		// Past the editor ceiling `raw` is withheld so Monaco is never handed
		// megabytes; the bounded text preview remains available.
		const mapped = previewMappingFor({ kind: "text", text: "big" });
		expect(mapped.fields).toEqual({ text: "big" });
		expect(mapped).not.toHaveProperty("editable");
	});

	test("a markdown result turns on the render toggle and the seed", () => {
		expect(previewMappingFor({ kind: "markdown", text: "# t", raw: "# t" })).toEqual({
			fields: { text: "# t", raw: "# t" },
			mdRender: true,
			editable: "# t",
		});
	});

	test("an html result opens editable with its live preview enabled", () => {
		const mapped = previewMappingFor({ kind: "html", text: "<h1>hi</h1>", raw: "<h1>hi</h1>" });
		expect(mapped.fields).toEqual({ htmlLive: "<h1>hi</h1>", raw: "<h1>hi</h1>" });
		expect(mapped.htmlLiveMode).toBe("live");
		expect(mapped.editable).toBe("<h1>hi</h1>");
	});

	test("a highlighted result uses its raw source as the editor seed", () => {
		const mapped = previewMappingFor({ kind: "highlighted", html: "<span>", raw: "code" });
		expect(mapped.fields).toEqual({ html: "<span>", raw: "code" });
		expect(mapped.editable).toBe("code");
	});

	test("an image result carries only the blob url", () => {
		expect(previewMappingFor({ kind: "image", blobUrl: "blob:1" }).fields).toEqual({ imageUrl: "blob:1" });
	});

	test("a pdf result carries the original bytes for on-demand rendering", () => {
		const bytes = new ArrayBuffer(8);
		expect(previewMappingFor({ kind: "pdf", bytes }).fields).toEqual({ pdfBytes: bytes });
	});

	test("a docx result carries the bytes for the docx renderer", () => {
		const buf = new ArrayBuffer(4);
		expect(previewMappingFor({ kind: "docx", bytes: buf }).fields).toEqual({ docxBytes: buf });
	});

	test("a sheets result carries the parsed sheet models", () => {
		const sheets = [{ name: "S", html: "<table>", truncated: false }];
		expect(previewMappingFor({ kind: "sheets", sheets }).fields).toEqual({ officeSheets: sheets });
	});

	test("a media result carries the element kind and its url", () => {
		// The pane has to know whether to mount an <audio> or a <video>; the
		// url alone would leave it guessing from the file name.
		expect(previewMappingFor({ kind: "media", media: "video", blobUrl: "blob:2" }).fields).toEqual({
			media: { kind: "video", url: "blob:2" },
		});
	});

	test("a font result carries only the url", () => {
		expect(previewMappingFor({ kind: "font", blobUrl: "blob:3", mime: "font/ttf" }).fields).toEqual({
			fontUrl: "blob:3",
		});
	});

	test("a mermaid result carries the diagram source", () => {
		expect(previewMappingFor({ kind: "mermaid", source: "graph TD; A-->B;" }).fields).toEqual({
			mermaidSource: "graph TD; A-->B;",
		});
	});
});
