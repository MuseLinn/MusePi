#!/usr/bin/env bun

import { describe, expect, test } from "bun:test";
import { checkChangelogI18n } from "./check-changelog-i18n.ts";

const HEADER = "# MusePi Changelog\n\n";

describe("checkChangelogI18n", () => {
	test("accepts a bullet with its nested EN child", () => {
		const content = `${HEADER}## [1.2.3] - 2026-01-01\n\n### Added\n\n- 中文条目。\n  - EN: The entry in English.\n`;
		const result = checkChangelogI18n(content);
		expect(result.problems).toEqual([]);
		expect(result.released).toBe(1);
	});

	test("flags a bullet with no EN child", () => {
		const content = `${HEADER}## [1.2.3] - 2026-01-01\n\n### Added\n\n- 没有英文。\n`;
		const result = checkChangelogI18n(content);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]?.version).toBe("1.2.3");
		expect(result.problems[0]?.message).toContain("no `- EN:` child");
	});

	test("flags more than one EN child on a single bullet", () => {
		const content = `${HEADER}## [1.2.3] - 2026-01-01\n\n### Added\n\n- 条目。\n  - EN: first\n  - EN: second\n`;
		const result = checkChangelogI18n(content);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]?.message).toContain("2 `- EN:` children");
	});

	test("accepts a wrapped EN child (multi-line translation)", () => {
		const content = `${HEADER}## [1.2.3] - 2026-01-01\n\n### Added\n\n- 多行中文条目，\n  续行。\n  - EN: a long English entry\n    that wraps onto a second line.\n`;
		expect(checkChangelogI18n(content).problems).toEqual([]);
	});

	test("does not require an EN child in [Unreleased]", () => {
		const content = `${HEADER}## [Unreleased]\n\n### Added\n\n- 未发布条目，无需英文。\n`;
		const result = checkChangelogI18n(content);
		expect(result.problems).toEqual([]);
		// Counted on the structure side, because a translation is not required.
		expect(result.unreleased).toBe(1);
		expect(result.released).toBe(0);
	});

	test("does not let an EN child satisfy the NEXT bullet", () => {
		// The stray-EN shape: A has no child, B's child sits under A.
		const content = `${HEADER}## [1.2.3] - 2026-01-01\n\n### Added\n\n- 甲。\n  - EN: stray translation of nothing.\n- 乙，也没有自己的英文。\n`;
		const result = checkChangelogI18n(content);
		// 甲 has one (stray) child; 乙 has none — exactly one problem, on 乙.
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]?.line).toBe(9);
	});

	test("checks every released version section", () => {
		const content = `${HEADER}## [1.2.4] - 2026-02-01\n\n### Fixed\n\n- 甲。\n  - EN: A.\n\n## [1.2.3] - 2026-01-01\n\n### Fixed\n\n- 乙。\n  - EN: B.\n`;
		const result = checkChangelogI18n(content);
		expect(result.problems).toEqual([]);
		expect(result.released).toBe(2);
	});

	test("reports a file with content but no version heading", () => {
		const result = checkChangelogI18n(`${HEADER}## [not-a-version]\n\n### Added\n\n- 甲。\n`);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]?.message).toContain("no parseable `## [x.y.z]` version section found");
	});

	test("a header-only file is not an error", () => {
		expect(checkChangelogI18n(HEADER).problems).toEqual([]);
	});

	test("an empty file is not an error", () => {
		expect(checkChangelogI18n("").problems).toEqual([]);
	});
});

describe("checkChangelogI18n — [Unreleased] line structure", () => {
	test("accepts categories, bullets, their EN children and wrapped bodies", () => {
		const content = `${HEADER}## [Unreleased]\n\n### 改进\n\n- **标题**：正文。\n  - EN: Title and body.\n  续行也属于上面那条。\n\n### 修复\n\n- 修复条目。\n  - EN: A fix.\n`;
		expect(checkChangelogI18n(content).problems).toEqual([]);
	});

	/** The shipped defect: the title line of a bullet was deleted, leaving its
	 *  EN child as a paragraph. The renderer keeps that block and loses the
	 *  entry, so the page showed an untitled paragraph. */
	test("flags a deleted bullet title, naming the exact line", () => {
		const content = `${HEADER}## [Unreleased]\n\n### 改进\n\n- 甲。\n  - EN: A.\n\n  - EN: orphaned translation of a deleted title.\n`;
		const result = checkChangelogI18n(content);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]?.line).toBe(10);
		expect(result.problems[0]?.version).toBe("Unreleased");
		expect(result.problems[0]?.message).toContain("orphan");
	});

	/** The majority shape in the live section: bullets pack consecutively with no
	 *  blank line between them, so deleting a title leaves its `- EN:` inside the
	 *  PREVIOUS entry's block. The previous bullet is still open, so a rule that
	 *  only checks "is this line indented" reads the orphan as a second child of
	 *  it — the page then prints one card carrying two translations of two
	 *  different features while the count drops by one. */
	// @guard: revert scripts/check-changelog-i18n.ts:137 | if (enChildren > 999) {
	// @guard: test flags a title deleted mid-block
	test("flags a title deleted mid-block, as a second EN child of the entry above", () => {
		const content = `${HEADER}## [Unreleased]\n\n### 改进\n\n` + "- 甲。\n  - EN: A.\n- 乙。\n  - EN: B.\n";
		// Delete 乙's title line; its EN child now sits directly under 甲's child.
		const mutated = content.replace("- 乙。\n", "");
		const result = checkChangelogI18n(mutated);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]?.line).toBe(9);
		expect(result.problems[0]?.version).toBe("Unreleased");
		expect(result.problems[0]?.message).toContain("2 `- EN:` children");
	});

	test("accepts one EN child plus wrapped body lines in the same entry", () => {
		// The cap is on EN children, not on indented lines: a wrapped body after
		// the translation is the normal shape and must not be mistaken for one.
		const content = `${HEADER}## [Unreleased]\n\n### 修复\n\n- 甲。\n  正文续行。\n  - EN: A.\n    and its wrap.\n  再一段续行。\n`;
		expect(checkChangelogI18n(content).problems).toEqual([]);
	});

	test("flags a paragraph that opens a block without a bullet", () => {
		const content = `${HEADER}## [Unreleased]\n\n### 新功能\n\n- 甲。\n  - EN: A.\n\n一段没有条目的正文。\n`;
		const result = checkChangelogI18n(content);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]?.line).toBe(10);
		expect(result.problems[0]?.message).toContain("orphan paragraph");
	});

	test("flags an unindented continuation line under a bullet", () => {
		// Same rendering failure as the orphan paragraph: the block starts with
		// `- ` but this line is a sibling paragraph, not the bullet's own body.
		const content = `${HEADER}## [Unreleased]\n\n### 修复\n\n- 甲。\n  续行。\n没有缩进的续行。\n`;
		const result = checkChangelogI18n(content);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]?.line).toBe(9);
	});

	test("counts an [Unreleased] bullet once, alongside released bullets", () => {
		const content = `${HEADER}## [Unreleased]\n\n### 修复\n\n- 甲。\n\n## [1.2.3] - 2026-01-01\n\n- 乙。\n  - EN: B.\n`;
		const result = checkChangelogI18n(content);
		expect(result.problems).toEqual([]);
		// The two counts are separate facts: one bullet had its translation
		// checked, the other only its structure.
		expect(result.released).toBe(1);
		expect(result.unreleased).toBe(1);
	});

	test("stops judging structure at the next released heading", () => {
		const content = `${HEADER}## [Unreleased]\n\n### 修复\n\n- 甲。\n\n## [1.2.3] - 2026-01-01\n\n一段已发布的平铺正文。\n`;
		expect(checkChangelogI18n(content).problems).toEqual([]);
	});

	test("a file without [Unreleased] is judged on released bullets only", () => {
		const content = `${HEADER}## [1.2.3] - 2026-01-01\n\n### Fixed\n\n- 甲。\n  - EN: A.\n\n一段平铺正文。\n`;
		expect(checkChangelogI18n(content).problems).toEqual([]);
	});
});
