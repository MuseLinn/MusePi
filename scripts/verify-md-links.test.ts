import { describe, expect, test } from "bun:test";
import {
	documentAnchors,
	githubSlug,
	isExampleLink,
	sourceDocumentFor,
	splitDestination,
	stripFencedCode,
} from "./verify-md-links";

describe("markdown link gate", () => {
	test("blanks fenced code while keeping line numbers", () => {
		const source = ["a", "```ts", "[x](missing.md)", "```", "[y](real.md)"].join("\n");
		const stripped = stripFencedCode(source).split("\n");
		expect(stripped[2]).toBe("");
		expect(stripped[4]).toBe("[y](real.md)");
		expect(stripped.length).toBe(5);
	});

	test("splits a destination into path and fragment", () => {
		expect(splitDestination("./a.md#b")).toEqual({ path: "./a.md", fragment: "b" });
		expect(splitDestination("./a.md")).toEqual({ path: "./a.md", fragment: null });
		expect(splitDestination("#local")).toEqual({ path: "", fragment: "local" });
		expect(splitDestination("./a.md?x=1#f")).toEqual({ path: "./a.md", fragment: "f" });
	});

	test("slugs a heading the way GitHub does", () => {
		expect(githubSlug("Tools and isolation")).toBe("tools-and-isolation");
		expect(githubSlug("Showcase: web_fetch")).toBe("showcase-web_fetch");
	});

	test("collects heading slugs with collision suffixes and explicit anchors", () => {
		const source = ["## Repeat", "## Repeat", '<a id="manual"></a>'].join("\n");
		const anchors = documentAnchors(source);
		expect(anchors.has("repeat")).toBe(true);
		expect(anchors.has("repeat-1")).toBe(true);
		expect(anchors.has("manual")).toBe(true);
	});

	test("resolves a rendered .html page to its source document", () => {
		expect(sourceDocumentFor("docs/collab.html")).toBe("docs/collab.md");
		expect(sourceDocumentFor("docs/collab.md")).toBe("docs/collab.md");
	});

	test("treats marked links as illustrative", () => {
		const source = ["<!-- link-example: convention -->", "[a](foo.md)", "", "[b](bar.md)"].join("\n");
		expect(isExampleLink(source, 2)).toBe(true);
		expect(isExampleLink(source, 4)).toBe(false);
	});
});
