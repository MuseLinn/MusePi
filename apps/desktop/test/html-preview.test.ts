import { describe, expect, it } from "bun:test";
import { htmlPreviewRequiresBuild, inlineHtmlPreviewStyles, withHtmlPreviewBase } from "../src/lib/html-preview";

describe("HTML preview document base", () => {
	it("resolves relative resources against Windows file paths", () => {
		const html = withHtmlPreviewBase(
			'<html><head><link rel="stylesheet" href="app.css"></head><body>x</body></html>',
			"C:\\work dir\\page.html",
		);
		expect(html).toContain('<base href="file:///C:/work%20dir/">');
		expect(html.indexOf("<base ")).toBeLessThan(html.indexOf("app.css"));
	});

	it("does not override an author-supplied base element", () => {
		const source = '<head><base href="https://example.com/"><style>x{}</style></head>';
		expect(withHtmlPreviewBase(source, "/tmp/page.html")).toBe(source);
	});

	it("adds a base to fragments and headless documents", () => {
		expect(withHtmlPreviewBase("<h1>x</h1>", "/tmp/page.html")).toBe(
			'<base href="file:///tmp/">​<h1>x</h1>'.replace("​", ""),
		);
		expect(withHtmlPreviewBase("<html><body>x</body></html>", "/tmp/page.html")).toContain("<head><base");
	});

	it("marks TypeScript and JSX module pages as build-required", () => {
		expect(htmlPreviewRequiresBuild('<script type="module" src="./src/main.tsx"></script>')).toBe(true);
		expect(htmlPreviewRequiresBuild('<script src="./src/main.jsx?dev=1"></script>')).toBe(true);
		expect(htmlPreviewRequiresBuild('<script type="module" src="./dist/main.js"></script>')).toBe(false);
	});

	it("inlines relative stylesheets for the opaque preview origin", async () => {
		const source = '<html><head><link rel="stylesheet" href="./preview.css"></head><body>x</body></html>';
		const html = await inlineHtmlPreviewStyles(source, "D:\\work\\page.html", async path => {
			expect(path).toBe("D:/work/preview.css");
			return "body{background:#e8f7ee}";
		});
		expect(html).toContain("<style>body{background:#e8f7ee}</style>");
		expect(html).not.toContain('<link rel="stylesheet"');
	});
});
