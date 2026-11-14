import { describe, expect, test } from "bun:test";
import { parseMarkdownMetadata, readMarkdownFrontMatter } from "../src/lib/markdown-frontmatter";

describe("markdown front matter", () => {
	test("splits the block from the body without touching either", () => {
		const source = "---\ntitle: Doc\nstatus: living\n---\n\n# Body\n";
		const { raw, body } = readMarkdownFrontMatter(source);

		expect(raw).toBe("---\ntitle: Doc\nstatus: living\n---\n");
		expect(body).toBe("\n# Body\n");
		expect(raw + body).toBe(source);
	});

	test("preserves CRLF bytes for the editor round trip", () => {
		const source = "---\r\ntitle: Doc\r\n---\r\nBody";
		const { raw, body } = readMarkdownFrontMatter(source);

		expect(raw).toBe("---\r\ntitle: Doc\r\n---\r\n");
		expect(body).toBe("Body");
		expect(raw + body).toBe(source);
	});

	test("leaves documents without a closed block alone", () => {
		expect(readMarkdownFrontMatter("# Title\n\n---\n\nText")).toEqual({ raw: "", body: "# Title\n\n---\n\nText" });
		// A leading rule with no closing delimiter is Markdown, not front matter.
		expect(readMarkdownFrontMatter("---\n\nText").raw).toBe("");
	});

	test("renders scalars, list values and objects", () => {
		const entries = parseMarkdownMetadata(
			"---\ntitle: GUI\nstatus: living\nscope:\n  - apps/desktop\n  - packages/client-core\nmeta:\n  owner: linn\n---\n",
		);

		expect(entries).toEqual([
			{ key: "title", values: ["GUI"] },
			{ key: "status", values: ["living"] },
			{ key: "scope", values: ["apps/desktop", "packages/client-core"] },
			{ key: "meta", values: ['{"owner":"linn"}'] },
		]);
	});

	test("keeps raw keys instead of normalizing them", () => {
		const entries = parseMarkdownMetadata("---\nallowed-tools: read\n---\n");
		expect(entries).toEqual([{ key: "allowed-tools", values: ["read"] }]);
	});

	test("returns no entries for an empty block", () => {
		expect(parseMarkdownMetadata("")).toEqual([]);
	});
});
