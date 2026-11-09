import { describe, expect, it } from "bun:test";
import { pageTextCode, paginateTextBlocks } from "@musepi/pi-coding-agent/tools/browser/page-text";

describe("browser page text pagination", () => {
	it("returns all short blocks without a continuation", () => {
		const page = paginateTextBlocks(["First paragraph", "Second paragraph"]);
		expect(page.text).toBe("First paragraph\n\nSecond paragraph");
		expect(page.blocks.map(block => block.id)).toEqual(["b1", "b2"]);
		expect(page.blockCount).toBe(2);
		expect(page.totalBlocks).toBe(2);
		expect(page.truncated).toBe(false);
		expect(page.nextCursor).toBeUndefined();
	});

	it("continues inside a block longer than maxChars", () => {
		const source = "a".repeat(3000);
		const first = paginateTextBlocks([source], { maxChars: 2048 });
		expect(first.text).toBe("a".repeat(2048));
		expect(first.nextCursor).toBe("0:2048");
		expect(first.truncated).toBe(true);
		expect(first.blocks[0]?.continued).toBe(true);

		const second = paginateTextBlocks([source], { maxChars: 2048, cursor: first.nextCursor });
		expect(second.text).toBe("a".repeat(952));
		expect(second.nextCursor).toBeUndefined();
		expect(second.truncated).toBe(false);
		expect(second.blocks[0]?.part).toBe(2);
	});

	it("continues at the next block without duplicating separators", () => {
		const first = paginateTextBlocks(["a".repeat(1500), "b".repeat(1500)], { maxChars: 2048 });
		expect(first.text).toBe("a".repeat(1500));
		expect(first.nextCursor).toBe("1:0");
		const second = paginateTextBlocks(["a".repeat(1500), "b".repeat(1500)], {
			maxChars: 2048,
			cursor: first.nextCursor,
		});
		expect(second.text).toBe("b".repeat(1500));
		expect(second.blocks[0]?.id).toBe("b2");
		expect(second.nextCursor).toBeUndefined();
	});

	it("returns a stable empty page", () => {
		expect(paginateTextBlocks([])).toMatchObject({
			text: "",
			blocks: [],
			blockCount: 0,
			totalBlocks: 0,
			truncated: false,
		});
	});

	it("rejects malformed and out-of-range cursors", () => {
		expect(() => paginateTextBlocks(["text"], { cursor: "bogus" })).toThrow(/cursor/i);
		expect(() => paginateTextBlocks(["text"], { cursor: "1:0" })).toThrow(/cursor/i);
		expect(() => paginateTextBlocks(["text"], { cursor: "0:5" })).toThrow(/cursor/i);
	});

	it("enforces the public maxChars bounds", () => {
		expect(() => paginateTextBlocks(["text"], { maxChars: 2047 })).toThrow(/2048/);
		expect(() => paginateTextBlocks(["text"], { maxChars: 24001 })).toThrow(/24000/);
		expect(paginateTextBlocks(["text"], { maxChars: 24000 }).text).toBe("text");
	});
});

describe("browser page text run bridge", () => {
	it("serializes scope and pagination options into a tab evaluation", () => {
		const code = pageTextCode({ scope: "document", maxChars: 24000, cursor: "2:10" });
		expect(code).toStartWith("return await tab.evaluate(");
		expect(code).toContain('"scope":"document"');
		expect(code).toContain('"maxChars":24000');
		expect(code).toContain('"cursor":"2:10"');
	});
});
