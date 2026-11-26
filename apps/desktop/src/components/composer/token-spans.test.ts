import { describe, expect, test } from "bun:test";
import { parseHighlightSpans } from "./token-spans";

/** A resolver that only knows the attachment chips staged in the composer. */
const noChips = (): null => null;

function references(text: string): Array<{ raw: string; kind: string; label: string }> {
	return parseHighlightSpans(text, noChips)
		.filter(span => span.kind === "reference")
		.map(span => ({
			raw: text.slice(span.start, span.end),
			kind: span.reference!.kind,
			label: span.reference!.label,
		}));
}

describe("parseHighlightSpans — @ references", () => {
	test("a session reference becomes a chip labelled by its id", () => {
		const [ref] = references("@history://01a20996-9d2f-7239-8bde-bd21a47fb618");
		expect(ref).toBeDefined();
		expect(ref!.kind).toBe("session");
		expect(ref!.label).toBe("01a20996");
		// The whole token is covered, so the raw URL is never painted as text.
		expect(ref!.raw).toBe("@history://01a20996-9d2f-7239-8bde-bd21a47fb618");
	});

	test("a file path becomes a chip labelled by its basename", () => {
		const [ref] = references("@src/components/app.ts");
		expect(ref).toEqual({ raw: "@src/components/app.ts", kind: "file", label: "app.ts" });
	});

	test("a trailing separator marks a folder", () => {
		const [ref] = references("@src/components/");
		expect(ref!.kind).toBe("folder");
		expect(ref!.label).toBe("components");
	});

	test("a windows path is one reference, not several", () => {
		const [ref, ...rest] = references("@C:\\work\\app.ts");
		expect(rest).toEqual([]);
		expect(ref!.kind).toBe("file");
		expect(ref!.label).toBe("app.ts");
	});

	test("prose with a bare @name stays plain text", () => {
		expect(references("@张三 你好")).toEqual([]);
		expect(references("@workflowz")).toEqual([]);
	});

	test("a reference stops at whitespace and the citation keeps its tail", () => {
		const spans = parseHighlightSpans("@src/a.ts 请参考", noChips);
		expect(spans).toHaveLength(1);
		expect(spans[0]!.end).toBe("@src/a.ts".length);
	});
});
