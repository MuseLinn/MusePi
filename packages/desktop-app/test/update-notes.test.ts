import { describe, expect, test } from "bun:test";
import { localizeUpdateNotes } from "../src/lib/update-notes";

/**
 * OTA notes contract: the manifest ships one bilingual string (Chinese bullet
 * + indented `- EN:` child). The update toast/dialog must pick one language
 * from the current locale, exactly like the what's-new panel does daemon-side.
 */
describe("localizeUpdateNotes", () => {
	const bilingual = "- **标题**：中文说明。\n  - EN: **Title**: English text.";

	test("zh-CN keeps the Chinese bullet and drops the EN child", () => {
		expect(localizeUpdateNotes(bilingual, "zh-CN")).toBe("- **标题**：中文说明。");
	});

	test("en-US swaps the Chinese bullet for the EN child", () => {
		expect(localizeUpdateNotes(bilingual, "en-US")).toBe("- **Title**: English text.");
	});

	test("en-US handles a multi-line bullet", () => {
		const multi = "- **标题**：第一行\n  第二行。\n  - EN: **Title**: line one\n  line two.";
		expect(localizeUpdateNotes(multi, "en-US")).toBe("- **Title**: line one\n  line two.");
	});

	test("a bullet without an EN child passes through in both locales", () => {
		const legacy = "- **旧条目**：只有中文。";
		expect(localizeUpdateNotes(legacy, "zh-CN")).toBe(legacy);
		expect(localizeUpdateNotes(legacy, "en-US")).toBe(legacy);
	});

	test("empty input stays empty", () => {
		expect(localizeUpdateNotes("", "en-US")).toBe("");
	});
});
