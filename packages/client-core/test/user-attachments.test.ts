import { describe, expect, test } from "bun:test";
import { parseAttachmentRefs } from "../src/components/transcript/user-attachments";

const hash = (char: string): string => char.repeat(64);
const ref = (char: string, name: string): string => `[Attachment] blob://${hash(char)} (${name})`;

describe("parseAttachmentRefs", () => {
	test("lifts reference lines out of a multi-line message and keeps the rest verbatim", () => {
		const text = `${ref("a", "report.pdf")}\n${ref("b", "notes.txt")}\n看下这两个文件\n第二行`;

		const parsed = parseAttachmentRefs(text);

		expect(parsed.refs).toEqual([
			{ hash: hash("a"), name: "report.pdf" },
			{ hash: hash("b"), name: "notes.txt" },
		]);
		expect(parsed.text).toBe("看下这两个文件\n第二行");
	});

	test("keeps name-only mentions and malformed hashes in the body", () => {
		const text = `[Attachment:notes.md]\n[Attachment] blob://not-a-hash (fake.txt)\n正文`;

		expect(parseAttachmentRefs(text)).toEqual({ text, refs: [] });
	});

	test("keeps parentheses inside the original filename", () => {
		const parsed = parseAttachmentRefs(ref("c", "report (final) (v2).pdf"));

		expect(parsed.refs).toEqual([{ hash: hash("c"), name: "report (final) (v2).pdf" }]);
		expect(parsed.text).toBe("");
	});

	test("deduplicates repeated references to the same blob", () => {
		const line = ref("d", "same.txt");
		const parsed = parseAttachmentRefs(`${line}\n${line}\n正文`);

		expect(parsed.refs).toEqual([{ hash: hash("d"), name: "same.txt" }]);
		expect(parsed.text).toBe("正文");
	});

	test("accepts CRLF and an unnamed reference", () => {
		const parsed = parseAttachmentRefs(`${ref("e", "a.txt")}\r\n${ref("f", "")}\r\n指令`);

		expect(parsed.refs.map(item => item.name)).toEqual(["a.txt", ""]);
		expect(parsed.text).toBe("指令");
	});

	test("leaves text that never mentions an attachment byte-identical", () => {
		const text = "第一行\n\n第三行\n";
		expect(parseAttachmentRefs(text)).toEqual({ text, refs: [] });
	});
});
