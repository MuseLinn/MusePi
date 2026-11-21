#!/usr/bin/env bun

import { describe, expect, test } from "bun:test";
import { CHANGELOG_CATEGORIES, checkChangelogCategories } from "./check-changelog-categories.ts";

const HEADER = "# MusePi Changelog\n\n";

describe("checkChangelogCategories", () => {
	test("accepts entries filed under the three categories", () => {
		const content = `${HEADER}## [Unreleased]\n\n### 新功能\n\n- 新条目。\n  - EN: A new entry.\n\n### 改进\n\n- 改进条目。\n  - EN: An improvement.\n\n### 修复\n\n- 修复条目。\n  - EN: A fix.\n`;
		const result = checkChangelogCategories(content);
		expect(result.problems).toEqual([]);
		expect(result.checked).toBe(3);
		expect(result.counts).toEqual({ 新功能: 1, 改进: 1, 修复: 1 });
	});

	test("flags an entry directly under the section heading", () => {
		const content = `${HEADER}## [Unreleased]\n\n- 没有分类的条目。\n`;
		const result = checkChangelogCategories(content);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]?.line).toBe(5);
		expect(result.problems[0]?.message).toContain("not under");
	});

	test("flags an unknown category heading and the entry under it", () => {
		const content = `${HEADER}## [Unreleased]\n\n### Added\n\n- 旧分类条目。\n`;
		const result = checkChangelogCategories(content);
		expect(result.problems).toHaveLength(2);
		expect(result.problems[0]?.line).toBe(5);
		expect(result.problems[0]?.message).toContain("unknown category");
		expect(result.problems[1]?.line).toBe(7);
		expect(result.problems[1]?.message).toContain("not under");
	});

	test("only judges the [Unreleased] section", () => {
		const content = `${HEADER}## [Unreleased]\n\n### 修复\n\n- 甲。\n\n## [1.2.3] - 2026-01-01\n\n- 已发布的平铺条目，不改写。\n`;
		const result = checkChangelogCategories(content);
		expect(result.problems).toEqual([]);
		expect(result.checked).toBe(1);
	});

	test("treats the nested EN child as part of its parent entry", () => {
		const content = `${HEADER}## [Unreleased]\n\n### 新功能\n\n- 甲。\n  - EN: A.\n  - 续行。\n`;
		const result = checkChangelogCategories(content);
		expect(result.problems).toEqual([]);
		expect(result.checked).toBe(1);
	});

	test("reports nothing when the file has no [Unreleased] section", () => {
		const result = checkChangelogCategories(`${HEADER}## [1.2.3] - 2026-01-01\n\n- 甲。\n`);
		expect(result.problems).toEqual([]);
		expect(result.checked).toBe(0);
	});

	test("keeps counting after a later category heading", () => {
		const content = `${HEADER}## [Unreleased]\n\n### 新功能\n\n- 甲。\n\n### 修复\n\n- 乙。\n- 丙。\n`;
		const result = checkChangelogCategories(content);
		expect(result.problems).toEqual([]);
		expect(result.counts).toEqual({ 新功能: 1, 改进: 0, 修复: 2 });
	});

	test("exposes the canonical category order", () => {
		expect(CHANGELOG_CATEGORIES).toEqual(["新功能", "改进", "修复"]);
	});
});
