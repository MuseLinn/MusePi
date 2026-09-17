#!/usr/bin/env bun

import { describe, expect, test } from "bun:test";
import { checkChangelogI18n } from "./check-changelog-i18n.ts";

const HEADER = "# MusePi Changelog\n\n";

describe("checkChangelogI18n", () => {
	test("accepts a bullet with its nested EN child", () => {
		const content = `${HEADER}## [1.2.3] - 2026-01-01\n\n### Added\n\n- 中文条目。\n  - EN: The entry in English.\n`;
		const result = checkChangelogI18n(content);
		expect(result.problems).toEqual([]);
		expect(result.checked).toBe(1);
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

	test("exempts the Unreleased section", () => {
		const content = `${HEADER}## [Unreleased]\n\n### Added\n\n- 未发布条目，无需英文。\n`;
		const result = checkChangelogI18n(content);
		expect(result.problems).toEqual([]);
		expect(result.checked).toBe(0);
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
		expect(result.checked).toBe(2);
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
