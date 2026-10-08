/**
 * Viewer-result → preview-state mapping.
 *
 * The point of testing this separately is the two behaviors a refactor of the
 * branch chain would most plausibly lose: HTML and highlighted results open
 * WITHOUT seeding the inline editor, while Markdown and text open WITH it. The
 * original chain got this by returning before the shared seed line; a mapping
 * that treated every format alike would silently make `.html` open in
 * source-edit mode.
 */
import { describe, expect, test } from "bun:test";
import { previewMappingFor } from "../src/lib/preview-from-viewer";

describe("previewMappingFor", () => {
	test("a text result fills text+raw and marks the buffer editable", () => {
		expect(previewMappingFor({ kind: "text", text: "hi", raw: "hi" })).toEqual({
			fields: { text: "hi", raw: "hi" },
			editable: "hi",
		});
	});

	test("a text result with no raw omits it and still offers the seed", () => {
		// Past the editor ceiling `raw` is withheld so the editor is never handed
		// megabytes; `text` still shows, and the seed is still `text`.
		const mapped = previewMappingFor({ kind: "text", text: "big" });
		expect(mapped.fields).toEqual({ text: "big" });
		expect(mapped.editable).toBe("big");
	});

	test("a markdown result turns on the render toggle and the seed", () => {
		expect(previewMappingFor({ kind: "markdown", text: "# t", raw: "# t" })).toEqual({
			fields: { text: "# t", raw: "# t" },
			mdRender: true,
			editable: "# t",
		});
	});

	test("an html result renders live and does NOT seed the editor", () => {
		// The preview IS the page. Seeding the editor here would open an `.html`
		// file in source-edit mode on every click — the asymmetry that was in the
		// chain and must survive the mapping.
		const mapped = previewMappingFor({ kind: "html", text: "<h1>hi</h1>", raw: "<h1>hi</h1>" });
		expect(mapped.fields).toEqual({ htmlLive: "<h1>hi</h1>", raw: "<h1>hi</h1>" });
		expect(mapped.htmlLiveMode).toBe("live");
		expect(mapped).not.toHaveProperty("editable");
	});

	test("a highlighted result does NOT seed the editor", () => {
		// Same reason as html: the highlighted view is a rendering, and a re-open
		// that seeded an editor would reset the buffer out from under a file the
		// person had not asked to edit.
		const mapped = previewMappingFor({ kind: "highlighted", html: "<span>", raw: "code" });
		expect(mapped.fields).toEqual({ html: "<span>", raw: "code" });
		expect(mapped).not.toHaveProperty("editable");
	});

	test("an image result carries only the blob url", () => {
		expect(previewMappingFor({ kind: "image", blobUrl: "blob:1" }).fields).toEqual({ imageUrl: "blob:1" });
	});

	test("a pdf result carries the page data urls", () => {
		expect(previewMappingFor({ kind: "pdf", pages: ["a", "b"] }).fields).toEqual({ pdfPages: ["a", "b"] });
	});

	test("a docx result carries the bytes for the docx renderer", () => {
		const buf = new ArrayBuffer(4);
		expect(previewMappingFor({ kind: "docx", bytes: buf }).fields).toEqual({ docxBytes: buf });
	});

	test("a sheets result carries the parsed sheet models", () => {
		const sheets = [{ name: "S", html: "<table>", truncated: false }];
		expect(previewMappingFor({ kind: "sheets", sheets }).fields).toEqual({ officeSheets: sheets });
	});
});
