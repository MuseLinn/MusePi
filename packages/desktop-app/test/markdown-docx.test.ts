import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import { markdownDocxName, markdownToDocxBlob } from "../src/lib/markdown-docx";

describe("Markdown Word export", () => {
	it("writes a valid OOXML package with formatted content and safe links", async () => {
		const blob = await markdownToDocxBlob(
			`# Title\n\n**Bold** and *italic* with [site](https://example.com).\n\n- first\n- second\n\n| Name | Value |\n| --- | ---: |\n| A | 1 |\n\n\`\`\`ts\nconst ok = true;\n\`\`\``,
		);
		const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
		const documentXml = strFromU8(files["word/document.xml"]!);
		expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
		expect(documentXml).toContain('w:pStyle w:val="Heading1"');
		expect(documentXml).toContain("<w:b");
		expect(documentXml).toContain("<w:i");
		expect(documentXml).toContain("<w:tbl>");
		expect(documentXml).toContain("const ok = true;");
		expect(strFromU8(files["word/_rels/document.xml.rels"]!)).toContain("https://example.com");
	});

	it("keeps Markdown filenames recognizable and removes unsafe filename characters", () => {
		expect(markdownDocxName("notes.md")).toBe("notes.docx");
		expect(markdownDocxName("notes.markdown")).toBe("notes.docx");
		expect(markdownDocxName("a:b*c?.md")).toBe("a_b_c_.docx");
		expect(markdownDocxName(".md")).toBe("document.docx");
	});
});
