import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { markdownImagePath } from "../src/components/FileMarkdownEditor";
import { readMarkdownFrontMatter } from "../src/lib/markdown-frontmatter";

describe("Markdown visual editor image resolution", () => {
	it("resolves relative images from the document directory on Windows and POSIX", () => {
		expect(markdownImagePath("D:\\workspace\\docs\\guide.md", "./assets/cover.png")).toBe(
			"D:/workspace/docs/assets/cover.png",
		);
		expect(markdownImagePath("/workspace/docs/guide.md", "../images/cover.webp")).toBe(
			"/workspace/images/cover.webp",
		);
	});

	it("keeps remote data out of the filesystem bridge and rejects transient blobs", () => {
		expect(markdownImagePath("/workspace/guide.md", "https://example.com/cover.png")).toBeNull();
		expect(markdownImagePath("/workspace/guide.md", "data:image/png;base64,AA==")).toBeNull();
		expect(markdownImagePath("/workspace/guide.md", "blob:local-draft")).toBeNull();
	});
});

describe("Markdown YAML Front Matter detection", () => {
	it("detects a complete front matter block, including CRLF and a BOM", () => {
		expect(readMarkdownFrontMatter("---\ntitle: Guide\n---\n# Body\n").raw).not.toBe("");
		expect(readMarkdownFrontMatter("\uFEFF---\r\ntitle: Guide\r\n...\r\nBody").raw).not.toBe("");
	});

	it("does not mistake a horizontal rule or leading content for front matter", () => {
		expect(readMarkdownFrontMatter("---\n# Body\n").raw).toBe("");
		expect(readMarkdownFrontMatter("# Body\n---\ntitle: Guide\n---\n").raw).toBe("");
	});
});
