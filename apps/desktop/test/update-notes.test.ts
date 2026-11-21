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

	const OTA = `## [0.8.0] - 2026-11-21

本次发布：2 项新功能 · 1 项改进 · 1 项修复

### 新功能

- **标题**：中文说明。
  - EN: **Title**: English text.

### 改进

- **改进标题**：中文说明。
  - EN: **Improved title**: English text.

### 修复

- **修复标题**：中文说明。
  - EN: **Fixed title**: English text.
`;

	test("en-US translates the Chinese category headings and the release summary line", () => {
		const localized = localizeUpdateNotes(OTA, "en-US");
		expect(localized).toContain("This release: 2 new features · 1 improvement · 1 fix");
		expect(localized).toContain("### New features");
		expect(localized).toContain("### Improvements");
		expect(localized).toContain("### Fixes");
		expect(localized).not.toContain("本次发布");
		expect(localized).not.toMatch(/###\s+(新功能|改进|修复)/);
		expect(localized).toContain("- **Title**: English text.");
		expect(localized).not.toContain("中文说明");
	});

	test("zh-CN keeps the Chinese headings and summary line untouched", () => {
		const localized = localizeUpdateNotes(OTA, "zh-CN");
		expect(localized).toContain("本次发布：2 项新功能 · 1 项改进 · 1 项修复");
		expect(localized).toContain("### 新功能");
		expect(localized).toContain("### 改进");
		expect(localized).toContain("### 修复");
		expect(localized).not.toContain("EN:");
	});

	test("en-US pluralizes summary items and translates the empty-release line", () => {
		expect(localizeUpdateNotes("本次发布：1 项新功能 · 2 项改进 · 1 项修复", "en-US")).toBe(
			"This release: 1 new feature · 2 improvements · 1 fix",
		);
		expect(localizeUpdateNotes("本次发布：4 项其他变更", "en-US")).toBe("This release: 4 other changes");
		expect(localizeUpdateNotes("本次发布：无用户可见变更", "en-US")).toBe("This release: no user-visible changes");
	});
});
