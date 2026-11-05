import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { markdownImagePath, resolveDocumentPath, sanitizeMarkdownHtml } from "../src/components/markdown-html";

describe("Markdown raw HTML rendering", () => {
	it("keeps README layout and media markup", () => {
		const html = sanitizeMarkdownHtml(
			'<p align="center"><img src="banner.png" width="1280" alt="MusePi"><code>musepi</code></p>',
		);
		expect(html).toContain('<p align="center">');
		expect(html).toContain('src="banner.png"');
		expect(html).toContain('width="1280"');
		expect(html).toContain('alt="MusePi"');
		expect(html).toContain("<code>musepi</code>");
	});

	it("keeps badge links and forces external links out of the app", () => {
		const html = sanitizeMarkdownHtml('<a href="https://example.com"><img src="https://img.shields.io/x.svg"></a>');
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain('src="https://img.shields.io/x.svg"');
	});

	it("drops scripts, handlers and unsafe URLs", () => {
		const html = sanitizeMarkdownHtml(
			'<p onclick="steal()">safe<script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="javascript:alert(1)"><img src="data:text/html,<script>alert(1)</script>"></p>',
		);
		expect(html).not.toContain("script");
		expect(html).not.toContain("onclick");
		expect(html).not.toContain("javascript:");
		expect(html).not.toContain("data:text/html");
		expect(html).toContain("safe");
		expect(html).toContain("x");
	});

	it("unwraps unknown tags but keeps their content", () => {
		expect(sanitizeMarkdownHtml("<unknown><strong>keep</strong></unknown>")).toBe("<strong>keep</strong>");
	});

	it("resolves document-relative image paths and leaves remote ones alone", () => {
		expect(markdownImagePath("D:\\workspace\\README.md", "banner.png")).toBe("D:/workspace/banner.png");
		expect(markdownImagePath("/workspace/docs/README.md", "../assets/cover.webp?raw=1")).toBe(
			"/workspace/assets/cover.webp",
		);
		expect(markdownImagePath("/workspace/README.md", "https://img.shields.io/badge.svg")).toBeNull();
	});

	it("resolves relative links without requiring an image extension", () => {
		expect(resolveDocumentPath("/workspace/docs/README.md", "./guide.md#install")).toBe("/workspace/docs/guide.md");
		expect(resolveDocumentPath("/workspace/README.md", "file:///workspace/assets/spec.pdf")).toBe(
			"/workspace/assets/spec.pdf",
		);
	});
});
