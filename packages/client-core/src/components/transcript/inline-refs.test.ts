import { describe, expect, test } from "bun:test";
import { parseInlineRefs } from "./inline-refs";

function labels(text: string): string[] {
	return parseInlineRefs(text).map(ref => `${ref.kind}:${ref.label}`);
}

describe("parseInlineRefs", () => {
	test("an ordinal image reference becomes an image chip", () => {
		const [ref] = parseInlineRefs("看看 [图片 1] 这张");
		expect(ref).toBeDefined();
		expect(ref!.kind).toBe("image");
		expect(ref!.label).toBe("图片 1");
		// The chip covers the whole bracketed run, so the syntax is not left
		// behind in the text beside it.
		expect("看看 [图片 1] 这张".slice(ref!.start, ref!.end)).toBe("[图片 1]");
	});

	test("the legacy name form keeps the name", () => {
		expect(labels("[图片:屏幕截图.png]")).toEqual(["image:屏幕截图.png"]);
	});

	test("an attachment reference becomes a file chip carrying its name", () => {
		expect(labels("见 [Attachment:app.ts]")).toEqual(["file:app.ts"]);
	});

	test("several references keep their order", () => {
		expect(labels("[图片 1] 与 [Attachment:a.ts] 再 [图片 2]")).toEqual([
			"image:图片 1",
			"file:a.ts",
			"image:图片 2",
		]);
	});

	test("prose about pictures is not a reference", () => {
		// No ordinal, no colon: this is the reader's own sentence.
		expect(labels("我看过 [图片] 和 图片 1")).toEqual([]);
	});

	test("the attachment reference LINE is not an inline reference", () => {
		// `[Attachment] blob://…` is lifted out of the body separately; it must
		// not also draw a chip.
		expect(labels("[Attachment] blob://abc (a.ts)")).toEqual([]);
	});

	test("text with no reference costs nothing", () => {
		expect(parseInlineRefs("普通消息")).toEqual([]);
	});
});
